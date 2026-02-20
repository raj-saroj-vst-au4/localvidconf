// =============================================================================
// Screen Share Component
// Displays the screen share stream prominently when active.
// Used as a standalone component when screen share needs its own view.
// Includes "You are sharing" indicator for the local user.
// =============================================================================

'use client';

import { useRef, useEffect } from 'react';
import { Box, Text, Badge, HStack, Icon } from '@chakra-ui/react';
import { FiMonitor } from 'react-icons/fi';

interface ScreenShareProps {
  stream: MediaStream | null;
  sharerName: string;
  isLocal: boolean;
}

export default function ScreenShare({ stream, sharerName, isLocal }: ScreenShareProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);

  if (!stream) return null;

  return (
    <Box position="relative" w="100%" h="100%" bg="black" borderRadius="lg" overflow="hidden">
      <Box
        as="video"
        ref={videoRef}
        autoPlay
        playsInline
        muted
        w="100%"
        h="100%"
        objectFit="contain"
      />

      {/* Screen share indicator overlay */}
      <HStack
        position="absolute"
        top={2}
        left={2}
        bg="blackAlpha.700"
        px={3}
        py={1}
        borderRadius="full"
      >
        <Icon as={FiMonitor} color="blue.400" />
        <Text fontSize="sm" color="white">
          {isLocal ? 'You are sharing your screen' : `${sharerName} is presenting`}
        </Text>
      </HStack>
    </Box>
  );
}
