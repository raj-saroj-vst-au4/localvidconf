// =============================================================================
// mediasoup Configuration
// Defines worker settings, router codecs, and transport parameters
// Network optimization: audio > screen share > video (via DSCP + bitrate caps)
//
// Key concepts:
// - Worker: OS process that handles media. One per CPU core.
// - Router: Routes RTP between producers and consumers within a room.
// - Transport: WebRTC connection between client and server (one send, one recv per peer).
// - Producer: A media track being sent (audio, video, screen).
// - Consumer: A media track being received.
// =============================================================================

import { types as mediasoupTypes } from 'mediasoup';
import os from 'os';

// --- Worker Settings ---
// Each worker runs as a separate OS process with its own thread.
// Spawn one worker per CPU core for maximum parallelism.
export const WORKER_SETTINGS: mediasoupTypes.WorkerSettings = {
  logLevel: 'warn',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  // Use half the available cores (leave headroom for Node.js and OS)
  rtcMinPort: 40000,
  rtcMaxPort: 40100,
};

// Number of mediasoup workers to spawn
// Each worker can handle ~500 consumers on modern hardware
export const NUM_WORKERS = Math.max(1, Math.ceil(os.cpus().length / 2));

// --- Media Codecs ---
// Defines which codecs the router supports. Clients negotiate from this list.
// Order matters: first codec is preferred.
// Payload types are spaced by 2 to leave room for RTX retransmission codecs
// (mediasoup auto-assigns RTX at PT+1 for each video codec)
export const MEDIA_CODECS: mediasoupTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    preferredPayloadType: 111,
    clockRate: 48000,
    channels: 2,
    parameters: {
      'sprop-stereo': 1,
      usedtx: 1,
      useinbandfec: 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    preferredPayloadType: 96,
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 300,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    preferredPayloadType: 98,
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    preferredPayloadType: 104,
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];

// --- WebRTC Transport Settings ---
// These configure how media data flows between client and SFU
export const WEBRTC_TRANSPORT_OPTIONS = {
  listenIps: [
    {
      // Listen on all interfaces inside Docker
      ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
      // Public IP that clients will connect to (set to server's public IP in production)
      announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
    },
  ],
  // ICE candidates tell the client where to send media packets
  enableUdp: true,      // UDP preferred for low-latency media
  enableTcp: true,      // TCP fallback for restrictive firewalls
  preferUdp: true,      // Always prefer UDP when available
  // Max incoming bitrate per transport (10 Mbps - generous for up to 50 users)
  initialAvailableOutgoingBitrate: 1000000, // 1 Mbps initial
  maxIncomingBitrate: 10000000,              // 10 Mbps max
};

// --- Simulcast Encodings ---
// Video is sent in 3 quality layers. The SFU selects the appropriate layer
// based on the receiver's bandwidth. This is key for network optimization.
export const SIMULCAST_ENCODINGS = [
  {
    rid: 'r0',
    maxBitrate: 100000,          // 100 Kbps - thumbnail quality
    scaleResolutionDownBy: 4,    // 320x180 (if source is 1280x720)
  },
  {
    rid: 'r1',
    maxBitrate: 300000,          // 300 Kbps - medium quality
    scaleResolutionDownBy: 2,    // 640x360
  },
  {
    rid: 'r2',
    maxBitrate: 900000,          // 900 Kbps - high quality
    scaleResolutionDownBy: 1,    // 1280x720 (original resolution)
  },
];

// Screen share uses a single high-quality layer (no simulcast needed)
// Higher bitrate because text/slides need sharp rendering
export const SCREEN_SHARE_ENCODING = {
  maxBitrate: 1500000,   // 1.5 Mbps for crisp text
  maxFramerate: 15,      // 15fps is enough for slides/code
};

// --- Network Priority Constants ---
// Used by the network optimizer to decide what to throttle first
export const MEDIA_PRIORITY = {
  AUDIO: 3,    // Highest: never throttle audio
  SCREEN: 2,   // High: only throttle if network is severely degraded
  VIDEO: 1,    // Normal: first thing to reduce/pause on poor networks
} as const;
