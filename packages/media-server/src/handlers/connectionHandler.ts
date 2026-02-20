// =============================================================================
// Connection Handler
// Manages socket connection lifecycle: join meeting, disconnect, reconnect.
// When a user joins:
// 1. Validates the meeting exists and is accessible
// 2. Creates/updates participant record in the database
// 3. Checks lobby status (hold in lobby vs. direct admit)
// 4. Creates a Peer instance and adds to the Room
// 5. Notifies existing participants of the new join
// =============================================================================

import { Socket, Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { Room } from '../services/Room';
import { Peer } from '../services/Peer';
import { SocketUser } from '../middleware/socketAuth';
import { createLogger } from '../utils/logger';
import { cleanupRateLimitCounters } from '../middleware/rateLimiter';

const log = createLogger('ConnectionHandler');

/**
 * Register connection-related event handlers on a socket.
 *
 * @param io - Socket.IO server instance (for broadcasting)
 * @param socket - The connected socket
 * @param rooms - Global room map (meetingCode → Room)
 * @param prisma - Prisma client for database operations
 * @param getOrCreateRoom - Function to get/create a Room with a mediasoup Router
 */
export function registerConnectionHandlers(
  io: SocketServer,
  socket: Socket,
  rooms: Map<string, Room>,
  prisma: PrismaClient,
  getOrCreateRoom: (meetingId: string, meetingCode: string) => Promise<Room>
): void {
  const user = socket.data.user as SocketUser;

  // -------------------------------------------------------------------------
  // JOIN MEETING
  // Client sends: { meetingCode: 'abc-defg-hij' }
  // Server responds: 'meeting-joined' or 'lobby-waiting'
  // -------------------------------------------------------------------------
  socket.on('join-meeting', async (data: { meetingCode: string }, callback?: Function) => {
    try {
      const { meetingCode } = data;

      // 1. Verify the meeting exists
      const meeting = await prisma.meeting.findUnique({
        where: { code: meetingCode },
        include: {
          participants: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true } },
            },
            where: { status: { not: 'REMOVED' } },
          },
        },
      });

      if (!meeting) {
        socket.emit('error', { message: 'Meeting not found' });
        return;
      }

      // 2. Check if the meeting has ended
      if (meeting.status === 'ENDED') {
        socket.emit('error', { message: 'This meeting has ended' });
        return;
      }

      // 3. Create or update participant record
      // Upsert: if they were a participant before (e.g., reconnecting), update their status
      // First check if participant already exists and was admitted
      const existingParticipant = await prisma.participant.findUnique({
        where: {
          userId_meetingId: { userId: user.userId, meetingId: meeting.id },
        },
      });

      // Don't reset an already-admitted participant back to lobby
      const shouldLobby = meeting.lobbyEnabled && meeting.hostId !== user.userId
        && (!existingParticipant || existingParticipant.status === 'IN_LOBBY');

      const participant = await prisma.participant.upsert({
        where: {
          userId_meetingId: { userId: user.userId, meetingId: meeting.id },
        },
        update: {
          status: shouldLobby ? 'IN_LOBBY' : 'IN_MEETING',
          leftAt: null,
        },
        create: {
          userId: user.userId,
          meetingId: meeting.id,
          role: meeting.hostId === user.userId ? 'HOST' : 'PARTICIPANT',
          status: meeting.lobbyEnabled && meeting.hostId !== user.userId
            ? 'IN_LOBBY'
            : 'IN_MEETING',
        },
      });

      // 4. If lobby is enabled and user is not the host, hold them in lobby
      if (participant.status === 'IN_LOBBY') {
        // Join a lobby-specific socket room for lobby events
        socket.join(`lobby:${meetingCode}`);

        // Store meeting context on socket for later use
        socket.data.meetingCode = meetingCode;
        socket.data.meetingId = meeting.id;
        socket.data.participantId = participant.id;

        socket.emit('lobby-waiting', { meetingTitle: meeting.title });

        // Notify the host that someone is waiting in the lobby
        io.to(`meeting:${meetingCode}`).emit('lobby-participant', {
          participantId: participant.id,
          userId: user.userId,
          name: user.name,
          email: user.email,
          image: user.image,
        });

        log.info('User waiting in lobby', {
          meetingCode,
          userId: user.userId,
          userName: user.name,
        });
        return;
      }

      // 5. User is admitted (no lobby or host) - add to the meeting room
      await joinMeetingRoom(io, socket, rooms, prisma, meeting, participant, user, getOrCreateRoom);

      // Call the acknowledgment callback if provided
      if (callback) callback({ success: true });

    } catch (err: any) {
      log.error('Error joining meeting', { error: err.message, socketId: socket.id });
      socket.emit('error', { message: 'Failed to join meeting' });
    }
  });

  // -------------------------------------------------------------------------
  // DISCONNECT
  // Clean up peer, update participant status, notify remaining peers
  // -------------------------------------------------------------------------
  socket.on('disconnect', async (reason: string) => {
    log.info('Socket disconnected', {
      socketId: socket.id,
      userId: user.userId,
      reason,
    });

    const meetingCode = socket.data.meetingCode as string;
    if (!meetingCode) return;

    const room = rooms.get(meetingCode);
    if (room) {
      // Remove peer from room (closes transports/producers/consumers)
      const peer = room.removePeer(socket.id);

      if (peer) {
        // Notify remaining peers that this user left
        io.to(`meeting:${meetingCode}`).emit('participant-left', {
          participantId: peer.participantId,
          socketId: socket.id,
        });

        // Notify about closed producers so peers remove the video tiles
        for (const [producerId] of peer.getProducers()) {
          io.to(`meeting:${meetingCode}`).emit('producer-closed', { producerId, peerId: socket.id });
        }
      }

      // If room is empty, clean it up
      if (room.isEmpty()) {
        room.close();
        rooms.delete(meetingCode);
        log.info('Room closed (empty)', { meetingCode });
      }
    }

    // Update participant status in database
    if (socket.data.participantId) {
      await prisma.participant.update({
        where: { id: socket.data.participantId },
        data: { leftAt: new Date() },
      }).catch(() => {}); // Non-critical, don't crash on DB errors
    }

    // Clean up rate limit counters to prevent memory leaks
    cleanupRateLimitCounters(socket.id);
  });
}

