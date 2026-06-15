// =============================================================================
// Reminder Scheduler
// Uses node-cron to periodically scan for pending reminders and fire them.
// Two types of reminders:
// - EMAIL: Sent via Nodemailer SMTP to all meeting participants
// - IN_APP: Sent via Socket.IO to connected users as toast notifications
//
// The cron job runs every minute and processes all due, unsent reminders.
// This approach is simple and works for a single-server deployment.
// For multi-server load balancing, you'd need a distributed lock (e.g., Redis).
// =============================================================================

import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { Server as SocketServer } from 'socket.io';
import { sendMail } from '../utils/mailer';
import { createLogger } from '../utils/logger';

const log = createLogger('ReminderScheduler');

export class ReminderScheduler {
  private prisma: PrismaClient;
  private io: SocketServer;
  private cronJob: cron.ScheduledTask | null = null;
  // Re-entrancy guard: prevents a slow run (slow SMTP) from overlapping the
  // next cron tick, which could double-process reminders.
  private isRunning = false;

  constructor(prisma: PrismaClient, io: SocketServer) {
    this.prisma = prisma;
    this.io = io;
  }

  /**
   * Start the cron job. Runs every minute to check for due reminders.
   * '* * * * *' = every minute (second field is intentionally omitted)
   */
  start(): void {
    this.cronJob = cron.schedule('* * * * *', async () => {
      await this.processReminders();
    });

    log.info('Reminder scheduler started (runs every minute)');
  }

  /**
   * Stop the cron job. Called during graceful shutdown.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      log.info('Reminder scheduler stopped');
    }
  }

  /**
   * Find all due, unsent reminders and process them.
   * A reminder is "due" if its triggerAt time has passed and it hasn't been sent.
   */
  private async processReminders(): Promise<void> {
    // Skip this tick if a previous run is still in progress (e.g. slow SMTP),
    // so runs never overlap and reminders are not double-sent.
    if (this.isRunning) {
      log.warn('Previous reminder cycle still running; skipping this tick');
      return;
    }
    this.isRunning = true;

    try {
      const now = new Date();

      // Find all reminders that should have fired by now but haven't
      const dueReminders = await this.prisma.reminder.findMany({
        where: {
          sent: false,
          triggerAt: { lte: now },
        },
        include: {
          meeting: {
            include: {
              participants: {
                include: {
                  user: { select: { email: true, name: true } },
                },
                where: { status: { not: 'REMOVED' } },
              },
            },
          },
        },
        // Process up to 50 reminders per cycle to prevent overload
        take: 50,
      });

      if (dueReminders.length === 0) return;

      log.info(`Processing ${dueReminders.length} due reminders`);

      for (const reminder of dueReminders) {
        try {
          if (reminder.type === 'EMAIL') {
            await this.sendEmailReminder(reminder);
          } else if (reminder.type === 'IN_APP') {
            await this.sendInAppReminder(reminder);
          }

          // Mark reminder as sent
          await this.prisma.reminder.update({
            where: { id: reminder.id },
            data: { sent: true },
          });
        } catch (err: any) {
          log.error('Failed to process reminder', {
            reminderId: reminder.id,
            error: err.message,
          });
          // Don't mark as sent on failure; it will be retried next minute
        }
      }
    } catch (err: any) {
      log.error('Error in reminder processing cycle', { error: err.message });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Send email reminders to all participants of a meeting.
   */
  private async sendEmailReminder(reminder: any): Promise<void> {
    const meeting = reminder.meeting;
    const joinUrl = `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/meeting/${meeting.code}`;

    // Calculate minutes until meeting
    const minutesBefore = meeting.scheduledAt
      ? Math.max(0, Math.round((meeting.scheduledAt.getTime() - Date.now()) / 60000))
      : 0;

    // Send to all participants
    for (const participant of meeting.participants) {
      try {
        await sendMail({
          to: participant.user.email,
          subject: `Reminder: "${meeting.title}" starts in ${minutesBefore} minutes`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #d69e2e;">Meeting Reminder</h2>
              <p>Your meeting <strong>"${meeting.title}"</strong> starts in
                 <strong>${minutesBefore} minutes</strong>.</p>
              <a href="${joinUrl}"
                 style="display: inline-block; background: #2196f3; color: white; padding: 12px 24px;
                        border-radius: 6px; text-decoration: none; font-weight: bold;">
                Join Now
              </a>
            </div>
          `,
        });
      } catch (emailErr: any) {
        log.error('Failed to send reminder email', {
          to: participant.user.email,
          error: emailErr.message,
        });
      }
    }

    log.info('Email reminders sent', {
      meetingId: meeting.id,
      recipientCount: meeting.participants.length,
    });
  }

  /**
   * Send in-app notification via Socket.IO.
   * Connected users see a toast notification.
   */
  private async sendInAppReminder(reminder: any): Promise<void> {
    const meeting = reminder.meeting;
    const minutesBefore = meeting.scheduledAt
      ? Math.max(0, Math.round((meeting.scheduledAt.getTime() - Date.now()) / 60000))
      : 0;

    // Send only to the intended participant's own room (all their sockets/tabs),
    // not a global broadcast which would leak reminders to every connected user.
    for (const participant of meeting.participants) {
      this.io.to(`user:${participant.userId}`).emit('reminder', {
        type: 'IN_APP',
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        meetingCode: meeting.code,
        minutesBefore,
        targetEmail: participant.user.email,
      });
    }

    log.info('In-app reminders sent', {
      meetingId: meeting.id,
      participantCount: meeting.participants.length,
    });
  }
}
