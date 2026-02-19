// =============================================================================
// Chat Panel Component
// In-meeting chat with message history and real-time updates.
// Shows sender name, message content, and timestamp.
// Messages auto-scroll to the latest.
// =============================================================================

'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Box, VStack, HStack, Text, Input, IconButton, Flex, Avatar,
} from '@chakra-ui/react';
import { FiSend } from 'react-icons/fi';
import { Socket } from 'socket.io-client';
import type { ChatMessage } from '@/types';

interface ChatPanelProps {
  socket: Socket | null;
  isConnected: boolean;
  currentUserEmail: string;
}

export default function ChatPanel({
  socket,
  isConnected,
  currentUserEmail,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Fetch chat history on mount
  useEffect(() => {
    if (!socket || !isConnected) return;

    socket.emit('get-chat-history', null, (data: { messages: ChatMessage[] }) => {
      setMessages(data.messages);
    });

    // Listen for new chat messages
    socket.on('new-chat', (message: ChatMessage) => {
      setMessages((prev) => [...prev, message]);
    });

    return () => {
      socket.off('new-chat');
    };
  }, [socket, isConnected]);

  function handleSend() {
    if (!newMessage.trim() || !socket) return;

    socket.emit('send-chat', { content: newMessage.trim() });
    setNewMessage('');
  }

  // Format timestamp: show time only (e.g., "2:30 PM")
  function formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <Box
      w={{ base: '100%', md: '300px' }}
      h="100%"
      bg="meeting.surface"
      borderLeft={{ md: '1px' }}
      borderColor="whiteAlpha.200"
      display="flex"
      flexDirection="column"
    >
      {/* Header */}
      <Box p={3} borderBottom="1px" borderColor="whiteAlpha.200">
        <Text fontWeight="bold" fontSize="sm">Chat</Text>
      </Box>

      {/* Messages */}
      <VStack
        flex={1}
        overflowY="auto"
        p={3}
        spacing={3}
        align="stretch"
      >
        {messages.length === 0 ? (
          <Text color="gray.500" textAlign="center" fontSize="sm" mt={4}>
            No messages yet. Start the conversation!
          </Text>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderEmail === currentUserEmail;
            return (
              <Flex
                key={msg.id}
                direction="column"
                align={isMe ? 'flex-end' : 'flex-start'}
              >
                {/* Sender name (not shown for self) */}
                {!isMe && (
                  <Text fontSize="xs" color="gray.400" mb={0.5}>
                    {msg.senderName}
                  </Text>
                )}
                <Box
                  maxW="85%"
                  bg={isMe ? 'brand.600' : 'whiteAlpha.200'}
                  color="white"
                  px={3}
                  py={1.5}
                  borderRadius="lg"
                  borderBottomRightRadius={isMe ? 'sm' : 'lg'}
                  borderBottomLeftRadius={isMe ? 'lg' : 'sm'}
                >
                  <Text fontSize="sm" wordBreak="break-word">
                    {msg.content}
                  </Text>
                </Box>
                <Text fontSize="xx-small" color="gray.600" mt={0.5}>
                  {formatTime(msg.createdAt)}
                </Text>
              </Flex>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </VStack>

      {/* Message input */}
      <HStack p={3} borderTop="1px" borderColor="whiteAlpha.200">
        <Input
          placeholder="Type a message..."
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          bg="whiteAlpha.100"
          borderColor="whiteAlpha.300"
          size="sm"
        />
        <IconButton
          aria-label="Send"
          icon={<FiSend />}
          size="sm"
          colorScheme="brand"
          onClick={handleSend}
          isDisabled={!newMessage.trim()}
        />
      </HStack>
    </Box>
  );
}