/**
 * Internal helper: actually join the meeting room.
 * Creates the Room if it doesn't exist, creates a Peer, and notifies everyone.
 */
export async function joinMeetingRoom(
  io: SocketServer,
  socket: Socket,
  rooms: Map<string, Room>,
  prisma: PrismaClient,
  meeting: any,
  participant: any,
  user: SocketUser,
  getOrCreateRoom: (meetingId: string, meetingCode: string) => Promise<Room>
): Promise<void> {
  // Get or create the mediasoup Room
  const room = await getOrCreateRoom(meeting.id, meeting.code);

  // Create a Peer instance for this user
  const peer = new Peer(
    socket.id,
    participant.id,
    user.userId,
    user.name,
    user.email,
    user.image
  );
  room.addPeer(peer);

  // Join the Socket.IO room for broadcasting
  socket.join(`meeting:${meeting.code}`);

  // Store context on the socket for other handlers
  socket.data.meetingCode = meeting.code;
  socket.data.meetingId = meeting.id;
  socket.data.participantId = participant.id;

  // Update meeting status to LIVE if it's still SCHEDULED
  if (meeting.status === 'SCHEDULED') {
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: { status: 'LIVE', startedAt: new Date() },
    });
  }

  // Collect existing producers to send to the new peer
  // This lets the new peer create consumers for everyone already in the room
  const existingProducers: any[] = [];
  for (const [socketId, existingPeer] of room.getPeers()) {
    if (socketId === socket.id) continue; // Skip self
    for (const [producerId, producer] of existingPeer.getProducers()) {
      existingProducers.push({
        peerId: socketId,
        participantId: existingPeer.participantId,
        producerId,
        kind: producer.kind,
        appData: producer.appData,
        userName: existingPeer.userName,
        userImage: existingPeer.userImage,
      });
    }
  }

  // Only send participants who currently have an active peer connection.
  // meeting.participants may include users who previously joined but left
  // (their status stays IN_MEETING but leftAt is set on disconnect).
  const activePeerUserIds = new Set(
    Array.from(room.getPeers().values()).map((p) => p.userId)
  );

  // Send meeting info and router capabilities to the new peer
  socket.emit('meeting-joined', {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      code: meeting.code,
      hostId: meeting.hostId,
      lobbyEnabled: meeting.lobbyEnabled,
    },
    participants: (meeting.participants ?? []).filter((p: any) => activePeerUserIds.has(p.userId)),
    routerCapabilities: room.getRouterCapabilities(),
    existingProducers,
  });

  // Notify existing peers about the new participant
  socket.to(`meeting:${meeting.code}`).emit('participant-joined', {
    participantId: participant.id,
    userId: user.userId,
    name: user.name,
    email: user.email,
    image: user.image,
    socketId: socket.id,
  });
}
