// =============================================================================
// Media Server Entry Point
// Initializes: Express (health checks), Socket.IO (signaling), mediasoup (SFU)
// This is the main file that wires everything together.
//
// Architecture:
// - Express: HTTP server for health checks and REST endpoints
// - Socket.IO: WebSocket server for real-time signaling
// - mediasoup: SFU for WebRTC media relay
// - Prisma: Database client for MySQL operations
// - node-cron: Scheduled reminder processing
//
// This container is designed to be replicated across servers for load balancing.
// Each instance manages its own mediasoup workers and room state.
// =============================================================================

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import jwt from 'jsonwebtoken';

// Config
import { validateEnv, env } from './config/env';
import { CORS_OPTIONS } from './config/cors';
import { WORKER_SETTINGS, NUM_WORKERS, MEDIA_CODECS } from './config/mediasoup';

// Services
import { Room } from './services/Room';
import { ReminderScheduler } from './services/ReminderScheduler';

// Handlers
import { registerConnectionHandlers } from './handlers/connectionHandler';
import { registerMediasoupHandlers } from './handlers/mediasoupHandler';
import { registerMeetingHandlers } from './handlers/meetingHandler';
import { registerBreakoutHandlers } from './handlers/breakoutHandler';
import { registerQAHandlers } from './handlers/qaHandler';
import { registerChatHandlers } from './handlers/chatHandler';

// Middleware
import { socketAuthMiddleware } from './middleware/socketAuth';
import { createLogger } from './utils/logger';

const log = createLogger('Server');

// Validate environment configuration before anything else so bad/missing
// env fails fast at boot rather than surfacing as obscure runtime errors.
validateEnv();

const PORT = parseInt(process.env.PORT || '4000');

// --- Global State ---
// These are scoped to this server instance.
// For load balancing, each server has its own rooms and workers.
const prisma = new PrismaClient();
const rooms = new Map<string, Room>();                         // meetingCode → Room
const workers: mediasoupTypes.Worker[] = [];                   // mediasoup worker pool
let workerIndex = 0;                                           // Round-robin worker assignment

// Module-scoped graceful-shutdown handle. Assigned in start() once the server
// is wired up, so process-level crash handlers can reuse the same teardown path.
let shutdown: ((exitCode?: number) => Promise<void>) | undefined;
let shuttingDown = false;

// --- Process-level crash safety ---
// A media server is long-lived; an unhandled rejection or thrown error must be
// logged loudly and (for hard failures) drive a graceful shutdown rather than
// leaving a half-dead process that the orchestrator keeps routing traffic to.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err?.message, stack: err?.stack });
  // Attempt a best-effort graceful shutdown, then exit non-zero. Guard against
  // re-entry if the exception fires mid-shutdown.
  if (shutdown && !shuttingDown) {
    shutdown(1).catch((e) => {
      log.error('Error during shutdown after uncaughtException', {
        error: e instanceof Error ? e.message : String(e),
      });
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});

// =============================================================================
// 1. Initialize Express with Security Middleware
// =============================================================================

const app = express();

// Helmet: sets secure HTTP headers (CSP, HSTS, X-Frame-Options, etc.)
app.use(helmet());

// CORS: only allow requests from the frontend domain
app.use(cors(CORS_OPTIONS));

// Rate limiting: prevent brute-force and DoS attacks on HTTP endpoints
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 100,                 // Max 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
}));

// --- Health Check Endpoint ---
// Used by Docker health checks and load balancer probes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    workers: workers.length,
    uptime: process.uptime(),
  });
});

