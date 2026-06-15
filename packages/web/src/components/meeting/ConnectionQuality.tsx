// =============================================================================
// Connection Quality Indicator
// A compact signal-strength indicator (three bars) reflecting the WebRTC
// connection health for a participant. Colors follow the meeting theme:
//   good -> green, fair -> amber, poor -> red, unknown -> muted/grey.
// =============================================================================

'use client';

import { HStack, Box, Tooltip } from '@chakra-ui/react';

export type ConnectionQualityLevel = 'good' | 'fair' | 'poor' | 'unknown';

interface ConnectionQualityProps {
  quality: ConnectionQualityLevel;
  // Optional label override for the tooltip; defaults to a human-readable text.
  label?: string;
}

// Number of lit bars and the active color per quality level.
const QUALITY_CONFIG: Record<
  ConnectionQualityLevel,
  { bars: number; color: string; text: string }
> = {
  good: { bars: 3, color: 'meeting.success', text: 'Good connection' },
  fair: { bars: 2, color: 'meeting.warning', text: 'Fair connection' },
  poor: { bars: 1, color: 'meeting.danger', text: 'Poor connection' },
  unknown: { bars: 0, color: 'whiteAlpha.500', text: 'Connection unknown' },
};

// Three bars of increasing height.
const BAR_HEIGHTS = ['6px', '10px', '14px'];

export default function ConnectionQuality({ quality, label }: ConnectionQualityProps) {
  const { bars, color, text } = QUALITY_CONFIG[quality] ?? QUALITY_CONFIG.unknown;

  return (
    <Tooltip label={label ?? text} hasArrow>
      <HStack
        spacing="2px"
        align="flex-end"
        h="14px"
        role="img"
        aria-label={label ?? text}
      >
        {BAR_HEIGHTS.map((height, i) => (
          <Box
            key={height}
            w="3px"
            h={height}
            borderRadius="sm"
            bg={i < bars ? color : 'whiteAlpha.300'}
            transition="background-color 0.2s"
          />
        ))}
      </HStack>
    </Tooltip>
  );
}
