// =============================================================================
// useMeeting Hook
// Orchestrates the entire meeting experience:
// - Socket connection and meeting join flow
// - Lobby waiting state
// - Participant list management
// - Host control actions (admit, kick, transfer, invite)
// - Meeting status (live, ended)
//
// This hook combines useSocket and useMediasoup into a single API
// that the meeting page component consumes.
// =============================================================================

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';
import { useMediasoup } from './useMediasoup';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import type { Meeting, Participant, ParticipantRole } from '@/types';

interface UseMeetingProps {
  meetingCode: string;
  // Gate the actual room join (the `join-meeting` emit + media capture) until the
  // caller is ready — e.g. after the user confirms devices in the pre-join screen.
  // Defaults to true so callers that don't need a pre-join gate are unaffected.
  ready?: boolean;
}

// A transient reaction shown briefly in the UI (auto-expires).
export interface ActiveReaction {
  id: string;            // unique key for React lists
  participantId: string;
  userName: string;
  emoji: string;
}

// How long a reaction stays visible before auto-expiring.
const REACTION_TTL_MS = 4000;

interface UseMeetingReturn {
  // Meeting state
  meeting: Meeting | null;
  participants: Participant[];
  lobbyParticipants: any[];
  isHost: boolean;
  isInLobby: boolean;
  isLoading: boolean;
  error: string | null;

  // Media controls (forwarded from useMediasoup)
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  peers: Map<string, any>;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  toggleAudio: () => void;
  toggleVideo: () => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;

  // Active speaker (forwarded from useMediasoup)
  activeSpeakerParticipantId: string | null;

  // Optional device / quality controls (forwarded from useMediasoup if present)
  audioInputDevices?: MediaDeviceInfo[];
  videoInputDevices?: MediaDeviceInfo[];
  switchCamera?: (deviceId: string) => Promise<void> | void;
  switchMic?: (deviceId: string) => Promise<void> | void;
  connectionQuality?: string;

  // Reactions & raised hands
  reactions: ActiveReaction[];
  raisedHands: Map<string, string>; // participantId -> userName
  sendReaction: (emoji: string) => void;
  raiseHand: () => void;
  lowerHand: () => void;

  // Host control actions
  admitFromLobby: (participantId: string) => void;
  rejectFromLobby: (participantId: string) => void;
  moveToLobby: (participantId: string) => void;
  kickParticipant: (participantId: string) => void;
  transferHost: (participantId: string) => void;
  inviteParticipant: (email: string) => void;
  endMeeting: () => void;
  leaveMeeting: () => void;

  // Moderation actions
  muteAll: () => void;
  muteParticipant: (participantId: string) => void;
  promoteCoHost: (participantId: string) => void;
  demoteCoHost: (participantId: string) => void;
}

