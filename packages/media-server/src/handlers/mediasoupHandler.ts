// =============================================================================
// mediasoup Signaling Handler
// Handles all WebRTC transport/producer/consumer lifecycle events.
// This is the bridge between mediasoup-client (browser) and mediasoup (server).
//
// Flow for a new peer:
// 1. Client receives routerCapabilities from 'meeting-joined' event
// 2. Client creates mediasoup Device and loads capabilities
// 3. Client requests 'create-transport' (send) → gets transport params
// 4. Client requests 'create-transport' (recv) → gets transport params
// 5. Client calls 'connect-transport' for DTLS handshake
// 6. Client calls 'produce' to start sending audio/video/screen
// 7. Client calls 'consume' for each existing producer to start receiving
// =============================================================================

import { Socket, Server as SocketServer } from 'socket.io';
import { Room } from '../services/Room';
import { checkRateLimit } from '../middleware/rateLimiter';
import { SIMULCAST_ENCODINGS, SCREEN_SHARE_ENCODING } from '../config/mediasoup';
import { createLogger } from '../utils/logger';
import { types as mediasoupTypes } from 'mediasoup';

const log = createLogger('MediasoupHandler');

/**
 * Register mediasoup signaling event handlers on a socket.
 *
 * @param io - Socket.IO server instance
 * @param socket - The connected socket
 * @param rooms - Global room map
 */
