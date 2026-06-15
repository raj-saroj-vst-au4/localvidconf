// =============================================================================
// Control Bar Component
// Bottom bar with meeting controls: mute, camera, screen share, leave, etc.
// Responsive: shows icons only on mobile, icons + labels on desktop.
// Positioned fixed at the bottom of the meeting room.
// =============================================================================

'use client';

import {
  Flex, IconButton, Button, Tooltip, Box, Text, Menu, MenuButton,
  MenuList, MenuItem, Divider, useDisclosure, Popover, PopoverTrigger,
  PopoverContent, PopoverBody, SimpleGrid,
} from '@chakra-ui/react';
import {
  FiMic, FiMicOff, FiVideo, FiVideoOff, FiMonitor, FiPhoneOff,
  FiUsers, FiMessageSquare, FiHelpCircle, FiMoreVertical, FiGrid,
  FiSmile, FiVolumeX, FiSettings,
} from 'react-icons/fi';

// Emoji set offered in the reactions popover (matches server's allow-list).
const REACTION_EMOJIS = ['👍', '👏', '❤️', '😂', '😮', '🎉', '🙌', '✋'];

interface ControlBarProps {
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isHost: boolean;
  participantCount: number;
  // Toggles
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
  onLeaveMeeting: () => void;
  onEndMeeting: () => void;
  // Panel toggles
  onToggleParticipants: () => void;
  onToggleChat: () => void;
  onToggleQA: () => void;
  onToggleBreakout: () => void;
  // Panel open states
  isParticipantsOpen: boolean;
  isChatOpen: boolean;
  isQAOpen: boolean;
  // Reactions, hand, host mute-all, settings (all optional; wired by page agent)
  onReaction?: (emoji: string) => void;
  onToggleHand?: () => void;
  isHandRaised?: boolean;
  onMuteAll?: () => void;
  onOpenSettings?: () => void;
}

