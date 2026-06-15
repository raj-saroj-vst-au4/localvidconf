// =============================================================================
// useBreakoutRooms Hook
// Manages breakout room state and actions for the meeting.
// Listens for breakout-related socket events and provides control functions.
// =============================================================================

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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

  // Holds the active countdown interval id. Stored in a ref so we can clear it
  // from the effect cleanup and from the 'breakout-ended' handler (a cleanup
  // returned from a socket.on callback never runs).
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

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

      // Start countdown timer if there's an end time. Clear any prior interval
      // first, and store the id in a ref so the effect cleanup / 'breakout-ended'
      // can stop it (the value returned from a socket.on callback is discarded).
      if (data.breakoutRoom.endsAt) {
        clearCountdown();
        const endTime = new Date(data.breakoutRoom.endsAt).getTime();
        countdownRef.current = setInterval(() => {
          const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
          setTimeRemaining(remaining);
          if (remaining <= 0) clearCountdown();
        }, 1000);
      }
    });

    // Breakout rooms were closed - return to main room
    socket.on('breakout-ended', () => {
      clearCountdown();
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
      // Stop the countdown so the interval doesn't leak across reconnects/unmount.
      clearCountdown();
    };
  }, [socket, isConnected, clearCountdown]);

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
