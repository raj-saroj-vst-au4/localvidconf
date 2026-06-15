// =============================================================================
// Reactions Overlay
// Renders transient emoji reactions floating up over the video area. Each
// reaction animates from the bottom of the overlay upward while fading out,
// then is removed by the parent (reactions are expected to auto-expire in the
// owning hook). This component is purely presentational and pointer-transparent
// so it never blocks clicks on the video grid beneath it.
// =============================================================================

'use client';

import { useMemo } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';

interface Reaction {
  id: string;
  emoji: string;
  userName: string;
}

interface ReactionsOverlayProps {
  reactions: Reaction[];
}

const MotionBox = motion(Box);

// Spread reactions across the horizontal axis deterministically by id so a
// given reaction keeps a stable lane for its whole lifetime.
function laneFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  }
  // 10% .. 90% of the width.
  return 10 + (Math.abs(hash) % 81);
}

export default function ReactionsOverlay({ reactions }: ReactionsOverlayProps) {
  // Precompute lane positions so they don't shift on re-render.
  const positioned = useMemo(
    () => reactions.map((r) => ({ ...r, left: laneFor(r.id) })),
    [reactions],
  );

  return (
    <Box
      position="absolute"
      inset={0}
      overflow="hidden"
      pointerEvents="none"
      zIndex={20}
    >
      <AnimatePresence>
        {positioned.map((r) => (
          <MotionBox
            key={r.id}
            position="absolute"
            bottom="10%"
            left={`${r.left}%`}
            initial={{ opacity: 0, y: 0, scale: 0.6 }}
            animate={{ opacity: 1, y: -240, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 3.5, ease: 'easeOut' }}
            textAlign="center"
            transform="translateX(-50%)"
          >
            <Text fontSize="4xl" lineHeight={1} aria-hidden>
              {r.emoji}
            </Text>
            <Text
              fontSize="xs"
              color="white"
              bg="blackAlpha.600"
              borderRadius="full"
              px={2}
              mt={1}
              noOfLines={1}
              maxW="120px"
            >
              {r.userName}
            </Text>
          </MotionBox>
        ))}
      </AnimatePresence>
    </Box>
  );
}
