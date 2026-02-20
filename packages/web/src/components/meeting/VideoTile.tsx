// =============================================================================
// Video Tile Component
// Displays a single participant's video (or avatar if video is off).
// Shows name label, mute indicator, and screen share badge.
// Responsive: adapts size based on grid layout from parent.
// =============================================================================

'use client';

import { useRef, useEffect } from 'react';
import { Box, Avatar, Text, Flex, Icon, Badge } from '@chakra-ui/react';
import { FiMicOff, FiMonitor } from 'react-icons/fi';
import { types as mediasoupTypes } from 'mediasoup-client';

interface VideoTileProps {
  stream?: MediaStream | null;             // MediaStream from getUserMedia or consumer
  consumer?: mediasoupTypes.Consumer;       // mediasoup consumer (for remote peers)
  userName: string;
  userImage?: string | null;
  isAudioEnabled?: boolean;
  isVideoEnabled?: boolean;
  isScreenShare?: boolean;
  isLocal?: boolean;                        // True for the local user's tile
  isSpeaking?: boolean;                     // Green border when speaking (future)
}

export default function VideoTile({
  stream,
  consumer,
  userName,
  userImage,
  isAudioEnabled = true,
  isVideoEnabled = true,
  isScreenShare = false,
  isLocal = false,
  isSpeaking = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach the media stream to the video element
  useEffect(() => {
    if (!videoRef.current) return;

    if (consumer) {
      // For remote peers: create a new MediaStream from the consumer's track
      const mediaStream = new MediaStream([consumer.track]);
      videoRef.current.srcObject = mediaStream;
    } else if (stream) {
      // For local video: use the stream directly
      videoRef.current.srcObject = stream;
    }

    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream, consumer]);

  return (
    <Box
      position="relative"
      bg="meeting.bg"
      borderRadius="lg"
      overflow="hidden"
      border="2px"
      // Green border when speaking, subtle border otherwise
      borderColor={isSpeaking ? 'green.400' : 'whiteAlpha.200'}
      transition="border-color 0.2s"
      w="100%"
      h="100%"
      minH={{ base: '120px', sm: '150px', md: '200px' }}
    >
      {/* Video element (hidden when video is off) */}
      {isVideoEnabled ? (
        <Box
          as="video"
          ref={videoRef}
          autoPlay
          playsInline
          // Mirror local video so the user sees themselves as in a mirror
          transform={isLocal && !isScreenShare ? 'scaleX(-1)' : 'none'}
          w="100%"
          h="100%"
          objectFit={isScreenShare ? 'contain' : 'cover'}
          // Mute local video to prevent echo (user hears themselves otherwise)
          muted={isLocal}
        />
      ) : (
        // Avatar fallback when video is off
        <Flex
          w="100%"
          h="100%"
          align="center"
          justify="center"
          bg="meeting.surface"
        >
          <Avatar
            name={userName}
            src={userImage || undefined}
            size={{ base: 'lg', md: 'xl' }}
          />
        </Flex>
      )}

      {/* Bottom overlay: name + indicators */}
      <Flex
        position="absolute"
        bottom={0}
        left={0}
        right={0}
        bg="blackAlpha.600"
        px={2}
        py={1}
        align="center"
        justify="space-between"
      >
        <Text
          fontSize={{ base: 'xs', md: 'sm' }}
          color="white"
          noOfLines={1}
          fontWeight="medium"
        >
          {userName} {isLocal && '(You)'}
        </Text>

        <Flex align="center" gap={1}>
          {/* Screen share badge */}
          {isScreenShare && (
            <Badge colorScheme="blue" fontSize="xs">
              <Icon as={FiMonitor} mr={1} />
              Screen
            </Badge>
          )}

          {/* Muted indicator */}
          {!isAudioEnabled && (
            <Icon as={FiMicOff} color="red.400" boxSize={3} />
          )}
        </Flex>
      </Flex>
    </Box>
  );
}
