// =============================================================================
// Breakout Room Card
// Displays a single breakout room with its name, participant count, and timer.
// Used in the BreakoutManager for listing active breakout rooms.
// =============================================================================

'use client';

import {
  Box, HStack, VStack, Text, Badge, Avatar, AvatarGroup,
} from '@chakra-ui/react';
import type { BreakoutRoom } from '@/types';

interface BreakoutRoomCardProps {
  room: BreakoutRoom;
  timeRemaining?: number | null;
}

export default function BreakoutRoomCard({ room, timeRemaining }: BreakoutRoomCardProps) {
  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <Box
      p={3}
      bg="whiteAlpha.100"
      borderRadius="md"
      border="1px"
      borderColor="whiteAlpha.200"
    >
      <HStack justify="space-between" mb={2}>
        <Text fontWeight="bold" fontSize="sm">{room.name}</Text>
        <HStack>
          <Badge colorScheme="green" fontSize="xs">
            {room.participants?.length || 0}
          </Badge>
          {timeRemaining != null && (
            <Badge colorScheme="orange" fontSize="xs">
              {formatTime(timeRemaining)}
            </Badge>
          )}
        </HStack>
      </HStack>

      {/* Participant avatars */}
      {room.participants && room.participants.length > 0 && (
        <AvatarGroup size="xs" max={5}>
          {room.participants.map((p) => (
            <Avatar
              key={p.id}
              name={p.user?.name}
              src={p.user?.image || undefined}
            />
          ))}
        </AvatarGroup>
      )}
    </Box>
  );
}
