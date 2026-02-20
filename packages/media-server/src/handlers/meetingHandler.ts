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
import nodemailer from 'nodemailer';

const log = createLogger('MeetingHandler');

// Validation schemas for admin actions
const emailSchema = z.string().email().max(320);

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

/**
 * Create SMTP transporter for sending invitation emails.
 */
function createMailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
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

      // Update participant status in database
      // Include meeting.participants so joinMeetingRoom can send the full participant list
      // to the admitted user (same shape as the join-meeting handler's Prisma query).
      const admitted = await prisma.participant.update({
        where: { id: data.participantId },
        data: { status: 'IN_MEETING' },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          meeting: {
            include: {
              participants: {
                include: {
                  user: { select: { id: true, name: true, email: true, image: true } },
                },
                where: { status: { not: 'REMOVED' } },
              },
            },
          },
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

      // Update participant status to REMOVED
      await prisma.participant.update({
        where: { id: data.participantId },
        data: { status: 'REMOVED' },
      });

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

      // Find the target participant's socket
      const targetParticipant = await prisma.participant.findUnique({
        where: { id: data.participantId },
        include: { user: true },
      });

      if (!targetParticipant) return;

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

      // Update roles in a transaction for atomicity
      await prisma.$transaction([
        // Demote current host to participant
        prisma.participant.update({
          where: { id: currentHost.id },
          data: { role: 'PARTICIPANT' },
        }),
        // Promote new host
        prisma.participant.update({
          where: { id: data.newHostId },
          data: { role: 'HOST' },
        }),
        // Update the meeting's hostId
        prisma.meeting.update({
          where: { id: socket.data.meetingId },
          data: {
            hostId: (await prisma.participant.findUnique({
              where: { id: data.newHostId },
            }))?.userId || '',
          },
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

      // Prevent kicking the host
      const target = await prisma.participant.findUnique({
        where: { id: data.participantId },
      });
      if (target?.role === 'HOST') {
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

      // Send invitation email
      const transporter = createMailTransporter();
      const joinUrl = `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/meeting/${meetingCode}`;

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: data.email,
        subject: `${user.name} invited you to: ${meeting.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2196f3;">You're invited to join a meeting</h2>
            <p><strong>${user.name}</strong> has invited you to join:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin: 0 0 10px;">${meeting.title}</h3>
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
