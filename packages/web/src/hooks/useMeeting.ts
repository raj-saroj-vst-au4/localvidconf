// =============================================================================
// useMeeting Hook
// Orchestrates the entire meeting experience:
// - Socket connection and meeting join flow
// - Lobby waiting state (shown inline on the meeting page, no redirect)
// - Participant list management
// - Host control actions (admit, kick, transfer, invite)
// - Meeting status (live, ended)
//
// This hook combines useSocket and useMediasoup into a single API
// that the meeting page component consumes.
// =============================================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSocket } from './useSocket';
import { useMediasoup } from './useMediasoup';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import type { Meeting, Participant } from '@/types';

interface UseMeetingProps {
  meetingCode: string;
}

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
  toggleVideo: () => Promise<void>;
  // Returns null on success, error message on failure (e.g. mobile not supported)
  startScreenShare: () => Promise<string | null>;
  stopScreenShare: () => void;

  // Device selection (forwarded from useMediasoup)
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  selectedVideoDeviceId: string | null;
  selectedAudioDeviceId: string | null;
  selectVideoDevice: (deviceId: string) => Promise<void>;
  selectAudioDevice: (deviceId: string) => Promise<void>;

  // Host control actions
  admitFromLobby: (participantId: string) => void;
  rejectFromLobby: (participantId: string) => void;
  moveToLobby: (participantId: string) => void;
  kickParticipant: (participantId: string) => void;
  transferHost: (participantId: string) => void;
  inviteParticipant: (email: string) => void;
  endMeeting: () => void;
  leaveMeeting: () => void;
}

export function useMeeting({ meetingCode }: UseMeetingProps): UseMeetingReturn {
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

  // -------------------------------------------------------------------------
  // JOIN MEETING FLOW
  // Once socket is connected, emit 'join-meeting' and handle the response
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !isConnected || !session) return;

    // Join the meeting
    socket.emit('join-meeting', { meetingCode });

    // --- Successfully joined the meeting ---
    socket.on('meeting-joined', async (data: any) => {
      setMeeting(data.meeting);
      setParticipants(data.participants ?? []);
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

      // For lobby users: reveal the meeting room AFTER media is fully initialized.
      // This prevents rendering the meeting room before camera/mic are ready.
      // For regular joins, isInLobby is already false so this is a harmless no-op.
      setIsInLobby(false);
    });

    // --- Waiting in lobby ---
    socket.on('lobby-waiting', (data: { meetingTitle: string }) => {
      setMeeting({ title: data.meetingTitle } as Meeting);
      setIsInLobby(true);
      setIsLoading(false);
    });

    // --- Admitted from lobby ---
    // 'meeting-joined' fires before 'admitted' (server calls joinMeetingRoom first).
    // setIsInLobby(false) is handled at the end of the meeting-joined handler above,
    // after media is fully initialized. Nothing to do here.
    socket.on('admitted', () => {});

    // --- New participant joined ---
    // Server sends: { participantId, userId, name, email, image, socketId }
    // We must map to the Participant shape (server field names differ from type fields).
    socket.on('participant-joined', (data: any) => {
      setParticipants((prev) => {
        // Avoid duplicates
        if (prev.some(p => p.userId === data.userId)) return prev;
        const newParticipant: Participant = {
          id: data.participantId,
          userId: data.userId,
          meetingId: meeting?.id ?? '',
          role: 'PARTICIPANT',
          status: 'IN_MEETING',
          breakoutRoomId: null,
          joinedAt: new Date().toISOString(),
          user: {
            id: data.userId,
            name: data.name,
            email: data.email,
            image: data.image ?? null,
          },
        };
        return [...prev, newParticipant];
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
    socket.on('host-changed', (data: { newHostId: string }) => {
      setParticipants((prev) =>
        prev.map((p) => ({
          ...p,
          role: p.id === data.newHostId ? 'HOST' as const : (p.role === 'HOST' ? 'PARTICIPANT' as const : p.role),
        }))
      );
      // Check if we are the new host
      const myParticipant = participants.find(p => p.userId === (session?.user as any)?.id);
      if (myParticipant?.id === data.newHostId) {
        setIsHost(true);
      } else {
        setIsHost(false);
      }
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
      socket.off('error');
    };
  }, [socket, isConnected, session, meetingCode]);

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
    videoDevices: mediasoup.videoDevices,
    audioDevices: mediasoup.audioDevices,
    selectedVideoDeviceId: mediasoup.selectedVideoDeviceId,
    selectedAudioDeviceId: mediasoup.selectedAudioDeviceId,
    selectVideoDevice: mediasoup.selectVideoDevice,
    selectAudioDevice: mediasoup.selectAudioDevice,
    admitFromLobby,
    rejectFromLobby,
    moveToLobby,
    kickParticipant,
    transferHost,
    inviteParticipant,
    endMeeting,
    leaveMeeting,
  };
}
