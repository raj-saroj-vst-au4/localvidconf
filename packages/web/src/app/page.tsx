// =============================================================================
// Dashboard Page (Home)
// Shows upcoming meetings, quick join, and create meeting options
// Protected route: requires Google OAuth authentication
// Responsive layout adapts from single column (mobile) to multi-column (desktop)
// =============================================================================

'use client';

import { useState, useEffect } from 'react';
import {
  Box, Container, Heading, Text, Button, Input, VStack, HStack,
  SimpleGrid, Card, CardBody, CardHeader, Badge, Flex, IconButton,
  useToast, Modal, ModalOverlay, ModalContent, ModalHeader,
  ModalBody, ModalFooter, ModalCloseButton, useDisclosure, Divider,
} from '@chakra-ui/react';
import { AddIcon, ArrowForwardIcon, CalendarIcon } from '@chakra-ui/icons';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/layout/Navbar';
import ProtectedRoute from '@/components/common/ProtectedRoute';
import type { Meeting } from '@/types';

export default function DashboardPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const toast = useToast();
  const { isOpen, onOpen, onClose } = useDisclosure();

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [joinCode, setJoinCode] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch user's meetings on mount
  useEffect(() => {
    fetchMeetings();
  }, []);

  async function fetchMeetings() {
    try {
      const res = await fetch('/meet/api/meetings');
      if (res.ok) {
        const data = await res.json();
        setMeetings(data.meetings);
      }
    } catch (err) {
      console.error('Failed to fetch meetings:', err);
    } finally {
      setIsLoading(false);
    }
  }

  // --- Quick Join: navigate to meeting by code ---
  function handleJoin() {
    const code = joinCode.trim().toLowerCase();
    if (!code) {
      toast({ title: 'Enter a meeting code', status: 'warning', duration: 3000 });
      return;
    }
    router.push(`/meeting/${code}`);
  }

  // --- Instant Meeting: create and immediately join ---
  async function handleInstantMeeting() {
    setIsCreating(true);
    try {
      const res = await fetch('/meet/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Instant Meeting' }),
      });
      if (res.ok) {
        const data = await res.json();
        router.push(`/meeting/${data.meeting.code}`);
      } else {
        toast({ title: 'Failed to create meeting', status: 'error', duration: 3000 });
      }
    } catch (err) {
      toast({ title: 'Network error', status: 'error', duration: 3000 });
    } finally {
      setIsCreating(false);
    }
  }

  // --- Create Scheduled Meeting ---
  async function handleCreateMeeting() {
    if (!newTitle.trim()) {
      toast({ title: 'Enter a meeting title', status: 'warning', duration: 3000 });
      return;
    }
    setIsCreating(true);
    try {
      const res = await fetch('/meet/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setMeetings((prev) => [data.meeting, ...prev]);
        onClose();
        setNewTitle('');
        toast({ title: 'Meeting created!', status: 'success', duration: 3000 });
      }
    } catch (err) {
      toast({ title: 'Failed to create meeting', status: 'error', duration: 3000 });
    } finally {
      setIsCreating(false);
    }
  }

  // --- Status badge color mapping ---
  function statusColor(status: string) {
    switch (status) {
      case 'LIVE': return 'green';
      case 'SCHEDULED': return 'yellow';
      case 'ENDED': return 'gray';
      default: return 'gray';
    }
  }

  return (
    <ProtectedRoute>
      <Box minH="100vh" bg="gray.900">
        <Navbar />

        <Container
          // Responsive max width: full on mobile, wider on larger screens
          maxW={{ base: '100%', sm: '95%', md: '90%', lg: '1000px', xl: '1200px' }}
          py={{ base: 4, md: 8 }}
          px={{ base: 3, sm: 4, md: 6 }}
        >
          {/* --- Welcome Section --- */}
          <VStack align="start" spacing={2} mb={{ base: 6, md: 8 }}>
            <Heading
              size={{ base: 'md', md: 'lg' }}
              color="white"
            >
              Welcome, {session?.user?.name?.split(' ')[0]}
            </Heading>
            <Text color="gray.400" fontSize={{ base: 'sm', md: 'md' }}>
              Start or join a meeting to get going.
            </Text>
          </VStack>

          {/* --- Quick Actions Grid --- */}
          {/* 1 column on mobile, 2 on tablet, 3 on laptop+ */}
          <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} spacing={{ base: 3, md: 4 }} mb={{ base: 6, md: 8 }}>
            {/* Instant Meeting Card */}
            <Card bg="meeting.surface" border="1px" borderColor="whiteAlpha.200">
              <CardBody>
                <VStack spacing={3}>
                  <IconButton
                    aria-label="New meeting"
                    icon={<AddIcon />}
                    colorScheme="brand"
                    size="lg"
                    borderRadius="full"
                    onClick={handleInstantMeeting}
                    isLoading={isCreating}
                  />
                  <Text fontWeight="bold">New Meeting</Text>
                  <Text fontSize="sm" color="gray.400" textAlign="center">
                    Start an instant meeting
                  </Text>
                </VStack>
              </CardBody>
            </Card>

            {/* Join Meeting Card */}
            <Card bg="meeting.surface" border="1px" borderColor="whiteAlpha.200">
              <CardBody>
                <VStack spacing={3}>
                  <HStack w="full">
                    <Input
                      placeholder="abc-defg-hij"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value)}
                      bg="whiteAlpha.100"
                      border="1px"
                      borderColor="whiteAlpha.300"
                      size={{ base: 'sm', md: 'md' }}
                      // Allow joining by pressing Enter
                      onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                    />
                    <IconButton
                      aria-label="Join meeting"
                      icon={<ArrowForwardIcon />}
                      colorScheme="brand"
                      onClick={handleJoin}
                    />
                  </HStack>
                  <Text fontSize="sm" color="gray.400">
                    Enter a code to join
                  </Text>
                </VStack>
              </CardBody>
            </Card>

            {/* Schedule Meeting Card */}
            <Card bg="meeting.surface" border="1px" borderColor="whiteAlpha.200">
              <CardBody>
                <VStack spacing={3}>
                  <IconButton
                    aria-label="Schedule meeting"
                    icon={<CalendarIcon />}
                    colorScheme="purple"
                    size="lg"
                    borderRadius="full"
                    onClick={() => router.push('/meeting/schedule')}
                  />
                  <Text fontWeight="bold">Schedule</Text>
                  <Text fontSize="sm" color="gray.400" textAlign="center">
                    Plan a future meeting
                  </Text>
                </VStack>
              </CardBody>
            </Card>
          </SimpleGrid>

          <Divider borderColor="whiteAlpha.200" mb={{ base: 4, md: 6 }} />

          {/* --- Meetings List --- */}
          <Flex justify="space-between" align="center" mb={4}>
            <Heading size={{ base: 'sm', md: 'md' }}>Your Meetings</Heading>
            <Button size="sm" leftIcon={<AddIcon />} onClick={onOpen}>
              Create
            </Button>
          </Flex>

          {isLoading ? (
            <Text color="gray.400">Loading meetings...</Text>
          ) : meetings.length === 0 ? (
            <Card bg="meeting.surface" border="1px" borderColor="whiteAlpha.200">
              <CardBody>
                <Text color="gray.400" textAlign="center">
                  No meetings yet. Create one to get started!
                </Text>
              </CardBody>
            </Card>
          ) : (
            <VStack spacing={3} align="stretch">
              {meetings.map((meeting) => (
                <Card
                  key={meeting.id}
                  bg="meeting.surface"
                  border="1px"
                  borderColor="whiteAlpha.200"
                  cursor="pointer"
                  _hover={{ borderColor: 'brand.500', transform: 'translateY(-1px)' }}
                  transition="all 0.2s"
                  onClick={() => router.push(`/meeting/${meeting.code}`)}
                >
                  <CardBody py={3} px={{ base: 3, md: 4 }}>
                    <Flex
                      justify="space-between"
                      align={{ base: 'start', sm: 'center' }}
                      direction={{ base: 'column', sm: 'row' }}
                      gap={2}
                    >
                      <VStack align="start" spacing={1}>
                        <HStack>
                          <Text fontWeight="bold" fontSize={{ base: 'sm', md: 'md' }}>
                            {meeting.title}
                          </Text>
                          <Badge colorScheme={statusColor(meeting.status)} fontSize="xs">
                            {meeting.status}
                          </Badge>
                        </HStack>
                        <Text fontSize="xs" color="gray.500">
                          Code: {meeting.code}
                        </Text>
                      </VStack>
                      <Button size="sm" colorScheme="brand" variant="outline">
                        {meeting.status === 'LIVE' ? 'Join' : 'Open'}
                      </Button>
                    </Flex>
                  </CardBody>
                </Card>
              ))}
            </VStack>
          )}
        </Container>
      </Box>

      {/* --- Create Meeting Modal --- */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent bg="meeting.surface" mx={{ base: 4, md: 0 }}>
          <ModalHeader>Create Meeting</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Input
              placeholder="Meeting title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              bg="whiteAlpha.100"
              border="1px"
              borderColor="whiteAlpha.300"
              onKeyDown={(e) => e.key === 'Enter' && handleCreateMeeting()}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onClose}>Cancel</Button>
            <Button
              colorScheme="brand"
              onClick={handleCreateMeeting}
              isLoading={isCreating}
            >
              Create
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </ProtectedRoute>
  );
}