export default function ControlBar({
  isAudioEnabled,
  isVideoEnabled,
  isScreenSharing,
  isHost,
  participantCount,
  onToggleAudio,
  onToggleVideo,
  onStartScreenShare,
  onStopScreenShare,
  onLeaveMeeting,
  onEndMeeting,
  onToggleParticipants,
  onToggleChat,
  onToggleQA,
  onToggleBreakout,
  isParticipantsOpen,
  isChatOpen,
  isQAOpen,
  onReaction,
  onToggleHand,
  isHandRaised = false,
  onMuteAll,
  onOpenSettings,
}: ControlBarProps) {
  return (
    <Flex
      position="fixed"
      bottom={0}
      left={0}
      right={0}
      bg="meeting.control"
      borderTop="1px"
      borderColor="whiteAlpha.200"
      py={{ base: 2, md: 3 }}
      px={{ base: 2, md: 6 }}
      justify="center"
      align="center"
      zIndex={100}
      // Safe area inset for mobile notch/home bar
      pb={{ base: 'calc(8px + env(safe-area-inset-bottom))', md: 3 }}
    >
      <Flex
        maxW="900px"
        w="100%"
        justify="space-between"
        align="center"
      >
        {/* --- Left: Media Controls --- */}
        <Flex gap={{ base: 1, sm: 2 }} align="center">
          {/* Microphone toggle */}
          <Tooltip label={isAudioEnabled ? 'Mute' : 'Unmute'}>
            <IconButton
              aria-label={isAudioEnabled ? 'Mute' : 'Unmute'}
              icon={isAudioEnabled ? <FiMic /> : <FiMicOff />}
              variant={isAudioEnabled ? 'control' : 'danger'}
              size={{ base: 'md', md: 'lg' }}
              onClick={onToggleAudio}
              borderRadius="full"
            />
          </Tooltip>

          {/* Camera toggle */}
          <Tooltip label={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}>
            <IconButton
              aria-label={isVideoEnabled ? 'Camera off' : 'Camera on'}
              icon={isVideoEnabled ? <FiVideo /> : <FiVideoOff />}
              variant={isVideoEnabled ? 'control' : 'danger'}
              size={{ base: 'md', md: 'lg' }}
              onClick={onToggleVideo}
              borderRadius="full"
            />
          </Tooltip>

          {/* Screen share toggle */}
          <Tooltip label={isScreenSharing ? 'Stop sharing' : 'Share screen'}>
            <IconButton
              aria-label="Screen share"
              icon={<FiMonitor />}
              variant={isScreenSharing ? 'controlActive' : 'control'}
              size={{ base: 'md', md: 'lg' }}
              onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
              borderRadius="full"
            />
          </Tooltip>

          {/* Reactions popover */}
          {onReaction && (
            <Popover placement="top" isLazy>
              <Tooltip label="Reactions">
                <Box display="inline-block">
                  <PopoverTrigger>
                    <IconButton
                      aria-label="Reactions"
                      icon={<FiSmile />}
                      variant="control"
                      size={{ base: 'md', md: 'lg' }}
                      borderRadius="full"
                    />
                  </PopoverTrigger>
                </Box>
              </Tooltip>
              <PopoverContent
                w="auto"
                bg="meeting.surface"
                borderColor="whiteAlpha.300"
              >
                <PopoverBody>
                  <SimpleGrid columns={4} spacing={1}>
                    {REACTION_EMOJIS.map((emoji) => (
                      <IconButton
                        key={emoji}
                        aria-label={`React ${emoji}`}
                        icon={<Text fontSize="xl">{emoji}</Text>}
                        variant="ghost"
                        size="md"
                        onClick={() => onReaction(emoji)}
                      />
                    ))}
                  </SimpleGrid>
                </PopoverBody>
              </PopoverContent>
            </Popover>
          )}

          {/* Raise / lower hand */}
          {onToggleHand && (
            <Tooltip label={isHandRaised ? 'Lower hand' : 'Raise hand'}>
              <IconButton
                aria-label={isHandRaised ? 'Lower hand' : 'Raise hand'}
                icon={<Text fontSize="lg">✋</Text>}
                variant={isHandRaised ? 'controlActive' : 'control'}
                size={{ base: 'md', md: 'lg' }}
                onClick={onToggleHand}
                borderRadius="full"
              />
            </Tooltip>
          )}
        </Flex>

        {/* --- Center: Feature Panels --- */}
        {/* Hidden on smallest mobile, shown from sm breakpoint */}
        <Flex gap={{ base: 1, sm: 2 }} align="center" display={{ base: 'none', sm: 'flex' }}>
          {/* Participants panel */}
          <Tooltip label="Participants">
            <Box position="relative">
              <IconButton
                aria-label="Participants"
                icon={<FiUsers />}
                variant={isParticipantsOpen ? 'controlActive' : 'control'}
                size={{ base: 'md', md: 'lg' }}
                onClick={onToggleParticipants}
                borderRadius="full"
              />
              {/* Participant count badge */}
              <Text
                position="absolute"
                top={-1}
                right={-1}
                bg="brand.500"
                color="white"
                fontSize="xs"
                fontWeight="bold"
                borderRadius="full"
                px={1.5}
                minW="20px"
                textAlign="center"
              >
                {participantCount}
              </Text>
            </Box>
          </Tooltip>

          {/* Chat panel */}
          <Tooltip label="Chat">
            <IconButton
              aria-label="Chat"
              icon={<FiMessageSquare />}
              variant={isChatOpen ? 'controlActive' : 'control'}
              size={{ base: 'md', md: 'lg' }}
              onClick={onToggleChat}
              borderRadius="full"
            />
          </Tooltip>

          {/* Q&A panel */}
          <Tooltip label="Q&A">
            <IconButton
              aria-label="Q&A"
              icon={<FiHelpCircle />}
              variant={isQAOpen ? 'controlActive' : 'control'}
              size={{ base: 'md', md: 'lg' }}
              onClick={onToggleQA}
              borderRadius="full"
            />
          </Tooltip>

          {/* Breakout rooms (host only) */}
          {isHost && (
            <Tooltip label="Breakout rooms">
              <IconButton
                aria-label="Breakout rooms"
                icon={<FiGrid />}
                variant="control"
                size={{ base: 'md', md: 'lg' }}
                onClick={onToggleBreakout}
                borderRadius="full"
              />
            </Tooltip>
          )}

          {/* Mute all (host only) */}
          {isHost && onMuteAll && (
            <Tooltip label="Mute everyone">
              <IconButton
                aria-label="Mute all"
                icon={<FiVolumeX />}
                variant="control"
                size={{ base: 'md', md: 'lg' }}
                onClick={onMuteAll}
                borderRadius="full"
              />
            </Tooltip>
          )}

          {/* Settings / devices */}
          {onOpenSettings && (
            <Tooltip label="Settings">
              <IconButton
                aria-label="Settings"
                icon={<FiSettings />}
                variant="control"
                size={{ base: 'md', md: 'lg' }}
                onClick={onOpenSettings}
                borderRadius="full"
              />
            </Tooltip>
          )}
        </Flex>

        {/* --- Mobile overflow menu (replaces center buttons on mobile) --- */}
        <Box display={{ base: 'block', sm: 'none' }}>
          <Menu>
            <MenuButton
              as={IconButton}
              aria-label="More options"
              icon={<FiMoreVertical />}
              variant="control"
              borderRadius="full"
            />
            <MenuList bg="meeting.surface" borderColor="whiteAlpha.300">
              <MenuItem icon={<FiUsers />} onClick={onToggleParticipants} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                Participants ({participantCount})
              </MenuItem>
              <MenuItem icon={<FiMessageSquare />} onClick={onToggleChat} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                Chat
              </MenuItem>
              <MenuItem icon={<FiHelpCircle />} onClick={onToggleQA} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                Q&A
              </MenuItem>
              {isHost && (
                <MenuItem icon={<FiGrid />} onClick={onToggleBreakout} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                  Breakout Rooms
                </MenuItem>
              )}
              {isHost && onMuteAll && (
                <MenuItem icon={<FiVolumeX />} onClick={onMuteAll} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                  Mute Everyone
                </MenuItem>
              )}
              {onToggleHand && (
                <MenuItem icon={<Text as="span">✋</Text>} onClick={onToggleHand} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                  {isHandRaised ? 'Lower Hand' : 'Raise Hand'}
                </MenuItem>
              )}
              {onOpenSettings && (
                <MenuItem icon={<FiSettings />} onClick={onOpenSettings} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                  Settings
                </MenuItem>
              )}
            </MenuList>
          </Menu>
        </Box>

        {/* --- Right: Leave/End --- */}
        <Flex gap={2} align="center">
          {isHost ? (
            <Menu>
              <MenuButton
                as={Button}
                bg="meeting.danger"
                color="white"
                _hover={{ bg: 'red.600' }}
                size={{ base: 'sm', md: 'md' }}
                leftIcon={<FiPhoneOff />}
              >
                <Text display={{ base: 'none', md: 'inline' }}>End</Text>
              </MenuButton>
              <MenuList bg="meeting.surface" borderColor="whiteAlpha.300">
                <MenuItem onClick={onLeaveMeeting} bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                  Leave meeting
                </MenuItem>
                <MenuItem onClick={onEndMeeting} color="red.400" bg="transparent" _hover={{ bg: 'whiteAlpha.200' }}>
                  End meeting for all
                </MenuItem>
              </MenuList>
            </Menu>
          ) : (
            <Button
              bg="meeting.danger"
              color="white"
              _hover={{ bg: 'red.600' }}
              size={{ base: 'sm', md: 'md' }}
              leftIcon={<FiPhoneOff />}
              onClick={onLeaveMeeting}
            >
              <Text display={{ base: 'none', md: 'inline' }}>Leave</Text>
            </Button>
          )}
        </Flex>
      </Flex>
    </Flex>
  );
}
