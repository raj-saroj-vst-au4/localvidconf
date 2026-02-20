// =============================================================================
// Meeting Invitation API Route
// POST: Send an email invitation to join a meeting (host/co-host only)
// Invitations are tracked in the database and sent via SMTP
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { inviteSchema } from '@/lib/validators';
import { sendInvitationEmail } from '@/lib/mailer';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid email', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const userId = (session.user as any).id;

  // Verify the user is host or co-host of this meeting
  const participant = await prisma.participant.findFirst({
    where: {
      userId,
      meeting: { code: params.id },
      role: { in: ['HOST', 'CO_HOST'] },
    },
    include: {
      meeting: true,
      user: true,
    },
  });

  if (!participant) {
    return NextResponse.json(
      { error: 'Only host or co-host can send invitations' },
      { status: 403 }
    );
  }

  // Create invitation record in the database
  const invitation = await prisma.invitation.create({
    data: {
      email: parsed.data.email,
      meetingId: participant.meetingId,
      invitedById: userId,
    },
  });

  // Send the email asynchronously (don't block the response)
  // If email fails, the invitation record still exists for retry
  sendInvitationEmail(
    parsed.data.email,
    participant.meeting.title,
    participant.meeting.code,
    participant.user.name
  ).catch((err) => {
    console.error('Failed to send invitation email:', err);
  });

  return NextResponse.json({ invitation }, { status: 201 });
}
