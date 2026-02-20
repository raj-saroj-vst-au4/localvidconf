// =============================================================================
// Breakout Room Manager Component
// Host-only panel for creating, managing, and closing breakout rooms.
// Features:
// - Create rooms with custom names
// - Assign participants manually or randomly
// - Set timer for auto-close
// - Broadcast message to all breakout rooms
// - Close all breakouts and return everyone to main room
// =============================================================================

'use client';

import { useState } from 'react';
import {
  Box, VStack, HStack, Text, Input, Button, IconButton, Heading,
  NumberInput, NumberInputField, NumberInputStepper, NumberIncrementStepper,
  NumberDecrementStepper, Checkbox, CheckboxGroup, Divider, Badge,
  Textarea, Alert, AlertIcon,
} from '@chakra-ui/react';
import { FiPlus, FiTrash2, FiSend, FiX } from 'react-icons/fi';
import type { Participant, BreakoutRoom } from '@/types';

interface BreakoutManagerProps {
  participants: Participant[];
  breakoutRooms: BreakoutRoom[];
  isInBreakout: boolean;
  timeRemaining: number | null;
  currentUserId: string;
  onCreateBreakoutRooms: (rooms: { name: string; participantIds: string[] }[], duration?: number) => void;
  onCloseBreakoutRooms: () => void;
  onBroadcastToBreakouts: (message: string) => void;
}

// Shape of a room being configured (before creation)
interface RoomConfig {
  name: string;
  selectedParticipants: string[];
}

