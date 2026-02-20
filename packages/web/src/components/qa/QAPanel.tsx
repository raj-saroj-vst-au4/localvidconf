// =============================================================================
// Q&A Panel Component (Slido-style)
// Sidebar panel showing all questions sorted by upvotes.
// Includes input to ask new questions and real-time updates.
// Questions: pinned first → then sorted by upvote count (descending).
// =============================================================================

'use client';

import { useState } from 'react';
import {
  Box, VStack, HStack, Text, Input, IconButton, Heading, Divider,
  Tabs, TabList, Tab, TabPanels, TabPanel,
} from '@chakra-ui/react';
import { FiSend } from 'react-icons/fi';
import QuestionCard from './QuestionCard';
import type { Question } from '@/types';

interface QAPanelProps {
  questions: Question[];
  isHost: boolean;
  onAskQuestion: (content: string) => void;
  onUpvote: (questionId: string) => void;
  onMarkAnswered: (questionId: string) => void;
  onPin: (questionId: string) => void;
}

export default function QAPanel({
  questions,
  isHost,
  onAskQuestion,
  onUpvote,
  onMarkAnswered,
  onPin,
}: QAPanelProps) {
  const [newQuestion, setNewQuestion] = useState('');

  function handleSubmit() {
    if (!newQuestion.trim()) return;
    onAskQuestion(newQuestion.trim());
    setNewQuestion('');
  }

  // Split questions into unanswered and answered for tab filtering
  const unanswered = questions.filter((q) => !q.isAnswered);
  const answered = questions.filter((q) => q.isAnswered);

  return (
    <Box
      w={{ base: '100%', md: '350px' }}
      h="100%"
      bg="meeting.surface"
      borderLeft={{ md: '1px' }}
      borderColor="whiteAlpha.200"
      display="flex"
      flexDirection="column"
    >
      {/* Header */}
      <Box p={3} borderBottom="1px" borderColor="whiteAlpha.200">
        <Heading size="sm">Q&A ({questions.length})</Heading>
        <Text fontSize="xs" color="gray.500" mt={1}>
          Ask questions or upvote the ones you want answered
        </Text>
      </Box>

      {/* Tabs: All / Unanswered / Answered */}
      <Tabs variant="soft-rounded" colorScheme="brand" size="sm" flex={1} display="flex" flexDirection="column">
        <TabList px={3} pt={2}>
          <Tab color="gray.400" _selected={{ color: 'white', bg: 'brand.600' }}>
            All ({questions.length})
          </Tab>
          <Tab color="gray.400" _selected={{ color: 'white', bg: 'brand.600' }}>
            Open ({unanswered.length})
          </Tab>
          <Tab color="gray.400" _selected={{ color: 'white', bg: 'brand.600' }}>
            Answered ({answered.length})
          </Tab>
        </TabList>

        <TabPanels flex={1} overflowY="auto">
          {/* All questions */}
          <TabPanel p={3}>
            <QuestionList
              questions={questions}
              isHost={isHost}
              onUpvote={onUpvote}
              onMarkAnswered={onMarkAnswered}
              onPin={onPin}
            />
          </TabPanel>

          {/* Unanswered only */}
          <TabPanel p={3}>
            <QuestionList
              questions={unanswered}
              isHost={isHost}
              onUpvote={onUpvote}
              onMarkAnswered={onMarkAnswered}
              onPin={onPin}
            />
          </TabPanel>

          {/* Answered only */}
          <TabPanel p={3}>
            <QuestionList
              questions={answered}
              isHost={isHost}
              onUpvote={onUpvote}
              onMarkAnswered={onMarkAnswered}
              onPin={onPin}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>

      {/* Ask question input */}
      <HStack p={3} borderTop="1px" borderColor="whiteAlpha.200">
        <Input
          placeholder="Ask a question..."
          value={newQuestion}
          onChange={(e) => setNewQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          bg="whiteAlpha.100"
          borderColor="whiteAlpha.300"
          size="sm"
        />
        <IconButton
          aria-label="Submit question"
          icon={<FiSend />}
          size="sm"
          colorScheme="brand"
          onClick={handleSubmit}
          isDisabled={!newQuestion.trim()}
        />
      </HStack>
    </Box>
  );
}

// Sub-component for rendering a list of questions
function QuestionList({
  questions,
  isHost,
  onUpvote,
  onMarkAnswered,
  onPin,
}: {
  questions: Question[];
  isHost: boolean;
  onUpvote: (id: string) => void;
  onMarkAnswered: (id: string) => void;
  onPin: (id: string) => void;
}) {
  if (questions.length === 0) {
    return (
      <Text color="gray.500" textAlign="center" fontSize="sm" mt={4}>
        No questions yet. Be the first to ask!
      </Text>
    );
  }

  return (
    <VStack spacing={2} align="stretch">
      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          isHost={isHost}
          onUpvote={onUpvote}
          onMarkAnswered={onMarkAnswered}
          onPin={onPin}
        />
      ))}
    </VStack>
  );
}
