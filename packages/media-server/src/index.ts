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

// Config
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
const PORT = parseInt(process.env.PORT || '4000');

// --- Global State ---
// These are scoped to this server instance.
// For load balancing, each server has its own rooms and workers.
const prisma = new PrismaClient();
const rooms = new Map<string, Room>();                         // meetingCode → Room
const workers: mediasoupTypes.Worker[] = [];                   // mediasoup worker pool
let workerIndex = 0;                                           // Round-robin worker assignment

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

  // Time-limited credentials: valid for 24 hours
  // The TURN server validates these using the shared secret
  const crypto = require('crypto');
  const unixTimestamp = Math.floor(Date.now() / 1000) + 24 * 3600; // 24h from now
  const username = `${unixTimestamp}:meetuser`;
  const hmac = crypto.createHmac('sha1', turnSecret);
  hmac.update(username);
  const credential = hmac.digest('base64');

  res.json({
    urls: [
      process.env.TURN_SERVER_URL || 'turn:localhost:3478',
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
      // Remove the dead worker and create a replacement
      const idx = workers.indexOf(worker);
      if (idx !== -1) workers.splice(idx, 1);

      // Create a replacement worker
      mediasoup.createWorker(WORKER_SETTINGS).then(newWorker => {
        workers.push(newWorker);
        log.info('Replacement worker created');
      });
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
  const worker = workers[workerIndex];
  workerIndex = (workerIndex + 1) % workers.length;
  return worker;
}

/**
 * Get or create a Room for a meeting.
 * If the room already exists (another peer joined first), return it.
 * Otherwise, create a new mediasoup Router and Room.
 */
async function getOrCreateRoom(meetingId: string, meetingCode: string): Promise<Room> {
  let room = rooms.get(meetingCode);
  if (room) return room;

  // Create a new Router on the next available worker
  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

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
    // Close connections cleanly when the process is stopped
    const shutdown = async () => {
      log.info('Shutting down...');
      reminderScheduler.stop();

      // Close all rooms
      for (const [code, room] of rooms) {
        room.close();
      }
      rooms.clear();

      // Close all mediasoup workers
      for (const worker of workers) {
        worker.close();
      }

      await prisma.$disconnect();
      httpServer.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err: any) {
    log.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();