export default function BreakoutManager({
  participants,
  breakoutRooms,
  isInBreakout,
  timeRemaining,
  currentUserId,
  onCreateBreakoutRooms,
  onCloseBreakoutRooms,
  onBroadcastToBreakouts,
}: BreakoutManagerProps) {
  // Configuration state for creating new breakout rooms
  const [roomConfigs, setRoomConfigs] = useState<RoomConfig[]>([
    { name: 'Room 1', selectedParticipants: [] },
  ]);
  const [duration, setDuration] = useState<number>(10); // Default: 10 minutes
  const [broadcastMessage, setBroadcastMessage] = useState('');

  // --- Room Configuration Helpers ---

  function addRoom() {
    setRoomConfigs([
      ...roomConfigs,
      { name: `Room ${roomConfigs.length + 1}`, selectedParticipants: [] },
    ]);
  }

  function removeRoom(index: number) {
    setRoomConfigs(roomConfigs.filter((_, i) => i !== index));
  }

  function updateRoomName(index: number, name: string) {
    const updated = [...roomConfigs];
    updated[index].name = name;
    setRoomConfigs(updated);
  }

  function toggleParticipant(roomIndex: number, participantId: string) {
    const updated = [...roomConfigs];

    // Remove from any other room first (a participant can only be in one breakout)
    updated.forEach((room, i) => {
      if (i !== roomIndex) {
        room.selectedParticipants = room.selectedParticipants.filter(
          (id) => id !== participantId
        );
      }
    });

    // Toggle in the target room
    const room = updated[roomIndex];
    if (room.selectedParticipants.includes(participantId)) {
      room.selectedParticipants = room.selectedParticipants.filter(
        (id) => id !== participantId
      );
    } else {
      room.selectedParticipants.push(participantId);
    }

    setRoomConfigs(updated);
  }

  // Randomly distribute participants across rooms
  function randomAssign() {
    const eligible = participants.filter(
      (p) => p.userId !== currentUserId && p.status === 'IN_MEETING'
    );
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);

    const updated = roomConfigs.map((r) => ({
      ...r,
      selectedParticipants: [] as string[],
    }));

    shuffled.forEach((participant, i) => {
      const roomIdx = i % updated.length;
      updated[roomIdx].selectedParticipants.push(participant.id);
    });

    setRoomConfigs(updated);
  }

  function handleCreate() {
    const rooms = roomConfigs
      .filter((r) => r.selectedParticipants.length > 0)
      .map((r) => ({
        name: r.name,
        participantIds: r.selectedParticipants,
      }));

    if (rooms.length === 0) return;
    onCreateBreakoutRooms(rooms, duration);
  }

  function handleBroadcast() {
    if (!broadcastMessage.trim()) return;
    onBroadcastToBreakouts(broadcastMessage.trim());
    setBroadcastMessage('');
  }

  // Format seconds to MM:SS
  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <Box
      w={{ base: '100%', md: '350px' }}
      h="100%"
      bg="meeting.surface"
      borderLeft={{ md: '1px' }}
      borderColor="whiteAlpha.200"
      overflowY="auto"
      p={4}
    >
      <Heading size="sm" mb={4}>Breakout Rooms</Heading>

      {/* --- Active Breakout Rooms --- */}
      {breakoutRooms.length > 0 ? (
        <VStack spacing={4} align="stretch">
          {/* Timer display */}
          {timeRemaining !== null && (
            <Alert status="info" bg="whiteAlpha.100" borderRadius="md">
              <AlertIcon />
              <Text fontSize="sm">
                Time remaining: <strong>{formatTime(timeRemaining)}</strong>
              </Text>
            </Alert>
          )}

          {/* Active rooms list */}
          {breakoutRooms.map((room) => (
            <Box key={room.id} p={3} bg="whiteAlpha.100" borderRadius="md">
              <HStack justify="space-between" mb={2}>
                <Text fontWeight="bold" fontSize="sm">{room.name}</Text>
                <Badge colorScheme="green">{room.participants?.length || 0} people</Badge>
              </HStack>
            </Box>
          ))}

          {/* Broadcast to all */}
          <Divider borderColor="whiteAlpha.200" />
          <Text fontSize="xs" fontWeight="bold" color="gray.400">
            BROADCAST TO ALL ROOMS
          </Text>
          <HStack>
            <Input
              placeholder="Type a message..."
              value={broadcastMessage}
              onChange={(e) => setBroadcastMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleBroadcast()}
              bg="whiteAlpha.100"
              borderColor="whiteAlpha.300"
              size="sm"
            />
            <IconButton
              aria-label="Broadcast"
              icon={<FiSend />}
              size="sm"
              colorScheme="brand"
              onClick={handleBroadcast}
            />
          </HStack>

          {/* Close all breakouts */}
          <Button
            colorScheme="red"
            variant="outline"
            size="sm"
            onClick={onCloseBreakoutRooms}
          >
            Close All Breakout Rooms
          </Button>
        </VStack>
      ) : (
        /* --- Create Breakout Rooms --- */
        <VStack spacing={4} align="stretch">
          {/* Room configurations */}
          {roomConfigs.map((config, roomIdx) => (
            <Box key={roomIdx} p={3} bg="whiteAlpha.100" borderRadius="md">
              <HStack mb={2}>
                <Input
                  value={config.name}
                  onChange={(e) => updateRoomName(roomIdx, e.target.value)}
                  size="sm"
                  bg="whiteAlpha.100"
                  borderColor="whiteAlpha.300"
                  flex={1}
                />
                {roomConfigs.length > 1 && (
                  <IconButton
                    aria-label="Remove room"
                    icon={<FiTrash2 />}
                    size="xs"
                    variant="ghost"
                    color="red.400"
                    onClick={() => removeRoom(roomIdx)}
                  />
                )}
              </HStack>

              {/* Participant checkboxes */}
              <VStack align="start" spacing={1}>
                {participants
                  .filter((p) => p.userId !== currentUserId && p.status === 'IN_MEETING')
                  .map((p) => (
                    <Checkbox
                      key={p.id}
                      size="sm"
                      isChecked={config.selectedParticipants.includes(p.id)}
                      onChange={() => toggleParticipant(roomIdx, p.id)}
                      colorScheme="brand"
                    >
                      <Text fontSize="xs">{p.user?.name}</Text>
                    </Checkbox>
                  ))}
              </VStack>
            </Box>
          ))}

          {/* Add room + Random assign */}
          <HStack>
            <Button size="sm" leftIcon={<FiPlus />} variant="ghost" onClick={addRoom}>
              Add Room
            </Button>
            <Button size="sm" variant="ghost" onClick={randomAssign}>
              Random Assign
            </Button>
          </HStack>

          {/* Duration */}
          <HStack>
            <Text fontSize="sm" color="gray.400">Duration (min):</Text>
            <NumberInput
              value={duration}
              onChange={(_, val) => setDuration(val || 10)}
              min={1}
              max={120}
              size="sm"
              maxW="80px"
            >
              <NumberInputField bg="whiteAlpha.100" borderColor="whiteAlpha.300" />
              <NumberInputStepper>
                <NumberIncrementStepper borderColor="whiteAlpha.300" />
                <NumberDecrementStepper borderColor="whiteAlpha.300" />
              </NumberInputStepper>
            </NumberInput>
          </HStack>

          {/* Create button */}
          <Button
            colorScheme="brand"
            onClick={handleCreate}
            isDisabled={roomConfigs.every((r) => r.selectedParticipants.length === 0)}
          >
            Open Breakout Rooms
          </Button>
        </VStack>
      )}
    </Box>
  );
}
