// =============================================================================
// Video Grid Component
// Responsive grid layout for video tiles (like Zoom/Meet gallery view).
// Adapts the grid based on participant count and screen size:
// - 1 person: full screen
// - 2 people: side by side (stacked on mobile)
// - 3-4 people: 2x2 grid
// - 5-9 people: 3x3 grid
// - 10+ people: 4+ columns with scroll
// Screen share gets priority: shown large with other tiles small on the side.
// =============================================================================

'use client';

import { useRef, useEffect } from 'react';
import { Box, SimpleGrid, Flex } from '@chakra-ui/react';
import VideoTile from './VideoTile';
import type { PeerMedia } from '@/types';

interface VideoGridProps {
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  peers: Map<string, PeerMedia>;
  userName: string;
  userImage: string | null;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
}

export default function VideoGrid({
  localStream,
  screenStream,
  peers,
  userName,
  userImage,
  isAudioEnabled,
  isVideoEnabled,
  isScreenSharing,
}: VideoGridProps) {
  const peerArray = Array.from(peers.values());
  const totalParticipants = peerArray.length + 1; // +1 for local user

  // Check if anyone is screen sharing (local or remote)
  const activeScreenShare = isScreenSharing
    ? { isLocal: true, stream: screenStream }
    : peerArray.find(p => p.screenSharing)
      ? { isLocal: false, peer: peerArray.find(p => p.screenSharing) }
      : null;

  // --- Screen Share Layout ---
  // Screen takes 80% of display; video feeds sit on the "longer side":
  //   landscape → right strip (row direction)
  //   portrait  → bottom strip (column direction)
  // Orientation is detected via CSS media query for accuracy on all devices.
  if (activeScreenShare) {
    return (
      // Wrap in a Box so audio elements don't affect the flex layout
      <Box w="100%" h="100%" position="relative">
        <Flex
          w="100%"
          h="100%"
          gap={2}
          p={2}
          sx={{
            // Portrait default: screen on top, videos on bottom
            flexDirection: 'column',
            '@media (orientation: landscape)': {
              // Landscape: screen on left, videos on right
              flexDirection: 'row',
            },
          }}
        >
          {/* Main area: screen share — 80% of space (flex 4 out of 5) */}
          <Box
            flex={4}
            sx={{
              minHeight: '200px',
              '@media (orientation: landscape)': {
                minHeight: 'unset',
              },
            }}
          >
            {activeScreenShare.isLocal ? (
              <VideoTile
                stream={screenStream}
                userName={userName}
                userImage={userImage}
                isVideoEnabled={true}
                isScreenShare={true}
                isLocal={true}
              />
            ) : (
              (() => {
                const peer = activeScreenShare.peer!;
                const screenConsumer = Array.from(peer.consumers.values()).find(
                  c => (c.appData as any)?.type === 'screen'
                );
                return screenConsumer ? (
                  <VideoTile
                    consumer={screenConsumer}
                    userName={peer.userName}
                    userImage={peer.userImage}
                    isVideoEnabled={true}
                    isScreenShare={true}
                  />
                ) : null;
              })()
            )}
          </Box>

          {/* Sidebar: video thumbnails — 20% of space (flex 1 out of 5)
              Portrait  → horizontal scrolling strip at bottom
              Landscape → vertical scrolling strip on right */}
          <Flex
            flex={1}
            gap={2}
            sx={{
              // Portrait: horizontal row of tiles
              flexDirection: 'row',
              overflowX: 'auto',
              overflowY: 'hidden',
              minHeight: '100px',
              maxHeight: '160px',
              '@media (orientation: landscape)': {
                // Landscape: vertical column of tiles
                flexDirection: 'column',
                overflowX: 'hidden',
                overflowY: 'auto',
                minHeight: 'unset',
                maxHeight: '100%',
                maxWidth: '220px',
                minWidth: '140px',
              },
            }}
          >
            {/* Local user tile */}
            <Box
              flexShrink={0}
              sx={{
                width: '120px',
                height: '90px',
                '@media (orientation: landscape)': {
                  width: '100%',
                  height: '130px',
                },
              }}
            >
              <VideoTile
                stream={localStream}
                userName={userName}
                userImage={userImage}
                isAudioEnabled={isAudioEnabled}
                isVideoEnabled={isVideoEnabled}
                isLocal={true}
              />
            </Box>

            {/* Remote peer camera tiles (exclude screen share tiles) */}
            {peerArray.map((peer) => {
              const videoConsumer = Array.from(peer.consumers.values()).find(
                c => c.kind === 'video' && (c.appData as any)?.type !== 'screen'
              );
              return (
                <Box
                  key={peer.peerId}
                  flexShrink={0}
                  sx={{
                    width: '120px',
                    height: '90px',
                    '@media (orientation: landscape)': {
                      width: '100%',
                      height: '130px',
                    },
                  }}
                >
                  <VideoTile
                    consumer={videoConsumer}
                    userName={peer.userName}
                    userImage={peer.userImage}
                    isAudioEnabled={peer.audioEnabled}
                    isVideoEnabled={peer.videoEnabled}
                  />
                </Box>
              );
            })}
          </Flex>
        </Flex>

        {/* Hidden audio players — must render in both layouts or audio stops
            when transitioning to screen share mode */}
        {peerArray.map((peer) => {
          const audioConsumer = Array.from(peer.consumers.values()).find(
            c => c.kind === 'audio'
          );
          if (!audioConsumer) return null;
          return <AudioPlayer key={`audio-${peer.peerId}`} consumer={audioConsumer} />;
        })}
      </Box>
    );
  }

  // --- Gallery View Layout ---
  // Responsive grid that adapts to participant count and screen size

  // Calculate optimal grid columns based on participant count
  const getColumns = () => {
    if (totalParticipants <= 1) return { base: 1, sm: 1, md: 1, lg: 1, xl: 1 };
    if (totalParticipants <= 2) return { base: 1, sm: 2, md: 2, lg: 2, xl: 2 };
    if (totalParticipants <= 4) return { base: 1, sm: 2, md: 2, lg: 2, xl: 2 };
    if (totalParticipants <= 6) return { base: 1, sm: 2, md: 2, lg: 3, xl: 3 };
    if (totalParticipants <= 9) return { base: 1, sm: 2, md: 3, lg: 3, xl: 3 };
    return { base: 2, sm: 2, md: 3, lg: 4, xl: 4 };
  };

  return (
    <Box w="100%" h="100%" p={2} overflowY="auto">
      <SimpleGrid
        columns={getColumns()}
        spacing={{ base: 1, sm: 2, md: 3 }}
        w="100%"
        h="100%"
      >
        {/* Local user tile (always first) */}
        <VideoTile
          stream={localStream}
          userName={userName}
          userImage={userImage}
          isAudioEnabled={isAudioEnabled}
          isVideoEnabled={isVideoEnabled}
          isLocal={true}
        />

        {/* Remote peer tiles */}
        {peerArray.map((peer) => {
          // Get the video consumer (not screen share)
          const videoConsumer = Array.from(peer.consumers.values()).find(
            c => c.kind === 'video' && c.appData?.type !== 'screen'
          );

          return (
            <VideoTile
              key={peer.peerId}
              consumer={videoConsumer}
              userName={peer.userName}
              userImage={peer.userImage}
              isAudioEnabled={peer.audioEnabled}
              isVideoEnabled={peer.videoEnabled}
            />
          );
        })}
      </SimpleGrid>

      {/* Hidden audio elements for remote peers */}
      {/* Audio must be played via <audio> elements, not attached to video tiles */}
      {peerArray.map((peer) => {
        const audioConsumer = Array.from(peer.consumers.values()).find(
          c => c.kind === 'audio'
        );
        if (!audioConsumer) return null;
        return (
          <AudioPlayer key={`audio-${peer.peerId}`} consumer={audioConsumer} />
        );
      })}
    </Box>
  );
}

// --- Hidden Audio Player ---
// Plays audio from a mediasoup consumer without any visible UI.
// Each remote peer needs one audio element.
function AudioPlayer({ consumer }: { consumer: any }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && consumer) {
      const stream = new MediaStream([consumer.track]);
      audioRef.current.srcObject = stream;
    }
  }, [consumer]);

  // Hidden audio element: no controls, auto-play
  return <audio ref={audioRef as any} autoPlay />;
}

