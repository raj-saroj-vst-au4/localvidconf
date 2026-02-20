// =============================================================================
// Breakout Timer Component
// Floating countdown timer shown when the user is in a breakout room.
// Displays remaining time before auto-return to the main room.
// =============================================================================

'use client';

import { Box, HStack, Text, Icon, Badge } from '@chakra-ui/react';
import { FiClock } from 'react-icons/fi';

interface BreakoutTimerProps {
  timeRemaining: number; // Seconds
  roomName: string;
}

export default function BreakoutTimer({ timeRemaining, roomName }: BreakoutTimerProps) {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;
  const isUrgent = timeRemaining <= 60; // Last minute: show red

  return (
    <Box
      position="fixed"
      top={4}
      left="50%"
      transform="translateX(-50%)"
      bg="meeting.surface"
      border="1px"
      borderColor={isUrgent ? 'red.400' : 'brand.400'}
      borderRadius="full"
      px={4}
      py={2}
      zIndex={200}
      boxShadow="lg"
    >
      <HStack spacing={3}>
        <Icon as={FiClock} color={isUrgent ? 'red.400' : 'brand.400'} />
        <Text fontSize="sm" fontWeight="medium">
          {roomName}
        </Text>
        <Badge
          colorScheme={isUrgent ? 'red' : 'blue'}
          fontSize="md"
          px={2}
          borderRadius="md"
        >
          {minutes}:{seconds.toString().padStart(2, '0')}
        </Badge>
      </HStack>
    </Box>
  );
}
