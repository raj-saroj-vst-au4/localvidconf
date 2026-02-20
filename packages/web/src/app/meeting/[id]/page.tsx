// =============================================================================
// Meeting Room Page
// The main meeting experience: video grid, control bar, side panels.
// Orchestrates all hooks and components into a unified meeting UI.
//
// Layout:
// - Full screen dark background (no navbar in meetings)
// - Video grid fills the available space
// - Control bar fixed at the bottom
// - Side panels (participants, chat, Q&A, breakout) slide in from the right
// - Responsive: panels stack vertically on mobile
// =============================================================================

'use client';

import { useState, useEffect } from 'react';
import {
  Box, Flex, useToast, useDisclosure,
  Drawer, DrawerOverlay, DrawerContent, DrawerBody,
  Center, Card, CardBody, VStack, Heading, Text, Spinner, Avatar,
} from '@chakra-ui/react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';

// Hooks
import { useMeeting } from '@/hooks/useMeeting';
import { useBreakoutRooms } from '@/hooks/useBreakoutRooms';
import { useQA } from '@/hooks/useQA';
import { useSocket } from '@/hooks/useSocket';

// Components
import VideoGrid from '@/components/meeting/VideoGrid';
import ControlBar from '@/components/meeting/ControlBar';
import ParticipantList from '@/components/meeting/ParticipantList';
import ChatPanel from '@/components/meeting/ChatPanel';
import QAPanel from '@/components/qa/QAPanel';
import BreakoutManager from '@/components/breakout/BreakoutManager';
import ProtectedRoute from '@/components/common/ProtectedRoute';
import LoadingSpinner from '@/components/common/LoadingSpinner';

// Panel type for tracking which side panel is open
type PanelType = 'participants' | 'chat' | 'qa' | 'breakout' | null;

