// =============================================================================
// Network Optimizer
// Implements adaptive bitrate strategy: audio > screen share > video
// Monitors transport stats and adjusts quality layers based on network conditions
//
// Strategy:
// 1. Audio is NEVER throttled (highest priority, lowest bandwidth ~32kbps)
// 2. Screen share is reduced only under severe degradation
// 3. Video is the first to be downgraded or paused
//
// This matches the user requirement: "prioritize audio & screen over video"
// =============================================================================

import { types as mediasoupTypes } from 'mediasoup';
import { createLogger } from './logger';

const log = createLogger('NetworkOptimizer');

// Thresholds for network quality assessment
const THRESHOLDS = {
  PACKET_LOSS_MILD: 0.03,     // 3% loss: start reducing video quality
  PACKET_LOSS_MODERATE: 0.05,  // 5% loss: drop video to lowest layer
  PACKET_LOSS_SEVERE: 0.10,    // 10% loss: pause video entirely
  RTT_HIGH: 300,               // 300ms RTT: reduce max video layer
  RTT_CRITICAL: 500,           // 500ms RTT: minimal video only
};

export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

/**
 * Assess network quality based on packet loss and round-trip time.
 * Called periodically for each peer's transport.
 */
export function assessNetworkQuality(packetLoss: number, rtt: number): NetworkQuality {
  if (packetLoss >= THRESHOLDS.PACKET_LOSS_SEVERE || rtt >= THRESHOLDS.RTT_CRITICAL) {
    return 'critical';
  }
  if (packetLoss >= THRESHOLDS.PACKET_LOSS_MODERATE || rtt >= THRESHOLDS.RTT_HIGH) {
    return 'poor';
  }
  if (packetLoss >= THRESHOLDS.PACKET_LOSS_MILD) {
    return 'fair';
  }
  if (rtt < 100 && packetLoss < 0.01) {
    return 'excellent';
  }
  return 'good';
}

/**
 * Determine the optimal simulcast layer for a video consumer based on network quality.
 * Returns { spatialLayer, temporalLayer } that the consumer should subscribe to.
 *
 * Simulcast layers:
 * - r0 (spatial 0): 320x180 @ 100kbps (thumbnail)
 * - r1 (spatial 1): 640x360 @ 300kbps (medium)
 * - r2 (spatial 2): 1280x720 @ 900kbps (high)
 */
export function getOptimalVideoLayer(quality: NetworkQuality): {
  spatialLayer: number;
  temporalLayer: number;
} {
  switch (quality) {
    case 'excellent':
      // Full quality: highest spatial and temporal layers
      return { spatialLayer: 2, temporalLayer: 2 };
    case 'good':
      // Medium quality: mid spatial, full temporal
      return { spatialLayer: 1, temporalLayer: 2 };
    case 'fair':
      // Reduced quality: mid spatial, reduced temporal (lower framerate)
      return { spatialLayer: 1, temporalLayer: 1 };
    case 'poor':
      // Minimal video: lowest spatial layer, reduced framerate
      return { spatialLayer: 0, temporalLayer: 1 };
    case 'critical':
      // Absolute minimum: thumbnail at lowest framerate
      // At this point, video should ideally be paused to preserve audio
      return { spatialLayer: 0, temporalLayer: 0 };
  }
}

/**
 * Determine whether video should be paused to preserve audio and screen share.
 * Audio NEVER pauses. Screen share pauses only at 'critical'.
 * Video pauses at 'critical' and may pause at 'poor' depending on participant count.
 */
export function shouldPauseMedia(
  quality: NetworkQuality,
  mediaType: 'audio' | 'video' | 'screen',
  participantCount: number
): boolean {
  // Audio is NEVER paused - this is the core priority rule
  if (mediaType === 'audio') return false;

  // Screen share only pauses under critical network conditions
  if (mediaType === 'screen') return quality === 'critical';

  // Video pausing logic:
  // - Critical network: always pause video
  // - Poor network with many participants: pause to save bandwidth
  if (quality === 'critical') return true;
  if (quality === 'poor' && participantCount > 10) return true;

  return false;
}

/**
 * Calculate the maximum outgoing bitrate for a transport based on network quality
 * and the number of active consumers. Prevents overwhelming slow connections.
 */
export function getMaxBitrate(quality: NetworkQuality, consumerCount: number): number {
  const baseBitrates: Record<NetworkQuality, number> = {
    excellent: 10000000,  // 10 Mbps
    good: 5000000,        // 5 Mbps
    fair: 2000000,        // 2 Mbps
    poor: 800000,         // 800 Kbps
    critical: 300000,     // 300 Kbps (enough for audio + thumbnail)
  };

  // Scale based on consumer count (more consumers = more bandwidth needed)
  const base = baseBitrates[quality];
  const scaled = Math.min(base, base * (consumerCount / 5));

  return Math.max(scaled, 100000); // Minimum 100 Kbps (for audio)
}
