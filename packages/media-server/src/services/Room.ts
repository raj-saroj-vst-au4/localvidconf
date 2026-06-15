// =============================================================================
// Room Service
// Manages the mediasoup Router and all peers within a meeting room.
// This is the most complex file in the project because it orchestrates:
// 1. mediasoup Router lifecycle (main room + breakout rooms)
// 2. Peer join/leave with transport management
// 3. Producer/consumer creation for media relay
// 4. Breakout room creation with separate routers
//
// Architecture:
// - Each meeting has one Room instance with one main Router
// - Each breakout room gets its own Router (isolated media)
// - When a peer joins a breakout, they disconnect from main and connect to breakout
// - When breakouts close, everyone reconnects to the main router
// =============================================================================

import { types as mediasoupTypes } from 'mediasoup';
import type { Server as SocketServer } from 'socket.io';
import { Peer } from './Peer';
import { WEBRTC_TRANSPORT_OPTIONS, MEDIA_CODECS, SIMULCAST_ENCODINGS, SCREEN_SHARE_ENCODING } from '../config/mediasoup';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('Room');

export class Room {
  readonly meetingId: string;
  readonly meetingCode: string;

  // Main mediasoup Router - handles media for the main meeting room
  private router: mediasoupTypes.Router;

  // All peers currently in the main room (key: socket ID)
  private peers: Map<string, Peer> = new Map();

  // Breakout room routers (key: breakout room DB ID)
  // Each breakout room gets its own router for isolated media
  private breakoutRouters: Map<string, mediasoupTypes.Router> = new Map();

  // Peers in breakout rooms (key: breakout room ID, value: set of socket IDs)
  private breakoutPeers: Map<string, Map<string, Peer>> = new Map();

  // Socket.IO server, used to broadcast media events (producer-closed,
  // active-speaker) into the `meeting:<code>` room. Wired via setIo() after
  // construction so the Room constructor signature stays stable.
  private io: SocketServer | null = null;

  // AudioLevelObserver on the main router. Created lazily the first time an
  // audio producer is added (mediasoup observer creation is async, and the
  // constructor cannot be async).
  private audioLevelObserver: mediasoupTypes.AudioLevelObserver | null = null;
  private audioObserverPending: Promise<mediasoupTypes.AudioLevelObserver> | null = null;

  constructor(
    meetingId: string,
    meetingCode: string,
    router: mediasoupTypes.Router
  ) {
    this.meetingId = meetingId;
    this.meetingCode = meetingCode;
    this.router = router;
    log.info('Room created', { meetingId, meetingCode });
  }

  /**
   * Provide the Socket.IO server so the Room can broadcast media events
   * (producer-closed, active-speaker) to its meeting room. Idempotent.
   */
  setIo(io: SocketServer): void {
    if (!this.io) {
      this.io = io;
    }
  }

  // --- Router Access ---

  getRouter(): mediasoupTypes.Router {
    return this.router;
  }

  getRouterCapabilities(): mediasoupTypes.RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  // --- Peer Management ---

  addPeer(peer: Peer): void {
    // Enforce the per-room capacity limit (counts main + breakout peers).
    // Throwing here rejects the join in the caller before any media is set up.
    if (this.getPeerCount() >= env.MAX_PEERS_PER_ROOM) {
      throw new Error(
        `Room is full (max ${env.MAX_PEERS_PER_ROOM} participants)`
      );
    }

    this.peers.set(peer.socketId, peer);
    log.info('Peer joined room', {
      meetingId: this.meetingId,
      socketId: peer.socketId,
      userName: peer.userName,
      peerCount: this.peers.size,
    });
  }

  removePeer(socketId: string): Peer | undefined {
    let removed = this.peers.get(socketId);
    if (removed) {
      removed.close(); // Clean up all transports/producers/consumers
      this.peers.delete(socketId);
      log.info('Peer left room', {
        meetingId: this.meetingId,
        socketId,
        peerCount: this.peers.size,
      });
    }

    // Also check breakout rooms. If the peer lived only in a breakout room,
    // return that peer so callers can still emit leave notifications for it.
    for (const [breakoutId, breakoutPeerMap] of this.breakoutPeers) {
      const breakoutPeer = breakoutPeerMap.get(socketId);
      if (breakoutPeer) {
        breakoutPeer.close();
        breakoutPeerMap.delete(socketId);
        if (!removed) removed = breakoutPeer;
      }
    }

    return removed;
  }

