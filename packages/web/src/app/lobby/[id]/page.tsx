// =============================================================================
// Lobby Waiting Room Page
// Displayed when a participant joins a meeting with lobby enabled
// Shows a waiting screen until the host admits them
// Listens for 'admitted' socket event to redirect to the meeting room
// =============================================================================

'use client';

import { useEffect, useState } from 'react';
import {
  Box, Center, VStack, Heading, Text, Spinner, Card, CardBody, Avatar,
} from '@chakra-ui/react';
import { useSession } from 'next-auth/react';
import { useRouter, useParams } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import ProtectedRoute from '@/components/common/ProtectedRoute';

export default function LobbyPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const params = useParams();
  const meetingCode = params.id as string;
  const [meetingTitle, setMeetingTitle] = useState('');
  const [isRejected, setIsRejected] = useState(false);

  useEffect(() => {
    if (!session) return;

    // Get the existing socket (already connected and in lobby from useMeeting)
    const socket = getSocket((session as any).accessToken);

    // Only connect and emit join-meeting if not already connected
    // (the meeting page already joined and put us in the lobby room)
    if (!socket.connected) {
      socket.connect();
      socket.emit('join-meeting', { meetingCode });
    }

    socket.on('lobby-waiting', (data: { meetingTitle: string }) => {
      setMeetingTitle(data.meetingTitle);
    });

    // Host admitted us → redirect to the actual meeting room
    socket.on('admitted', () => {
      router.push(`/meeting/${meetingCode}`);
    });

    socket.on('lobby-rejected', () => {
      setIsRejected(true);
    });

    return () => {
      socket.off('lobby-waiting');
      socket.off('admitted');
      socket.off('lobby-rejected');
    };
  }, [session, meetingCode, router]);

  return (
    <ProtectedRoute>
      <Box minH="100vh" bg="gray.900">
        <Center h="100vh" px={4}>
          <Card
            bg="meeting.surface"
            border="1px"
            borderColor="whiteAlpha.200"
            w={{ base: '100%', sm: '400px' }}
          >
            <CardBody p={{ base: 6, md: 8 }}>
              <VStack spacing={6}>
                <Avatar
                  size="xl"
                  name={session?.user?.name || ''}
                  src={session?.user?.image || ''}
                />

                {isRejected ? (
                  <>
                    <Heading size="md" color="red.400">Entry Denied</Heading>
                    <Text color="gray.400" textAlign="center">
                      The host has denied your request to join this meeting.
                    </Text>
                  </>
                ) : (
                  <>
                    <VStack spacing={2}>
                      <Heading size="md">Waiting to join</Heading>
                      {meetingTitle && (
                        <Text color="brand.400" fontWeight="bold">
                          {meetingTitle}
                        </Text>
                      )}
                    </VStack>

                    <Spinner size="lg" color="brand.500" thickness="3px" />

                    <Text color="gray.400" textAlign="center" fontSize="sm">
                      The host will let you in soon.
                      Please wait...
                    </Text>
                  </>
                )}
              </VStack>
            </CardBody>
          </Card>
        </Center>
      </Box>
    </ProtectedRoute>
  );
}
