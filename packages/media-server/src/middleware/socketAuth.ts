// =============================================================================
// Socket.IO Authentication Middleware
// Verifies the JWT token on every socket connection handshake.
// Uses the same NEXTAUTH_SECRET that NextAuth uses to sign tokens.
// This ensures only authenticated Google OAuth users can connect.
//
// Flow:
// 1. Client sends JWT in socket.auth.token during handshake
// 2. This middleware decodes and verifies the token
// 3. If valid, attaches user data to socket.data for use in handlers
// 4. If invalid, rejects the connection with an error
// =============================================================================

import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { createLogger } from '../utils/logger';

const log = createLogger('SocketAuth');

// User data extracted from the JWT token and attached to socket.data
export interface SocketUser {
  userId: string;
  email: string;
  name: string;
  image: string | null;
}

/**
 * Socket.IO middleware that authenticates connections via JWT.
 * Rejects unauthenticated connections before they can emit any events.
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const token = socket.handshake.auth?.token;

  if (!token) {
    log.warn('Connection rejected: no token provided', { socketId: socket.id });
    return next(new Error('Authentication required'));
  }

  try {
    // NextAuth JWT tokens are signed with NEXTAUTH_SECRET
    // The token contains: userId, email, name, picture (from our jwt callback)
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      throw new Error('NEXTAUTH_SECRET not configured');
    }

    const decoded = jwt.verify(token, secret) as any;

    // Attach user data to socket for use in event handlers
    // This avoids re-querying the database for every socket event
    socket.data.user = {
      userId: decoded.userId || decoded.sub,
      email: decoded.email,
      name: decoded.name,
      image: decoded.picture || null,
    } as SocketUser;

    log.info('Socket authenticated', {
      socketId: socket.id,
      userId: socket.data.user.userId,
      email: socket.data.user.email,
    });

    next();
  } catch (err: any) {
    log.warn('Connection rejected: invalid token', {
      socketId: socket.id,
      error: err.message,
    });
    next(new Error('Invalid authentication token'));
  }
}
