// =============================================================================
// Navigation Bar
// Top navigation with logo, user menu, and sign out
// Responsive: collapses to hamburger on mobile
// Only shown outside of meeting rooms (meetings have their own controls)
// =============================================================================

'use client';

import {
  Box, Flex, Button, Text, Avatar, Menu, MenuButton, MenuList, MenuItem,
  IconButton, useDisclosure, Drawer, DrawerOverlay, DrawerContent,
  DrawerHeader, DrawerBody, VStack, HStack, Divider,
} from '@chakra-ui/react';
import { HamburgerIcon, CloseIcon } from '@chakra-ui/icons';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export default function Navbar() {
  const { data: session } = useSession();
  const router = useRouter();
  // Mobile drawer state (hamburger menu)
  const { isOpen, onOpen, onClose } = useDisclosure();

  return (
    <Box bg="meeting.surface" borderBottom="1px" borderColor="whiteAlpha.200" px={4}>
      <Flex
        h={16}
        alignItems="center"
        justifyContent="space-between"
        // Responsive max width: full on mobile, centered on desktop
        maxW={{ base: '100%', lg: '1200px', xl: '1400px' }}
        mx="auto"
      >
        {/* --- Logo / Brand --- */}
        <HStack
          spacing={2}
          cursor="pointer"
          onClick={() => router.push('/')}
        >
          <Text
            fontSize={{ base: 'lg', md: 'xl' }}
            fontWeight="bold"
            bgGradient="linear(to-r, brand.400, brand.600)"
            bgClip="text"
          >
            Confera
          </Text>
        </HStack>

        {/* --- Desktop Nav Items --- */}
        {/* Hidden on mobile (base), shown from tablet (md) and up */}
        <HStack spacing={4} display={{ base: 'none', md: 'flex' }}>
          {session ? (
            <>
              <Button
                variant="ghost"
                color="gray.300"
                _hover={{ color: 'white' }}
                onClick={() => router.push('/')}
              >
                Dashboard
              </Button>
              <Button
                variant="ghost"
                color="gray.300"
                _hover={{ color: 'white' }}
                onClick={() => router.push('/meeting/schedule')}
              >
                Schedule
              </Button>

              {/* User avatar menu with sign out */}
              <Menu>
                <MenuButton>
                  <Avatar
                    size="sm"
                    name={session.user?.name || ''}
                    src={session.user?.image || ''}
                  />
                </MenuButton>
                <MenuList bg="meeting.surface" borderColor="whiteAlpha.300">
                  <MenuItem
                    bg="transparent"
                    _hover={{ bg: 'whiteAlpha.200' }}
                    isDisabled
                  >
                    <VStack align="start" spacing={0}>
                      <Text fontWeight="bold">{session.user?.name}</Text>
                      <Text fontSize="xs" color="gray.400">{session.user?.email}</Text>
                    </VStack>
                  </MenuItem>
                  <Divider borderColor="whiteAlpha.200" />
                  <MenuItem
                    bg="transparent"
                    _hover={{ bg: 'whiteAlpha.200' }}
                    onClick={() => signOut({ callbackUrl: '/auth/signin' })}
                  >
                    Sign Out
                  </MenuItem>
                </MenuList>
              </Menu>
            </>
          ) : (
            <Button
              colorScheme="brand"
              onClick={() => router.push('/auth/signin')}
            >
              Sign In
            </Button>
          )}
        </HStack>

        {/* --- Mobile Hamburger Button --- */}
        {/* Only shown on mobile (base), hidden from tablet (md) and up */}
        <IconButton
          display={{ base: 'flex', md: 'none' }}
          aria-label="Open menu"
          icon={isOpen ? <CloseIcon /> : <HamburgerIcon />}
          variant="ghost"
          color="white"
          onClick={isOpen ? onClose : onOpen}
        />
      </Flex>

      {/* --- Mobile Drawer Navigation --- */}
      <Drawer isOpen={isOpen} placement="right" onClose={onClose}>
        <DrawerOverlay />
        <DrawerContent bg="meeting.surface">
          <DrawerHeader borderBottomWidth="1px" borderColor="whiteAlpha.200">
            {session && (
              <HStack>
                <Avatar
                  size="sm"
                  name={session.user?.name || ''}
                  src={session.user?.image || ''}
                />
                <VStack align="start" spacing={0}>
                  <Text fontSize="sm" fontWeight="bold">{session.user?.name}</Text>
                  <Text fontSize="xs" color="gray.400">{session.user?.email}</Text>
                </VStack>
              </HStack>
            )}
          </DrawerHeader>
          <DrawerBody>
            <VStack spacing={4} mt={4}>
              <Button
                w="full"
                variant="ghost"
                justifyContent="start"
                onClick={() => { router.push('/'); onClose(); }}
              >
                Dashboard
              </Button>
              <Button
                w="full"
                variant="ghost"
                justifyContent="start"
                onClick={() => { router.push('/meeting/schedule'); onClose(); }}
              >
                Schedule Meeting
              </Button>
              <Divider borderColor="whiteAlpha.200" />
              <Button
                w="full"
                variant="ghost"
                justifyContent="start"
                color="red.400"
                onClick={() => signOut({ callbackUrl: '/auth/signin' })}
              >
                Sign Out
              </Button>
            </VStack>
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </Box>
  );
}