// --- TURN Credentials Endpoint ---
// Generates time-limited HMAC credentials for the TURN server.
// Clients call this before joining a meeting to get TURN access.
app.get('/turn-credentials', (req, res) => {
  const turnSecret = process.env.TURN_SECRET;
  if (!turnSecret) {
    return res.status(500).json({ error: 'TURN secret not configured' });
  }

  // Require a valid NextAuth JWT before handing out TURN credentials.
  // Token may arrive via the Authorization header ("Bearer <t>") or ?token=.
  const authHeader = req.headers.authorization || '';
  const headerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const token = headerToken || queryToken;

  const secret = process.env.NEXTAUTH_SECRET;
  if (!token || !secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err: any) {
    log.warn('turn-credentials rejected: invalid token', { error: err?.message });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Time-limited credentials: valid for 1 hour
  // The TURN server validates these using the shared secret
  const crypto = require('crypto');
  const unixTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1h from now
  const username = `${unixTimestamp}:meetuser`;
  const hmac = crypto.createHmac('sha1', turnSecret);
  hmac.update(username);
  const credential = hmac.digest('base64');

  // TURN_SERVER_URL may be a comma-separated list so clients on different
  // networks each get a reachable entry — e.g. a LAN URL for same-subnet peers
  // plus a public TCP-relay URL (turn:host:3478?transport=tcp) for users outside
  // the LAN whose media can only reach the SFU by relaying through the edge.
  const turnUrls = (process.env.TURN_SERVER_URL || 'turn:localhost:3478')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  res.json({
    urls: [
      ...turnUrls,
      // Also provide STUN for NAT detection (no auth needed)
      'stun:stun.l.google.com:19302',
    ],
    username,
    credential,
  });
});

// =============================================================================
// 2. Initialize HTTP Server and Socket.IO
// =============================================================================

const httpServer = http.createServer(app);

const io = new SocketServer(httpServer, {
  cors: CORS_OPTIONS,
  // WebSocket preferred for lower latency; polling as fallback
  transports: ['websocket', 'polling'],
  // Increase max payload for RTP parameters (can be large)
  maxHttpBufferSize: 1e6, // 1 MB
  // Heartbeat / liveness tuning: detect and reap dead connections promptly so
  // a hung peer (or a stalled upstream proxy) doesn't linger as a ghost.
  pingInterval: 25000,
  pingTimeout: 20000,
  connectTimeout: 20000,
});

// --- Socket.IO Authentication Middleware ---
// Every connection must provide a valid JWT token
io.use(socketAuthMiddleware);

// =============================================================================
// 3. Initialize mediasoup Workers
// =============================================================================

/**
 * Create mediasoup workers (one per CPU core / 2).
 * Workers are the OS processes that handle media.
 */
async function createWorkers(): Promise<void> {
  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = await mediasoup.createWorker(WORKER_SETTINGS);

    worker.on('died', (error) => {
      // Worker died: this is a critical error. In production, you'd restart the process.
      log.error(`mediasoup worker ${i} died!`, { error: error?.message });
      const deadPid = worker.pid;

      // Remove the dead worker from the pool
      const idx = workers.indexOf(worker);
      if (idx !== -1) workers.splice(idx, 1);

      // Create a replacement worker, then keep round-robin in range
      mediasoup.createWorker(WORKER_SETTINGS).then(newWorker => {
        workers.push(newWorker);
        // Recompute the round-robin cursor against the (now changed) pool size.
        workerIndex = workers.length > 0 ? workerIndex % workers.length : 0;
        log.info('Replacement worker created');
      });

      // The dead worker took its routers (and thus their rooms) down with it.
      // Tear those rooms down and notify their peers so clients can recover.
      terminateRoomsForWorker(deadPid);
    });

    workers.push(worker);
    log.info(`mediasoup worker ${i} created (pid: ${worker.pid})`);
  }
}

/**
 * Get the next worker in round-robin order.
 * Distributes rooms evenly across workers for load balancing.
 */
function getNextWorker(): mediasoupTypes.Worker {
  if (workers.length === 0) {
    throw new Error('No mediasoup workers available');
  }
  // Guard against workerIndex drifting out of range after the pool shrinks.
  workerIndex = workerIndex % workers.length;
  const worker = workers[workerIndex];
  workerIndex = (workerIndex + 1) % workers.length;
  return worker;
}

/**
 * Tear down every Room whose main router lived on a now-dead worker.
 * mediasoup does not expose a router's owning worker, so we tag each router's
 * appData with the worker pid at creation time and match on that here.
 * Each affected room is closed, its peers notified, and removed from the map.
 */
function terminateRoomsForWorker(deadPid: number): void {
  for (const [code, room] of rooms) {
    const router = room.getRouter();
    if ((router.appData as { workerPid?: number }).workerPid !== deadPid) continue;

    log.error('Tearing down room on dead worker', {
      meetingCode: code,
      meetingId: room.meetingId,
      deadPid,
    });

    // Notify everyone in the room before we destroy server-side state.
    // Peers are joined to the `meeting:<code>` Socket.IO room (see connectionHandler).
    io.to(`meeting:${code}`).emit('room-terminated', {
      meetingCode: code,
      reason: 'media-worker-failure',
    });

    room.close();
    rooms.delete(code);
  }
}

/**
 * Get or create a Room for a meeting.
 * If the room already exists (another peer joined first), return it.
 * Otherwise, create a new mediasoup Router and Room.
 */
