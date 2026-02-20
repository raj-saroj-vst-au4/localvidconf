// =============================================================================
// Q&A Handler (Slido-style)
// Real-time question and answer feature with upvoting.
// Key improvements over the Slido reference:
// - Duplicate vote prevention via @@unique([questionId, userId]) constraint
// - Upvote toggle (click again to remove your vote)
// - Pin/unpin for host highlighting
// - Sorted by upvote count for democratic prioritization
//
// All events are broadcast in real-time via Socket.IO for instant updates.
// Data is persisted in MySQL (not Redis with TTL like the reference).
// =============================================================================

import { Socket, Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketUser } from '../middleware/socketAuth';
import { createLogger } from '../utils/logger';
import { checkRateLimit } from '../middleware/rateLimiter';
import { z } from 'zod';

const log = createLogger('QAHandler');

// Input validation schemas
const questionSchema = z.string().min(1).max(1000).trim();
const idSchema = z.string().min(1);

export function registerQAHandlers(
  io: SocketServer,
  socket: Socket,
  prisma: PrismaClient
): void {
  const user = socket.data.user as SocketUser;

  // -------------------------------------------------------------------------
  // ASK QUESTION
  // Any participant can submit a question. It appears for all participants
  // in real-time, sorted by upvote count.
  // -------------------------------------------------------------------------
  socket.on('ask-question', async (data: { content: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'ask-question')) return;

    try {
      const parsed = questionSchema.safeParse(data.content);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid question' });
        return;
      }

      const meetingId = socket.data.meetingId;
      if (!meetingId) return;

      // Create question in database
      const question = await prisma.question.create({
        data: {
          content: parsed.data,
          authorId: user.userId,
          meetingId,
        },
        include: {
          author: { select: { id: true, name: true, image: true } },
        },
      });

      // Broadcast new question to all participants in the meeting
      const payload = {
        id: question.id,
        content: question.content,
        authorId: question.authorId,
        meetingId: question.meetingId,
        isAnswered: false,
        isPinned: false,
        createdAt: question.createdAt.toISOString(),
        author: question.author,
        upvoteCount: 0,
        hasUpvoted: false,
      };

      // Send to everyone in the meeting (including sender for consistency)
      io.to(`meeting:${socket.data.meetingCode}`).emit('new-question', payload);

      // Also broadcast to breakout rooms (Q&A is meeting-wide, not room-specific)
      const breakoutRooms = await prisma.breakoutRoom.findMany({
        where: { meetingId, isActive: true },
        select: { id: true },
      });
      for (const br of breakoutRooms) {
        io.to(`breakout:${br.id}`).emit('new-question', payload);
      }

      log.info('Question asked', {
        meetingCode: socket.data.meetingCode,
        questionId: question.id,
        by: user.email,
      });

      if (callback) callback({ question: payload });
    } catch (err: any) {
      log.error('Error asking question', { error: err.message });
      socket.emit('error', { message: 'Failed to submit question' });
    }
  });

  // -------------------------------------------------------------------------
  // UPVOTE QUESTION (Toggle)
  // Clicking upvote adds a vote. Clicking again removes it.
  // The @@unique([questionId, userId]) constraint prevents duplicates.
  // This is an improvement over the Slido reference which allowed duplicate votes.
  // -------------------------------------------------------------------------
  socket.on('upvote-question', async (data: { questionId: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'upvote-question')) return;

    try {
      const parsed = idSchema.safeParse(data.questionId);
      if (!parsed.success) return;

      const questionId = parsed.data;

      // Check if the user already upvoted this question
      const existingUpvote = await prisma.upvote.findUnique({
        where: {
          questionId_userId: { questionId, userId: user.userId },
        },
      });

      if (existingUpvote) {
        // Already upvoted → remove the upvote (toggle OFF)
        await prisma.upvote.delete({
          where: { id: existingUpvote.id },
        });
      } else {
        // Not upvoted → add the upvote (toggle ON)
        await prisma.upvote.create({
          data: { questionId, userId: user.userId },
        });
      }

      // Get updated upvote count
      const upvoteCount = await prisma.upvote.count({
        where: { questionId },
      });

      // Broadcast updated upvote count to all participants
      const payload = {
        questionId,
        upvoteCount,
        // Each client checks their own hasUpvoted status locally
      };

      io.to(`meeting:${socket.data.meetingCode}`).emit('question-upvoted', payload);

      // Also notify breakout rooms
      const question = await prisma.question.findUnique({
        where: { id: questionId },
        select: { meetingId: true },
      });
      if (question) {
        const breakoutRooms = await prisma.breakoutRoom.findMany({
          where: { meetingId: question.meetingId, isActive: true },
          select: { id: true },
        });
        for (const br of breakoutRooms) {
          io.to(`breakout:${br.id}`).emit('question-upvoted', payload);
        }
      }

      if (callback) callback({ upvoteCount, hasUpvoted: !existingUpvote });
    } catch (err: any) {
      log.error('Error toggling upvote', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // MARK QUESTION AS ANSWERED
  // Host/co-host marks a question as answered.
  // Answered questions are visually distinct in the UI.
  // -------------------------------------------------------------------------
  socket.on('mark-answered', async (data: { questionId: string }) => {
    if (!checkRateLimit(socket, 'upvote-question')) return;

    try {
      // Verify host role
      const hostParticipant = await prisma.participant.findFirst({
        where: {
          id: socket.data.participantId,
          role: { in: ['HOST', 'CO_HOST'] },
        },
      });
      if (!hostParticipant) {
        socket.emit('error', { message: 'Only host can mark questions as answered' });
        return;
      }

      // Toggle the answered status
      const question = await prisma.question.findUnique({
        where: { id: data.questionId },
      });
      if (!question) return;

      const updated = await prisma.question.update({
        where: { id: data.questionId },
        data: { isAnswered: !question.isAnswered },
      });

      // Broadcast to all
      io.to(`meeting:${socket.data.meetingCode}`).emit('question-answered', {
        questionId: data.questionId,
        isAnswered: updated.isAnswered,
      });
    } catch (err: any) {
      log.error('Error marking answered', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // PIN/UNPIN QUESTION
  // Host pins a question to the top of the Q&A list.
  // Pinned questions always appear first, regardless of upvote count.
  // -------------------------------------------------------------------------
  socket.on('pin-question', async (data: { questionId: string }) => {
    try {
      // Verify host role
      const hostParticipant = await prisma.participant.findFirst({
        where: {
          id: socket.data.participantId,
          role: { in: ['HOST', 'CO_HOST'] },
        },
      });
      if (!hostParticipant) {
        socket.emit('error', { message: 'Only host can pin questions' });
        return;
      }

      // Toggle pin status
      const question = await prisma.question.findUnique({
        where: { id: data.questionId },
      });
      if (!question) return;

      const updated = await prisma.question.update({
        where: { id: data.questionId },
        data: { isPinned: !question.isPinned },
      });

      io.to(`meeting:${socket.data.meetingCode}`).emit('question-pinned', {
        questionId: data.questionId,
        isPinned: updated.isPinned,
      });
    } catch (err: any) {
      log.error('Error pinning question', { error: err.message });
    }
  });
}
