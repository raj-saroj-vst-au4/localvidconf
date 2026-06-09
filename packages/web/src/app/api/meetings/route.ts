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
import { customAlphabet } from 'nanoid';

/**
 * Generate a meeting code in the format "abc-defg-hij".
 * Uses nanoid's customAlphabet (crypto-strong RNG, unlike Math.random) over the
 * [a-z] alphabet so codes always match the join validator
 * regex /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.
 */
const nanoCode = customAlphabet('abcdefghijklmnopqrstuvwxyz', 10);
function generateMeetingCode(): string {
  const raw = nanoCode();
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
  const input = parsed.data; // captured after the success guard so it's narrowed inside the closure

  // Create the meeting + HOST participant, retrying on the (rare) unique-code
  // collision (Prisma P2002) instead of surfacing a 500 to the user.
  async function createWithUniqueCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await prisma.meeting.create({
          data: {
            title: input.title,
            description: input.description,
            code: generateMeetingCode(),
            hostId: userId,
            scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
            lobbyEnabled: input.lobbyEnabled,
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
      } catch (err: any) {
        if (err?.code === 'P2002' && attempt < 4) continue; // code collision → retry
        throw err;
      }
    }
    throw new Error('Could not generate a unique meeting code');
  }
  const meeting = await createWithUniqueCode();

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
