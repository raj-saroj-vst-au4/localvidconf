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
  if (meeting.isInLobby) {
    router.push(`/lobby/${meetingCode}`);
    return null;
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
          onStartScreenShare={meeting.startScreenShare}
          onStopScreenShare={meeting.stopScreenShare}
          onLeaveMeeting={meeting.leaveMeeting}
          onEndMeeting={meeting.endMeeting}
          onToggleParticipants={() => togglePanel('participants')}
          onToggleChat={() => togglePanel('chat')}
          onToggleQA={() => togglePanel('qa')}
          onToggleBreakout={() => togglePanel('breakout')}
          isParticipantsOpen={activePanel === 'participants'}
          isChatOpen={activePanel === 'chat'}
          isQAOpen={activePanel === 'qa'}
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
