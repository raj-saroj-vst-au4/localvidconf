// =============================================================================
// useBreakoutRooms Hook
// Manages breakout room state and actions for the meeting.
// Listens for breakout-related socket events and provides control functions.
// =============================================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import type { BreakoutRoom, Participant } from '@/types';

interface UseBreakoutRoomsProps {
  socket: Socket | null;
  isConnected: boolean;
  participants: Participant[];
}

interface UseBreakoutRoomsReturn {
  breakoutRooms: BreakoutRoom[];
  isInBreakout: boolean;
  currentBreakoutRoom: BreakoutRoom | null;
  timeRemaining: number | null; // Seconds remaining before auto-close
  // Actions (host only)
  createBreakoutRooms: (rooms: { name: string; participantIds: string[] }[], duration?: number) => void;
  closeBreakoutRooms: () => void;
  broadcastToBreakouts: (message: string) => void;
}

export function useBreakoutRooms({
  socket,
  isConnected,
  participants,
}: UseBreakoutRoomsProps): UseBreakoutRoomsReturn {
  const [breakoutRooms, setBreakoutRooms] = useState<BreakoutRoom[]>([]);
  const [isInBreakout, setIsInBreakout] = useState(false);
  const [currentBreakoutRoom, setCurrentBreakoutRoom] = useState<BreakoutRoom | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!socket || !isConnected) return;

    // Breakout rooms were created by the host
    socket.on('breakout-created', (data: { rooms: BreakoutRoom[] }) => {
      setBreakoutRooms(data.rooms);
    });

    // This peer was moved into a breakout room
    socket.on('breakout-joined', (data: { breakoutRoom: any; routerCapabilities: any }) => {
      setIsInBreakout(true);
      setCurrentBreakoutRoom(data.breakoutRoom);

      // Start countdown timer if there's an end time
      if (data.breakoutRoom.endsAt) {
        const endTime = new Date(data.breakoutRoom.endsAt).getTime();
        const interval = setInterval(() => {
          const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
          setTimeRemaining(remaining);
          if (remaining <= 0) clearInterval(interval);
        }, 1000);

        return () => clearInterval(interval);
      }
    });

    // Breakout rooms were closed - return to main room
    socket.on('breakout-ended', () => {
      setIsInBreakout(false);
      setCurrentBreakoutRoom(null);
      setBreakoutRooms([]);
      setTimeRemaining(null);
    });

    socket.on('breakout-closed', () => {
      setBreakoutRooms([]);
    });

    // Broadcast message from host in breakout room
    socket.on('breakout-broadcast', (data: { message: string; from: string }) => {
      // This will be handled by the UI to show a toast/banner
    });

    return () => {
      socket.off('breakout-created');
      socket.off('breakout-joined');
      socket.off('breakout-ended');
      socket.off('breakout-closed');
      socket.off('breakout-broadcast');
    };
  }, [socket, isConnected]);

  // --- Host Actions ---

  const createBreakoutRooms = useCallback((
    rooms: { name: string; participantIds: string[] }[],
    duration?: number
  ) => {
    socket?.emit('create-breakout', { rooms, duration });
  }, [socket]);

  const closeBreakoutRooms = useCallback(() => {
    socket?.emit('close-breakouts');
  }, [socket]);

  const broadcastToBreakouts = useCallback((message: string) => {
    socket?.emit('broadcast-to-breakouts', { message });
  }, [socket]);

  return {
    breakoutRooms,
    isInBreakout,
    currentBreakoutRoom,
    timeRemaining,
    createBreakoutRooms,
    closeBreakoutRooms,
    broadcastToBreakouts,
  };
}
