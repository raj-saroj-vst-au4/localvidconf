// =============================================================================
// Socket.IO Rate Limiter
// Prevents abuse by limiting how many events a client can emit per second.
// Different limits for different event types:
// - Media events (transport/produce/consume): higher limit (real-time critical)
// - Chat/Q&A events: moderate limit
// - Admin events (kick/transfer): low limit (rarely needed)
//
// Uses a sliding window counter per socket per event type.
// =============================================================================

import { Socket } from 'socket.io';
import { createLogger } from '../utils/logger';

const log = createLogger('RateLimiter');

// Rate limits per event category (max events per window)
const LIMITS: Record<string, { maxEvents: number; windowMs: number }> = {
  // Media signaling: high frequency (transport negotiation is bursty)
  media: { maxEvents: 30, windowMs: 1000 },
  // Chat and Q&A: moderate (prevent spam)
  chat: { maxEvents: 5, windowMs: 1000 },
  // Admin actions: low frequency (prevent abuse)
  admin: { maxEvents: 3, windowMs: 1000 },
  // Default for unclassified events
  default: { maxEvents: 10, windowMs: 1000 },
};

// Map event names to their rate limit categories
const EVENT_CATEGORIES: Record<string, string> = {
  'create-transport': 'media',
  'connect-transport': 'media',
  'produce': 'media',
  'consume': 'media',
  'resume-consumer': 'media',
  'set-preferred-layers': 'media',
  'pause-producer': 'media',
  'resume-producer': 'media',
  'send-chat': 'chat',
  'ask-question': 'chat',
  'upvote-question': 'chat',
  'send-reaction': 'chat',
  'raise-hand': 'chat',
  'lower-hand': 'chat',
  'pin-question': 'admin',
  'mark-answered': 'admin',
  'close-producer': 'media',
  'kick-participant': 'admin',
  'transfer-host': 'admin',
  'lobby-admit': 'admin',
  'lobby-reject': 'admin',
  'move-to-lobby': 'admin',
  'invite-participant': 'admin',
  'mute-all': 'admin',
  'mute-participant': 'admin',
  'promote-cohost': 'admin',
  'demote-cohost': 'admin',
};

// Per-identity event counters: Map<counterKey, Map<category, { count, resetTime }>>
// counterKey is the authenticated user id when available, otherwise the socket id.
const counters = new Map<string, Map<string, { count: number; resetTime: number }>>();

/**
 * Resolve the counter key for a socket. Keying on the authenticated user id
 * (when present) prevents trivial reconnect-resets where a client drops and
 * reopens the socket to obtain a fresh per-socket counter. Falls back to the
 * socket id only for unauthenticated connections.
 */
function getCounterKey(socket: Socket): string {
  return socket.data?.user?.userId ?? socket.id;
}

/**
 * Check if a socket event should be rate-limited.
 * Returns true if the event is allowed, false if rate-limited.
 */
export function checkRateLimit(socket: Socket, eventName: string): boolean {
  const category = EVENT_CATEGORIES[eventName] || 'default';
  const limit = LIMITS[category] || LIMITS.default;
  const now = Date.now();
  const counterKey = getCounterKey(socket);

  // Initialize counter map for this identity if needed
  if (!counters.has(counterKey)) {
    counters.set(counterKey, new Map());
  }
  const socketCounters = counters.get(counterKey)!;

  // Get or initialize counter for this category
  let counter = socketCounters.get(category);
  if (!counter || now >= counter.resetTime) {
    // Window expired, reset counter
    counter = { count: 0, resetTime: now + limit.windowMs };
    socketCounters.set(category, counter);
  }

  counter.count++;

  if (counter.count > limit.maxEvents) {
    log.warn('Rate limit exceeded', {
      counterKey,
      socketId: socket.id,
      event: eventName,
      category,
      count: counter.count,
      limit: limit.maxEvents,
    });
    return false; // Rate limited
  }

  return true; // Allowed
}

/**
 * Clean up counters when a socket disconnects.
 * Prevents memory leaks from accumulating counter maps.
 *
 * Accepts the disconnecting key, which may be a socket id (unauthenticated
 * connections) or an authenticated user id. For authenticated users that may
 * still have other live sockets the user-keyed entry is intentionally kept;
 * the sliding window makes any stale entry self-expiring and harmless.
 */
export function cleanupRateLimitCounters(socketId: string): void {
  counters.delete(socketId);
}
