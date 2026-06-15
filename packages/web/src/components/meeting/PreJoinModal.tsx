// =============================================================================
// Pre-Join Device Preview Screen
// Shown before a participant enters the meeting. Lets the user:
//   - preview their camera (mirrored, like a mirror)
//   - see a live mic input-level meter
//   - toggle camera / mic on or off
//   - pick camera / mic / speaker devices via enumerateDevices
// On join (or unmount) the preview's getUserMedia tracks are stopped so the
// camera/mic are freed before the real meeting media pipeline acquires them.
// =============================================================================

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Flex, Box, VStack, HStack, Heading, Text, Button, IconButton,
  Select, FormControl, FormLabel, Avatar, Tooltip, Progress,
} from '@chakra-ui/react';
import {
  FiVideo, FiVideoOff, FiMic, FiMicOff, FiVolume2,
} from 'react-icons/fi';

interface PreJoinModalProps {
  onJoin: (opts: {
    audioEnabled: boolean;
    videoEnabled: boolean;
    audioDeviceId?: string;
    videoDeviceId?: string;
  }) => void;
  meetingTitle?: string;
}

export default function PreJoinModal({ onJoin, meetingTitle }: PreJoinModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The live preview stream; kept in a ref so cleanup never races React state.
  const streamRef = useRef<MediaStream | null>(null);
  // Web Audio plumbing for the mic-level meter.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDeviceId, setAudioDeviceId] = useState<string | undefined>(undefined);
  const [videoDeviceId, setVideoDeviceId] = useState<string | undefined>(undefined);
  const [speakerDeviceId, setSpeakerDeviceId] = useState<string | undefined>(undefined);

  const [micLevel, setMicLevel] = useState(0); // 0..100
  const [error, setError] = useState<string | null>(null);

  // --- Filtered device lists -------------------------------------------------
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');

  // --- Tear down everything the preview holds open ---------------------------
  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setMicLevel(0);
  }, []);

  // --- Drive the mic-level meter from an analyser node -----------------------
  const startMeter = useCallback((stream: MediaStream) => {
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (stream.getAudioTracks().length === 0) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        const node = analyserRef.current;
        if (!node) return;
        node.getByteTimeDomainData(data);
        // RMS around the 128 midpoint -> rough loudness percentage.
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setMicLevel(Math.min(100, Math.round(rms * 140)));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Audio metering is best-effort; ignore failures.
    }
  }, []);

  // --- (Re)acquire the preview stream for the current device selection -------
  const acquire = useCallback(async () => {
    stopStream();
    setError(null);

    // Nothing requested: leave the preview blank but don't error out.
    if (!audioEnabled && !videoEnabled) return;

    const constraints: MediaStreamConstraints = {
      audio: audioEnabled
        ? (audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true)
        : false,
      video: videoEnabled
        ? (videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true)
        : false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      // Lock in the actual device ids the browser picked, so the dropdowns
      // reflect reality and the join payload matches the preview.
      const aTrack = stream.getAudioTracks()[0];
      const vTrack = stream.getVideoTracks()[0];
      if (aTrack) {
        const id = aTrack.getSettings().deviceId;
        if (id) setAudioDeviceId(id);
      }
      if (vTrack) {
        const id = vTrack.getSettings().deviceId;
        if (id) setVideoDeviceId(id);
      }

      // Labels are only populated after a permission grant, so re-enumerate.
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);

      startMeter(stream);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Camera/microphone permission was denied. Check your browser settings.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('No camera or microphone was found.');
      } else {
        setError('Could not access your camera or microphone.');
      }
    }
  }, [audioEnabled, videoEnabled, audioDeviceId, videoDeviceId, stopStream, startMeter]);

  // Re-acquire whenever the on/off toggles or chosen input devices change.
  useEffect(() => {
    void acquire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioEnabled, videoEnabled, audioDeviceId, videoDeviceId]);

  // Always release the camera/mic when the component goes away.
  useEffect(() => {
    return () => stopStream();
  }, [stopStream]);

  // Apply the chosen speaker to the preview element where supported.
  useEffect(() => {
    const el = videoRef.current as (HTMLVideoElement & {
      setSinkId?: (id: string) => Promise<void>;
    }) | null;
    if (el && speakerDeviceId && typeof el.setSinkId === 'function') {
      el.setSinkId(speakerDeviceId).catch(() => {});
    }
  }, [speakerDeviceId]);

  function handleJoin() {
    // Free the preview's tracks before handing control to the meeting pipeline.
    stopStream();
    onJoin({
      audioEnabled,
      videoEnabled,
      audioDeviceId,
      videoDeviceId,
    });
  }

  return (
    <Flex
      position="fixed"
      inset={0}
      bg="meeting.bg"
      align="center"
      justify="center"
      p={{ base: 4, md: 8 }}
      zIndex={1400}
      overflowY="auto"
    >
      <Flex
        direction={{ base: 'column', lg: 'row' }}
        bg="meeting.surface"
        borderRadius="xl"
        overflow="hidden"
        boxShadow="dark-lg"
        maxW="900px"
        w="100%"
        gap={0}
      >
        {/* --- Camera preview --------------------------------------------- */}
        <Box flex={1} p={{ base: 4, md: 6 }}>
          <Box
            position="relative"
            bg="black"
            borderRadius="lg"
            overflow="hidden"
            w="100%"
            sx={{ aspectRatio: '16 / 9' }}
            minH="200px"
          >
            {videoEnabled && !error ? (
              <Box
                as="video"
                ref={videoRef}
                autoPlay
                playsInline
                muted
                transform="scaleX(-1)" // mirror, like looking in a mirror
                w="100%"
                h="100%"
                objectFit="cover"
              />
            ) : (
              <Flex w="100%" h="100%" align="center" justify="center">
                <Avatar size="xl" />
              </Flex>
            )}

            {error && (
              <Flex
                position="absolute"
                inset={0}
                align="center"
                justify="center"
                bg="blackAlpha.700"
                p={4}
              >
                <Text fontSize="sm" color="red.300" textAlign="center">
                  {error}
                </Text>
              </Flex>
            )}

            {/* In-preview on/off toggles */}
            <HStack
              position="absolute"
              bottom={3}
              left={0}
              right={0}
              justify="center"
              spacing={3}
            >
              <Tooltip label={audioEnabled ? 'Turn off microphone' : 'Turn on microphone'}>
                <IconButton
                  aria-label="Toggle microphone"
                  icon={audioEnabled ? <FiMic /> : <FiMicOff />}
                  onClick={() => setAudioEnabled((v) => !v)}
                  variant={audioEnabled ? 'controlActive' : 'control'}
                  bg={audioEnabled ? undefined : 'meeting.danger'}
                  borderRadius="full"
                />
              </Tooltip>
              <Tooltip label={videoEnabled ? 'Turn off camera' : 'Turn on camera'}>
                <IconButton
                  aria-label="Toggle camera"
                  icon={videoEnabled ? <FiVideo /> : <FiVideoOff />}
                  onClick={() => setVideoEnabled((v) => !v)}
                  variant={videoEnabled ? 'controlActive' : 'control'}
                  bg={videoEnabled ? undefined : 'meeting.danger'}
                  borderRadius="full"
                />
              </Tooltip>
            </HStack>
          </Box>

          {/* Mic level meter */}
          <HStack mt={3} spacing={2} align="center">
            <FiMic color="var(--chakra-colors-gray-400)" />
            <Progress
              value={audioEnabled ? micLevel : 0}
              size="xs"
              colorScheme="green"
              borderRadius="full"
              flex={1}
              bg="whiteAlpha.200"
            />
          </HStack>
        </Box>

        {/* --- Settings + join ------------------------------------------- */}
        <VStack
          flex={1}
          align="stretch"
          spacing={4}
          p={{ base: 4, md: 6 }}
          justify="center"
        >
          <Box>
            <Heading size="md" noOfLines={2}>
              {meetingTitle || 'Ready to join?'}
            </Heading>
            <Text fontSize="sm" color="gray.400" mt={1}>
              Check your camera and microphone before joining.
            </Text>
          </Box>

          <FormControl>
            <FormLabel fontSize="sm" mb={1}>
              <FiVideo style={{ display: 'inline', marginRight: 6 }} />
              Camera
            </FormLabel>
            <Select
              size="sm"
              bg="whiteAlpha.100"
              borderColor="whiteAlpha.300"
              value={videoDeviceId ?? ''}
              onChange={(e) => setVideoDeviceId(e.target.value || undefined)}
              isDisabled={cameras.length === 0}
            >
              {cameras.length === 0 && <option value="">No cameras found</option>}
              {cameras.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId} style={{ color: 'black' }}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </Select>
          </FormControl>

          <FormControl>
            <FormLabel fontSize="sm" mb={1}>
              <FiMic style={{ display: 'inline', marginRight: 6 }} />
              Microphone
            </FormLabel>
            <Select
              size="sm"
              bg="whiteAlpha.100"
              borderColor="whiteAlpha.300"
              value={audioDeviceId ?? ''}
              onChange={(e) => setAudioDeviceId(e.target.value || undefined)}
              isDisabled={mics.length === 0}
            >
              {mics.length === 0 && <option value="">No microphones found</option>}
              {mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId} style={{ color: 'black' }}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </Select>
          </FormControl>

          {speakers.length > 0 && (
            <FormControl>
              <FormLabel fontSize="sm" mb={1}>
                <FiVolume2 style={{ display: 'inline', marginRight: 6 }} />
                Speaker
              </FormLabel>
              <Select
                size="sm"
                bg="whiteAlpha.100"
                borderColor="whiteAlpha.300"
                value={speakerDeviceId ?? ''}
                onChange={(e) => setSpeakerDeviceId(e.target.value || undefined)}
              >
                {speakers.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId} style={{ color: 'black' }}>
                    {d.label || `Speaker ${i + 1}`}
                  </option>
                ))}
              </Select>
            </FormControl>
          )}

          <Button colorScheme="brand" size="lg" onClick={handleJoin} mt={2}>
            Join now
          </Button>
        </VStack>
      </Flex>
    </Flex>
  );
}
