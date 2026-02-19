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
import { Peer } from './Peer';
import { WEBRTC_TRANSPORT_OPTIONS, MEDIA_CODECS, SIMULCAST_ENCODINGS, SCREEN_SHARE_ENCODING } from '../config/mediasoup';
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

  // --- Router Access ---

  getRouter(): mediasoupTypes.Router {
    return this.router;
  }

  getRouterCapabilities(): mediasoupTypes.RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  // --- Peer Management ---

  addPeer(peer: Peer): void {
    this.peers.set(peer.socketId, peer);
    log.info('Peer joined room', {
      meetingId: this.meetingId,
      socketId: peer.socketId,
      userName: peer.userName,
      peerCount: this.peers.size,
    });
  }

  removePeer(socketId: string): Peer | undefined {
    const peer = this.peers.get(socketId);
    if (peer) {
      peer.close(); // Clean up all transports/producers/consumers
      this.peers.delete(socketId);
      log.info('Peer left room', {
        meetingId: this.meetingId,
        socketId,
        peerCount: this.peers.size,
      });
    }

    // Also check breakout rooms
    for (const [breakoutId, breakoutPeerMap] of this.breakoutPeers) {
      const breakoutPeer = breakoutPeerMap.get(socketId);
      if (breakoutPeer) {
        breakoutPeer.close();
        breakoutPeerMap.delete(socketId);
      }
    }

    return peer;
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

    // Set max incoming bitrate to prevent bandwidth abuse
    await transport.setMaxIncomingBitrate(10000000); // 10 Mbps

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

    // When the producer closes, notify all consumers
    producer.on('transportclose', () => {
      log.debug('Producer transport closed', { producerId: producer.id });
      peer.removeProducer(producer.id);
    });

    return producer;
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

    // Close all breakout rooms
    this.closeAllBreakouts();

    // Close the main router
    this.router.close();
  }

  isEmpty(): boolean {
    return this.getPeerCount() === 0;
  }
}
