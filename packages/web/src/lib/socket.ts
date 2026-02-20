// =============================================================================
// Socket.IO Client Configuration
// Singleton socket instance shared across all hooks and components
// Connects to the media server with JWT auth token in handshake
// =============================================================================

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/**
 * Get or create the Socket.IO client connection.
 * The JWT token is sent during the handshake for server-side authentication.
 *
 * Why singleton: Multiple socket connections from the same client would
 * cause duplicate events, wasted bandwidth, and inconsistent state.
 *
 * @param token - NextAuth JWT token for authentication
 * @returns Socket.IO client instance
 */
export function getSocket(token?: string): Socket {
  if (socket?.connected) return socket;

  // Connect to same origin; nginx routes /media/socket.io/ to media-server:4000
  socket = io('', {
    // Socket.IO engine path routed through /media/ prefix by nginx
    path: '/media/socket.io/',
    // Send JWT token in the handshake for server-side auth verification
    auth: { token },
    // Use WebSocket first, fall back to polling if blocked by firewall
    transports: ['websocket', 'polling'],
    // Don't auto-connect; we connect manually after getting the token
    autoConnect: false,
    // Reconnect with exponential backoff on disconnection
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  return socket;
}

/**
 * Disconnect and clean up the socket instance.
 * Called when user leaves a meeting or signs out.
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
