// =============================================================================
// Upvote Toggle API Route
// POST: Toggle upvote on a question (add if not upvoted, remove if already upvoted)
// Uses @@unique([questionId, userId]) constraint to prevent duplicate votes
// This is an improvement over the Slido reference which allowed duplicate upvotes
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id;
  const questionId = params.id;

  // Verify the question exists and get meeting context
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: { meetingId: true },
  });

  if (!question) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 });
  }

  // Verify the user is a participant in this meeting
  const participant = await prisma.participant.findUnique({
    where: {
      userId_meetingId: { userId, meetingId: question.meetingId },
    },
  });

  if (!participant || participant.status === 'REMOVED') {
    return NextResponse.json({ error: 'Not a participant' }, { status: 403 });
  }

  // Check if the user has already upvoted this question
  const existingUpvote = await prisma.upvote.findUnique({
    where: {
      questionId_userId: { questionId, userId },
    },
  });

  let hasUpvoted: boolean;

  if (existingUpvote) {
    // User already upvoted → remove the upvote (toggle off)
    await prisma.upvote.delete({
      where: { id: existingUpvote.id },
    });
    hasUpvoted = false;
  } else {
    // User hasn't upvoted → add the upvote (toggle on)
    await prisma.upvote.create({
      data: { questionId, userId },
    });
    hasUpvoted = true;
  }

  // Get the new upvote count after the toggle
  const upvoteCount = await prisma.upvote.count({
    where: { questionId },
  });

  return NextResponse.json({ questionId, upvoteCount, hasUpvoted });
}
