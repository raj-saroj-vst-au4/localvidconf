// =============================================================================
// Control Bar Component
// Bottom bar with meeting controls: mute, camera, screen share, leave, etc.
// Responsive: shows icons only on mobile, icons + labels on desktop.
// Positioned fixed at the bottom of the meeting room.
// Device selection: chevron menus appear next to mic/camera when multiple
// devices are available.
// =============================================================================

'use client';

import {
  Flex, IconButton, Button, Tooltip, Box, Text, Menu, MenuButton,
  MenuList, MenuItem, Divider,
} from '@chakra-ui/react';
import { ChevronUpIcon } from '@chakra-ui/icons';
import {
  FiMic, FiMicOff, FiVideo, FiVideoOff, FiMonitor, FiPhoneOff,
  FiUsers, FiMessageSquare, FiHelpCircle, FiMoreVertical, FiGrid,
} from 'react-icons/fi';

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
  // Device selection (optional — hidden when only one device available)
  videoDevices?: MediaDeviceInfo[];
  audioDevices?: MediaDeviceInfo[];
  selectedVideoDeviceId?: string | null;
  selectedAudioDeviceId?: string | null;
  onSelectVideoDevice?: (deviceId: string) => void;
  onSelectAudioDevice?: (deviceId: string) => void;
  // True when a different participant is sharing — disables the button for others
  someoneElseIsScreenSharing?: boolean;
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
  videoDevices = [],
  audioDevices = [],
  selectedVideoDeviceId,
  selectedAudioDeviceId,
  onSelectVideoDevice,
  onSelectAudioDevice,
  someoneElseIsScreenSharing = false,
}: ControlBarProps) {
  const hasMultipleVideoDevices = videoDevices.length > 1;
  const hasMultipleAudioDevices = audioDevices.length > 1;

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

          {/* Microphone toggle + optional device selector */}
          <Flex align="center">
            <Tooltip label={isAudioEnabled ? 'Mute' : 'Unmute'}>
              <IconButton
                aria-label={isAudioEnabled ? 'Mute' : 'Unmute'}
                icon={isAudioEnabled ? <FiMic /> : <FiMicOff />}
                variant={isAudioEnabled ? 'control' : 'danger'}
                size={{ base: 'md', md: 'lg' }}
                onClick={onToggleAudio}
                borderRadius={hasMultipleAudioDevices ? 'full' : 'full'}
              />
            </Tooltip>
            {hasMultipleAudioDevices && onSelectAudioDevice && (
              <Menu placement="top">
                <Tooltip label="Select microphone">
                  <MenuButton
                    as={IconButton}
                    aria-label="Select microphone"
                    icon={<ChevronUpIcon />}
                    size="xs"
                    variant="ghost"
                    color="whiteAlpha.700"
                    _hover={{ color: 'white', bg: 'whiteAlpha.200' }}
                    minW="18px"
                    h="18px"
                    ml={-1}
                    mb={4}
                  />
                </Tooltip>
                <MenuList bg="meeting.surface" borderColor="whiteAlpha.300" maxW="280px">
                  <Text px={3} py={1} fontSize="xs" color="gray.400" fontWeight="semibold" textTransform="uppercase">
                    Microphone
                  </Text>
                  {audioDevices.map((device) => (
                    <MenuItem
                      key={device.deviceId}
                      onClick={() => onSelectAudioDevice(device.deviceId)}
                      bg="transparent"
                      _hover={{ bg: 'whiteAlpha.200' }}
                      fontSize="sm"
                      fontWeight={device.deviceId === selectedAudioDeviceId ? 'bold' : 'normal'}
                      color={device.deviceId === selectedAudioDeviceId ? 'brand.300' : 'inherit'}
                    >
                      {device.label || `Microphone ${audioDevices.indexOf(device) + 1}`}
                    </MenuItem>
                  ))}
                </MenuList>
              </Menu>
            )}
          </Flex>

          {/* Camera toggle + optional device selector */}
          <Flex align="center">
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
            {hasMultipleVideoDevices && onSelectVideoDevice && (
              <Menu placement="top">
                <Tooltip label="Select camera">
                  <MenuButton
                    as={IconButton}
                    aria-label="Select camera"
                    icon={<ChevronUpIcon />}
                    size="xs"
                    variant="ghost"
                    color="whiteAlpha.700"
                    _hover={{ color: 'white', bg: 'whiteAlpha.200' }}
                    minW="18px"
                    h="18px"
                    ml={-1}
                    mb={4}
                  />
                </Tooltip>
                <MenuList bg="meeting.surface" borderColor="whiteAlpha.300" maxW="280px">
                  <Text px={3} py={1} fontSize="xs" color="gray.400" fontWeight="semibold" textTransform="uppercase">
                    Camera
                  </Text>
                  {videoDevices.map((device) => (
                    <MenuItem
                      key={device.deviceId}
                      onClick={() => onSelectVideoDevice(device.deviceId)}
                      bg="transparent"
                      _hover={{ bg: 'whiteAlpha.200' }}
                      fontSize="sm"
                      fontWeight={device.deviceId === selectedVideoDeviceId ? 'bold' : 'normal'}
                      color={device.deviceId === selectedVideoDeviceId ? 'brand.300' : 'inherit'}
                    >
                      {device.label || `Camera ${videoDevices.indexOf(device) + 1}`}
                    </MenuItem>
                  ))}
                </MenuList>
              </Menu>
            )}
          </Flex>

          {/* Screen share toggle — disabled when another participant is sharing */}
          <Tooltip label={
            isScreenSharing
              ? 'Stop sharing'
              : someoneElseIsScreenSharing
                ? 'Another participant is already sharing'
                : 'Share screen'
          }>
            <IconButton
              aria-label="Screen share"
              icon={<FiMonitor />}
              variant={isScreenSharing ? 'controlActive' : 'control'}
              size={{ base: 'md', md: 'lg' }}
              onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
              isDisabled={someoneElseIsScreenSharing}
              borderRadius="full"
            />
          </Tooltip>
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
              {/* Device selectors in mobile overflow */}
              {hasMultipleAudioDevices && onSelectAudioDevice && (
                <>
                  <Divider borderColor="whiteAlpha.200" />
                  <Text px={3} py={1} fontSize="xs" color="gray.400" fontWeight="semibold" textTransform="uppercase">
                    Microphone
                  </Text>
                  {audioDevices.map((device) => (
                    <MenuItem
                      key={device.deviceId}
                      onClick={() => onSelectAudioDevice(device.deviceId)}
                      bg="transparent"
                      _hover={{ bg: 'whiteAlpha.200' }}
                      fontSize="sm"
                      fontWeight={device.deviceId === selectedAudioDeviceId ? 'bold' : 'normal'}
                    >
                      {device.label || `Microphone ${audioDevices.indexOf(device) + 1}`}
                    </MenuItem>
                  ))}
                </>
              )}
              {hasMultipleVideoDevices && onSelectVideoDevice && (
                <>
                  <Divider borderColor="whiteAlpha.200" />
                  <Text px={3} py={1} fontSize="xs" color="gray.400" fontWeight="semibold" textTransform="uppercase">
                    Camera
                  </Text>
                  {videoDevices.map((device) => (
                    <MenuItem
                      key={device.deviceId}
                      onClick={() => onSelectVideoDevice(device.deviceId)}
                      bg="transparent"
                      _hover={{ bg: 'whiteAlpha.200' }}
                      fontSize="sm"
                      fontWeight={device.deviceId === selectedVideoDeviceId ? 'bold' : 'normal'}
                    >
                      {device.label || `Camera ${videoDevices.indexOf(device) + 1}`}
                    </MenuItem>
                  ))}
                </>
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
