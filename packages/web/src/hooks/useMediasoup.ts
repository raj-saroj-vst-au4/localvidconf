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

export type ConnectionQuality = 'good' | 'fair' | 'poor';

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
  // --- Device selection ---
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  selectedAudioInputId: string | null;
  selectedVideoInputId: string | null;
  switchCamera: (deviceId: string) => Promise<void>;
  switchMic: (deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
  // --- Active speaker ---
  activeSpeakerParticipantId: string | null;
  // --- Connection quality ---
  connectionQuality: ConnectionQuality;
}

export function useMediasoup({ socket, isConnected }: UseMediasoupProps): UseMediasoupReturn {
  // --- State ---
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, PeerMedia>>(new Map());
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // --- Device selection state ---
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string | null>(null);
  const [selectedVideoInputId, setSelectedVideoInputId] = useState<string | null>(null);

  // --- Active speaker / connection quality state ---
  const [activeSpeakerParticipantId, setActiveSpeakerParticipantId] = useState<string | null>(null);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>('good');

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
  // Currently-selected input device ids, mirrored into refs so non-React code
  // paths (re-acquire on toggle, breakout re-init) can read them synchronously.
  const selectedAudioInputRef = useRef<string | null>(null);
  const selectedVideoInputRef = useRef<string | null>(null);
  // Live mutable refs to the current local/screen streams so the unmount
  // cleanup (which captures only on first render) can stop the latest tracks.
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Live ref to the socket so callbacks captured once (e.g. a screen track's
  // native-stop `onended`) always reach the *current* socket, not a stale/null
  // one from an early render before the connection was established.
  const socketRef = useRef<Socket | null>(socket);
  socketRef.current = socket;
  // getStats() poll handle and the down-shifted layer we last requested per
  // consumer, so we don't spam the server with identical 'set-preferred-layers'.
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const preferredLayerRef = useRef<Map<string, number>>(new Map());

  // -------------------------------------------------------------------------
  // DEVICE ENUMERATION
  // Populate the audio/video input + audio output lists. Labels are only
  // available after a getUserMedia permission has been granted, so this is
  // (re)called after media init and on devicechange.
  // -------------------------------------------------------------------------
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter((d) => d.kind === 'audioinput'));
      setVideoInputs(devices.filter((d) => d.kind === 'videoinput'));
      setAudioOutputs(devices.filter((d) => d.kind === 'audiooutput'));
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // INITIALIZE MEDIA
  // Called after joining a meeting and receiving routerCapabilities.
  // Steps: create Device → load capabilities → get user media → create transports → produce
  // -------------------------------------------------------------------------
  const initializeMedia = useCallback(async (
    routerCapabilities: mediasoupTypes.RtpCapabilities
  ) => {
    if (!socket) return;

    // Release any media held by a PRIOR initialization before acquiring new
    // devices. initializeMedia re-runs on socket reconnect (the join effect
    // depends on isConnected) and on lobby-admit / breakout transitions. Without
    // this, the previous getUserMedia tracks are abandoned still-live and keep
    // the mic/camera hardware capturing — toggleAudio/toggleVideo only stop the
    // CURRENT producer's track, never the orphaned ones, so the device stays in
    // use even when "muted". (Uses refs/stable setters only; a no-op on first run.)
    producersRef.current.forEach((p) => { try { p.close(); } catch { /* already closed */ } });
    producersRef.current.clear();
    consumersRef.current.forEach((c) => { try { c.close(); } catch { /* already closed */ } });
    consumersRef.current.clear();
    preferredLayerRef.current.clear();
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    setPeers(new Map());
    setActiveSpeakerParticipantId(null);

    try {
      // 1. Create and load the mediasoup Device
      // The Device determines which codecs/features the browser supports
      const device = new Device();
      await device.load({ routerRtpCapabilities: routerCapabilities });
      deviceRef.current = device;

      // 1b. Fetch time-limited TURN/STUN credentials so both transports can
      // traverse NAT. Same-origin path; the reverse proxy routes /media -> SFU.
      // The endpoint now requires the same JWT used for the socket handshake;
      // reuse the token stored on the socket's auth so the request authenticates.
      try {
        const authToken = (socket as any)?.auth?.token as string | undefined;
        const res = await fetch('/media/turn-credentials', {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });
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
      // Start with both audio and video; user can toggle later.
      // Honour any previously-selected input devices (e.g. after a breakout
      // re-init the user keeps the camera/mic they had chosen).
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,   // Remove echo from speakers
        noiseSuppression: true,   // Reduce background noise
        autoGainControl: true,    // Normalize volume levels
      };
      if (selectedAudioInputRef.current) {
        audioConstraints.deviceId = { exact: selectedAudioInputRef.current };
      }
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1280 },   // 720p ideal, browser adjusts if needed
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      };
      if (selectedVideoInputRef.current) {
        videoConstraints.deviceId = { exact: selectedVideoInputRef.current };
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
      });
      setLocalStream(stream);

      // Record which physical devices we actually got so the UI selects can
      // reflect the active inputs, then (re)enumerate the device list.
      const initAudioTrack = stream.getAudioTracks()[0];
      const initVideoTrack = stream.getVideoTracks()[0];
      if (initAudioTrack) {
        const id = initAudioTrack.getSettings().deviceId ?? null;
        selectedAudioInputRef.current = id;
        setSelectedAudioInputId(id);
      }
      if (initVideoTrack) {
        const id = initVideoTrack.getSettings().deviceId ?? null;
        selectedVideoInputRef.current = id;
        setSelectedVideoInputId(id);
      }
      // Labels are only populated once we hold a media permission, so refresh now.
      void refreshDevices();

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
  }, [socket, refreshDevices]);

  // -------------------------------------------------------------------------
  // SWITCH CAMERA / MIC
  // Acquire a track from the chosen deviceId and hot-swap it into the existing
  // producer via replaceTrack (no renegotiation, no new producer). Falls back
  // to remembering the selection if the producer is currently absent/paused so
  // the next (re)acquire uses it.
  // -------------------------------------------------------------------------
  const switchCamera = useCallback(async (deviceId: string) => {
    selectedVideoInputRef.current = deviceId;
    setSelectedVideoInputId(deviceId);

    const producer = producersRef.current.get('video');
    // If video is off (producer paused / track stopped) just remember the
    // choice; toggleVideo will re-acquire with this deviceId via the ref.
    if (!producer || producer.paused) return;

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      const oldTrack = producer.track;
      await producer.replaceTrack({ track: newTrack });
      oldTrack?.stop();

      // Refresh local preview with the new video track.
      setLocalStream((prev) => {
        const audio = prev ? prev.getAudioTracks() : [];
        return new MediaStream([...audio, newTrack]);
      });
    } catch (err) {
      console.error('Failed to switch camera:', err);
    }
  }, []);

  const switchMic = useCallback(async (deviceId: string) => {
    selectedAudioInputRef.current = deviceId;
    setSelectedAudioInputId(deviceId);

    const producer = producersRef.current.get('audio');
    if (!producer) return;

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) return;

      const oldTrack = producer.track;
      await producer.replaceTrack({ track: newTrack });
      oldTrack?.stop();
      // Preserve mute state: replaceTrack on a paused producer keeps it paused,
      // but the fresh track is live, so mirror the current intent.
      if (producer.paused) newTrack.enabled = false;

      setLocalStream((prev) => {
        const video = prev ? prev.getVideoTracks() : [];
        return new MediaStream([newTrack, ...video]);
      });
    } catch (err) {
      console.error('Failed to switch mic:', err);
    }
  }, []);

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
          // Tag the consumer with its media type so we can later recompute a
          // peer's screenSharing flag from the consumers that remain.
          appData: { type: appData?.type ?? data.appData?.type },
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
  // TEARDOWN MEDIA
  // Close all producers/consumers/transports and reset peer state. Used both by
  // unmount cleanup and by breakout transitions before re-initialising on the
  // new router. Does NOT stop the local camera/mic tracks by default so the
  // same physical capture can be re-produced after a breakout move; pass
  // stopLocal=true to fully release hardware (unmount).
  // -------------------------------------------------------------------------
  const teardownMedia = useCallback((stopLocal: boolean) => {
    for (const producer of producersRef.current.values()) {
      producer.close();
    }
    producersRef.current.clear();

    for (const consumer of consumersRef.current.values()) {
      consumer.close();
    }
    consumersRef.current.clear();
    preferredLayerRef.current.clear();

    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    deviceRef.current = null;

    // Remote peers belong to the router we just left — drop them so the new
    // router's peers repopulate cleanly via fresh consume() calls.
    setPeers(new Map());
    setActiveSpeakerParticipantId(null);

    if (stopLocal) {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    }
  }, []);

  // Recompute a peer's screenSharing flag from the media types of the
  // consumers it still has. Avoids the flag getting stuck `true` after a
  // screen-share consumer/producer closes.
  function recomputeScreenSharing(peer: PeerMedia): void {
    let sharing = false;
    for (const c of peer.consumers.values()) {
      if ((c.appData as any)?.type === 'screen') {
        sharing = true;
        break;
      }
    }
    peer.screenSharing = sharing;
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
          preferredLayerRef.current.delete(consumerId);
          setPeers((prev) => {
            const updated = new Map(prev);
            const peer = updated.get(data.peerId);
            if (peer) {
              peer.consumers.delete(consumerId);
              if (peer.consumers.size === 0) {
                updated.delete(data.peerId);
              } else {
                // The closed consumer may have been the screen share — recompute
                // from what's left rather than leaving the flag stuck `true`.
                recomputeScreenSharing(peer);
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
            preferredLayerRef.current.delete(consumer.id);
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

    // Active speaker: server picks the loudest peer (or null on silence).
    // We surface the participantId so the UI can highlight the active tile.
    socket.on('active-speaker', (data: { peerId: string | null; participantId: string | null; producerId: string | null }) => {
      setActiveSpeakerParticipantId(data.participantId);
    });

    // BREAKOUT JOINED: the server moved us onto a breakout router. Tear down the
    // main-router media stack and re-init (new Device + transports + reproduce
    // local tracks) against the breakout's routerCapabilities so audio/video
    // actually flow inside the breakout.
    socket.on('breakout-joined', async (data: { routerCapabilities: mediasoupTypes.RtpCapabilities; breakoutRoomId: string }) => {
      if (!data?.routerCapabilities) return;
      teardownMedia(false);
      await initializeMedia(data.routerCapabilities);
    });

    // BREAKOUT ENDED: server moved us back to the main router — re-init there.
    socket.on('breakout-ended', async (data: { routerCapabilities: mediasoupTypes.RtpCapabilities }) => {
      if (!data?.routerCapabilities) return;
      teardownMedia(false);
      await initializeMedia(data.routerCapabilities);
    });

    return () => {
      socket.off('new-producer');
      socket.off('producer-closed');
      socket.off('participant-left');
      socket.off('producer-paused');
      socket.off('producer-resumed');
      socket.off('active-speaker');
      socket.off('breakout-joined');
      socket.off('breakout-ended');
    };
  }, [socket, isConnected, initializeMedia, teardownMedia]);

  // -------------------------------------------------------------------------
  // MEDIA CONTROLS
  // Toggle audio, video, and screen share
  // -------------------------------------------------------------------------

  const toggleAudio = useCallback(async () => {
    const producer = producersRef.current.get('audio');
    if (!producer || !socket) return;

    if (producer.paused) {
      // UNMUTE: the mic track was stopped on mute to release the hardware (and
      // its in-use indicator), so re-acquire a fresh one and swap it in.
      try {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (selectedAudioInputRef.current) {
          audioConstraints.deviceId = { exact: selectedAudioInputRef.current };
        }
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
        const newTrack = newStream.getAudioTracks()[0];
        await producer.replaceTrack({ track: newTrack });
        producer.resume();
        socket.emit('resume-producer', { producerId: producer.id });
        // Keep localStream in sync (preserve any video track).
        setLocalStream((prev) => {
          const video = prev ? prev.getVideoTracks() : [];
          return new MediaStream([...video, newTrack]);
        });
        setIsAudioEnabled(true);
      } catch (err) {
        console.error('Failed to re-enable microphone:', err);
      }
    } else {
      // MUTE: pause the producer AND stop the mic track so the hardware (and the
      // OS "microphone in use" indicator) is actually released. Pausing alone
      // keeps the capture device open. Re-acquired on the next unmute.
      producer.pause();
      socket.emit('pause-producer', { producerId: producer.id });
      producer.track?.stop();
      setLocalStream((prev) => {
        if (!prev) return prev;
        prev.getAudioTracks().forEach((t) => {
          t.stop();
          prev.removeTrack(t);
        });
        return new MediaStream(prev.getVideoTracks());
      });
      setIsAudioEnabled(false);
    }
  }, [socket]);

  const toggleVideo = useCallback(async () => {
    const producer = producersRef.current.get('video');
    if (!producer || !socket) return;

    if (producer.paused) {
      // RE-ENABLE: the camera track was stopped on disable to free the device,
      // so re-acquire a fresh one and swap it into the existing producer.
      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        };
        if (selectedVideoInputRef.current) {
          videoConstraints.deviceId = { exact: selectedVideoInputRef.current };
        }
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
        });
        const newTrack = newStream.getVideoTracks()[0];
        await producer.replaceTrack({ track: newTrack });
        producer.resume();
        socket.emit('resume-producer', { producerId: producer.id });
        // Refresh the local preview with the new track.
        setLocalStream((prev) => {
          const audio = prev ? prev.getAudioTracks() : [];
          return new MediaStream([...audio, newTrack]);
        });
        setIsVideoEnabled(true);
      } catch (err) {
        console.error('Failed to re-enable camera:', err);
      }
    } else {
      // DISABLE: pause the producer AND stop the camera track, so the hardware
      // (and its in-use indicator) is actually released. Pausing alone keeps the
      // capture device open. The track is re-acquired on the next enable.
      producer.pause();
      socket.emit('pause-producer', { producerId: producer.id });
      producer.track?.stop();
      setLocalStream((prev) => {
        if (!prev) return prev;
        prev.getVideoTracks().forEach((t) => {
          t.stop();
          prev.removeTrack(t);
        });
        return new MediaStream(prev.getAudioTracks());
      });
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

  // Stable identity (`[]` deps) and ref-based, so the native "Stop sharing"
  // onended handler (captured once when sharing started) always performs the
  // FULL teardown — closing the producer and emitting `close-producer` so remote
  // peers drop the screen tile and revert to the grid layout. Reading socket and
  // screenStream from refs avoids the stale-closure bug where onended captured a
  // null socket / empty stream from an early render and silently skipped cleanup.
  const stopScreenShare = useCallback(() => {
    const producer = producersRef.current.get('screen');
    if (producer) {
      socketRef.current?.emit('close-producer', { producerId: producer.id });
      producer.close();
      producersRef.current.delete('screen');
    }

    const ss = screenStreamRef.current;
    if (ss) {
      ss.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
    }
    setIsScreenSharing(false);
  }, []);

  // Mirror the latest local/screen streams into refs so the unmount cleanup
  // (which only runs once) can stop whatever the current tracks are.
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { screenStreamRef.current = screenStream; }, [screenStream]);

  // -------------------------------------------------------------------------
  // DEVICE CHANGE WATCHER
  // Keep the device lists fresh when the user plugs/unplugs a camera/headset.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const onChange = () => { void refreshDevices(); };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    // Initial enumeration (labels are blank until a permission is granted).
    void refreshDevices();
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
    };
  }, [refreshDevices]);

  // -------------------------------------------------------------------------
  // CONNECTION QUALITY POLL
  // Every 3s, sample producer/consumer getStats(), derive a coarse
  // good/fair/poor level from packet loss, and down-shift the simulcast layer
  // of remote video consumers when bandwidth is poor (basic adaptation).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !isConnected) return;

    const poll = async () => {
      let totalLost = 0;
      let totalPackets = 0;

      // Outbound (our producers): inspect remote-inbound loss reports.
      for (const producer of producersRef.current.values()) {
        try {
          const stats = await producer.getStats();
          stats.forEach((report: any) => {
            if (report.type === 'remote-inbound-rtp') {
              if (typeof report.packetsLost === 'number') totalLost += report.packetsLost;
              if (typeof report.packetsReceived === 'number') {
                totalPackets += report.packetsReceived + (report.packetsLost || 0);
              }
            }
          });
        } catch { /* transport may be closing */ }
      }

      // Inbound (consumers): inspect inbound-rtp loss.
      for (const consumer of consumersRef.current.values()) {
        try {
          const stats = await consumer.getStats();
          stats.forEach((report: any) => {
            if (report.type === 'inbound-rtp') {
              if (typeof report.packetsLost === 'number') totalLost += report.packetsLost;
              if (typeof report.packetsReceived === 'number') {
                totalPackets += report.packetsReceived;
              }
            }
          });
        } catch { /* consumer may be closing */ }
      }

      const lossRatio = totalPackets > 0 ? totalLost / totalPackets : 0;
      let quality: ConnectionQuality = 'good';
      if (lossRatio > 0.1) quality = 'poor';
      else if (lossRatio > 0.03) quality = 'fair';
      setConnectionQuality(quality);

      // Basic simulcast adaptation: when poor, ask the SFU for the lowest
      // spatial layer on each remote video consumer; otherwise let it run full.
      const targetSpatial = quality === 'poor' ? 0 : quality === 'fair' ? 1 : 2;
      for (const consumer of consumersRef.current.values()) {
        if (consumer.kind !== 'video') continue;
        const last = preferredLayerRef.current.get(consumer.id);
        if (last === targetSpatial) continue; // avoid redundant emits
        preferredLayerRef.current.set(consumer.id, targetSpatial);
        socket.emit('set-preferred-layers', {
          consumerId: consumer.id,
          spatialLayer: targetSpatial,
          temporalLayer: 2,
        });
      }
    };

    statsIntervalRef.current = setInterval(() => { void poll(); }, 3000);
    return () => {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
    };
  }, [socket, isConnected]);

  // -------------------------------------------------------------------------
  // CLEANUP
  // Close all producers, consumers, and transports when unmounting.
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      teardownMedia(true);
    };
  }, [teardownMedia]);

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
    // Device selection
    audioInputs,
    videoInputs,
    audioOutputs,
    selectedAudioInputId,
    selectedVideoInputId,
    switchCamera,
    switchMic,
    refreshDevices,
    // Active speaker
    activeSpeakerParticipantId,
    // Connection quality
    connectionQuality,
  };
}
