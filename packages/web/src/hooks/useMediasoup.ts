// =============================================================================
// useMediasoup Hook
// Manages the entire mediasoup-client lifecycle:
// - Device initialization with router capabilities
// - Send/recv transport creation and DTLS handshake
// - Audio/video/screen producing with simulcast
// - Consuming remote peers' media streams
// - Network-adaptive quality (audio > screen > video priority)
// - Device enumeration and selection (camera/mic switching)
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
  // Device selection
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  selectedVideoDeviceId: string | null;
  selectedAudioDeviceId: string | null;
  selectVideoDevice: (deviceId: string) => Promise<void>;
  selectAudioDevice: (deviceId: string) => Promise<void>;
  // Control functions
  toggleAudio: () => void;
  toggleVideo: () => Promise<void>;
  // Returns null on success, error message string on failure
  startScreenShare: () => Promise<string | null>;
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
  // Device lists
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string | null>(null);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string | null>(null);

  // --- Refs (persist across renders without triggering re-renders) ---
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<mediasoupTypes.Transport | null>(null);
  const recvTransportRef = useRef<mediasoupTypes.Transport | null>(null);
  const producersRef = useRef<Map<string, mediasoupTypes.Producer>>(new Map());
  const consumersRef = useRef<Map<string, mediasoupTypes.Consumer>>(new Map());
  // Refs to avoid stale closures in callbacks
  const localStreamRef = useRef<MediaStream | null>(null);
  const isVideoEnabledRef = useRef(true);
  const selectedVideoDeviceIdRef = useRef<string | null>(null);
  const selectedAudioDeviceIdRef = useRef<string | null>(null);
  // Refs for screen share state to avoid stale closures
  const screenStreamRef = useRef<MediaStream | null>(null);
  const isScreenSharingRef = useRef(false);
  const peersRef = useRef<Map<string, PeerMedia>>(new Map());
  // Ref to stopScreenShare so startScreenShare's onended handler is never stale
  const stopScreenShareRef = useRef<() => void>(() => {});

  // Keep refs in sync with state
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { isVideoEnabledRef.current = isVideoEnabled; }, [isVideoEnabled]);
  useEffect(() => { selectedVideoDeviceIdRef.current = selectedVideoDeviceId; }, [selectedVideoDeviceId]);
  useEffect(() => { selectedAudioDeviceIdRef.current = selectedAudioDeviceId; }, [selectedAudioDeviceId]);
  useEffect(() => { screenStreamRef.current = screenStream; }, [screenStream]);
  useEffect(() => { isScreenSharingRef.current = isScreenSharing; }, [isScreenSharing]);
  useEffect(() => { peersRef.current = peers; }, [peers]);

  // -------------------------------------------------------------------------
  // ENUMERATE DEVICES
  // Called after getUserMedia (permission grant unlocks device labels).
  // Also called on devicechange events for hot-plug support.
  // -------------------------------------------------------------------------
  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
      setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
    } catch {
      // enumerateDevices is not critical; ignore errors
    }
  }, []);

  // Listen for device hot-plug/unplug events (mediaDevices may be absent in non-secure contexts)
  useEffect(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.addEventListener('devicechange', enumerateDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', enumerateDevices);
    };
  }, [enumerateDevices]);

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

      // 2. Get user's camera and microphone
      // Start with both audio and video; user can toggle later
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1280 },   // 720p ideal, browser adjusts if needed
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      };
      if (selectedVideoDeviceIdRef.current) {
        videoConstraints.deviceId = { exact: selectedVideoDeviceIdRef.current };
      }

      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,   // Remove echo from speakers
        noiseSuppression: true,   // Reduce background noise
        autoGainControl: true,    // Normalize volume levels
      };
      if (selectedAudioDeviceIdRef.current) {
        audioConstraints.deviceId = { exact: selectedAudioDeviceIdRef.current };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
      });
      setLocalStream(stream);

      // Enumerate devices now that permission is granted (labels are available)
      await enumerateDevices();

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
        await enumerateDevices();
        const audioTrack = audioStream.getAudioTracks()[0];
        if (audioTrack) await produce(audioTrack, 'audio');
        setIsVideoEnabled(false);
      } catch {
        console.error('Failed to get even audio');
      }
    }
  }, [socket, enumerateDevices]);

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
          // ICE servers for NAT traversal
          iceServers: [], // Will be populated from TURN credentials
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
      // For video: track ended externally; update state so user can re-enable
      if (type === 'video') {
        setIsVideoEnabled(false);
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
          // Pass appData so consumer.appData.type === 'screen' works in VideoGrid
          appData,
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
          const wasScreenShare = (consumer.appData as any)?.type === 'screen';
          consumer.close();
          consumersRef.current.delete(consumerId);

          // Update peers state
          setPeers((prev) => {
            const updated = new Map(prev);
            const peer = updated.get(data.peerId);
            if (peer) {
              peer.consumers.delete(consumerId);
              // Reset screenSharing flag when the screen producer closes
              if (wasScreenShare) peer.screenSharing = false;
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
    if (!producer || !socket || producer.closed) return;

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

  // Toggle video: stop track when turning OFF (camera light off),
  // re-acquire camera when turning ON (reliable even after track ended).
  const toggleVideo = useCallback(async () => {
    if (!socket) return;

    const producer = producersRef.current.get('video');

    if (isVideoEnabledRef.current) {
      // --- Turning OFF ---
      if (producer && !producer.closed) {
        producer.pause();
        socket.emit('pause-producer', { producerId: producer.id });
      }
      // Stop the camera track so the camera indicator light turns off
      localStreamRef.current?.getVideoTracks().forEach(t => t.stop());
      setIsVideoEnabled(false);
    } else {
      // --- Turning ON ---
      // Always re-acquire the camera to get a fresh track
      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        };
        if (selectedVideoDeviceIdRef.current) {
          videoConstraints.deviceId = { exact: selectedVideoDeviceIdRef.current };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const newVideoTrack = stream.getVideoTracks()[0];

        if (producer && !producer.closed) {
          // Replace the ended/paused track with the fresh one, then resume
          await producer.replaceTrack({ track: newVideoTrack });
          producer.resume();
          socket.emit('resume-producer', { producerId: producer.id });
        } else {
          // Producer was closed or never created — create a new one
          if (producer) {
            // Clean up any closed producer reference
            producersRef.current.delete('video');
          }
          await produce(newVideoTrack, 'video');
        }

        // Rebuild local stream with new video track alongside existing audio
        const audioTracks = localStreamRef.current?.getAudioTracks() ?? [];
        const newStream = new MediaStream([...audioTracks, newVideoTrack]);
        setLocalStream(newStream);
        setIsVideoEnabled(true);
      } catch (err: any) {
        console.error('Failed to re-enable camera:', err);
      }
    }
  }, [socket]);

  const startScreenShare = useCallback(async (): Promise<string | null> => {
    if (!sendTransportRef.current) return 'Not connected to meeting';
    if (isScreenSharingRef.current) return null; // already sharing, no-op

    // Check if getDisplayMedia is supported — not available on many mobile browsers
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return 'Screen sharing is not supported on this device. Please use Chrome or Firefox on a desktop.';
    }

    // Client-side guard: reject if a remote peer is already sharing
    for (const peer of peersRef.current.values()) {
      if (peer.screenSharing) {
        return 'Another participant is already sharing their screen';
      }
    }

    // Acquire the screen capture stream
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 15, max: 30 },
        },
        audio: false,
      });
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        return null; // User cancelled the picker — not an error to surface
      }
      return err.message || 'Screen sharing was denied';
    }

    const screenTrack = stream.getVideoTracks()[0];
    setScreenStream(stream);
    screenStreamRef.current = stream;
    setIsScreenSharing(true);
    isScreenSharingRef.current = true;

    try {
      await produce(screenTrack, 'screen');

      // Use ref so this callback is never stale when the browser fires "Stop sharing"
      screenTrack.onended = () => { stopScreenShareRef.current(); };

      return null; // success
    } catch (err: any) {
      // Server rejected (e.g., someone else started sharing between our check and produce)
      stream.getTracks().forEach(t => t.stop());
      setScreenStream(null);
      screenStreamRef.current = null;
      setIsScreenSharing(false);
      isScreenSharingRef.current = false;
      return err.message || 'Failed to start screen sharing';
    }
  }, [socket]); // socket is the only external dep needed

  const stopScreenShare = useCallback(() => {
    const producer = producersRef.current.get('screen');
    if (producer && socket) {
      socket.emit('close-producer', { producerId: producer.id });
      producer.close();
      producersRef.current.delete('screen');
    }

    // Use ref to avoid stale closure over screenStream state
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
    }
    setIsScreenSharing(false);
    isScreenSharingRef.current = false;
  }, [socket]); // no longer depends on screenStream state

  // Keep stopScreenShareRef current so startScreenShare's onended handler is never stale
  useEffect(() => { stopScreenShareRef.current = stopScreenShare; }, [stopScreenShare]);

  // -------------------------------------------------------------------------
  // DEVICE SELECTION
  // Switch camera or microphone without reconnecting.
  // Uses producer.replaceTrack() which swaps the track without server re-negotiation.
  // -------------------------------------------------------------------------

  const selectVideoDevice = useCallback(async (deviceId: string) => {
    setSelectedVideoDeviceId(deviceId);
    selectedVideoDeviceIdRef.current = deviceId;

    // If video is currently off, the new device will be used next time it's turned on
    if (!isVideoEnabledRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      const newTrack = stream.getVideoTracks()[0];

      const producer = producersRef.current.get('video');
      if (producer && !producer.closed) {
        // Stop old video tracks before replacing
        localStreamRef.current?.getVideoTracks().forEach(t => t.stop());
        await producer.replaceTrack({ track: newTrack });
      }

      const audioTracks = localStreamRef.current?.getAudioTracks() ?? [];
      const newStream = new MediaStream([...audioTracks, newTrack]);
      setLocalStream(newStream);
    } catch (err: any) {
      console.error('Failed to switch camera:', err);
    }
  }, []);

  const selectAudioDevice = useCallback(async (deviceId: string) => {
    setSelectedAudioDeviceId(deviceId);
    selectedAudioDeviceIdRef.current = deviceId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const newTrack = stream.getAudioTracks()[0];

      const producer = producersRef.current.get('audio');
      if (producer && !producer.closed) {
        // Stop old audio tracks before replacing
        localStreamRef.current?.getAudioTracks().forEach(t => t.stop());
        await producer.replaceTrack({ track: newTrack });
      }

      const videoTracks = localStreamRef.current?.getVideoTracks() ?? [];
      const newStream = new MediaStream([newTrack, ...videoTracks]);
      setLocalStream(newStream);
    } catch (err: any) {
      console.error('Failed to switch microphone:', err);
    }
  }, []);

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
    videoDevices,
    audioDevices,
    selectedVideoDeviceId,
    selectedAudioDeviceId,
    selectVideoDevice,
    selectAudioDevice,
    toggleAudio,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    initializeMedia,
    consumeProducer,
  };
}
