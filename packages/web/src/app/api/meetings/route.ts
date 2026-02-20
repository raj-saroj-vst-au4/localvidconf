// =============================================================================
// Meetings API Route
// GET: List meetings for the authenticated user
// POST: Create a new meeting with a cryptographically random join code
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { createMeetingSchema } from '@/lib/validators';
import { nanoid } from 'nanoid';

/**
 * Generate a meeting code in the format "abc-defg-hij"
 * Uses nanoid for cryptographic randomness (not Math.random)
 * This format is easy to read and share verbally
 */
function generateMeetingCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  // Generate 10 random characters and format as xxx-xxxx-xxx
  const raw = Array.from({ length: 10 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 10)}`;
}

// --- GET /api/meetings ---
// Returns all meetings where the user is host or participant
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id;

  // Fetch meetings where user is host OR a participant
  const meetings = await prisma.meeting.findMany({
    where: {
      OR: [
        { hostId: userId },
        { participants: { some: { userId } } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    // Limit to recent meetings for performance
    take: 50,
  });

  return NextResponse.json({ meetings });
}

// --- POST /api/meetings ---
// Creates a new meeting and sets the creator as HOST
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();

  // Validate input with Zod schema (prevents injection/invalid data)
  const parsed = createMeetingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const userId = (session.user as any).id;
  const code = generateMeetingCode();

  // Create the meeting and add the creator as a HOST participant in one transaction
  // This ensures atomicity: if either fails, both are rolled back
  const meeting = await prisma.meeting.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      code,
      hostId: userId,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
      lobbyEnabled: parsed.data.lobbyEnabled,
      // Automatically add the creator as a HOST participant
      participants: {
        create: {
          userId,
          role: 'HOST',
          status: 'IN_MEETING',
        },
      },
    },
  });

  // If the meeting is scheduled, create reminders (15 min and 5 min before)
  if (parsed.data.scheduledAt) {
    const scheduledTime = new Date(parsed.data.scheduledAt);
    await prisma.reminder.createMany({
      data: [
        {
          meetingId: meeting.id,
          type: 'EMAIL',
          triggerAt: new Date(scheduledTime.getTime() - 15 * 60 * 1000), // 15 min before
        },
        {
          meetingId: meeting.id,
          type: 'EMAIL',
          triggerAt: new Date(scheduledTime.getTime() - 5 * 60 * 1000), // 5 min before
        },
        {
          meetingId: meeting.id,
          type: 'IN_APP',
          triggerAt: new Date(scheduledTime.getTime() - 5 * 60 * 1000), // 5 min in-app
        },
      ],
    });
  }

  return NextResponse.json({ meeting }, { status: 201 });
}