  getPeer(socketId: string): Peer | undefined {
    // Check main room first, then breakout rooms
    const mainPeer = this.peers.get(socketId);
    if (mainPeer) return mainPeer;

    for (const breakoutPeerMap of this.breakoutPeers.values()) {
      const breakoutPeer = breakoutPeerMap.get(socketId);
      if (breakoutPeer) return breakoutPeer;
    }
    return undefined;
  }

  getPeers(): Map<string, Peer> {
    return this.peers;
  }

  getPeerCount(): number {
    let total = this.peers.size;
    for (const breakoutPeerMap of this.breakoutPeers.values()) {
      total += breakoutPeerMap.size;
    }
    return total;
  }

  // --- Transport Creation ---

  /**
   * Create a WebRTC transport for a peer.
   * Each peer needs two transports: one for sending, one for receiving.
   *
   * @param direction - 'send' for producing media, 'recv' for consuming
   * @param peer - The peer requesting the transport
   * @param routerOverride - Optional router (for breakout rooms)
   */
  async createTransport(
    direction: 'send' | 'recv',
    peer: Peer,
    routerOverride?: mediasoupTypes.Router
  ): Promise<mediasoupTypes.WebRtcTransport> {
    const activeRouter = routerOverride || this.router;

    // Create the transport on the router
    const transport = await activeRouter.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS);

    // Set max incoming bitrate to prevent bandwidth abuse.
    // Reuse the configured cap rather than duplicating the magic number.
    await transport.setMaxIncomingBitrate(WEBRTC_TRANSPORT_OPTIONS.maxIncomingBitrate);

    // Store the transport on the peer
    if (direction === 'send') {
      peer.setSendTransport(transport);
    } else {
      peer.setRecvTransport(transport);
    }

    // Clean up when transport closes (e.g., ICE failure, timeout)
    transport.on('routerclose', () => {
      log.warn('Transport router closed', { transportId: transport.id });
      transport.close();
    });

    log.debug('Transport created', {
      direction,
      transportId: transport.id,
      peerId: peer.socketId,
    });

