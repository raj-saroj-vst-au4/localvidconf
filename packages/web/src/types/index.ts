// =============================================================================
// Shared TypeScript types for the Meet Clone frontend
// These types mirror the Prisma models but are used on the client side
// where Prisma types aren't available (e.g., in components and hooks)
// =============================================================================

import type { types as mediasoupTypes } from 'mediasoup-client';

// --- Meeting Types ---

export type MeetingStatus = 'SCHEDULED' | 'LIVE' | 'ENDED';
export type ParticipantRole = 'HOST' | 'CO_HOST' | 'PARTICIPANT';
export type ParticipantStatus = 'IN_LOBBY' | 'IN_MEETING' | 'IN_BREAKOUT' | 'REMOVED';

export interface Meeting {
  id: string;
  title: string;
  description: string | null;
  code: string;
  hostId: string;
  status: MeetingStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lobbyEnabled: boolean;
  createdAt: string;
}

export interface Participant {
  id: string;
  userId: string;
  meetingId: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  breakoutRoomId: string | null;
  joinedAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    image: string | null;
  };
}

// --- Breakout Room Types ---

export interface BreakoutRoom {
  id: string;
  name: string;
  meetingId: string;
  isActive: boolean;
  endsAt: string | null;
  participants: Participant[];
}

// --- Q&A Types (Slido-style) ---

export interface Question {
  id: string;
  content: string;
  authorId: string;
  meetingId: string;
  isAnswered: boolean;
  isPinned: boolean;
  createdAt: string;
  upvoteCount: number;        // Computed count of upvotes
  hasUpvoted: boolean;        // Whether the current user has upvoted
  author: {
    id: string;
    name: string;
    image: string | null;
  };
}

// --- Chat Types ---

export interface ChatMessage {
  id: string;
  content: string;
  senderEmail: string;
  senderName: string;
  meetingId: string;
  createdAt: string;
}

// --- Media Types ---
// Represents a remote peer's media streams in the meeting

export interface PeerMedia {
  peerId: string;           // Socket ID of the peer
  participantId: string;    // Database participant ID
  userName: string;
  userImage: string | null;
  // Each peer can have up to 3 producers: audio, video, screen
  consumers: Map<string, mediasoupTypes.Consumer>;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
}

// --- Socket Event Payloads ---
// Type-safe payloads for all socket events

export interface JoinMeetingPayload {
  meetingCode: string;
  token: string;
}

export interface TransportOptions {
  id: string;
  iceParameters: mediasoupTypes.IceParameters;
  iceCandidates: mediasoupTypes.IceCandidate[];
  dtlsParameters: mediasoupTypes.DtlsParameters;
}

export interface ProducePayload {
  transportId: string;
  kind: mediasoupTypes.MediaKind;
  rtpParameters: mediasoupTypes.RtpParameters;
  appData: { type: 'audio' | 'video' | 'screen' };
}

export interface ConsumePayload {
  id: string;
  producerId: string;
  kind: mediasoupTypes.MediaKind;
  rtpParameters: mediasoupTypes.RtpParameters;
}

// --- Breakout Room Creation Payload ---

export interface CreateBreakoutPayload {
  rooms: Array<{
    name: string;
    participantIds: string[];
  }>;
  duration?: number; // Minutes until auto-close
}

// --- Invitation ---

export interface Invitation {
  id: string;
  email: string;
  meetingId: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  sentAt: string;
}
