// =============================================================================
// Reminders API Route
// POST: Create a reminder for a scheduled meeting
// Reminders are processed by the media server's cron scheduler
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { scheduleReminderSchema } from '@/lib/validators';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = scheduleReminderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Verify the meeting exists and has a scheduled time
  const meeting = await prisma.meeting.findUnique({
    where: { id: parsed.data.meetingId },
  });

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }

  if (!meeting.scheduledAt) {
    return NextResponse.json(
      { error: 'Meeting has no scheduled time. Cannot set reminder.' },
      { status: 400 }
    );
  }

  // Calculate when the reminder should fire
  const triggerAt = new Date(
    meeting.scheduledAt.getTime() - parsed.data.minutesBefore * 60 * 1000
  );

  // Don't create reminders that would fire in the past
  if (triggerAt <= new Date()) {
    return NextResponse.json(
      { error: 'Reminder time is in the past' },
      { status: 400 }
    );
  }

  const reminder = await prisma.reminder.create({
    data: {
      meetingId: parsed.data.meetingId,
      type: parsed.data.type,
      triggerAt,
    },
  });

  return NextResponse.json({ reminder }, { status: 201 });
}
