// =============================================================================
// Email Service using Nodemailer
// Sends meeting invitations and reminders via SMTP
// Used by both the Next.js API routes (invitations) and media server (reminders)
// =============================================================================

import nodemailer from 'nodemailer';

/**
 * Create a reusable SMTP transporter.
 * Configuration is read from environment variables set in docker-compose.
 * Gmail requires an "App Password" (not your regular password) when 2FA is enabled.
 */
function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // true for 465, false for other ports (STARTTLS)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

/**
 * Send a meeting invitation email.
 * Called when the host invites someone on-the-fly during a meeting.
 *
 * @param to - Recipient email address
 * @param meetingTitle - Title of the meeting
 * @param meetingCode - Join code (e.g., "abc-defg-hij")
 * @param inviterName - Name of the person who sent the invite
 */
export async function sendInvitationEmail(
  to: string,
  meetingTitle: string,
  meetingCode: string,
  inviterName: string
): Promise<void> {
  const transporter = createTransporter();
  const joinUrl = `${process.env.NEXTAUTH_URL}/meeting/${meetingCode}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `${inviterName} invited you to: ${meetingTitle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2196f3;">You're invited to a meeting</h2>
        <p><strong>${inviterName}</strong> has invited you to join:</p>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin: 0 0 10px;">${meetingTitle}</h3>
          <p style="margin: 0; color: #666;">Meeting Code: <strong>${meetingCode}</strong></p>
        </div>
        <a href="${joinUrl}"
           style="display: inline-block; background: #2196f3; color: white; padding: 12px 24px;
                  border-radius: 6px; text-decoration: none; font-weight: bold;">
          Join Meeting
        </a>
        <p style="margin-top: 20px; color: #999; font-size: 12px;">
          You need a Google account to join. Sign in at the link above.
        </p>
      </div>
    `,
  });
}

/**
 * Send a meeting reminder email.
 * Called by the cron scheduler before a meeting starts.
 *
 * @param to - Recipient email address
 * @param meetingTitle - Title of the meeting
 * @param meetingCode - Join code
 * @param minutesBefore - How many minutes before the meeting this reminder fires
 */
export async function sendReminderEmail(
  to: string,
  meetingTitle: string,
  meetingCode: string,
  minutesBefore: number
): Promise<void> {
  const transporter = createTransporter();
  const joinUrl = `${process.env.NEXTAUTH_URL}/meeting/${meetingCode}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `Reminder: "${meetingTitle}" starts in ${minutesBefore} minutes`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #d69e2e;">Meeting Reminder</h2>
        <p>Your meeting <strong>"${meetingTitle}"</strong> starts in
           <strong>${minutesBefore} minutes</strong>.</p>
        <a href="${joinUrl}"
           style="display: inline-block; background: #2196f3; color: white; padding: 12px 24px;
                  border-radius: 6px; text-decoration: none; font-weight: bold;">
          Join Now
        </a>
      </div>
    `,
  });
}
