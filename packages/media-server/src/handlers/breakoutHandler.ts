// =============================================================================
// Breakout Room Handler
// Manages breakout room lifecycle: create, assign participants, close.
// Each breakout room gets its own mediasoup Router for isolated media.
//
// Flow:
// 1. Host creates breakout rooms (with names and participant assignments)
// 2. Assigned participants are moved from main room to breakout routers
// 3. Optional timer auto-closes breakout rooms after duration
// 4. Host can broadcast messages to all breakout rooms
// 5. Host closes breakouts → everyone returns to main room
// =============================================================================

import { Socket, Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { types as mediasoupTypes } from 'mediasoup';
import { Room } from '../services/Room';
import { SocketUser } from '../middleware/socketAuth';
import { createLogger } from '../utils/logger';
import { checkRateLimit } from '../middleware/rateLimiter';
import { z } from 'zod';

const log = createLogger('BreakoutHandler');

// Inline validation schema (avoid cross-package imports for Docker build isolation)
const createBreakoutSchema = z.object({
  rooms: z.array(z.object({
    name: z.string().min(1).max(100).trim(),
    participantIds: z.array(z.string()),
  })).min(1).max(20),
  duration: z.number().min(1).max(120).optional(),
});

export function registerBreakoutHandlers(
  io: SocketServer,
  socket: Socket,
  rooms: Map<string, Room>,
  prisma: PrismaClient,
  getWorker: () => mediasoupTypes.Worker
): void {
  const user = socket.data.user as SocketUser;

  // -------------------------------------------------------------------------
  // CREATE BREAKOUT ROOMS
  // Host creates multiple breakout rooms with participant assignments.
  // Each room gets its own mediasoup router for media isolation.
  // -------------------------------------------------------------------------
  socket.on('create-breakout', async (
    data: {
      rooms: Array<{ name: string; participantIds: string[] }>;
      duration?: number; // Minutes until auto-close
    },
    callback?: Function
  ) => {
    if (!checkRateLimit(socket, 'lobby-admit')) return; // Reuse admin rate limit

    try {
      // Verify host role
      const hostParticipant = await prisma.participant.findFirst({
        where: {
          id: socket.data.participantId,
          role: { in: ['HOST', 'CO_HOST'] },
        },
      });
      if (!hostParticipant) {
        socket.emit('error', { message: 'Only host can create breakout rooms' });
        return;
      }

      // Validate input
      const parsed = createBreakoutSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid breakout room configuration' });
        return;
      }

      const meetingCode = socket.data.meetingCode;
      const room = rooms.get(meetingCode);
      if (!room) return;

      const worker = getWorker();
      const endsAt = data.duration
        ? new Date(Date.now() + data.duration * 60 * 1000)
        : null;

      // Create breakout rooms in database and mediasoup
      const createdRooms = [];
      for (const roomConfig of parsed.data.rooms) {
        // Create database record
        const breakoutRoom = await prisma.breakoutRoom.create({
          data: {
            name: roomConfig.name,
            meetingId: socket.data.meetingId,
            endsAt,
          },
        });

        // Create mediasoup router for this breakout room
        await room.createBreakoutRouter(breakoutRoom.id, worker);

        // Assign participants to this breakout room in the database
        for (const participantId of roomConfig.participantIds) {
          await prisma.participant.update({
            where: { id: participantId },
            data: {
              status: 'IN_BREAKOUT',
              breakoutRoomId: breakoutRoom.id,
            },
          });
        }

        createdRooms.push({
          id: breakoutRoom.id,
          name: breakoutRoom.name,
          participantIds: roomConfig.participantIds,
          endsAt: endsAt?.toISOString() || null,
        });
      }

      // Move peers in the media server
      for (const createdRoom of createdRooms) {
        for (const participantId of createdRoom.participantIds) {
          // Find the socket for this participant
          for (const [socketId, peer] of room.getPeers()) {
            if (peer.participantId === participantId) {
              // Move peer to breakout router
              room.movePeerToBreakout(socketId, createdRoom.id);

              const targetSocket = io.sockets.sockets.get(socketId);
              if (targetSocket) {
                // Leave main meeting room, join breakout socket room
                targetSocket.leave(`meeting:${meetingCode}`);
                targetSocket.join(`breakout:${createdRoom.id}`);

                // Tell the peer which breakout room they're in
                // They'll need to re-create transports on the breakout router
                targetSocket.emit('breakout-joined', {
                  breakoutRoom: createdRoom,
                  routerCapabilities: room.getBreakoutRouter(createdRoom.id)?.rtpCapabilities,
                });
              }
              break;
            }
          }
        }
      }

      // Notify all participants about the breakout rooms
      io.to(`meeting:${meetingCode}`).emit('breakout-created', {
        rooms: createdRooms,
      });

      // Set up auto-close timer if duration was specified
      if (data.duration) {
        setTimeout(async () => {
          // Auto-close breakout rooms when timer expires
          await closeBreakoutRooms(io, socket, room, meetingCode, prisma);
        }, data.duration * 60 * 1000);

        log.info('Breakout timer set', {
          meetingCode,
          duration: data.duration,
          endsAt: endsAt?.toISOString(),
        });
      }

      log.info('Breakout rooms created', {
        meetingCode,
        roomCount: createdRooms.length,
        createdBy: user.email,
      });

      if (callback) callback({ rooms: createdRooms });
    } catch (err: any) {
      log.error('Error creating breakout rooms', { error: err.message });
      socket.emit('error', { message: 'Failed to create breakout rooms' });
    }
  });

  // -------------------------------------------------------------------------
  // BROADCAST TO ALL BREAKOUT ROOMS
  // Host sends a message that appears in all breakout rooms.
  // -------------------------------------------------------------------------
  socket.on('broadcast-to-breakouts', async (data: { message: string }) => {
    try {
      const hostParticipant = await prisma.participant.findFirst({
        where: {
          id: socket.data.participantId,
          role: { in: ['HOST', 'CO_HOST'] },
        },
      });
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;
      const room = rooms.get(meetingCode);
      if (!room) return;

      // Get all breakout room IDs for this meeting
      const breakoutRooms = await prisma.breakoutRoom.findMany({
        where: { meetingId: socket.data.meetingId, isActive: true },
      });

      // Broadcast to each breakout socket room
      for (const br of breakoutRooms) {
        io.to(`breakout:${br.id}`).emit('breakout-broadcast', {
          message: data.message,
          from: user.name,
        });
      }

      log.info('Broadcast to breakouts', { meetingCode, message: data.message });
    } catch (err: any) {
      log.error('Error broadcasting', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // CLOSE ALL BREAKOUT ROOMS
  // Host ends breakout session. Everyone returns to the main room.
  // -------------------------------------------------------------------------
  socket.on('close-breakouts', async (_, callback?: Function) => {
    try {
      const hostParticipant = await prisma.participant.findFirst({
        where: {
          id: socket.data.participantId,
          role: { in: ['HOST', 'CO_HOST'] },
        },
      });
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;
      const room = rooms.get(meetingCode);
      if (!room) return;

      await closeBreakoutRooms(io, socket, room, meetingCode, prisma);

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error closing breakouts', { error: err.message });
    }
  });
}

/**
 * Helper: close all breakout rooms and return everyone to the main room.
 * Used by both the manual close event and the auto-close timer.
 */
async function closeBreakoutRooms(
  io: SocketServer,
  socket: Socket,
  room: Room,
  meetingCode: string,
  prisma: PrismaClient
): Promise<void> {
  // Close all breakout rooms in the database
  await prisma.breakoutRoom.updateMany({
    where: { meetingId: socket.data.meetingId, isActive: true },
    data: { isActive: false },
  });

  // Update all participants back to IN_MEETING
  await prisma.participant.updateMany({
    where: {
      meetingId: socket.data.meetingId,
      status: 'IN_BREAKOUT',
    },
    data: {
      status: 'IN_MEETING',
      breakoutRoomId: null,
    },
  });

  // Get all breakout room IDs before closing
  const breakoutRoomIds = Array.from(
    (room as any).breakoutRouters?.keys?.() || []
  );

  // Move all peers back to main room in mediasoup
  const movedSocketIds = room.closeAllBreakouts();

  // Move sockets: leave breakout rooms, join main meeting room
  for (const socketId of movedSocketIds) {
    const peerSocket = io.sockets.sockets.get(socketId);
    if (peerSocket) {
      // Leave all breakout socket rooms
      for (const brId of breakoutRoomIds) {
        peerSocket.leave(`breakout:${brId}`);
      }
      // Rejoin main meeting
      peerSocket.join(`meeting:${meetingCode}`);
      // Tell peer to re-create transports on the main router
      peerSocket.emit('breakout-ended', {
        routerCapabilities: room.getRouterCapabilities(),
      });
    }
  }

  // Notify everyone
  io.to(`meeting:${meetingCode}`).emit('breakout-closed');

  log.info('All breakout rooms closed', { meetingCode });
}
