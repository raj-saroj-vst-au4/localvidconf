// =============================================================================
// Participant List Panel
// Sidebar showing all participants with their roles and status.
// Host sees additional controls: kick, move to lobby, transfer host.
// Shows lobby participants waiting to be admitted.
// =============================================================================

'use client';

import {
  Box, VStack, HStack, Text, Avatar, Badge, IconButton, Divider,
  Heading, Tooltip, Input, Button, useDisclosure, Modal, ModalOverlay,
  ModalContent, ModalHeader, ModalBody, ModalFooter, ModalCloseButton,
} from '@chakra-ui/react';
import { FiUserMinus, FiCornerDownLeft, FiStar, FiUserPlus, FiCheck, FiX } from 'react-icons/fi';
import { useState } from 'react';
import type { Participant } from '@/types';

interface ParticipantListProps {
  participants: Participant[];
  lobbyParticipants: any[];
  isHost: boolean;
  currentUserId: string;
  onAdmit: (participantId: string) => void;
  onReject: (participantId: string) => void;
  onKick: (participantId: string) => void;
  onMoveToLobby: (participantId: string) => void;
  onTransferHost: (participantId: string) => void;
  onInvite: (email: string) => void;
}

export default function ParticipantList({
  participants,
  lobbyParticipants,
  isHost,
  currentUserId,
  onAdmit,
  onReject,
  onKick,
  onMoveToLobby,
  onTransferHost,
  onInvite,
}: ParticipantListProps) {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [inviteEmail, setInviteEmail] = useState('');

  function handleInvite() {
    if (inviteEmail.trim()) {
      onInvite(inviteEmail.trim());
      setInviteEmail('');
      onClose();
    }
  }

  // Role badge color
  function roleColor(role: string) {
    switch (role) {
      case 'HOST': return 'yellow';
      case 'CO_HOST': return 'purple';
      default: return 'gray';
    }
  }

  return (
    <Box
      w={{ base: '100%', md: '300px' }}
      h="100%"
      bg="meeting.surface"
      borderLeft={{ md: '1px' }}
      borderColor="whiteAlpha.200"
      overflowY="auto"
      p={4}
    >
      {/* Header with invite button */}
      <HStack justify="space-between" mb={4}>
        <Heading size="sm">Participants ({participants.length})</Heading>
        {isHost && (
          <Tooltip label="Invite someone">
            <IconButton
              aria-label="Invite"
              icon={<FiUserPlus />}
              size="sm"
              variant="ghost"
              onClick={onOpen}
            />
          </Tooltip>
        )}
      </HStack>

      {/* --- Lobby Participants (host sees these) --- */}
      {isHost && lobbyParticipants.length > 0 && (
        <>
          <Text fontSize="xs" color="yellow.400" fontWeight="bold" mb={2}>
            WAITING IN LOBBY ({lobbyParticipants.length})
          </Text>
          <VStack spacing={2} mb={4} align="stretch">
            {lobbyParticipants.map((p) => (
              <HStack
                key={p.participantId}
                p={2}
                bg="whiteAlpha.100"
                borderRadius="md"
                borderLeft="3px"
                borderColor="yellow.400"
              >
                <Avatar size="xs" name={p.name} src={p.image} />
                <Text fontSize="sm" flex={1} noOfLines={1}>{p.name}</Text>
                <Tooltip label="Admit">
                  <IconButton
                    aria-label="Admit"
                    icon={<FiCheck />}
                    size="xs"
                    colorScheme="green"
                    onClick={() => onAdmit(p.participantId)}
                  />
                </Tooltip>
                <Tooltip label="Reject">
                  <IconButton
                    aria-label="Reject"
                    icon={<FiX />}
                    size="xs"
                    colorScheme="red"
                    onClick={() => onReject(p.participantId)}
                  />
                </Tooltip>
              </HStack>
            ))}
          </VStack>
          <Divider borderColor="whiteAlpha.200" mb={3} />
        </>
      )}

      {/* --- In-Meeting Participants --- */}
      <Text fontSize="xs" color="gray.500" fontWeight="bold" mb={2}>
        IN MEETING
      </Text>
      <VStack spacing={2} align="stretch">
        {participants
          .filter((p) => p.status === 'IN_MEETING')
          .map((participant) => (
            <HStack
              key={participant.id}
              p={2}
              bg="whiteAlpha.50"
              borderRadius="md"
              _hover={{ bg: 'whiteAlpha.100' }}
            >
              <Avatar
                size="xs"
                name={participant.user?.name}
                src={participant.user?.image || undefined}
              />
              <VStack align="start" spacing={0} flex={1}>
                <Text fontSize="sm" noOfLines={1}>
                  {participant.user?.name}
                  {participant.userId === currentUserId && ' (You)'}
                </Text>
                {participant.role !== 'PARTICIPANT' && (
                  <Badge fontSize="xx-small" colorScheme={roleColor(participant.role)}>
                    {participant.role}
                  </Badge>
                )}
              </VStack>

              {/* Host controls for each participant */}
              {isHost && participant.userId !== currentUserId && (
                <HStack spacing={0}>
                  <Tooltip label="Move to lobby">
                    <IconButton
                      aria-label="Move to lobby"
                      icon={<FiCornerDownLeft />}
                      size="xs"
                      variant="ghost"
                      onClick={() => onMoveToLobby(participant.id)}
                    />
                  </Tooltip>
                  <Tooltip label="Transfer host">
                    <IconButton
                      aria-label="Transfer host"
                      icon={<FiStar />}
                      size="xs"
                      variant="ghost"
                      onClick={() => onTransferHost(participant.id)}
                    />
                  </Tooltip>
                  <Tooltip label="Remove">
                    <IconButton
                      aria-label="Remove"
                      icon={<FiUserMinus />}
                      size="xs"
                      variant="ghost"
                      color="red.400"
                      onClick={() => onKick(participant.id)}
                    />
                  </Tooltip>
                </HStack>
              )}
            </HStack>
          ))}
      </VStack>

      {/* --- Invite Modal --- */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent bg="meeting.surface" mx={4}>
          <ModalHeader>Invite to Meeting</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Input
              placeholder="Enter email address"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              bg="whiteAlpha.100"
              borderColor="whiteAlpha.300"
              type="email"
              onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onClose}>Cancel</Button>
            <Button colorScheme="brand" onClick={handleInvite}>
              Send Invite
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}
