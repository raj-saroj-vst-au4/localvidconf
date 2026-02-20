// =============================================================================
// Participants API Route
// GET: List all participants of a meeting
// Used by the participant list panel and lobby manager
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id;

  // Verify the user is a participant (not removed) before showing the list
  // This prevents non-participants from snooping on meeting attendees
  const meeting = await prisma.meeting.findUnique({
    where: { code: params.id },
    include: {
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  });

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }

  // Check if the requesting user is a participant
  const isParticipant = meeting.participants.some(
    (p) => p.userId === userId && p.status !== 'REMOVED'
  );

  if (!isParticipant) {
    return NextResponse.json({ error: 'Not a participant' }, { status: 403 });
  }

  return NextResponse.json({ participants: meeting.participants });
}