export function useMeeting({ meetingCode, ready = true }: UseMeetingProps): UseMeetingReturn {
  const { data: session } = useSession();
  const router = useRouter();
  const { socket, isConnected, error: socketError } = useSocket();
  const mediasoup = useMediasoup({ socket, isConnected });

  // --- Meeting State ---
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [lobbyParticipants, setLobbyParticipants] = useState<any[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [isInLobby, setIsInLobby] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Reactions & raised hands ---
  const [reactions, setReactions] = useState<ActiveReaction[]>([]);
  const [raisedHands, setRaisedHands] = useState<Map<string, string>>(new Map());

  // Keep a live ref to `participants` so socket handlers (registered once) can
  // read the current list without going stale across the effect's lifetime.
  const participantsRef = useRef<Participant[]>(participants);
  participantsRef.current = participants;

  // Track outstanding reaction-expiry timers so we can clear them on unmount.
  const reactionTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Live ref to mediasoup so the (once-registered) force-mute handler reads the
  // current audio state / toggle without a stale closure.
  const mediasoupRef = useRef(mediasoup);
  mediasoupRef.current = mediasoup;

  // -------------------------------------------------------------------------
  // JOIN MEETING FLOW
  // Once socket is connected, emit 'join-meeting' and handle the response
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Do not touch the room until the caller is ready (pre-join confirmed).
    // Without this gate the user joins — and starts producing camera/mic —
    // the instant the socket connects, before clicking "Join now".
    if (!socket || !isConnected || !session || !ready) return;

    // Join the meeting
    socket.emit('join-meeting', { meetingCode });

    // --- Successfully joined the meeting ---
    socket.on('meeting-joined', async (data: any) => {
      setMeeting(data.meeting);
      setParticipants(data.participants);
      setIsHost(data.meeting.hostId === (session.user as any)?.id);
      setIsLoading(false);

      // Initialize mediasoup with the router capabilities
      await mediasoup.initializeMedia(data.routerCapabilities);

      // Consume existing producers from peers already in the room
      for (const producer of data.existingProducers) {
        await mediasoup.consumeProducer(
          producer.producerId,
          producer.peerId,
          producer.participantId,
          producer.userName,
          producer.userImage,
          producer.kind,
          producer.appData
        );
      }
    });

    // --- Waiting in lobby ---
    socket.on('lobby-waiting', (data: { meetingTitle: string }) => {
      setMeeting({ title: data.meetingTitle } as Meeting);
      setIsInLobby(true);
      setIsLoading(false);
    });

    // --- Admitted from lobby ---
    socket.on('admitted', async (data: any) => {
      setIsInLobby(false);
      // Re-emit join to get full meeting data and router capabilities
      socket.emit('join-meeting', { meetingCode });
    });

    // --- New participant joined ---
    // Server payload: { participantId, userId, name, email, image, socketId }.
    // Map it into a proper Participant shape (with `id` and nested `user`) so
    // `participant-left` filtering (by `p.id`) and ParticipantList rendering
    // (which read `p.user.*`) work correctly.
    socket.on('participant-joined', (data: any) => {
      setParticipants((prev) => {
        // Avoid duplicates (same participant row or same user).
        if (prev.some((p) => p.id === data.participantId || p.userId === data.userId)) {
          return prev;
        }
        const participant: Participant = {
          id: data.participantId,
          userId: data.userId,
          meetingId: '',
          role: 'PARTICIPANT',
          status: 'IN_MEETING',
          breakoutRoomId: null,
          joinedAt: new Date().toISOString(),
          user: {
            id: data.userId,
            email: data.email,
            name: data.name,
            image: data.image ?? null,
          },
        };
        return [...prev, participant];
      });
    });

    // --- Participant left ---
    socket.on('participant-left', (data: { participantId: string }) => {
      setParticipants((prev) =>
        prev.filter((p) => p.id !== data.participantId)
      );
    });

    // --- Lobby participant waiting (host only) ---
    socket.on('lobby-participant', (data: any) => {
      setLobbyParticipants((prev) => [...prev, data]);
    });

    // --- Host changed ---
    // `newHostId` is a participant id (matches Participant.id on the server).
    socket.on('host-changed', (data: { newHostId: string }) => {
      setParticipants((prev) =>
        prev.map((p) => ({
          ...p,
          role: p.id === data.newHostId ? ('HOST' as const) : (p.role === 'HOST' ? ('PARTICIPANT' as const) : p.role),
        }))
      );
      // Recompute our own host status from the live participants ref (not the
      // stale closure) so the new host's `isHost` flips correctly.
      const myUserId = (session?.user as any)?.id;
      const myParticipant = participantsRef.current.find((p) => p.userId === myUserId);
      setIsHost(myParticipant?.id === data.newHostId);
    });

    // --- Moved to lobby ---
    socket.on('moved-to-lobby', () => {
      setIsInLobby(true);
    });

    // --- Kicked ---
    socket.on('kicked', () => {
      router.push('/?kicked=true');
    });

    // --- Meeting ended ---
    socket.on('meeting-ended', () => {
      router.push('/?ended=true');
    });

    // --- Emoji reaction (transient) ---
    socket.on('reaction', (data: { participantId: string; userName: string; emoji: string }) => {
      const reaction: ActiveReaction = {
        id: `${data.participantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        participantId: data.participantId,
        userName: data.userName,
        emoji: data.emoji,
      };
      setReactions((prev) => [...prev, reaction]);
      // Auto-expire after the TTL.
      const timer = setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== reaction.id));
        reactionTimersRef.current = reactionTimersRef.current.filter((t) => t !== timer);
      }, REACTION_TTL_MS);
      reactionTimersRef.current.push(timer);
    });

    // --- Raise / lower hand ---
    socket.on('hand-updated', (data: { participantId: string; userName: string; raised: boolean }) => {
      setRaisedHands((prev) => {
        const next = new Map(prev);
        if (data.raised) {
          next.set(data.participantId, data.userName);
        } else {
          next.delete(data.participantId);
        }
        return next;
      });
    });

    // --- Forced mute by host/co-host ---
    socket.on('force-mute', () => {
      // Disable the local mic if it is currently on. toggleAudio() toggles, so
      // only call it when audio is enabled to land on isAudioEnabled=false.
      // Read from the ref to avoid a stale-closure read of isAudioEnabled.
      if (mediasoupRef.current.isAudioEnabled) {
        mediasoupRef.current.toggleAudio();
      }
    });

    // --- Participant role changed (promote/demote co-host) ---
    socket.on('participant-role-changed', (data: { participantId: string; role: ParticipantRole }) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === data.participantId ? { ...p, role: data.role } : p))
      );
    });

    // --- Error ---
    socket.on('error', (data: { message: string }) => {
      setError(data.message);
    });

    return () => {
      socket.off('meeting-joined');
      socket.off('lobby-waiting');
      socket.off('admitted');
      socket.off('participant-joined');
      socket.off('participant-left');
      socket.off('lobby-participant');
      socket.off('host-changed');
      socket.off('moved-to-lobby');
      socket.off('kicked');
      socket.off('meeting-ended');
      socket.off('reaction');
      socket.off('hand-updated');
      socket.off('force-mute');
      socket.off('participant-role-changed');
      socket.off('error');
      // Clear any pending reaction-expiry timers.
      reactionTimersRef.current.forEach((t) => clearTimeout(t));
      reactionTimersRef.current = [];
    };
    // Handlers read live values via refs (participantsRef, mediasoupRef), so
    // they are intentionally omitted from deps — re-running this effect would
    // tear down and re-register the whole join flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, isConnected, session, meetingCode, ready]);

  // -------------------------------------------------------------------------
  // HOST CONTROL ACTIONS
  // These emit socket events to the media server
  // -------------------------------------------------------------------------

  const admitFromLobby = useCallback((participantId: string) => {
    socket?.emit('lobby-admit', { participantId });
    // Remove from lobby list
    setLobbyParticipants((prev) => prev.filter((p) => p.participantId !== participantId));
  }, [socket]);

  const rejectFromLobby = useCallback((participantId: string) => {
    socket?.emit('lobby-reject', { participantId });
    setLobbyParticipants((prev) => prev.filter((p) => p.participantId !== participantId));
  }, [socket]);

  const moveToLobby = useCallback((participantId: string) => {
    socket?.emit('move-to-lobby', { participantId });
  }, [socket]);

  const kickParticipant = useCallback((participantId: string) => {
    socket?.emit('kick-participant', { participantId });
  }, [socket]);

  const transferHost = useCallback((participantId: string) => {
    socket?.emit('transfer-host', { newHostId: participantId });
  }, [socket]);

  const inviteParticipant = useCallback((email: string) => {
    socket?.emit('invite-participant', { email });
  }, [socket]);

  const endMeeting = useCallback(() => {
    socket?.emit('end-meeting');
  }, [socket]);

  const leaveMeeting = useCallback(() => {
    socket?.disconnect();
    router.push('/');
  }, [socket, router]);

  // -------------------------------------------------------------------------
  // REACTIONS & RAISE-HAND ACTIONS
  // -------------------------------------------------------------------------

  const sendReaction = useCallback((emoji: string) => {
    socket?.emit('send-reaction', { emoji });
  }, [socket]);

  const raiseHand = useCallback(() => {
    socket?.emit('raise-hand');
  }, [socket]);

  const lowerHand = useCallback(() => {
    socket?.emit('lower-hand');
  }, [socket]);

  // -------------------------------------------------------------------------
  // MODERATION ACTIONS (host / co-host)
  // -------------------------------------------------------------------------

  const muteAll = useCallback(() => {
    socket?.emit('mute-all');
  }, [socket]);

  const muteParticipant = useCallback((participantId: string) => {
    socket?.emit('mute-participant', { participantId });
  }, [socket]);

  const promoteCoHost = useCallback((participantId: string) => {
    socket?.emit('promote-cohost', { participantId });
  }, [socket]);

  const demoteCoHost = useCallback((participantId: string) => {
    socket?.emit('demote-cohost', { participantId });
  }, [socket]);

  // Forward optional media-device controls from useMediasoup if that hook
  // exposes them (kept loosely typed so this stays forward-compatible without
  // owning useMediasoup).
  const ms = mediasoup as typeof mediasoup & {
    activeSpeakerParticipantId?: string | null;
    audioInputDevices?: MediaDeviceInfo[];
    videoInputDevices?: MediaDeviceInfo[];
    switchCamera?: (deviceId: string) => Promise<void> | void;
    switchMic?: (deviceId: string) => Promise<void> | void;
    connectionQuality?: string;
  };

  return {
    meeting,
    participants,
    lobbyParticipants,
    isHost,
    isInLobby,
    isLoading,
    error: error || socketError,
    localStream: mediasoup.localStream,
    screenStream: mediasoup.screenStream,
    peers: mediasoup.peers,
    isAudioEnabled: mediasoup.isAudioEnabled,
    isVideoEnabled: mediasoup.isVideoEnabled,
    isScreenSharing: mediasoup.isScreenSharing,
    toggleAudio: mediasoup.toggleAudio,
    toggleVideo: mediasoup.toggleVideo,
    startScreenShare: mediasoup.startScreenShare,
    stopScreenShare: mediasoup.stopScreenShare,
    // Active speaker + optional device/quality controls forwarded from useMediasoup.
    activeSpeakerParticipantId: ms.activeSpeakerParticipantId ?? null,
    audioInputDevices: ms.audioInputs,
    videoInputDevices: ms.videoInputs,
    switchCamera: ms.switchCamera,
    switchMic: ms.switchMic,
    connectionQuality: ms.connectionQuality,
    // Reactions & raised hands
    reactions,
    raisedHands,
    sendReaction,
    raiseHand,
    lowerHand,
    admitFromLobby,
    rejectFromLobby,
    moveToLobby,
    kickParticipant,
    transferHost,
    inviteParticipant,
    endMeeting,
    leaveMeeting,
    // Moderation
    muteAll,
    muteParticipant,
    promoteCoHost,
    demoteCoHost,
  };
}
