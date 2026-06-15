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

import { useRef, useEffect, useState, useMemo } from 'react';
import { Box, SimpleGrid, Flex, IconButton, Text } from '@chakra-ui/react';
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import VideoTile from './VideoTile';
import type { PeerMedia } from '@/types';

// Max remote tiles shown per gallery page (local tile is rendered separately
// and always visible, so a full page shows PEERS_PER_PAGE + 1 tiles).
const PEERS_PER_PAGE = 11;

interface VideoGridProps {
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  peers: Map<string, PeerMedia>;
  userName: string;
  userImage: string | null;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  // DB participantId of the current active speaker (matches PeerMedia.participantId).
  activeSpeakerParticipantId?: string | null;
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
  activeSpeakerParticipantId,
}: VideoGridProps) {
  const peerArray = Array.from(peers.values());
  const totalParticipants = peerArray.length + 1; // +1 for local user

  // --- Pagination state (must run unconditionally, before any early return) ---
  // The local tile occupies one slot on the first page only.
  const totalPages = Math.max(
    1,
    Math.ceil(Math.max(0, peerArray.length - PEERS_PER_PAGE + 1) / PEERS_PER_PAGE) + 1,
  );
  const [page, setPage] = useState(0);

  // Clamp the page if the participant count shrinks (e.g. peers leave).
  const safePage = Math.min(page, totalPages - 1);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  // Slice of remote peers visible on the current page. Page 0 reserves one slot
  // for the local tile, so it shows PEERS_PER_PAGE - 1 remote peers; later pages
  // show a full PEERS_PER_PAGE remote peers.
  const visiblePeers = useMemo(() => {
    if (safePage === 0) return peerArray.slice(0, PEERS_PER_PAGE - 1);
    const start = (PEERS_PER_PAGE - 1) + (safePage - 1) * PEERS_PER_PAGE;
    return peerArray.slice(start, start + PEERS_PER_PAGE);
    // peerArray is rebuilt every render; depend on peers (its stable source).
  }, [peers, safePage]);

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
                  isSpeaking={
                    !!activeSpeakerParticipantId &&
                    peer.participantId === activeSpeakerParticipantId
                  }
                />
              </Box>
            );
          })}
        </Flex>
      </Flex>
    );
  }

  // --- Gallery View Layout ---
  // Responsive grid that adapts to participant count and screen size.
  // Paginated: the local tile is always page 1; remote peers are split into
  // pages of PEERS_PER_PAGE. We never create video elements for off-page peers,
  // but their audio players stay mounted (rendered below) so audio keeps playing.

  const tilesOnPage = visiblePeers.length + (safePage === 0 ? 1 : 0);

  // Pager range, 1-based and inclusive ("Showing X–Y of Z" counts everyone).
  const rangeStart =
    safePage === 0 ? 1 : (PEERS_PER_PAGE - 1) + (safePage - 1) * PEERS_PER_PAGE + 2;
  const rangeEnd =
    safePage === 0
      ? tilesOnPage
      : (PEERS_PER_PAGE - 1) + (safePage - 1) * PEERS_PER_PAGE + 1 + visiblePeers.length;

  // Calculate optimal grid columns based on tiles shown on the current page
  const getColumns = () => {
    if (tilesOnPage <= 1) return { base: 1, sm: 1, md: 1, lg: 1, xl: 1 };
    if (tilesOnPage <= 2) return { base: 1, sm: 2, md: 2, lg: 2, xl: 2 };
    if (tilesOnPage <= 4) return { base: 1, sm: 2, md: 2, lg: 2, xl: 2 };
    if (tilesOnPage <= 6) return { base: 1, sm: 2, md: 2, lg: 3, xl: 3 };
    if (tilesOnPage <= 9) return { base: 1, sm: 2, md: 3, lg: 3, xl: 3 };
    return { base: 2, sm: 2, md: 3, lg: 4, xl: 4 };
  };

  return (
    <Box w="100%" h="100%" p={2} overflowY="auto" display="flex" flexDirection="column">
      <SimpleGrid
        columns={getColumns()}
        spacing={{ base: 1, sm: 2, md: 3 }}
        w="100%"
        flex="1"
        minH={0}
      >
        {/* Local user tile (always first, only on page 1) */}
        {safePage === 0 && (
          <VideoTile
            stream={localStream}
            userName={userName}
            userImage={userImage}
            isAudioEnabled={isAudioEnabled}
            isVideoEnabled={isVideoEnabled}
            isLocal={true}
          />
        )}

        {/* Remote peer tiles for the current page only */}
        {visiblePeers.map((peer) => {
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
              isSpeaking={
                !!activeSpeakerParticipantId &&
                peer.participantId === activeSpeakerParticipantId
              }
            />
          );
        })}
      </SimpleGrid>

      {/* Pager: only shown when there is more than one page */}
      {totalPages > 1 && (
        <Flex align="center" justify="center" gap={3} pt={2} flexShrink={0}>
          <IconButton
            aria-label="Previous page"
            icon={<FiChevronLeft />}
            size="sm"
            variant="control"
            isDisabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            borderRadius="full"
          />
          <Text fontSize="sm" color="whiteAlpha.800" minW="160px" textAlign="center">
            Showing {rangeStart}–{rangeEnd} of {totalParticipants}
          </Text>
          <IconButton
            aria-label="Next page"
            icon={<FiChevronRight />}
            size="sm"
            variant="control"
            isDisabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            borderRadius="full"
          />
        </Flex>
      )}

      {/* Hidden audio elements for ALL remote peers (independent of pagination) */}
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

