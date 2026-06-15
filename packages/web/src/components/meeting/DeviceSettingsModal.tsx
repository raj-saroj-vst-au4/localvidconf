// =============================================================================
// Device Settings Modal
// In-meeting modal that lets the user switch their active camera, microphone,
// and speaker without leaving the call. The parent owns the device lists and
// current selections; this component is a thin, controlled view that calls
// the supplied onSelect callbacks. Speaker selection is only shown when the
// browser exposes audiooutput devices (setSinkId support).
// =============================================================================

'use client';

import {
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter,
  ModalCloseButton, FormControl, FormLabel, Select, VStack, Button, Text,
} from '@chakra-ui/react';
import { FiVideo, FiMic, FiVolume2 } from 'react-icons/fi';

interface DeviceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;

  // Device lists (typically from navigator.mediaDevices.enumerateDevices()).
  videoInputDevices: MediaDeviceInfo[];
  audioInputDevices: MediaDeviceInfo[];
  audioOutputDevices?: MediaDeviceInfo[];

  // Currently selected device ids.
  currentVideoDeviceId?: string;
  currentAudioDeviceId?: string;
  currentSpeakerDeviceId?: string;

  // Selection callbacks.
  onSelectVideo: (deviceId: string) => void;
  onSelectAudio: (deviceId: string) => void;
  onSelectSpeaker?: (deviceId: string) => void;
}

export default function DeviceSettingsModal({
  isOpen,
  onClose,
  videoInputDevices,
  audioInputDevices,
  audioOutputDevices = [],
  currentVideoDeviceId,
  currentAudioDeviceId,
  currentSpeakerDeviceId,
  onSelectVideo,
  onSelectAudio,
  onSelectSpeaker,
}: DeviceSettingsModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered>
      <ModalOverlay />
      <ModalContent bg="meeting.surface" mx={4}>
        <ModalHeader>Settings</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <VStack align="stretch" spacing={4}>
            <FormControl>
              <FormLabel fontSize="sm" mb={1}>
                <FiVideo style={{ display: 'inline', marginRight: 6 }} />
                Camera
              </FormLabel>
              <Select
                size="sm"
                bg="whiteAlpha.100"
                borderColor="whiteAlpha.300"
                value={currentVideoDeviceId ?? ''}
                onChange={(e) => onSelectVideo(e.target.value)}
                isDisabled={videoInputDevices.length === 0}
              >
                {videoInputDevices.length === 0 && (
                  <option value="">No cameras found</option>
                )}
                {videoInputDevices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId} style={{ color: 'black' }}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </Select>
            </FormControl>

            <FormControl>
              <FormLabel fontSize="sm" mb={1}>
                <FiMic style={{ display: 'inline', marginRight: 6 }} />
                Microphone
              </FormLabel>
              <Select
                size="sm"
                bg="whiteAlpha.100"
                borderColor="whiteAlpha.300"
                value={currentAudioDeviceId ?? ''}
                onChange={(e) => onSelectAudio(e.target.value)}
                isDisabled={audioInputDevices.length === 0}
              >
                {audioInputDevices.length === 0 && (
                  <option value="">No microphones found</option>
                )}
                {audioInputDevices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId} style={{ color: 'black' }}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </Select>
            </FormControl>

            {audioOutputDevices.length > 0 && onSelectSpeaker && (
              <FormControl>
                <FormLabel fontSize="sm" mb={1}>
                  <FiVolume2 style={{ display: 'inline', marginRight: 6 }} />
                  Speaker
                </FormLabel>
                <Select
                  size="sm"
                  bg="whiteAlpha.100"
                  borderColor="whiteAlpha.300"
                  value={currentSpeakerDeviceId ?? ''}
                  onChange={(e) => onSelectSpeaker(e.target.value)}
                >
                  {audioOutputDevices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId} style={{ color: 'black' }}>
                      {d.label || `Speaker ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </FormControl>
            )}

            <Text fontSize="xs" color="gray.500">
              Changes apply immediately to your live audio and video.
            </Text>
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button colorScheme="brand" onClick={onClose}>Done</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