export default function MeetingRoomPage() {
  const params = useParams();
  const meetingCode = params.id as string;
  const { data: session } = useSession();
  const toast = useToast();
  const router = useRouter();

  // Active side panel (only one at a time on desktop, drawer on mobile)
  const [activePanel, setActivePanel] = useState<PanelType>(null);
  // Drawer for mobile panels
  const { isOpen: isDrawerOpen, onOpen: onDrawerOpen, onClose: onDrawerClose } = useDisclosure();

  // --- Meeting Hook: core meeting state and controls ---
  const meeting = useMeeting({ meetingCode });

  // --- Socket for child components ---
  const { socket, isConnected } = useSocket();

  // --- Q&A Hook ---
  const qa = useQA({
    socket,
    isConnected,
    meetingId: meeting.meeting?.id || null,
  });

  // --- Breakout Rooms Hook ---
  const breakoutRooms = useBreakoutRooms({
    socket,
    isConnected,
    participants: meeting.participants,
  });

  // True when a remote peer is currently screen sharing (local user is not)
  const someoneElseIsScreenSharing = !meeting.isScreenSharing &&
    Array.from(meeting.peers.values()).some((p: any) => p.screenSharing);

  // Wrap startScreenShare to surface errors as toasts (e.g. mobile not supported)
  const handleStartScreenShare = async () => {
    const error = await meeting.startScreenShare();
    if (error) {
      toast({
        title: 'Screen sharing unavailable',
        description: error,
        status: 'warning',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  // --- Panel Toggle Handlers ---
  // On desktop: toggle side panel
  // On mobile: open drawer with panel content
  function togglePanel(panel: PanelType) {
    if (activePanel === panel) {
      setActivePanel(null);
      onDrawerClose();
    } else {
      setActivePanel(panel);
      // On mobile, open the drawer
      if (window.innerWidth < 768) {
        onDrawerOpen();
      }
    }
  }

  // --- Toast for socket events ---
  useEffect(() => {
    if (!socket || !isConnected) return;

    // Show toast when invited participant receives invite confirmation
    socket.on('invite-sent', (data: { email: string }) => {
      toast({
        title: `Invitation sent to ${data.email}`,
        status: 'success',
        duration: 3000,
      });
    });

    // Show toast for breakout room broadcast messages
    socket.on('breakout-broadcast', (data: { message: string; from: string }) => {
      toast({
        title: `Message from ${data.from}`,
        description: data.message,
        status: 'info',
        duration: 5000,
      });
    });

    // In-app reminder notifications
    socket.on('reminder', (data: any) => {
      if (data.targetEmail === session?.user?.email) {
        toast({
          title: `Meeting Reminder`,
          description: `"${data.meetingTitle}" starts in ${data.minutesBefore} minutes`,
          status: 'warning',
          duration: 10000,
          isClosable: true,
        });
      }
    });

    return () => {
      socket.off('invite-sent');
      socket.off('breakout-broadcast');
      socket.off('reminder');
    };
  }, [socket, isConnected, session, toast]);

  // --- Error handling ---
  useEffect(() => {
    if (meeting.error) {
      toast({
        title: 'Error',
        description: meeting.error,
        status: 'error',
        duration: 5000,
      });
    }
  }, [meeting.error, toast]);

  // --- Loading state ---
  if (meeting.isLoading) {
    return <LoadingSpinner message="Joining meeting..." />;
  }

  // --- Lobby waiting state ---
  // Stay on this page and show an inline waiting card.
  // The server will emit 'meeting-joined' then 'admitted' when the host lets the user in,
  // which the useMeeting hook handles without any page navigation.
  if (meeting.isInLobby) {
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
                  <VStack spacing={2}>
                    <Heading size="md">Waiting to join</Heading>
                    {meeting.meeting?.title && (
                      <Text color="brand.400" fontWeight="bold">
                        {meeting.meeting.title}
                      </Text>
                    )}
                  </VStack>
                  <Spinner size="lg" color="brand.500" thickness="3px" />
                  <Text color="gray.400" textAlign="center" fontSize="sm">
                    The host will let you in soon. Please wait...
                  </Text>
                </VStack>
              </CardBody>
            </Card>
          </Center>
        </Box>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <Box
        h="100vh"
        w="100vw"
        bg="meeting.bg"
        overflow="hidden"
        display="flex"
        flexDirection="column"
      >
        {/* --- Main Content Area --- */}
        <Flex flex={1} overflow="hidden">
          {/* Video Grid: takes all available space minus side panel */}
          <Box
            flex={1}
            // Leave room for the control bar at the bottom
            pb={{ base: '70px', md: '80px' }}
            overflow="hidden"
          >
            <VideoGrid
              localStream={meeting.localStream}
              screenStream={meeting.screenStream}
              peers={meeting.peers}
              userName={session?.user?.name || ''}
              userImage={session?.user?.image || null}
              isAudioEnabled={meeting.isAudioEnabled}
              isVideoEnabled={meeting.isVideoEnabled}
              isScreenSharing={meeting.isScreenSharing}
            />
          </Box>

          {/* --- Desktop Side Panel --- */}
          {/* Only shown on md+ screens when a panel is active */}
          {activePanel && (
            <Box
              display={{ base: 'none', md: 'block' }}
              w="350px"
              h="100%"
              // Leave room for control bar
              pb="80px"
            >
              {activePanel === 'participants' && (
                <ParticipantList
                  participants={meeting.participants}
                  lobbyParticipants={meeting.lobbyParticipants}
                  isHost={meeting.isHost}
                  currentUserId={(session?.user as any)?.id || ''}
                  onAdmit={meeting.admitFromLobby}
                  onReject={meeting.rejectFromLobby}
                  onKick={meeting.kickParticipant}
                  onMoveToLobby={meeting.moveToLobby}
                  onTransferHost={meeting.transferHost}
                  onInvite={meeting.inviteParticipant}
                />
              )}
              {activePanel === 'chat' && (
                <ChatPanel
                  socket={socket}
                  isConnected={isConnected}
                  currentUserEmail={session?.user?.email || ''}
                />
              )}
              {activePanel === 'qa' && (
                <QAPanel
                  questions={qa.questions}
                  isHost={meeting.isHost}
                  onAskQuestion={qa.askQuestion}
                  onUpvote={qa.upvoteQuestion}
                  onMarkAnswered={qa.markAnswered}
                  onPin={qa.pinQuestion}
                />
              )}
              {activePanel === 'breakout' && meeting.isHost && (
                <BreakoutManager
                  participants={meeting.participants}
                  breakoutRooms={breakoutRooms.breakoutRooms}
                  isInBreakout={breakoutRooms.isInBreakout}
                  timeRemaining={breakoutRooms.timeRemaining}
                  currentUserId={(session?.user as any)?.id || ''}
                  onCreateBreakoutRooms={breakoutRooms.createBreakoutRooms}
                  onCloseBreakoutRooms={breakoutRooms.closeBreakoutRooms}
                  onBroadcastToBreakouts={breakoutRooms.broadcastToBreakouts}
                />
              )}
            </Box>
          )}
        </Flex>

        {/* --- Control Bar (fixed at bottom) --- */}
        <ControlBar
          isAudioEnabled={meeting.isAudioEnabled}
          isVideoEnabled={meeting.isVideoEnabled}
          isScreenSharing={meeting.isScreenSharing}
          isHost={meeting.isHost}
          participantCount={meeting.participants.length}
          onToggleAudio={meeting.toggleAudio}
          onToggleVideo={meeting.toggleVideo}
          onStartScreenShare={handleStartScreenShare}
          onStopScreenShare={meeting.stopScreenShare}
          someoneElseIsScreenSharing={someoneElseIsScreenSharing}
          onLeaveMeeting={meeting.leaveMeeting}
          onEndMeeting={meeting.endMeeting}
          onToggleParticipants={() => togglePanel('participants')}
          onToggleChat={() => togglePanel('chat')}
          onToggleQA={() => togglePanel('qa')}
          onToggleBreakout={() => togglePanel('breakout')}
          isParticipantsOpen={activePanel === 'participants'}
          isChatOpen={activePanel === 'chat'}
          isQAOpen={activePanel === 'qa'}
          videoDevices={meeting.videoDevices}
          audioDevices={meeting.audioDevices}
          selectedVideoDeviceId={meeting.selectedVideoDeviceId}
          selectedAudioDeviceId={meeting.selectedAudioDeviceId}
          onSelectVideoDevice={meeting.selectVideoDevice}
          onSelectAudioDevice={meeting.selectAudioDevice}
        />

        {/* --- Mobile Drawer for Side Panels --- */}
        <Drawer
          isOpen={isDrawerOpen && activePanel !== null}
          placement="bottom"
          onClose={() => { onDrawerClose(); setActivePanel(null); }}
        >
          <DrawerOverlay />
          <DrawerContent
            bg="meeting.surface"
            maxH="70vh"
            borderTopRadius="xl"
          >
            <DrawerBody p={0}>
              {activePanel === 'participants' && (
                <ParticipantList
                  participants={meeting.participants}
                  lobbyParticipants={meeting.lobbyParticipants}
                  isHost={meeting.isHost}
                  currentUserId={(session?.user as any)?.id || ''}
                  onAdmit={meeting.admitFromLobby}
                  onReject={meeting.rejectFromLobby}
                  onKick={meeting.kickParticipant}
                  onMoveToLobby={meeting.moveToLobby}
                  onTransferHost={meeting.transferHost}
                  onInvite={meeting.inviteParticipant}
                />
              )}
              {activePanel === 'chat' && (
                <ChatPanel
                  socket={socket}
                  isConnected={isConnected}
                  currentUserEmail={session?.user?.email || ''}
                />
              )}
              {activePanel === 'qa' && (
                <QAPanel
                  questions={qa.questions}
                  isHost={meeting.isHost}
                  onAskQuestion={qa.askQuestion}
                  onUpvote={qa.upvoteQuestion}
                  onMarkAnswered={qa.markAnswered}
                  onPin={qa.pinQuestion}
                />
              )}
              {activePanel === 'breakout' && meeting.isHost && (
                <BreakoutManager
                  participants={meeting.participants}
                  breakoutRooms={breakoutRooms.breakoutRooms}
                  isInBreakout={breakoutRooms.isInBreakout}
                  timeRemaining={breakoutRooms.timeRemaining}
                  currentUserId={(session?.user as any)?.id || ''}
                  onCreateBreakoutRooms={breakoutRooms.createBreakoutRooms}
                  onCloseBreakoutRooms={breakoutRooms.closeBreakoutRooms}
                  onBroadcastToBreakouts={breakoutRooms.broadcastToBreakouts}
                />
              )}
            </DrawerBody>
          </DrawerContent>
        </Drawer>
      </Box>
    </ProtectedRoute>
  );
}
