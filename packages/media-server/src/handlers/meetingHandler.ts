// =============================================================================
// Meeting Handler
// Host control events: lobby management, host transfer, kick, invite.
// All admin actions verify the requester is HOST or CO_HOST before proceeding.
//
// Security: Every handler checks the participant's role in the database
// to prevent privilege escalation (e.g., a participant pretending to be host).
// =============================================================================

import { Socket, Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { Room } from '../services/Room';
import { Peer } from '../services/Peer';
import { SocketUser } from '../middleware/socketAuth';
import { joinMeetingRoom } from './connectionHandler';
import { createLogger } from '../utils/logger';
import { checkRateLimit } from '../middleware/rateLimiter';
import { z } from 'zod';
import { sendMail, escapeHtml } from '../utils/mailer';

const log = createLogger('MeetingHandler');

// Validation schemas for admin actions
const emailSchema = z.string().email().max(320);
const idSchema = z.string().cuid();

// Allowlist of reactions clients may broadcast (emoji or short names).
const ALLOWED_REACTIONS = new Set<string>([
  '👍', '❤️', '😂', '😮', '🎉', '👏',
  'thumbsup', 'heart', 'laugh', 'wow', 'tada', 'clap',
]);

/**
 * Helper: verify the socket user is HOST or CO_HOST of their current meeting.
 * Returns the participant record if authorized, null otherwise.
 */
async function verifyHostRole(
  socket: Socket,
  prisma: PrismaClient
): Promise<any | null> {
  const participant = await prisma.participant.findFirst({
    where: {
      id: socket.data.participantId,
      role: { in: ['HOST', 'CO_HOST'] },
    },
  });
  if (!participant) {
    socket.emit('error', { message: 'Only host or co-host can perform this action' });
  }
  return participant;
}

export function registerMeetingHandlers(
  io: SocketServer,
  socket: Socket,
  rooms: Map<string, Room>,
  prisma: PrismaClient,
  getOrCreateRoom: (meetingId: string, meetingCode: string) => Promise<Room>
): void {
  const user = socket.data.user as SocketUser;

  // -------------------------------------------------------------------------
  // LOBBY ADMIT
  // Host admits a participant from the lobby into the meeting.
  // The participant's status changes from IN_LOBBY to IN_MEETING.
  // -------------------------------------------------------------------------
  socket.on('lobby-admit', async (data: { participantId: string }) => {
    if (!checkRateLimit(socket, 'lobby-admit')) return;

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;

      // Authz: the target must belong to THIS host's meeting (prevent cross-meeting IDOR)
      if (!idSchema.safeParse(data.participantId).success) return;
      const inThisMeeting = await prisma.participant.findFirst({
        where: { id: data.participantId, meetingId: socket.data.meetingId },
        select: { id: true },
      });
      if (!inThisMeeting) {
        socket.emit('error', { message: 'Participant is not in this meeting' });
        return;
      }

      // Update participant status in database
      const admitted = await prisma.participant.update({
        where: { id: data.participantId },
        data: { status: 'IN_MEETING' },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          meeting: true,
        },
      });

      // Find the waiting participant's socket in the lobby room
      const lobbyRoom = io.sockets.adapter.rooms.get(`lobby:${meetingCode}`);
      if (lobbyRoom) {
        for (const socketId of lobbyRoom) {
          const lobbySocket = io.sockets.sockets.get(socketId);
          if (lobbySocket && lobbySocket.data.participantId === data.participantId) {
            // Move from lobby to meeting
            lobbySocket.leave(`lobby:${meetingCode}`);

            // Join the actual meeting room
            await joinMeetingRoom(
              io, lobbySocket, rooms, prisma,
              admitted.meeting, admitted, lobbySocket.data.user,
              getOrCreateRoom
            );

            // Tell the admitted user they're in
            lobbySocket.emit('admitted', {
              meeting: admitted.meeting,
            });
            break;
          }
        }
      }

      log.info('Participant admitted from lobby', {
        meetingCode,
        participantId: data.participantId,
        admittedBy: user.email,
      });
    } catch (err: any) {
      log.error('Error admitting from lobby', { error: err.message });
      socket.emit('error', { message: 'Failed to admit participant' });
    }
  });

  // -------------------------------------------------------------------------
  // LOBBY REJECT
  // Host denies entry to a lobby participant.
  // -------------------------------------------------------------------------
  socket.on('lobby-reject', async (data: { participantId: string }) => {
    if (!checkRateLimit(socket, 'lobby-reject')) return;

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;

      // Authz: scope to this host's meeting (prevent cross-meeting IDOR)
      if (!idSchema.safeParse(data.participantId).success) return;
      const rejected = await prisma.participant.updateMany({
        where: { id: data.participantId, meetingId: socket.data.meetingId },
        data: { status: 'REMOVED' },
      });
      if (rejected.count === 0) {
        socket.emit('error', { message: 'Participant is not in this meeting' });
        return;
      }

      // Find and notify the rejected participant
      const lobbyRoom = io.sockets.adapter.rooms.get(`lobby:${meetingCode}`);
      if (lobbyRoom) {
        for (const socketId of lobbyRoom) {
          const lobbySocket = io.sockets.sockets.get(socketId);
          if (lobbySocket && lobbySocket.data.participantId === data.participantId) {
            lobbySocket.emit('lobby-rejected');
            lobbySocket.leave(`lobby:${meetingCode}`);
            break;
          }
        }
      }
    } catch (err: any) {
      log.error('Error rejecting from lobby', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // MOVE TO LOBBY
  // Host moves an active participant back to the lobby.
  // Their media is disconnected and they see the lobby waiting screen.
  // -------------------------------------------------------------------------
  socket.on('move-to-lobby', async (data: { participantId: string }) => {
    if (!checkRateLimit(socket, 'move-to-lobby')) return;

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;
      const room = rooms.get(meetingCode);

      // Find the target participant, scoped to this meeting (prevent cross-meeting IDOR)
      if (!idSchema.safeParse(data.participantId).success) return;
      const targetParticipant = await prisma.participant.findFirst({
        where: { id: data.participantId, meetingId: socket.data.meetingId },
        include: { user: true },
      });

      if (!targetParticipant) {
        socket.emit('error', { message: 'Participant is not in this meeting' });
        return;
      }

      // Prevent moving the host to lobby (host can't move themselves)
      if (targetParticipant.role === 'HOST') {
        socket.emit('error', { message: 'Cannot move the host to lobby' });
        return;
      }

      // Update status in database
      await prisma.participant.update({
        where: { id: data.participantId },
        data: { status: 'IN_LOBBY' },
      });

      // Find and disconnect the target's socket from the meeting
      if (room) {
        for (const [socketId, peer] of room.getPeers()) {
          if (peer.participantId === data.participantId) {
            // Remove from meeting room
            room.removePeer(socketId);

            const targetSocket = io.sockets.sockets.get(socketId);
            if (targetSocket) {
              // Move socket to lobby room
              targetSocket.leave(`meeting:${meetingCode}`);
              targetSocket.join(`lobby:${meetingCode}`);
              targetSocket.emit('moved-to-lobby');

              // Notify remaining peers
              io.to(`meeting:${meetingCode}`).emit('participant-left', {
                participantId: data.participantId,
                socketId,
              });

              // Notify remaining peers about closed producers
              for (const [producerId] of peer.getProducers()) {
                io.to(`meeting:${meetingCode}`).emit('producer-closed', { producerId });
              }
            }
            break;
          }
        }
      }

      log.info('Participant moved to lobby', {
        meetingCode,
        participantId: data.participantId,
        movedBy: user.email,
      });
    } catch (err: any) {
      log.error('Error moving to lobby', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // TRANSFER HOST
  // Current host transfers their host role to another participant.
  // The old host becomes a regular PARTICIPANT.
  // Only the HOST can transfer (not CO_HOST).
  // -------------------------------------------------------------------------
  socket.on('transfer-host', async (data: { newHostId: string }) => {
    if (!checkRateLimit(socket, 'transfer-host')) return;

    try {
      // Verify the requester is specifically the HOST (not co-host)
      const currentHost = await prisma.participant.findFirst({
        where: {
          id: socket.data.participantId,
          role: 'HOST',
        },
      });

      if (!currentHost) {
        socket.emit('error', { message: 'Only the current host can transfer host role' });
        return;
      }

      const meetingCode = socket.data.meetingCode;

      // Authz: the new host must be a participant of THIS meeting (prevent cross-meeting host hijack)
      if (!idSchema.safeParse(data.newHostId).success) return;
      const newHost = await prisma.participant.findFirst({
        where: { id: data.newHostId, meetingId: socket.data.meetingId },
      });
      if (!newHost) {
        socket.emit('error', { message: 'New host is not in this meeting' });
        return;
      }

      // Update roles in a transaction for atomicity
      await prisma.$transaction([
        // Demote current host to participant
        prisma.participant.update({
          where: { id: currentHost.id },
          data: { role: 'PARTICIPANT' },
        }),
        // Promote new host
        prisma.participant.update({
          where: { id: newHost.id },
          data: { role: 'HOST' },
        }),
        // Update the meeting's hostId
        prisma.meeting.update({
          where: { id: socket.data.meetingId },
          data: { hostId: newHost.userId },
        }),
      ]);

      // Notify all peers about the host change
      io.to(`meeting:${meetingCode}`).emit('host-changed', {
        newHostId: data.newHostId,
        oldHostId: currentHost.id,
      });

      log.info('Host transferred', {
        meetingCode,
        from: currentHost.id,
        to: data.newHostId,
      });
    } catch (err: any) {
      log.error('Error transferring host', { error: err.message });
      socket.emit('error', { message: 'Failed to transfer host role' });
    }
  });

  // -------------------------------------------------------------------------
  // KICK PARTICIPANT
  // Host removes a participant from the meeting entirely.
  // -------------------------------------------------------------------------
  socket.on('kick-participant', async (data: { participantId: string }) => {
    if (!checkRateLimit(socket, 'kick-participant')) return;

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;
      const room = rooms.get(meetingCode);

      // Find target scoped to this meeting (prevent cross-meeting IDOR)
      if (!idSchema.safeParse(data.participantId).success) return;
      const target = await prisma.participant.findFirst({
        where: { id: data.participantId, meetingId: socket.data.meetingId },
      });
      if (!target) {
        socket.emit('error', { message: 'Participant is not in this meeting' });
        return;
      }
      // Prevent kicking the host
      if (target.role === 'HOST') {
        socket.emit('error', { message: 'Cannot kick the host' });
        return;
      }

      // Update status in database
      await prisma.participant.update({
        where: { id: data.participantId },
        data: { status: 'REMOVED', leftAt: new Date() },
      });

      // Disconnect the kicked participant's socket
      if (room) {
        for (const [socketId, peer] of room.getPeers()) {
          if (peer.participantId === data.participantId) {
            room.removePeer(socketId);

            const targetSocket = io.sockets.sockets.get(socketId);
            if (targetSocket) {
              targetSocket.emit('kicked');
              targetSocket.leave(`meeting:${meetingCode}`);
              targetSocket.disconnect();
            }

            // Notify remaining peers
            io.to(`meeting:${meetingCode}`).emit('participant-left', {
              participantId: data.participantId,
              socketId,
              kicked: true,
            });

            for (const [producerId] of peer.getProducers()) {
              io.to(`meeting:${meetingCode}`).emit('producer-closed', { producerId });
            }
            break;
          }
        }
      }

      log.info('Participant kicked', {
        meetingCode,
        participantId: data.participantId,
        kickedBy: user.email,
      });
    } catch (err: any) {
      log.error('Error kicking participant', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // INVITE PARTICIPANT
  // Host sends an email invitation to join the meeting on-the-fly.
  // -------------------------------------------------------------------------
  socket.on('invite-participant', async (data: { email: string }) => {
    if (!checkRateLimit(socket, 'invite-participant')) return;

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) return;

      // Validate email
      const result = emailSchema.safeParse(data.email);
      if (!result.success) {
        socket.emit('error', { message: 'Invalid email address' });
        return;
      }

      const meetingCode = socket.data.meetingCode;
      const meeting = await prisma.meeting.findUnique({
        where: { id: socket.data.meetingId },
      });

      if (!meeting) return;

      // Create invitation record
      await prisma.invitation.create({
        data: {
          email: data.email,
          meetingId: meeting.id,
          invitedById: user.userId,
        },
      });

      // Send invitation email via the shared pooled transporter.
      // Escape user-controlled values to prevent HTML/email injection.
      const joinUrl = `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/meeting/${meetingCode}`;
      const safeInviterName = escapeHtml(user.name);
      const safeMeetingTitle = escapeHtml(meeting.title);

      await sendMail({
        to: data.email,
        subject: `${user.name} invited you to: ${meeting.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2196f3;">You're invited to join a meeting</h2>
            <p><strong>${safeInviterName}</strong> has invited you to join:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin: 0 0 10px;">${safeMeetingTitle}</h3>
              <p style="margin: 0; color: #666;">Meeting Code: <strong>${meetingCode}</strong></p>
            </div>
            <a href="${joinUrl}"
               style="display: inline-block; background: #2196f3; color: white; padding: 12px 24px;
                      border-radius: 6px; text-decoration: none; font-weight: bold;">
              Join Meeting
            </a>
          </div>
        `,
      });

      socket.emit('invite-sent', { email: data.email });

      log.info('Invitation sent', {
        meetingCode,
        invitedEmail: data.email,
        invitedBy: user.email,
      });
    } catch (err: any) {
      log.error('Error sending invitation', { error: err.message });
      socket.emit('error', { message: 'Failed to send invitation' });
    }
  });

  // -------------------------------------------------------------------------
  // MUTE ALL
  // Host asks all participants (except the host) to pause their microphone.
  // -------------------------------------------------------------------------
  socket.on('mute-all', async (_: unknown, callback?: Function) => {
    if (!checkRateLimit(socket, 'mute-all')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) {
        if (callback) callback({ error: 'Not authorized' });
        return;
      }

      const meetingCode = socket.data.meetingCode;

      // Broadcast to everyone in the meeting except the host's own socket.
      socket.to(`meeting:${meetingCode}`).emit('force-mute', {});

      log.info('Mute-all issued', { meetingCode, by: user.email });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error muting all', { error: err.message });
      if (callback) callback({ error: 'Failed to mute all' });
    }
  });

  // -------------------------------------------------------------------------
  // MUTE PARTICIPANT
  // Host asks a single participant to pause their microphone.
  // -------------------------------------------------------------------------
  socket.on('mute-participant', async (data: { participantId: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'mute-participant')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) {
        if (callback) callback({ error: 'Not authorized' });
        return;
      }

      if (!idSchema.safeParse(data.participantId).success) {
        if (callback) callback({ error: 'Invalid participant' });
        return;
      }

      const meetingCode = socket.data.meetingCode;

      // Scope to this meeting (prevent cross-meeting IDOR).
      const target = await prisma.participant.findFirst({
        where: { id: data.participantId, meetingId: socket.data.meetingId },
        select: { id: true },
      });
      if (!target) {
        if (callback) callback({ error: 'Participant is not in this meeting' });
        return;
      }

      // Emit force-mute to every socket belonging to that participant.
      const meetingRoom = io.sockets.adapter.rooms.get(`meeting:${meetingCode}`);
      if (meetingRoom) {
        for (const socketId of meetingRoom) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket && targetSocket.data.participantId === data.participantId) {
            targetSocket.emit('force-mute', {});
          }
        }
      }

      log.info('Mute-participant issued', {
        meetingCode,
        participantId: data.participantId,
        by: user.email,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error muting participant', { error: err.message });
      if (callback) callback({ error: 'Failed to mute participant' });
    }
  });

  // -------------------------------------------------------------------------
  // PROMOTE CO-HOST
  // Host promotes a participant to CO_HOST.
  // -------------------------------------------------------------------------
  socket.on('promote-cohost', async (data: { participantId: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'promote-cohost')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) {
        if (callback) callback({ error: 'Not authorized' });
        return;
      }

      if (!idSchema.safeParse(data.participantId).success) {
        if (callback) callback({ error: 'Invalid participant' });
        return;
      }

      const meetingCode = socket.data.meetingCode;

      // Scope to this meeting (prevent cross-meeting IDOR).
      const updated = await prisma.participant.updateMany({
        where: { id: data.participantId, meetingId: socket.data.meetingId, role: 'PARTICIPANT' },
        data: { role: 'CO_HOST' },
      });
      if (updated.count === 0) {
        if (callback) callback({ error: 'Participant cannot be promoted' });
        return;
      }

      io.to(`meeting:${meetingCode}`).emit('participant-role-changed', {
        participantId: data.participantId,
        role: 'CO_HOST',
      });

      log.info('Participant promoted to co-host', {
        meetingCode,
        participantId: data.participantId,
        by: user.email,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error promoting co-host', { error: err.message });
      if (callback) callback({ error: 'Failed to promote co-host' });
    }
  });

  // -------------------------------------------------------------------------
  // DEMOTE CO-HOST
  // Host demotes a co-host back to a regular participant.
  // -------------------------------------------------------------------------
  socket.on('demote-cohost', async (data: { participantId: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'demote-cohost')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) {
        if (callback) callback({ error: 'Not authorized' });
        return;
      }

      if (!idSchema.safeParse(data.participantId).success) {
        if (callback) callback({ error: 'Invalid participant' });
        return;
      }

      const meetingCode = socket.data.meetingCode;

      // Scope to this meeting and only demote co-hosts (never the HOST).
      const updated = await prisma.participant.updateMany({
        where: { id: data.participantId, meetingId: socket.data.meetingId, role: 'CO_HOST' },
        data: { role: 'PARTICIPANT' },
      });
      if (updated.count === 0) {
        if (callback) callback({ error: 'Participant cannot be demoted' });
        return;
      }

      io.to(`meeting:${meetingCode}`).emit('participant-role-changed', {
        participantId: data.participantId,
        role: 'PARTICIPANT',
      });

      log.info('Co-host demoted to participant', {
        meetingCode,
        participantId: data.participantId,
        by: user.email,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error demoting co-host', { error: err.message });
      if (callback) callback({ error: 'Failed to demote co-host' });
    }
  });

  // -------------------------------------------------------------------------
  // SEND REACTION
  // Any participant can broadcast a short-lived emoji reaction.
  // -------------------------------------------------------------------------
  socket.on('send-reaction', async (data: { emoji: string }, callback?: Function) => {
    if (!checkRateLimit(socket, 'send-reaction')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const emoji = typeof data?.emoji === 'string' ? data.emoji : '';
      if (!ALLOWED_REACTIONS.has(emoji)) {
        if (callback) callback({ error: 'Invalid reaction' });
        return;
      }

      const meetingCode = socket.data.meetingCode;

      io.to(`meeting:${meetingCode}`).emit('reaction', {
        participantId: socket.data.participantId,
        userName: user.name,
        emoji,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error sending reaction', { error: err.message });
      if (callback) callback({ error: 'Failed to send reaction' });
    }
  });

  // -------------------------------------------------------------------------
  // RAISE HAND
  // Any participant can raise their hand to request attention.
  // -------------------------------------------------------------------------
  socket.on('raise-hand', async (_: unknown, callback?: Function) => {
    if (!checkRateLimit(socket, 'raise-hand')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const meetingCode = socket.data.meetingCode;

      io.to(`meeting:${meetingCode}`).emit('hand-updated', {
        participantId: socket.data.participantId,
        userName: user.name,
        raised: true,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error raising hand', { error: err.message });
      if (callback) callback({ error: 'Failed to raise hand' });
    }
  });

  // -------------------------------------------------------------------------
  // LOWER HAND
  // Any participant can lower their previously-raised hand.
  // -------------------------------------------------------------------------
  socket.on('lower-hand', async (_: unknown, callback?: Function) => {
    if (!checkRateLimit(socket, 'lower-hand')) {
      if (callback) callback({ error: 'Rate limited' });
      return;
    }

    try {
      const meetingCode = socket.data.meetingCode;

      io.to(`meeting:${meetingCode}`).emit('hand-updated', {
        participantId: socket.data.participantId,
        userName: user.name,
        raised: false,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error lowering hand', { error: err.message });
      if (callback) callback({ error: 'Failed to lower hand' });
    }
  });

  // -------------------------------------------------------------------------
  // END MEETING
  // Host ends the meeting for everyone.
  // -------------------------------------------------------------------------
  socket.on('end-meeting', async () => {
    try {
      const hostParticipant = await verifyHostRole(socket, prisma);
      if (!hostParticipant) return;

      const meetingCode = socket.data.meetingCode;

      // Update meeting status
      await prisma.meeting.update({
        where: { id: socket.data.meetingId },
        data: { status: 'ENDED', endedAt: new Date() },
      });

      // Notify everyone and close the room
      io.to(`meeting:${meetingCode}`).emit('meeting-ended');

      const room = rooms.get(meetingCode);
      if (room) {
        room.close();
        rooms.delete(meetingCode);
      }

      log.info('Meeting ended', { meetingCode, endedBy: user.email });
    } catch (err: any) {
      log.error('Error ending meeting', { error: err.message });
    }
  });
}
