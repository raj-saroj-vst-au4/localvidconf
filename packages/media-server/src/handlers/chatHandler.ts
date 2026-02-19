// =============================================================================
// Chat Handler
// In-meeting chat messages. Messages are persisted in MySQL for meeting history.
// Chat works in both the main room and breakout rooms:
// - Main room messages go to everyone in the main meeting
// - Breakout room messages stay within that breakout room
// =============================================================================

import { Socket, Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketUser } from '../middleware/socketAuth';
import { createLogger } from '../utils/logger';
import { checkRateLimit } from '../middleware/rateLimiter';
import { z } from 'zod';

const log = createLogger('ChatHandler');

const messageSchema = z.string().min(1).max(2000).trim();

export function registerChatHandlers(
  io: SocketServer,
  socket: Socket,
  prisma: PrismaClient
): void {
  const user = socket.data.user as SocketUser;

  // -------------------------------------------------------------------------
  // SEND CHAT MESSAGE
  // Sends a message to the current room (main or breakout).
  // Messages are persisted in the database for meeting history.
  // -------------------------------------------------------------------------
  socket.on('send-chat', async (data: { content: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'send-chat')) return;

    try {
      const parsed = messageSchema.safeParse(data.content);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid message' });
        return;
      }

      const meetingId = socket.data.meetingId;
      if (!meetingId) return;

      // Persist the chat message in the database
      const chatMessage = await prisma.chatMessage.create({
        data: {
          content: parsed.data,
          senderEmail: user.email,
          senderName: user.name,
          meetingId,
        },
      });

      const payload = {
        id: chatMessage.id,
        content: chatMessage.content,
        senderEmail: chatMessage.senderEmail,
        senderName: chatMessage.senderName,
        meetingId: chatMessage.meetingId,
        createdAt: chatMessage.createdAt.toISOString(),
      };

      // Determine if the user is in a breakout room or main room
      // Check which socket rooms this socket is in
      const socketRooms = Array.from(socket.rooms);
      const breakoutRoom = socketRooms.find(r => r.startsWith('breakout:'));

      if (breakoutRoom) {
        // In a breakout room: only send to that breakout room
        io.to(breakoutRoom).emit('new-chat', payload);
      } else {
        // In main room: send to all main room participants
        io.to(`meeting:${socket.data.meetingCode}`).emit('new-chat', payload);
      }

      if (callback) callback({ message: payload });
    } catch (err: any) {
      log.error('Error sending chat', { error: err.message });
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // -------------------------------------------------------------------------
  // GET CHAT HISTORY
  // Fetches recent chat messages for the meeting.
  // Called when a participant joins to see missed messages.
  // -------------------------------------------------------------------------
  socket.on('get-chat-history', async (_, callback: Function) => {
    try {
      const meetingId = socket.data.meetingId;
      if (!meetingId) return callback({ messages: [] });

      // Fetch the last 100 messages for this meeting
      const messages = await prisma.chatMessage.findMany({
        where: { meetingId },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });

      callback({
        messages: messages.map((m: any) => ({
          id: m.id,
          content: m.content,
          senderEmail: m.senderEmail,
          senderName: m.senderName,
          meetingId: m.meetingId,
          createdAt: m.createdAt.toISOString(),
        })),
      });
    } catch (err: any) {
      log.error('Error fetching chat history', { error: err.message });
      callback({ messages: [] });
    }
  });
}
