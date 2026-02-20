// =============================================================================
// Host Controls Component
// Quick-access host actions shown as a floating toolbar.
// Wraps commonly used host actions: mute all, toggle lobby, end meeting.
// These are also accessible via the participant list, but this provides
// a more prominent UI for frequently used actions.
// =============================================================================

'use client';

import {
  HStack, IconButton, Tooltip, Menu, MenuButton, MenuList, MenuItem,
  Switch, FormControl, FormLabel, Text,
} from '@chakra-ui/react';
import { FiSettings, FiLock, FiUnlock, FiUsers } from 'react-icons/fi';

interface HostControlsProps {
  lobbyEnabled: boolean;
  onToggleLobby: (enabled: boolean) => void;
}

export default function HostControls({
  lobbyEnabled,
  onToggleLobby,
}: HostControlsProps) {
  return (
    <Menu>
      <Tooltip label="Host controls">
        <MenuButton
          as={IconButton}
          aria-label="Host controls"
          icon={<FiSettings />}
          variant="control"
          borderRadius="full"
        />
      </Tooltip>
      <MenuList bg="meeting.surface" borderColor="whiteAlpha.300" p={3}>
        <FormControl display="flex" alignItems="center" mb={2}>
          <FormLabel mb={0} fontSize="sm" flex={1}>
            {lobbyEnabled ? <FiLock style={{ display: 'inline' }} /> : <FiUnlock style={{ display: 'inline' }} />}
            {' '}Lobby
          </FormLabel>
          <Switch
            isChecked={lobbyEnabled}
            onChange={(e) => onToggleLobby(e.target.checked)}
            colorScheme="brand"
            size="sm"
          />
        </FormControl>
        <Text fontSize="xs" color="gray.500">
          When enabled, new participants wait for approval.
        </Text>
      </MenuList>
    </Menu>
  );
}
