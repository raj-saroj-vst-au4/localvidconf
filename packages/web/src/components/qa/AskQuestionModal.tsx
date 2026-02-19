// =============================================================================
// Ask Question Modal
// Full-screen modal for composing a Q&A question on mobile devices.
// On desktop, the inline input in QAPanel is sufficient, but mobile
// benefits from a larger input area.
// =============================================================================

'use client';

import { useState } from 'react';
import {
  Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody,
  ModalFooter, ModalCloseButton, Textarea, Button, Text,
} from '@chakra-ui/react';

interface AskQuestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (content: string) => void;
}

export default function AskQuestionModal({
  isOpen,
  onClose,
  onSubmit,
}: AskQuestionModalProps) {
  const [content, setContent] = useState('');

  function handleSubmit() {
    if (!content.trim()) return;
    onSubmit(content.trim());
    setContent('');
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered>
      <ModalOverlay />
      <ModalContent bg="meeting.surface" mx={4}>
        <ModalHeader>Ask a Question</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Textarea
            placeholder="Type your question here..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            bg="whiteAlpha.100"
            borderColor="whiteAlpha.300"
            rows={4}
            maxLength={1000}
            autoFocus
          />
          <Text fontSize="xs" color="gray.500" mt={1} textAlign="right">
            {content.length}/1000
          </Text>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={3} onClick={onClose}>Cancel</Button>
          <Button
            colorScheme="brand"
            onClick={handleSubmit}
            isDisabled={!content.trim()}
          >
            Submit Question
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
