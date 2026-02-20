// =============================================================================
// Single Meeting API Route
// GET: Fetch meeting details by code (used when joining)
// PATCH: Update meeting settings (host only)
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

// --- GET /api/meetings/[id] ---
// Fetches meeting details including participants
// [id] here is the meeting code (e.g., "abc-defg-hij"), not the database ID
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const meeting = await prisma.meeting.findUnique({
    where: { code: params.id },
    include: {
      host: { select: { id: true, name: true, email: true, image: true } },
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
        // Don't include removed participants
        where: { status: { not: 'REMOVED' } },
      },
      breakoutRooms: {
        where: { isActive: true },
        include: {
          participants: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true } },
            },
          },
        },
      },
    },
  });

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }

  return NextResponse.json({ meeting });
}

// --- PATCH /api/meetings/[id] ---
// Update meeting settings (only the host can do this)
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id;

  // Verify the user is the host before allowing updates
  const meeting = await prisma.meeting.findUnique({
    where: { code: params.id },
  });

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }

  if (meeting.hostId !== userId) {
    return NextResponse.json({ error: 'Only the host can update meeting settings' }, { status: 403 });
  }

  const body = await req.json();

  // Only allow updating specific fields (whitelist approach for security)
  const allowedFields: Record<string, any> = {};
  if (typeof body.title === 'string') allowedFields.title = body.title.trim();
  if (typeof body.lobbyEnabled === 'boolean') allowedFields.lobbyEnabled = body.lobbyEnabled;
  if (typeof body.status === 'string' && ['LIVE', 'ENDED'].includes(body.status)) {
    allowedFields.status = body.status;
    if (body.status === 'LIVE') allowedFields.startedAt = new Date();
    if (body.status === 'ENDED') allowedFields.endedAt = new Date();
  }

  const updated = await prisma.meeting.update({
    where: { id: meeting.id },
    data: allowedFields,
  });

  return NextResponse.json({ meeting: updated });
}