async function getOrCreateRoom(meetingId: string, meetingCode: string): Promise<Room> {
  let room = rooms.get(meetingCode);
  if (room) return room;

  // Admission control: cap the number of concurrent rooms this instance hosts.
  // Throw so the caller can reject the join with a clear, actionable error
  // instead of silently overcommitting workers and degrading every meeting.
  if (rooms.size >= env.MAX_ROOMS) {
    throw new Error('Server at capacity: maximum number of rooms reached');
  }

  // Create a new Router on the next available worker
  const worker = getNextWorker();
  // Tag the router with its owning worker pid so we can find and tear down
  // its rooms if that worker dies (mediasoup doesn't expose this linkage).
  const router = await worker.createRouter({
    mediaCodecs: MEDIA_CODECS,
    appData: { workerPid: worker.pid },
  });

  room = new Room(meetingId, meetingCode, router);
  rooms.set(meetingCode, room);

  log.info('New room created', { meetingId, meetingCode, workerId: worker.pid });
  return room;
}

// =============================================================================
// 4. Socket.IO Connection Handler
// =============================================================================

io.on('connection', (socket) => {
  log.info('New socket connection', {
    socketId: socket.id,
    user: socket.data.user?.email,
  });

  // Register all event handlers for this socket
  // Each handler file manages its own subset of events

  // Connection lifecycle: join meeting, disconnect
  registerConnectionHandlers(io, socket, rooms, prisma, getOrCreateRoom);

  // mediasoup signaling: transport, produce, consume
  registerMediasoupHandlers(io, socket, rooms);

  // Host controls: lobby, kick, transfer, invite
  registerMeetingHandlers(io, socket, rooms, prisma, getOrCreateRoom);

  // Breakout rooms: create, assign, close
  registerBreakoutHandlers(io, socket, rooms, prisma, getNextWorker);

  // Q&A with upvoting (Slido-style)
  registerQAHandlers(io, socket, prisma);

  // In-meeting chat
  registerChatHandlers(io, socket, prisma);
});

// =============================================================================
// 5. Start the Server
// =============================================================================

async function start(): Promise<void> {
  try {
    // Connect to the database
    await prisma.$connect();
    log.info('Database connected');

    // --- Crash reconciliation ---
    // A previous crash can leave participant rows stuck in an "active" state
    // (this instance never ran their disconnect handler). Clear them once, here,
    // AFTER the DB is connected but BEFORE we accept any connections, so stale
    // rows don't pollute presence/headcounts.
    //
    // NOTE: the audit text said status: 'LEFT', but the ParticipantStatus enum
    // has no LEFT member (IN_LOBBY | IN_MEETING | IN_BREAKOUT | REMOVED). We use
    // the schema-valid terminal status 'REMOVED' + leftAt, matching how kicked
    // participants are recorded elsewhere, so this neither type-errors nor
    // throws at runtime.
    const reconciled = await prisma.participant.updateMany({
      where: { status: { in: ['IN_MEETING', 'IN_BREAKOUT'] } },
      data: { status: 'REMOVED', leftAt: new Date() },
    });
    log.info('Reconciled stale participant rows from previous run', {
      count: reconciled.count,
    });

    // Create mediasoup workers
    await createWorkers();
    log.info(`${workers.length} mediasoup workers ready`);

    // Start the reminder scheduler
    const reminderScheduler = new ReminderScheduler(prisma, io);
    reminderScheduler.start();

    // Start listening for connections
    httpServer.listen(PORT, '0.0.0.0', () => {
      log.info(`Media server running on port ${PORT}`);
      log.info(`Workers: ${workers.length}, CORS: ${CORS_OPTIONS.origin}`);
    });

    // --- Graceful Shutdown ---
    // Close cleanly when stopped. Order matters:
    //   1. io.close()           - stop accepting new sockets / drop transports
    //   2. httpServer.close()   - stop accepting HTTP, drain in-flight (10s cap)
    //   3. close workers        - tear down mediasoup media processes
    //   4. prisma.$disconnect() - release DB connections
    //   5. process.exit()       - only after everything above has settled
    shutdown = async (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info('Shutting down...', { exitCode });
      reminderScheduler.stop();

      // 1. Stop accepting new Socket.IO connections.
      try {
        await new Promise<void>((resolve) => io.close(() => resolve()));
      } catch (e) {
        log.error('Error closing Socket.IO server', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // 2. Stop the HTTP server, but don't hang forever if a connection wedges.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          log.warn('HTTP server close timed out; forcing shutdown');
          resolve();
        }, 10000);
        httpServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });

      // 3. Close all rooms and mediasoup workers.
      for (const room of rooms.values()) {
        room.close();
      }
      rooms.clear();
      for (const worker of workers) {
        worker.close();
      }

      // 4. Release the database.
      try {
        await prisma.$disconnect();
      } catch (e) {
        log.error('Error disconnecting Prisma', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // 5. Now it's safe to exit.
      process.exit(exitCode);
    };

    process.on('SIGINT', () => shutdown?.());
    process.on('SIGTERM', () => shutdown?.());

  } catch (err: any) {
    log.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();
