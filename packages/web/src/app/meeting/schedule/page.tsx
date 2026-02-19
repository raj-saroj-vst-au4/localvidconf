// =============================================================================
// Schedule Meeting Page
// Form to create a scheduled meeting with date/time, title, description
// Automatically creates email + in-app reminders (15 min and 5 min before)
// =============================================================================

'use client';

import { useState } from 'react';
import {
  Box, Container, Heading, VStack, Input, Textarea, Button, FormControl,
  FormLabel, Switch, useToast, Card, CardBody, Text, HStack, Code,
} from '@chakra-ui/react';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/layout/Navbar';
import ProtectedRoute from '@/components/common/ProtectedRoute';

export default function ScheduleMeetingPage() {
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [lobbyEnabled, setLobbyEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdMeeting, setCreatedMeeting] = useState<any>(null);

  async function handleSubmit() {
    if (!title.trim()) {
      toast({ title: 'Title is required', status: 'warning', duration: 3000 });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/meet/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          scheduledAt: scheduledAt || undefined,
          lobbyEnabled,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setCreatedMeeting(data.meeting);
        toast({ title: 'Meeting scheduled!', status: 'success', duration: 3000 });
      } else {
        const data = await res.json();
        toast({ title: data.error || 'Failed to create meeting', status: 'error', duration: 3000 });
      }
    } catch {
      toast({ title: 'Network error', status: 'error', duration: 3000 });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ProtectedRoute>
      <Box minH="100vh" bg="gray.900">
        <Navbar />
        <Container
          maxW={{ base: '100%', sm: '95%', md: '600px' }}
          py={{ base: 4, md: 8 }}
          px={{ base: 3, sm: 4, md: 6 }}
        >
          <Heading size={{ base: 'md', md: 'lg' }} mb={6}>Schedule a Meeting</Heading>

          {/* Show creation success with join code */}
          {createdMeeting ? (
            <Card bg="meeting.surface" border="1px" borderColor="green.500">
              <CardBody>
                <VStack spacing={4}>
                  <Heading size="md" color="green.400">Meeting Created!</Heading>
                  <VStack spacing={1}>
                    <Text fontWeight="bold">{createdMeeting.title}</Text>
                    <Text color="gray.400">Share this code with participants:</Text>
                    <Code
                      fontSize={{ base: 'xl', md: '2xl' }}
                      p={3}
                      borderRadius="md"
                      colorScheme="brand"
                    >
                      {createdMeeting.code}
                    </Code>
                  </VStack>
                  <HStack spacing={3} flexWrap="wrap" justify="center">
                    <Button
                      colorScheme="brand"
                      onClick={() => router.push(`/meeting/${createdMeeting.code}`)}
                    >
                      Join Now
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(createdMeeting.code);
                        toast({ title: 'Code copied!', status: 'info', duration: 2000 });
                      }}
                    >
                      Copy Code
                    </Button>
                    <Button variant="ghost" onClick={() => setCreatedMeeting(null)}>
                      Schedule Another
                    </Button>
                  </HStack>
                </VStack>
              </CardBody>
            </Card>
          ) : (
            <Card bg="meeting.surface" border="1px" borderColor="whiteAlpha.200">
              <CardBody>
                <VStack spacing={5}>
                  <FormControl isRequired>
                    <FormLabel>Meeting Title</FormLabel>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Weekly standup"
                      bg="whiteAlpha.100"
                      borderColor="whiteAlpha.300"
                    />
                  </FormControl>

                  <FormControl>
                    <FormLabel>Description</FormLabel>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What's this meeting about?"
                      bg="whiteAlpha.100"
                      borderColor="whiteAlpha.300"
                      rows={3}
                    />
                  </FormControl>

                  <FormControl>
                    <FormLabel>Schedule Date & Time</FormLabel>
                    <Input
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                      bg="whiteAlpha.100"
                      borderColor="whiteAlpha.300"
                      // Prevent scheduling in the past
                      min={new Date().toISOString().slice(0, 16)}
                    />
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      Leave empty for an instant meeting (no reminders).
                    </Text>
                  </FormControl>

                  <FormControl display="flex" alignItems="center">
                    <FormLabel mb={0}>Enable Lobby</FormLabel>
                    <Switch
                      isChecked={lobbyEnabled}
                      onChange={(e) => setLobbyEnabled(e.target.checked)}
                      colorScheme="brand"
                    />
                  </FormControl>
                  <Text fontSize="xs" color="gray.500" mt={-3}>
                    When enabled, participants wait in a lobby until the host admits them.
                  </Text>

                  <Button
                    w="full"
                    colorScheme="brand"
                    size="lg"
                    onClick={handleSubmit}
                    isLoading={isSubmitting}
                  >
                    Schedule Meeting
                  </Button>
                </VStack>
              </CardBody>
            </Card>
          )}
        </Container>
      </Box>
    </ProtectedRoute>
  );
}
