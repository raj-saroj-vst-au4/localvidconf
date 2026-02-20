// =============================================================================
// Question Card Component
// Displays a single Q&A question with upvote button, author info, and status.
// Upvote is a toggle: click to upvote, click again to remove.
// Pinned questions have a highlighted border.
// Answered questions have a green checkmark.
// =============================================================================

'use client';

import {
  Box, HStack, VStack, Text, Avatar, Badge, IconButton, Tooltip, Flex,
} from '@chakra-ui/react';
import { FiChevronUp, FiCheck, FiMapPin } from 'react-icons/fi';
import type { Question } from '@/types';

interface QuestionCardProps {
  question: Question;
  isHost: boolean;
  onUpvote: (questionId: string) => void;
  onMarkAnswered: (questionId: string) => void;
  onPin: (questionId: string) => void;
}

export default function QuestionCard({
  question,
  isHost,
  onUpvote,
  onMarkAnswered,
  onPin,
}: QuestionCardProps) {
  return (
    <Box
      p={3}
      bg="whiteAlpha.50"
      borderRadius="md"
      border="1px"
      // Pinned questions have a gold border for visibility
      borderColor={question.isPinned ? 'yellow.400' : 'whiteAlpha.200'}
      // Answered questions have a subtle green tint
      opacity={question.isAnswered ? 0.7 : 1}
      transition="all 0.2s"
      _hover={{ bg: 'whiteAlpha.100' }}
    >
      <HStack align="start" spacing={3}>
        {/* Upvote Button (Slido-style) */}
        <VStack spacing={0} minW="40px">
          <IconButton
            aria-label="Upvote"
            icon={<FiChevronUp />}
            size="sm"
            variant="ghost"
            // Blue when user has upvoted, gray otherwise
            color={question.hasUpvoted ? 'brand.400' : 'gray.400'}
            _hover={{ color: 'brand.300' }}
            onClick={() => onUpvote(question.id)}
          />
          <Text
            fontSize="sm"
            fontWeight="bold"
            color={question.hasUpvoted ? 'brand.400' : 'gray.400'}
          >
            {question.upvoteCount}
          </Text>
        </VStack>

        {/* Question Content */}
        <VStack align="start" spacing={1} flex={1}>
          <Text fontSize="sm" wordBreak="break-word">
            {question.content}
          </Text>

          <HStack spacing={2}>
            <Avatar size="2xs" name={question.author.name} src={question.author.image || undefined} />
            <Text fontSize="xs" color="gray.500">
              {question.author.name}
            </Text>

            {/* Status badges */}
            {question.isPinned && (
              <Badge colorScheme="yellow" fontSize="xx-small">
                Pinned
              </Badge>
            )}
            {question.isAnswered && (
              <Badge colorScheme="green" fontSize="xx-small">
                Answered
              </Badge>
            )}
          </HStack>
        </VStack>

        {/* Host Controls */}
        {isHost && (
          <VStack spacing={0}>
            <Tooltip label={question.isAnswered ? 'Mark unanswered' : 'Mark answered'}>
              <IconButton
                aria-label="Mark answered"
                icon={<FiCheck />}
                size="xs"
                variant="ghost"
                color={question.isAnswered ? 'green.400' : 'gray.500'}
                onClick={() => onMarkAnswered(question.id)}
              />
            </Tooltip>
            <Tooltip label={question.isPinned ? 'Unpin' : 'Pin'}>
              <IconButton
                aria-label="Pin"
                icon={<FiMapPin />}
                size="xs"
                variant="ghost"
                color={question.isPinned ? 'yellow.400' : 'gray.500'}
                onClick={() => onPin(question.id)}
              />
            </Tooltip>
          </VStack>
        )}
      </HStack>
    </Box>
  );
}