export function registerMediasoupHandlers(
  io: SocketServer,
  socket: Socket,
  rooms: Map<string, Room>
): void {

  // -------------------------------------------------------------------------
  // CREATE TRANSPORT
  // Client requests a WebRTC transport for either sending or receiving.
  // Returns ICE/DTLS parameters that the client needs for the handshake.
  // -------------------------------------------------------------------------
  socket.on('create-transport', async (
    data: { direction: 'send' | 'recv' },
    callback: Function
  ) => {
    if (!checkRateLimit(socket, 'create-transport')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return callback({ error: 'Not in a meeting' });

      const peer = room.getPeer(socket.id);
      if (!peer) return callback({ error: 'Peer not found' });

      // Create the transport on the Room's router
      const transport = await room.createTransport(data.direction, peer);

      // Return transport parameters to the client
      // The client uses these to initialize its local transport
      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (err: any) {
      log.error('Error creating transport', { error: err.message });
      callback({ error: 'Failed to create transport' });
    }
  });

  // -------------------------------------------------------------------------
  // CONNECT TRANSPORT
  // Client sends DTLS parameters to complete the WebRTC handshake.
  // After this, the transport is ready for media.
  // -------------------------------------------------------------------------
  socket.on('connect-transport', async (
    data: { transportId: string; dtlsParameters: mediasoupTypes.DtlsParameters },
    callback: Function
  ) => {
    if (!checkRateLimit(socket, 'connect-transport')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return callback({ error: 'Not in a meeting' });

      const peer = room.getPeer(socket.id);
      if (!peer) return callback({ error: 'Peer not found' });

      // Find the transport by ID (could be send or recv)
      const sendTransport = peer.getSendTransport();
      const recvTransport = peer.getRecvTransport();
      let transport = null;

      if (sendTransport?.id === data.transportId) {
        transport = sendTransport;
      } else if (recvTransport?.id === data.transportId) {
        transport = recvTransport;
      }

      if (!transport) return callback({ error: 'Transport not found' });

      // Complete the DTLS handshake
      await transport.connect({ dtlsParameters: data.dtlsParameters });

      callback({ connected: true });
    } catch (err: any) {
      log.error('Error connecting transport', { error: err.message });
      callback({ error: 'Failed to connect transport' });
    }
  });

  // -------------------------------------------------------------------------
  // PRODUCE
  // Client starts sending a media track (audio, video, or screen share).
  // The server creates a Producer and notifies all other peers.
  // -------------------------------------------------------------------------
  socket.on('produce', async (
    data: {
      transportId: string;
      kind: mediasoupTypes.MediaKind;
      rtpParameters: mediasoupTypes.RtpParameters;
      appData: { type: 'audio' | 'video' | 'screen' };
    },
    callback: Function
  ) => {
    if (!checkRateLimit(socket, 'produce')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return callback({ error: 'Not in a meeting' });

      const peer = room.getPeer(socket.id);
      if (!peer) return callback({ error: 'Peer not found' });

      // Enforce only one screen share at a time across all peers
      if (data.appData.type === 'screen') {
        for (const [sid, p] of room.getPeers()) {
          if (sid === socket.id) continue;
          for (const [, producer] of p.getProducers()) {
            if ((producer.appData as any)?.type === 'screen' && !producer.closed) {
              return callback({ error: 'Someone is already sharing their screen' });
            }
          }
        }
      }

      // Create the producer on the peer's send transport
      const producer = await room.createProducer(
        peer,
        data.transportId,
        data.kind,
        data.rtpParameters,
        data.appData
      );

      // Notify all other peers in the room about this new producer
      // They'll create consumers to receive this stream
      socket.to(`meeting:${socket.data.meetingCode}`).emit('new-producer', {
        peerId: socket.id,
        participantId: peer.participantId,
        producerId: producer.id,
        kind: producer.kind,
        appData: producer.appData,
        userName: peer.userName,
        userImage: peer.userImage,
      });

      callback({ producerId: producer.id });
    } catch (err: any) {
      log.error('Error producing', { error: err.message });
      callback({ error: 'Failed to produce' });
    }
  });

  // -------------------------------------------------------------------------
  // CONSUME
  // Client wants to receive a specific producer's media.
  // The server creates a Consumer and returns its parameters.
  // -------------------------------------------------------------------------
  socket.on('consume', async (
    data: { producerId: string; rtpCapabilities: mediasoupTypes.RtpCapabilities },
    callback?: Function
  ) => {
    if (!checkRateLimit(socket, 'consume')) return;

    // Support both callback and event-based responses
    const respond = (result: any) => {
      if (typeof callback === 'function') {
        callback(result);
      } else if (result.error) {
        socket.emit('consume-error', result);
      } else {
        socket.emit('consume-result', result);
      }
    };

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return respond({ error: 'Not in a meeting' });

      const consumerPeer = room.getPeer(socket.id);
      if (!consumerPeer) return respond({ error: 'Peer not found' });

      // Find the producer's peer
      let producerPeer: any = null;
      for (const [, p] of room.getPeers()) {
        if (p.getProducer(data.producerId)) {
          producerPeer = p;
          break;
        }
      }
      if (!producerPeer) return respond({ error: 'Producer not found' });

      // Create the consumer
      const consumer = await room.createConsumer(
        consumerPeer,
        producerPeer,
        data.producerId,
        data.rtpCapabilities
      );

      if (!consumer) return respond({ error: 'Cannot consume this producer' });

      // Use the producer's appData (not the server consumer's empty appData)
      // so the client can identify screen share consumers via appData.type === 'screen'
      const producerObj = producerPeer.getProducer(data.producerId);
      const producerAppData = producerObj?.appData || {};

      respond({
        id: consumer.id,
        producerId: data.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: producerAppData,
      });
    } catch (err: any) {
      log.error('Error consuming', { error: err.message });
      respond({ error: 'Failed to consume' });
    }
  });

  // -------------------------------------------------------------------------
  // RESUME CONSUMER
  // Client has set up its media element and is ready to receive data.
  // Consumers start paused to give the client time to set up.
  // -------------------------------------------------------------------------
  socket.on('resume-consumer', async (
    data: { consumerId: string },
    callback: Function
  ) => {
    if (!checkRateLimit(socket, 'resume-consumer')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return callback({ error: 'Not in a meeting' });

      const peer = room.getPeer(socket.id);
      if (!peer) return callback({ error: 'Peer not found' });

      const consumer = peer.getConsumers().get(data.consumerId);
      if (!consumer) return callback({ error: 'Consumer not found' });

      await consumer.resume();
      callback({ resumed: true });
    } catch (err: any) {
      log.error('Error resuming consumer', { error: err.message });
      callback({ error: 'Failed to resume consumer' });
    }
  });

  // -------------------------------------------------------------------------
  // SET PREFERRED LAYERS
  // Client requests a specific simulcast quality layer.
  // Used by the network optimizer to adapt to bandwidth changes.
  // -------------------------------------------------------------------------
  socket.on('set-preferred-layers', async (
    data: { consumerId: string; spatialLayer: number; temporalLayer: number },
    callback?: Function
  ) => {
    if (!checkRateLimit(socket, 'set-preferred-layers')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return;

      const peer = room.getPeer(socket.id);
      if (!peer) return;

      const consumer = peer.getConsumers().get(data.consumerId);
      if (!consumer) return;

      // Set the preferred quality layer for this consumer
      await consumer.setPreferredLayers({
        spatialLayer: data.spatialLayer,
        temporalLayer: data.temporalLayer,
      });

      if (callback) callback({ success: true });
    } catch (err: any) {
      log.error('Error setting layers', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // PAUSE/RESUME PRODUCER
  // Client mutes/unmutes their audio or disables/enables video.
  // -------------------------------------------------------------------------
  socket.on('pause-producer', async (
    data: { producerId: string },
    callback?: Function
  ) => {
    if (!checkRateLimit(socket, 'pause-producer')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return;

      const peer = room.getPeer(socket.id);
      if (!peer) return;

      const producer = peer.getProducer(data.producerId);
      if (!producer) return;

      await producer.pause();

      // Notify other peers so they can show muted indicator
      socket.to(`meeting:${socket.data.meetingCode}`).emit('producer-paused', {
        producerId: data.producerId,
        peerId: socket.id,
      });

      if (callback) callback({ paused: true });
    } catch (err: any) {
      log.error('Error pausing producer', { error: err.message });
    }
  });

  socket.on('resume-producer', async (
    data: { producerId: string },
    callback?: Function
  ) => {
    if (!checkRateLimit(socket, 'resume-producer')) return;

    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return;

      const peer = room.getPeer(socket.id);
      if (!peer) return;

      const producer = peer.getProducer(data.producerId);
      if (!producer) return;

      await producer.resume();

      socket.to(`meeting:${socket.data.meetingCode}`).emit('producer-resumed', {
        producerId: data.producerId,
        peerId: socket.id,
      });

      if (callback) callback({ resumed: true });
    } catch (err: any) {
      log.error('Error resuming producer', { error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // CLOSE PRODUCER
  // Client stops sharing a media track (e.g., stops screen share).
  // -------------------------------------------------------------------------
  socket.on('close-producer', async (
    data: { producerId: string },
    callback?: Function
  ) => {
    try {
      const room = rooms.get(socket.data.meetingCode);
      if (!room) return;

      const peer = room.getPeer(socket.id);
      if (!peer) return;

      const producer = peer.getProducer(data.producerId);
      if (!producer) return;

      producer.close();
      peer.removeProducer(data.producerId);

      // Notify other peers to remove this stream
      socket.to(`meeting:${socket.data.meetingCode}`).emit('producer-closed', {
        producerId: data.producerId,
        peerId: socket.id,
      });

      if (callback) callback({ closed: true });
    } catch (err: any) {
      log.error('Error closing producer', { error: err.message });
    }
  });
}