    return transport;
  }

  // --- Producer Creation ---

  /**
   * Create a media producer (outgoing track) for a peer.
   * Produces audio, video, or screen share.
   *
   * For video: simulcast with 3 quality layers (320p, 640p, 720p)
   * For screen: single high-quality stream (1.5 Mbps, 15fps)
   * For audio: single stream with Opus DTX and FEC enabled
   */
  async createProducer(
    peer: Peer,
    transportId: string,
    kind: mediasoupTypes.MediaKind,
    rtpParameters: mediasoupTypes.RtpParameters,
    appData: { type: 'audio' | 'video' | 'screen' }
  ): Promise<mediasoupTypes.Producer> {
    const transport = peer.getSendTransport();
    if (!transport || transport.id !== transportId) {
      throw new Error('Send transport not found or ID mismatch');
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData,
    });

    peer.addProducer(producer);

    // Feed audio producers into the active-speaker observer (main room only).
    if (kind === 'audio') {
      this.addProducerToAudioObserver(producer).catch((err) => {
        log.warn('Failed to add producer to audio observer', {
          producerId: producer.id,
          error: err?.message,
        });
      });
    }

    // When the producer's transport closes (ICE failure, peer crash, etc.) the
    // producer dies too. Drop it locally AND tell remote peers so they remove
    // the corresponding video/audio tile instead of leaving a ghost tile.
    producer.on('transportclose', () => {
      log.debug('Producer transport closed', { producerId: producer.id });
      peer.removeProducer(producer.id);
      this.io
        ?.to(`meeting:${this.meetingCode}`)
        .emit('producer-closed', { producerId: producer.id, peerId: peer.socketId });
    });

    return producer;
  }

  // --- Active Speaker Detection ---

  /**
   * Lazily create the router's AudioLevelObserver and wire its events to
   * 'active-speaker' broadcasts. The observer emits 'volumes' at most once per
   * `interval` ms (throttled by mediasoup itself) and 'silence' when no one is
   * speaking.
   */
  private async ensureAudioLevelObserver(): Promise<mediasoupTypes.AudioLevelObserver> {
    if (this.audioLevelObserver) return this.audioLevelObserver;
    if (this.audioObserverPending) return this.audioObserverPending;

    this.audioObserverPending = this.router
      .createAudioLevelObserver({
        maxEntries: 1,
        threshold: -70,
        interval: 800,
      })
      .then((observer) => {
        this.audioLevelObserver = observer;

        // Someone is the loudest speaker.
        observer.on('volumes', (volumes) => {
          const top = volumes[0];
          if (!top) return;
          const producerId = top.producer.id;
          const owner = this.findPeerByProducerId(producerId);
          this.io?.to(`meeting:${this.meetingCode}`).emit('active-speaker', {
            peerId: owner?.socketId ?? null,
            participantId: owner?.participantId ?? null,
            producerId,
          });
        });

        // No one is speaking.
        observer.on('silence', () => {
          this.io?.to(`meeting:${this.meetingCode}`).emit('active-speaker', {
            peerId: null,
            participantId: null,
            producerId: null,
          });
        });

        return observer;
      });

    return this.audioObserverPending;
  }

  /**
   * Add an audio producer to the active-speaker observer so its volume is
   * tracked. Safe to call for any audio producer in the main room.
   */
  async addProducerToAudioObserver(producer: mediasoupTypes.Producer): Promise<void> {
    const observer = await this.ensureAudioLevelObserver();
    await observer.addProducer({ producerId: producer.id });
  }

  /** Find the main-room peer that owns the given producer id, if any. */
  private findPeerByProducerId(producerId: string): Peer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.getProducer(producerId)) return peer;
    }
    return undefined;
  }

  // --- Consumer Creation ---

  /**
   * Create a media consumer (incoming track) for a peer.
   * The consumer receives media from a specific producer.
   *
   * Before consuming, we check that the peer's device can handle the codec.
   * Consumers start paused to prevent overwhelming the client at startup.
   */
  async createConsumer(
    consumerPeer: Peer,
    producerPeer: Peer,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
    routerOverride?: mediasoupTypes.Router
  ): Promise<mediasoupTypes.Consumer | null> {
    const activeRouter = routerOverride || this.router;

    // Check if the consumer's device can consume this producer's codec
    if (!activeRouter.canConsume({ producerId, rtpCapabilities })) {
      log.warn('Cannot consume: incompatible codecs', {
        consumerId: consumerPeer.socketId,
        producerId,
      });
      return null;
    }

    const transport = consumerPeer.getRecvTransport();
    if (!transport) {
      log.warn('Cannot consume: no recv transport', { consumerId: consumerPeer.socketId });
      return null;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      // Start paused so the client can prepare its media elements
      // Client calls consumer.resume() when ready
      paused: true,
    });

    consumerPeer.addConsumer(consumer);

    // Clean up when the consumer's transport closes
    consumer.on('transportclose', () => {
      consumerPeer.removeConsumer(consumer.id);
    });

    // Clean up when the producer closes (remote peer left or stopped sharing)
    consumer.on('producerclose', () => {
      consumerPeer.removeConsumer(consumer.id);
    });

    return consumer;
  }

  // --- Breakout Room Management ---

  /**
   * Create a new breakout room with its own mediasoup Router.
   * Each breakout room is completely isolated - media from one
   * breakout room doesn't leak to another.
   */
  async createBreakoutRouter(
    breakoutRoomId: string,
    worker: mediasoupTypes.Worker
  ): Promise<mediasoupTypes.Router> {
    const breakoutRouter = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    this.breakoutRouters.set(breakoutRoomId, breakoutRouter);
    this.breakoutPeers.set(breakoutRoomId, new Map());
    log.info('Breakout router created', { meetingId: this.meetingId, breakoutRoomId });
    return breakoutRouter;
  }

  getBreakoutRouter(breakoutRoomId: string): mediasoupTypes.Router | undefined {
    return this.breakoutRouters.get(breakoutRoomId);
  }

  /**
   * Public accessor for the active breakout room IDs. Use this instead of
   * reaching into the private breakoutRouters map from other modules.
   */
  getBreakoutRoomIds(): string[] {
    return Array.from(this.breakoutRouters.keys());
  }

  /**
   * Move a peer from the main room to a breakout room.
   * The peer's main room transports are closed, and new ones
   * are created on the breakout router.
   */
  movePeerToBreakout(socketId: string, breakoutRoomId: string): Peer | undefined {
    const peer = this.peers.get(socketId);
    if (!peer) return undefined;

    // Remove from main room
    this.peers.delete(socketId);

    // Close existing transports (they're bound to the main router)
    peer.close();

    // Add to breakout room
    const breakoutPeerMap = this.breakoutPeers.get(breakoutRoomId);
    if (breakoutPeerMap) {
      // Create a new Peer instance since the old one was closed
      const newPeer = new Peer(
        peer.socketId,
        peer.participantId,
        peer.userId,
        peer.userName,
        peer.userEmail,
        peer.userImage
      );
      breakoutPeerMap.set(socketId, newPeer);
      return newPeer;
    }
    return undefined;
  }

  /**
   * Move a peer from a breakout room back to the main room.
   */
  movePeerToMain(socketId: string): Peer | undefined {
    // Find which breakout room the peer is in
    for (const [breakoutId, breakoutPeerMap] of this.breakoutPeers) {
      const peer = breakoutPeerMap.get(socketId);
      if (peer) {
        peer.close();
        breakoutPeerMap.delete(socketId);

        // Create new peer in main room
        const newPeer = new Peer(
          peer.socketId,
          peer.participantId,
          peer.userId,
          peer.userName,
          peer.userEmail,
          peer.userImage
        );
        this.peers.set(socketId, newPeer);
        return newPeer;
      }
    }
    return undefined;
  }

  /**
   * Close all breakout rooms and move everyone back to the main room.
   * Called when the host ends the breakout session.
   */
  closeAllBreakouts(): string[] {
    const movedSocketIds: string[] = [];

    for (const [breakoutId, breakoutPeerMap] of this.breakoutPeers) {
      for (const [socketId, peer] of breakoutPeerMap) {
        peer.close();
        const newPeer = new Peer(
          peer.socketId,
          peer.participantId,
          peer.userId,
          peer.userName,
          peer.userEmail,
          peer.userImage
        );
        this.peers.set(socketId, newPeer);
        movedSocketIds.push(socketId);
      }
    }

    // Close all breakout routers
    for (const router of this.breakoutRouters.values()) {
      router.close();
    }
    this.breakoutRouters.clear();
    this.breakoutPeers.clear();

    log.info('All breakout rooms closed', {
      meetingId: this.meetingId,
      movedPeers: movedSocketIds.length,
    });

    return movedSocketIds;
  }

  getBreakoutPeers(breakoutRoomId: string): Map<string, Peer> {
    return this.breakoutPeers.get(breakoutRoomId) || new Map();
  }

  /**
   * Return the breakout room ID a peer currently belongs to, or undefined if
   * the peer is in the main room (or not present). Useful on disconnect so we
   * can notify the right breakout room before the peer is removed.
   */
  findBreakoutRoomId(socketId: string): string | undefined {
    for (const [breakoutId, breakoutPeerMap] of this.breakoutPeers) {
      if (breakoutPeerMap.has(socketId)) return breakoutId;
    }
    return undefined;
  }

  // --- Room Cleanup ---

  /**
   * Close the entire room. Called when the meeting ends.
   * Closes all peers, breakout rooms, and the main router.
   */
  close(): void {
    log.info('Closing room', { meetingId: this.meetingId });

    // Close all peers in main room
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();

    // Close the active-speaker observer (it lives on the main router).
    if (this.audioLevelObserver) {
      this.audioLevelObserver.close();
      this.audioLevelObserver = null;
    }
    this.audioObserverPending = null;

    // Close all breakout rooms (also closes every breakout router).
    this.closeAllBreakouts();

    // Close the main router (this implicitly closes any breakout routers that
    // were not already closed above).
    this.router.close();
  }

  isEmpty(): boolean {
    return this.getPeerCount() === 0;
  }
}
