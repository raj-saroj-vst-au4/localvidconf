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
  // When someone is screen sharing, the screen takes up most of the space
  // with small video tiles on the side
  if (activeScreenShare) {
    return (
      <Flex
        w="100%"
        h="100%"
        direction={{ base: 'column', lg: 'row' }}
        gap={2}
        p={2}
      >
        {/* Main area: screen share (takes 75% on desktop, 60% on tablet) */}
        <Box flex={{ base: '1', md: '3' }} minH={{ base: '200px', md: '400px' }}>
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
            // Find the screen share consumer from the peer
            (() => {
              const peer = activeScreenShare.peer!;
              const screenConsumer = Array.from(peer.consumers.values()).find(
                c => c.appData?.type === 'screen'
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

        {/* Sidebar: small video tiles */}
        <Flex
          direction={{ base: 'row', lg: 'column' }}
          gap={2}
          flex="1"
          overflowY={{ base: 'hidden', lg: 'auto' }}
          overflowX={{ base: 'auto', lg: 'hidden' }}
          maxH={{ lg: '100%' }}
          minW={{ lg: '200px' }}
          maxW={{ lg: '250px' }}
        >
          {/* Local user tile */}
          <Box minW={{ base: '120px', lg: 'auto' }} h={{ base: '90px', lg: '140px' }}>
            <VideoTile
              stream={localStream}
              userName={userName}
              userImage={userImage}
              isAudioEnabled={isAudioEnabled}
              isVideoEnabled={isVideoEnabled}
              isLocal={true}
            />
          </Box>

          {/* Remote peer tiles */}
          {peerArray.map((peer) => {
            const videoConsumer = Array.from(peer.consumers.values()).find(
              c => c.kind === 'video' && c.appData?.type !== 'screen'
            );
            return (
              <Box key={peer.peerId} minW={{ base: '120px', lg: 'auto' }} h={{ base: '90px', lg: '140px' }}>
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

