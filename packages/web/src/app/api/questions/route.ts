// =============================================================================
// Q&A Questions API Route
// GET: List questions for a meeting, sorted by upvote count (Slido-style)
// POST: Submit a new question
// Upvote count and "hasUpvoted" status are computed per-user
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { askQuestionSchema } from '@/lib/validators';

// --- GET /api/questions?meetingId=xxx ---
// Returns questions sorted by upvote count (most popular first)
// Pinned questions always appear at the top
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id;
  const meetingId = req.nextUrl.searchParams.get('meetingId');

  if (!meetingId) {
    return NextResponse.json({ error: 'meetingId is required' }, { status: 400 });
  }

  // Fetch questions with upvote count and whether the current user has upvoted
  const questions = await prisma.question.findMany({
    where: { meetingId },
    include: {
      author: { select: { id: true, name: true, image: true } },
      upvotes: { select: { userId: true } },
      _count: { select: { upvotes: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Transform the data to include computed fields
  const transformed = questions.map((q) => ({
    id: q.id,
    content: q.content,
    authorId: q.authorId,
    meetingId: q.meetingId,
    isAnswered: q.isAnswered,
    isPinned: q.isPinned,
    createdAt: q.createdAt.toISOString(),
    author: q.author,
    upvoteCount: q._count.upvotes,
    // Check if the current user's ID exists in the upvotes array
    hasUpvoted: q.upvotes.some((u) => u.userId === userId),
  }));

  // Sort: pinned first, then by upvote count (descending)
  transformed.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.upvoteCount - a.upvoteCount;
  });

  return NextResponse.json({ questions: transformed });
}

// --- POST /api/questions ---
// Submit a new question to a meeting's Q&A
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = askQuestionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const userId = (session.user as any).id;

  // Verify the user is a participant of this meeting before allowing questions
  const participant = await prisma.participant.findUnique({
    where: {
      userId_meetingId: { userId, meetingId: parsed.data.meetingId },
    },
  });

  if (!participant || participant.status === 'REMOVED') {
    return NextResponse.json({ error: 'Not a participant' }, { status: 403 });
  }

  const question = await prisma.question.create({
    data: {
      content: parsed.data.content,
      authorId: userId,
      meetingId: parsed.data.meetingId,
    },
    include: {
      author: { select: { id: true, name: true, image: true } },
    },
  });

  return NextResponse.json({
    question: {
      ...question,
      upvoteCount: 0,
      hasUpvoted: false,
      createdAt: question.createdAt.toISOString(),
    },
  }, { status: 201 });
}
