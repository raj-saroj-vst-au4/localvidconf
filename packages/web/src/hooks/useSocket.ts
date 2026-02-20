// =============================================================================
// useSocket Hook
// Manages Socket.IO connection lifecycle tied to the React component lifecycle.
// Automatically connects when the component mounts and disconnects on unmount.
// Provides the socket instance and connection status to components.
// =============================================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket, disconnectSocket } from '@/lib/socket';
import { useSession } from 'next-auth/react';

interface UseSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  error: string | null;
}

export function useSocket(): UseSocketReturn {
  const { data: session } = useSession();
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!session) return;

    // Get the JWT token from the session for socket auth
    // NextAuth stores it in the session object
    const token = (session as any)?.accessToken || '';

    const socket = getSocket(token);
    socketRef.current = socket;

    // --- Connection Event Handlers ---

    socket.on('connect', () => {
      setIsConnected(true);
      setError(null);
    });

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      // If the server disconnected us, it might be due to auth failure
      if (reason === 'io server disconnect') {
        setError('Server disconnected');
      }
    });

    socket.on('connect_error', (err) => {
      setIsConnected(false);
      setError(err.message);
    });

    // Connect the socket
    if (!socket.connected) {
      socket.connect();
    }

    // Cleanup on unmount: disconnect and remove listeners
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
    };
  }, [session]);

  return {
    socket: socketRef.current,
    isConnected,
    error,
  };
}
