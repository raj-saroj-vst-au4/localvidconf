// =============================================================================
// Peer Service
// Manages per-peer state: WebRTC transports, media producers, and consumers.
// Each peer has:
// - 1 send transport (for their audio/video/screen streams)
// - 1 recv transport (for receiving other peers' streams)
// - N producers (their outgoing media tracks)
// - N consumers (incoming media tracks from other peers)
//
// Lifecycle: created on join → producers/consumers added during meeting → closed on leave
// =============================================================================

import { types as mediasoupTypes } from 'mediasoup';
import { createLogger } from '../utils/logger';

const log = createLogger('Peer');

export class Peer {
  // Unique identifiers
  readonly socketId: string;       // Socket.IO connection ID
  readonly participantId: string;  // Database participant record ID
  readonly userId: string;         // Database user ID
  readonly userName: string;
  readonly userEmail: string;
  readonly userImage: string | null;

  // WebRTC transports (one for sending, one for receiving)
  private sendTransport: mediasoupTypes.WebRtcTransport | null = null;
  private recvTransport: mediasoupTypes.WebRtcTransport | null = null;

  // Media tracks being sent by this peer
  // Key: producer ID, Value: mediasoup Producer
  private producers: Map<string, mediasoupTypes.Producer> = new Map();

  // Media tracks being received by this peer from other peers
  // Key: consumer ID, Value: mediasoup Consumer
  private consumers: Map<string, mediasoupTypes.Consumer> = new Map();

  constructor(
    socketId: string,
    participantId: string,
    userId: string,
    userName: string,
    userEmail: string,
    userImage: string | null
  ) {
    this.socketId = socketId;
    this.participantId = participantId;
    this.userId = userId;
    this.userName = userName;
    this.userEmail = userEmail;
    this.userImage = userImage;
    log.info('Peer created', { socketId, userId, userName });
  }

  // --- Transport Management ---

  setSendTransport(transport: mediasoupTypes.WebRtcTransport): void {
    this.sendTransport = transport;
  }

  setRecvTransport(transport: mediasoupTypes.WebRtcTransport): void {
    this.recvTransport = transport;
  }

  getSendTransport(): mediasoupTypes.WebRtcTransport | null {
    return this.sendTransport;
  }

  getRecvTransport(): mediasoupTypes.WebRtcTransport | null {
    return this.recvTransport;
  }

  // --- Producer Management ---
  // Producers represent outgoing media tracks (audio, video, screen share)

  addProducer(producer: mediasoupTypes.Producer): void {
    this.producers.set(producer.id, producer);
    log.debug('Producer added', {
      peerId: this.socketId,
      producerId: producer.id,
      kind: producer.kind,
      type: producer.appData?.type,
    });
  }

  removeProducer(producerId: string): void {
    this.producers.delete(producerId);
    log.debug('Producer removed', { peerId: this.socketId, producerId });
  }

  getProducer(producerId: string): mediasoupTypes.Producer | undefined {
    return this.producers.get(producerId);
  }

  getProducers(): Map<string, mediasoupTypes.Producer> {
    return this.producers;
  }

  /**
   * Find a producer by its media type (audio, video, screen).
   * Used when the client wants to mute/unmute a specific track type.
   */
  getProducerByType(type: string): mediasoupTypes.Producer | undefined {
    for (const producer of this.producers.values()) {
      if (producer.appData?.type === type) return producer;
    }
    return undefined;
  }

  // --- Consumer Management ---
  // Consumers represent incoming media tracks from other peers

  addConsumer(consumer: mediasoupTypes.Consumer): void {
    this.consumers.set(consumer.id, consumer);
  }

  removeConsumer(consumerId: string): void {
    this.consumers.delete(consumerId);
  }

  getConsumers(): Map<string, mediasoupTypes.Consumer> {
    return this.consumers;
  }

  // --- Cleanup ---
  // Called when the peer disconnects. Closes all transports, which
  // automatically closes all associated producers and consumers.

  close(): void {
    log.info('Closing peer', { socketId: this.socketId, userName: this.userName });

    // Close all producers first
    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

    // Close all consumers
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    // Close transports (this also closes any remaining producers/consumers)
    if (this.sendTransport) {
      this.sendTransport.close();
      this.sendTransport = null;
    }
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = null;
    }
  }
}
