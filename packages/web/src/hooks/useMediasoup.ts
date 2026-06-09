// =============================================================================
// useMediasoup Hook
// Manages the entire mediasoup-client lifecycle:
// - Device initialization with router capabilities
// - Send/recv transport creation and DTLS handshake
// - Audio/video/screen producing with simulcast
// - Consuming remote peers' media streams
// - Network-adaptive quality (audio > screen > video priority)
//
// This is the most complex hook in the application.
// It bridges React state with mediasoup's event-driven API.
// =============================================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Device, types as mediasoupTypes } from 'mediasoup-client';
import { Socket } from 'socket.io-client';
import type { PeerMedia, TransportOptions } from '@/types';

interface UseMediasoupProps {
  socket: Socket | null;
  isConnected: boolean;
}

interface UseMediasoupReturn {
  device: Device | null;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  peers: Map<string, PeerMedia>;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  // Control functions
  toggleAudio: () => void;
  toggleVideo: () => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  initializeMedia: (routerCapabilities: mediasoupTypes.RtpCapabilities) => Promise<void>;
  consumeProducer: (producerId: string, peerId: string, participantId: string, userName: string, userImage: string | null, kind: string, appData: any) => Promise<void>;
}

export function useMediasoup({ socket, isConnected }: UseMediasoupProps): UseMediasoupReturn {
  // --- State ---
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, PeerMedia>>(new Map());
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // --- Refs (persist across renders without triggering re-renders) ---
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<mediasoupTypes.Transport | null>(null);
  const recvTransportRef = useRef<mediasoupTypes.Transport | null>(null);
  const producersRef = useRef<Map<string, mediasoupTypes.Producer>>(new Map());
  const consumersRef = useRef<Map<string, mediasoupTypes.Consumer>>(new Map());
  // ICE servers (STUN/TURN) fetched from the media server. Required for users
  // behind restrictive/symmetric NAT (e.g. off-campus / mobile data) — without
  // TURN they would silently fail to connect.
  const iceServersRef = useRef<RTCIceServer[]>([]);

  // -------------------------------------------------------------------------
  // INITIALIZE MEDIA
  // Called after joining a meeting and receiving routerCapabilities.
  // Steps: create Device → load capabilities → get user media → create transports → produce
  // -------------------------------------------------------------------------
  const initializeMedia = useCallback(async (
    routerCapabilities: mediasoupTypes.RtpCapabilities
  ) => {
    if (!socket) return;

    try {
      // 1. Create and load the mediasoup Device
      // The Device determines which codecs/features the browser supports
      const device = new Device();
      await device.load({ routerRtpCapabilities: routerCapabilities });
      deviceRef.current = device;

      // 1b. Fetch time-limited TURN/STUN credentials so both transports can
      // traverse NAT. Same-origin path; the reverse proxy routes /media -> SFU.
      try {
        const res = await fetch('/media/turn-credentials');
        if (res.ok) {
          const t = await res.json();
          const urls: string[] = Array.isArray(t.urls) ? t.urls : [];
          const turnUrls = urls.filter((u) => u.startsWith('turn'));
          const stunUrls = urls.filter((u) => u.startsWith('stun'));
          const servers: RTCIceServer[] = [];
          if (turnUrls.length) servers.push({ urls: turnUrls, username: t.username, credential: t.credential });
          if (stunUrls.length) servers.push({ urls: stunUrls });
          iceServersRef.current = servers;
        }
      } catch (e) {
        console.warn('TURN credential fetch failed; continuing without relay (LAN-only)', e);
      }

      // 2. Get user's camera and microphone
      // Start with both audio and video; user can toggle later
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,   // Remove echo from speakers
          noiseSuppression: true,   // Reduce background noise
          autoGainControl: true,    // Normalize volume levels
        },
        video: {
          width: { ideal: 1280 },   // 720p ideal, browser adjusts if needed
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      setLocalStream(stream);

      // 3. Create send transport (for producing our audio/video/screen)
      await createSendTransport(device, socket);

      // 4. Create recv transport (for consuming others' media)
      await createRecvTransport(device, socket);

      // 5. Start producing audio and video
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];

      if (audioTrack) {
        await produce(audioTrack, 'audio');
      }
      if (videoTrack) {
        await produce(videoTrack, 'video');
      }
    } catch (err: any) {
      console.error('Failed to initialize media:', err);
      // If video fails (e.g., no camera), try audio-only
      // Audio is the highest priority
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setLocalStream(audioStream);
        const audioTrack = audioStream.getAudioTracks()[0];
        if (audioTrack) await produce(audioTrack, 'audio');
      } catch {
        console.error('Failed to get even audio');
      }
    }
  }, [socket]);

  // -------------------------------------------------------------------------
  // CREATE SEND TRANSPORT
  // Used for producing (sending) our media to the SFU
  // -------------------------------------------------------------------------
  async function createSendTransport(device: Device, socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.emit('create-transport', { direction: 'send' }, async (data: any) => {
        if (data.error) return reject(new Error(data.error));

        const transport = device.createSendTransport({
          id: data.id,
          iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
          // ICE servers (STUN/TURN) for NAT traversal
          iceServers: iceServersRef.current,
        });

        // Handle transport 'connect' event (DTLS handshake)
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit('connect-transport', {
            transportId: transport.id,
            dtlsParameters,
          }, (response: any) => {
            if (response.error) errback(new Error(response.error));
            else callback();
          });
        });

        // Handle transport 'produce' event (new media track)
        transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
          socket.emit('produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
            appData,
          }, (response: any) => {
            if (response.error) errback(new Error(response.error));
            else callback({ id: response.producerId });
          });
        });

        sendTransportRef.current = transport;
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // CREATE RECV TRANSPORT
  // Used for consuming (receiving) other peers' media
  // -------------------------------------------------------------------------
  async function createRecvTransport(device: Device, socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.emit('create-transport', { direction: 'recv' }, async (data: any) => {
        if (data.error) return reject(new Error(data.error));

        const transport = device.createRecvTransport({
          id: data.id,
          iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
          iceServers: iceServersRef.current,
        });

        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit('connect-transport', {
            transportId: transport.id,
            dtlsParameters,
          }, (response: any) => {
            if (response.error) errback(new Error(response.error));
            else callback();
          });
        });

        recvTransportRef.current = transport;
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // PRODUCE MEDIA TRACK
  // Creates a mediasoup Producer for a given track (audio, video, or screen).
  // Video uses simulcast (3 quality layers) for adaptive quality.
  // Screen share uses high bitrate / low framerate for crisp text.
  // Audio uses Opus with DTX and FEC for reliability.
  // -------------------------------------------------------------------------
  async function produce(
    track: MediaStreamTrack,
    type: 'audio' | 'video' | 'screen'
  ): Promise<void> {
    const transport = sendTransportRef.current;
    if (!transport) return;

    let encodings: mediasoupTypes.RtpEncodingParameters[] | undefined;

    if (type === 'video') {
      // Simulcast: 3 quality layers for adaptive video
      // The SFU selects the appropriate layer based on receiver bandwidth
      encodings = [
        { rid: 'r0', maxBitrate: 100000, scaleResolutionDownBy: 4 },   // 320x180
        { rid: 'r1', maxBitrate: 300000, scaleResolutionDownBy: 2 },   // 640x360
        { rid: 'r2', maxBitrate: 900000, scaleResolutionDownBy: 1 },   // 1280x720
      ];
    } else if (type === 'screen') {
      // Screen share: single high-quality layer (no simulcast needed)
      // Higher bitrate for crisp text, lower framerate since screen is mostly static
      encodings = [
        { maxBitrate: 1500000, maxFramerate: 15 },
      ];
    }
    // Audio: no encodings needed (Opus handles adaptation internally)

    const producer = await transport.produce({
      track,
      encodings,
      appData: { type },
    });

    producersRef.current.set(type, producer);

    // Handle track ending (e.g., user revokes camera permission)
    producer.on('trackended', () => {
      if (type === 'screen') {
        setIsScreenSharing(false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // CONSUME REMOTE PEER'S MEDIA
  // Creates a Consumer for a specific Producer from another peer.
  // The Consumer's track is added to a PeerMedia object for rendering.
  // -------------------------------------------------------------------------
  async function consume(
    producerId: string,
    peerId: string,
    participantId: string,
    userName: string,
    userImage: string | null,
    kind: string,
    appData: any
  ): Promise<void> {
    if (!socket || !deviceRef.current || !recvTransportRef.current) return;

    return new Promise((resolve) => {
      socket.emit('consume', {
        producerId,
        rtpCapabilities: deviceRef.current!.rtpCapabilities,
      }, async (data: any) => {
        if (data.error) {
          console.error('Failed to consume:', data.error);
          return resolve();
        }

        const consumer = await recvTransportRef.current!.consume({
          id: data.id,
          producerId: data.producerId,
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });

        consumersRef.current.set(consumer.id, consumer);

        // Update peers state with the new consumer
        setPeers((prev) => {
          const updated = new Map(prev);
          const existing = updated.get(peerId) || {
            peerId,
            participantId,
            userName,
            userImage,
            consumers: new Map(),
            audioEnabled: true,
            videoEnabled: true,
            screenSharing: false,
          };

          existing.consumers.set(consumer.id, consumer);

          // Track what type of media this peer is sending
          if (appData?.type === 'screen') existing.screenSharing = true;

          updated.set(peerId, existing);
          return updated;
        });

        // Resume the consumer (it starts paused on the server)
        socket.emit('resume-consumer', { consumerId: consumer.id }, () => {
          resolve();
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // SOCKET EVENT LISTENERS
  // Listen for events about other peers' media changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !isConnected) return;

    // New producer: another peer started sharing audio/video/screen
    socket.on('new-producer', async (data: any) => {
      await consume(
        data.producerId,
        data.peerId,
        data.participantId,
        data.userName,
        data.userImage,
        data.kind,
        data.appData
      );
    });

    // Producer closed: another peer stopped sharing
    socket.on('producer-closed', (data: { producerId: string; peerId: string }) => {
      // Find and remove the consumer for this producer
      for (const [consumerId, consumer] of consumersRef.current) {
        if (consumer.producerId === data.producerId) {
          consumer.close();
          consumersRef.current.delete(consumerId);

          // Update peers state
          setPeers((prev) => {
            const updated = new Map(prev);
            const peer = updated.get(data.peerId);
            if (peer) {
              peer.consumers.delete(consumerId);
              if (peer.consumers.size === 0) {
                updated.delete(data.peerId);
              }
            }
            return updated;
          });
          break;
        }
      }
    });

    // Peer left: remove all their consumers
    socket.on('participant-left', (data: { socketId: string }) => {
      setPeers((prev) => {
        const updated = new Map(prev);
        const peer = updated.get(data.socketId);
        if (peer) {
          for (const consumer of peer.consumers.values()) {
            consumer.close();
            consumersRef.current.delete(consumer.id);
          }
          updated.delete(data.socketId);
        }
        return updated;
      });
    });

    // Producer paused/resumed: update peer's audio/video status
    socket.on('producer-paused', (data: { producerId: string; peerId: string }) => {
      setPeers((prev) => {
        const updated = new Map(prev);
        const peer = updated.get(data.peerId);
        if (peer) {
          // Determine which type of producer was paused
          for (const consumer of peer.consumers.values()) {
            if (consumer.producerId === data.producerId) {
              if (consumer.kind === 'audio') peer.audioEnabled = false;
              if (consumer.kind === 'video') peer.videoEnabled = false;
            }
          }
        }
        return updated;
      });
    });

    socket.on('producer-resumed', (data: { producerId: string; peerId: string }) => {
      setPeers((prev) => {
        const updated = new Map(prev);
        const peer = updated.get(data.peerId);
        if (peer) {
          for (const consumer of peer.consumers.values()) {
            if (consumer.producerId === data.producerId) {
              if (consumer.kind === 'audio') peer.audioEnabled = true;
              if (consumer.kind === 'video') peer.videoEnabled = true;
            }
          }
        }
        return updated;
      });
    });

    return () => {
      socket.off('new-producer');
      socket.off('producer-closed');
      socket.off('participant-left');
      socket.off('producer-paused');
      socket.off('producer-resumed');
    };
  }, [socket, isConnected]);

  // -------------------------------------------------------------------------
  // MEDIA CONTROLS
  // Toggle audio, video, and screen share
  // -------------------------------------------------------------------------

  const toggleAudio = useCallback(() => {
    const producer = producersRef.current.get('audio');
    if (!producer || !socket) return;

    if (producer.paused) {
      producer.resume();
      socket.emit('resume-producer', { producerId: producer.id });
      setIsAudioEnabled(true);
    } else {
      producer.pause();
      socket.emit('pause-producer', { producerId: producer.id });
      setIsAudioEnabled(false);
    }
  }, [socket]);

  const toggleVideo = useCallback(() => {
    const producer = producersRef.current.get('video');
    if (!producer || !socket) return;

    if (producer.paused) {
      producer.resume();
      socket.emit('resume-producer', { producerId: producer.id });
      setIsVideoEnabled(true);
    } else {
      producer.pause();
      socket.emit('pause-producer', { producerId: producer.id });
      setIsVideoEnabled(false);
    }
  }, [socket]);

  const startScreenShare = useCallback(async () => {
    if (!sendTransportRef.current) return;

    try {
      // Request screen capture from the browser
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 15, max: 30 },  // Lower framerate for screen (saves bandwidth)
        },
        audio: false, // Screen audio is rarely needed
      });

      const screenTrack = stream.getVideoTracks()[0];
      setScreenStream(stream);
      setIsScreenSharing(true);

      await produce(screenTrack, 'screen');

      // Handle user stopping screen share via browser's native "Stop sharing" button
      screenTrack.onended = () => {
        stopScreenShare();
      };
    } catch (err: any) {
      // User cancelled the screen share dialog
      console.log('Screen share cancelled or failed:', err.message);
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    const producer = producersRef.current.get('screen');
    if (producer && socket) {
      socket.emit('close-producer', { producerId: producer.id });
      producer.close();
      producersRef.current.delete('screen');
    }

    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
    }
    setIsScreenSharing(false);
  }, [socket, screenStream]);

  // -------------------------------------------------------------------------
  // CLEANUP
  // Close all producers, consumers, and transports when unmounting
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      // Close all producers
      for (const producer of producersRef.current.values()) {
        producer.close();
      }
      producersRef.current.clear();

      // Close all consumers
      for (const consumer of consumersRef.current.values()) {
        consumer.close();
      }
      consumersRef.current.clear();

      // Close transports
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();

      // Stop local media tracks
      localStream?.getTracks().forEach((t) => t.stop());
      screenStream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Exposed consume function for existing producers when joining a room
  const consumeProducer = useCallback(async (
    producerId: string,
    peerId: string,
    participantId: string,
    userName: string,
    userImage: string | null,
    kind: string,
    appData: any
  ) => {
    await consume(producerId, peerId, participantId, userName, userImage, kind, appData);
  }, [socket, isConnected]);

  return {
    device: deviceRef.current,
    localStream,
    screenStream,
    peers,
    isAudioEnabled,
    isVideoEnabled,
    isScreenSharing,
    toggleAudio,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    initializeMedia,
    consumeProducer,
  };
}
