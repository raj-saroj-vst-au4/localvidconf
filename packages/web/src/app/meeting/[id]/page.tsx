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

import { useState, useEffect, useMemo } from 'react';
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
import PreJoinModal from '@/components/meeting/PreJoinModal';
import LobbyManager from '@/components/meeting/LobbyManager';
import ReactionsOverlay from '@/components/meeting/ReactionsOverlay';
import DeviceSettingsModal from '@/components/meeting/DeviceSettingsModal';
import ConnectionQuality, {
  type ConnectionQualityLevel,
} from '@/components/meeting/ConnectionQuality';

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
  // In-meeting device settings modal (switch camera/mic/speaker live)
  const { isOpen: isSettingsOpen, onOpen: onSettingsOpen, onClose: onSettingsClose } = useDisclosure();

  // --- Pre-join gate ---
  // The user must confirm their camera/mic in PreJoinModal before we surface the
  // live meeting UI. We capture their choices so they can be applied once the
  // meeting media pipeline is up.
  const [hasJoined, setHasJoined] = useState(false);
  const [joinPrefs, setJoinPrefs] = useState<{
    audioEnabled: boolean;
    videoEnabled: boolean;
    audioDeviceId?: string;
    videoDeviceId?: string;
  } | null>(null);

  // Device lists for the in-meeting settings modal. Enumerated locally so the
  // modal works regardless of how the media hook surfaces its device state.
  const [videoInputDevices, setVideoInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [currentVideoDeviceId, setCurrentVideoDeviceId] = useState<string | undefined>(undefined);
  const [currentAudioDeviceId, setCurrentAudioDeviceId] = useState<string | undefined>(undefined);

  // --- Meeting Hook: core meeting state and controls ---
  // `ready: hasJoined` gates the actual room join until the user confirms the
  // pre-join screen — otherwise they'd join (and broadcast) before clicking Join.
  const meeting = useMeeting({ meetingCode, ready: hasJoined });

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

  // --- Lobby waiting state ---
  // Redirect must run as a side effect, not during render.
  useEffect(() => {
    if (meeting.isInLobby) {
      router.push(`/lobby/${meetingCode}`);
    }
  }, [meeting.isInLobby, router, meetingCode]);

  // --- Apply pre-join device/media choices once the meeting media is live ---
  // The media pipeline always initialises with audio+video on; reconcile it to
  // the user's PreJoinModal selections (preferred input devices + on/off state).
  // Tracked via local flags so each adjustment is applied exactly once.
  const [prefsDevicesApplied, setPrefsDevicesApplied] = useState(false);
  const [prefsAudioApplied, setPrefsAudioApplied] = useState(false);
  const [prefsVideoApplied, setPrefsVideoApplied] = useState(false);

  useEffect(() => {
    if (!joinPrefs || prefsDevicesApplied || !meeting.localStream) return;
    if (joinPrefs.audioDeviceId && meeting.switchMic) {
      void meeting.switchMic(joinPrefs.audioDeviceId);
    }
    if (joinPrefs.videoDeviceId && meeting.switchCamera) {
      void meeting.switchCamera(joinPrefs.videoDeviceId);
    }
    setPrefsDevicesApplied(true);
  }, [joinPrefs, prefsDevicesApplied, meeting.localStream, meeting.switchMic, meeting.switchCamera]);

  useEffect(() => {
    if (!joinPrefs || prefsAudioApplied || !meeting.localStream) return;
    // Media starts with audio enabled; mute if the user chose to join muted.
    if (!joinPrefs.audioEnabled && meeting.isAudioEnabled) {
      meeting.toggleAudio();
    }
    setPrefsAudioApplied(true);
  }, [joinPrefs, prefsAudioApplied, meeting.localStream, meeting.isAudioEnabled, meeting.toggleAudio]);

  useEffect(() => {
    if (!joinPrefs || prefsVideoApplied || !meeting.localStream) return;
    if (!joinPrefs.videoEnabled && meeting.isVideoEnabled) {
      meeting.toggleVideo();
    }
    setPrefsVideoApplied(true);
  }, [joinPrefs, prefsVideoApplied, meeting.localStream, meeting.isVideoEnabled, meeting.toggleVideo]);

  // --- Enumerate devices for the in-meeting settings modal ---
  useEffect(() => {
    if (!isSettingsOpen || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    let cancelled = false;
    navigator.mediaDevices.enumerateDevices().then((list) => {
      if (cancelled) return;
      setVideoInputDevices(list.filter((d) => d.kind === 'videoinput'));
      setAudioInputDevices(list.filter((d) => d.kind === 'audioinput'));
      setAudioOutputDevices(list.filter((d) => d.kind === 'audiooutput'));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isSettingsOpen]);

  // --- Derived UI values ---
  // Our own participant row (to know if *we* have a hand raised).
  const myUserId = (session?.user as any)?.id || '';
  const myParticipant = useMemo(
    () => meeting.participants.find((p) => p.userId === myUserId),
    [meeting.participants, myUserId],
  );
  const isHandRaised = myParticipant ? meeting.raisedHands.has(myParticipant.id) : false;
  // ParticipantList wants a Set of participantIds with raised hands.
  const raisedHandIds = useMemo(
    () => new Set(meeting.raisedHands.keys()),
    [meeting.raisedHands],
  );
  // Map the hook's coarse quality string onto the indicator's level type.
  const connectionLevel: ConnectionQualityLevel =
    meeting.connectionQuality === 'good' ||
    meeting.connectionQuality === 'fair' ||
    meeting.connectionQuality === 'poor'
      ? meeting.connectionQuality
      : 'unknown';

  function handleToggleHand() {
    if (isHandRaised) meeting.lowerHand();
    else meeting.raiseHand();
  }

  // Admit everyone currently waiting in the lobby (the hook only exposes a
  // per-participant admit, so fan it out over the current lobby list).
  function admitAllFromLobby() {
    meeting.lobbyParticipants.forEach((p) => meeting.admitFromLobby(p.participantId));
  }

  function handlePreJoin(opts: {
    audioEnabled: boolean;
    videoEnabled: boolean;
    audioDeviceId?: string;
    videoDeviceId?: string;
  }) {
    setJoinPrefs(opts);
    setCurrentVideoDeviceId(opts.videoDeviceId);
    setCurrentAudioDeviceId(opts.audioDeviceId);
    setHasJoined(true);
  }

  // --- Pre-join gate: confirm devices BEFORE we join the room or show any
  // loading/lobby state. The room join is gated on `hasJoined` (see useMeeting
  // `ready`), so meeting.isLoading stays true until the user clicks Join — this
  // check must come first or the spinner would mask the pre-join screen forever.
  if (!hasJoined) {
    return (
      <ProtectedRoute>
        <PreJoinModal onJoin={handlePreJoin} meetingTitle={meeting.meeting?.title} />
      </ProtectedRoute>
    );
  }

  // --- Loading state (after the user has clicked Join) ---
  if (meeting.isLoading) {
    return <LoadingSpinner message="Joining meeting..." />;
  }

  // --- Lobby waiting state (redirect handled by the effect above) ---
  if (meeting.isInLobby) {
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
        {/* --- Lobby admit/reject toast (host only) --- */}
        {/* Floating banner so hosts see waiting participants without opening
            the participants panel. */}
        {meeting.isHost && (
          <LobbyManager
            lobbyParticipants={meeting.lobbyParticipants}
            onAdmit={meeting.admitFromLobby}
            onReject={meeting.rejectFromLobby}
            onAdmitAll={admitAllFromLobby}
          />
        )}

        {/* --- Main Content Area --- */}
        <Flex flex={1} overflow="hidden">
          {/* Video Grid: takes all available space minus side panel */}
          <Box
            flex={1}
            // Anchor the floating reactions overlay to the video area.
            position="relative"
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

            {/* Floating emoji reactions (pointer-transparent overlay) */}
            <ReactionsOverlay
              reactions={meeting.reactions.map((r) => ({
                id: r.id,
                emoji: r.emoji,
                userName: r.userName,
              }))}
            />

            {/* Connection quality indicator (top-left of the video area) */}
            <Box position="absolute" top={3} left={3} zIndex={20} pointerEvents="none">
              <ConnectionQuality quality={connectionLevel} />
            </Box>
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
                  onAdmitAll={admitAllFromLobby}
                  onPromoteCoHost={meeting.promoteCoHost}
                  onDemoteCoHost={meeting.demoteCoHost}
                  onMuteParticipant={meeting.muteParticipant}
                  raisedHands={raisedHandIds}
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
          // Reactions, raise-hand, host mute-all, and device settings
          onReaction={meeting.sendReaction}
          onToggleHand={handleToggleHand}
          isHandRaised={isHandRaised}
          onMuteAll={meeting.muteAll}
          onOpenSettings={onSettingsOpen}
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
                  onAdmitAll={admitAllFromLobby}
                  onPromoteCoHost={meeting.promoteCoHost}
                  onDemoteCoHost={meeting.demoteCoHost}
                  onMuteParticipant={meeting.muteParticipant}
                  raisedHands={raisedHandIds}
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

        {/* --- In-meeting device settings (switch camera/mic/speaker live) --- */}
        <DeviceSettingsModal
          isOpen={isSettingsOpen}
          onClose={onSettingsClose}
          videoInputDevices={videoInputDevices}
          audioInputDevices={audioInputDevices}
          audioOutputDevices={audioOutputDevices}
          currentVideoDeviceId={currentVideoDeviceId}
          currentAudioDeviceId={currentAudioDeviceId}
          onSelectVideo={(deviceId) => {
            setCurrentVideoDeviceId(deviceId);
            if (meeting.switchCamera) void meeting.switchCamera(deviceId);
          }}
          onSelectAudio={(deviceId) => {
            setCurrentAudioDeviceId(deviceId);
            if (meeting.switchMic) void meeting.switchMic(deviceId);
          }}
        />
      </Box>
    </ProtectedRoute>
  );
}
