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
  toggleVideo: () => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;

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
    socket.on('participant-joined', (data: any) => {
      setParticipants((prev) => {
        // Avoid duplicates
        if (prev.some(p => p.userId === data.userId)) return prev;
        return [...prev, data as Participant];
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
