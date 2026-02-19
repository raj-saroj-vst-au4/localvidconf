// =============================================================================
// Lobby Manager Component
// Floating notification shown to the host when participants are waiting.
// Displays a badge count and quick admit/reject buttons.
// =============================================================================

'use client';

import {
  Box, HStack, VStack, Text, Avatar, Button, Badge, Collapse,
  IconButton,
} from '@chakra-ui/react';
import { FiCheck, FiX, FiChevronDown, FiChevronUp } from 'react-icons/fi';
import { useState } from 'react';

interface LobbyManagerProps {
  lobbyParticipants: any[];
  onAdmit: (participantId: string) => void;
  onReject: (participantId: string) => void;
  onAdmitAll: () => void;
}

export default function LobbyManager({
  lobbyParticipants,
  onAdmit,
  onReject,
  onAdmitAll,
}: LobbyManagerProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (lobbyParticipants.length === 0) return null;

  return (
    <Box
      position="fixed"
      top={4}
      left="50%"
      transform="translateX(-50%)"
      bg="meeting.surface"
      border="1px"
      borderColor="yellow.400"
      borderRadius="lg"
      p={3}
      maxW={{ base: '90%', md: '400px' }}
      zIndex={200}
      boxShadow="lg"
    >
      {/* Header with count */}
      <HStack justify="space-between" cursor="pointer" onClick={() => setIsExpanded(!isExpanded)}>
        <HStack>
          <Badge colorScheme="yellow" fontSize="sm">
            {lobbyParticipants.length}
          </Badge>
          <Text fontSize="sm" fontWeight="bold">
            {lobbyParticipants.length === 1 ? 'person' : 'people'} waiting in lobby
          </Text>
        </HStack>
        <IconButton
          aria-label="Toggle"
          icon={isExpanded ? <FiChevronUp /> : <FiChevronDown />}
          size="xs"
          variant="ghost"
        />
      </HStack>

      {/* Participant list with admit/reject */}
      <Collapse in={isExpanded}>
        <VStack spacing={2} mt={3} align="stretch">
          {lobbyParticipants.map((p) => (
            <HStack key={p.participantId} justify="space-between">
              <HStack>
                <Avatar size="xs" name={p.name} src={p.image} />
                <Text fontSize="sm">{p.name}</Text>
              </HStack>
              <HStack spacing={1}>
                <IconButton
                  aria-label="Admit"
                  icon={<FiCheck />}
                  size="xs"
                  colorScheme="green"
                  onClick={() => onAdmit(p.participantId)}
                />
                <IconButton
                  aria-label="Reject"
                  icon={<FiX />}
                  size="xs"
                  colorScheme="red"
                  variant="ghost"
                  onClick={() => onReject(p.participantId)}
                />
              </HStack>
            </HStack>
          ))}

          {lobbyParticipants.length > 1 && (
            <Button size="xs" colorScheme="green" variant="outline" onClick={onAdmitAll}>
              Admit All
            </Button>
          )}
        </VStack>
      </Collapse>
    </Box>
  );
}
