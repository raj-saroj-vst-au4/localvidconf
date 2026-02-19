// =============================================================================
// useQA Hook
// Manages the Q&A (Slido-style) feature state and actions.
// Questions are sorted: pinned first, then by upvote count (descending).
// Upvoting is a toggle (click to upvote, click again to remove).
// Duplicate votes are prevented by the @@unique constraint in the database.
// =============================================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { useSession } from 'next-auth/react';
import type { Question } from '@/types';

interface UseQAProps {
  socket: Socket | null;
  isConnected: boolean;
  meetingId: string | null;
}

interface UseQAReturn {
  questions: Question[];
  isLoading: boolean;
  // Actions
  askQuestion: (content: string) => void;
  upvoteQuestion: (questionId: string) => void;
  markAnswered: (questionId: string) => void;
  pinQuestion: (questionId: string) => void;
}

export function useQA({ socket, isConnected, meetingId }: UseQAProps): UseQAReturn {
  const { data: session } = useSession();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // --- Fetch initial questions when meeting is joined ---
  useEffect(() => {
    if (!meetingId) return;

    async function fetchQuestions() {
      try {
        const res = await fetch(`/meet/api/questions?meetingId=${meetingId}`);
        if (res.ok) {
          const data = await res.json();
          setQuestions(data.questions);
        }
      } catch (err) {
        console.error('Failed to fetch questions:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchQuestions();
  }, [meetingId]);

  // --- Listen for real-time Q&A events ---
  useEffect(() => {
    if (!socket || !isConnected) return;

    // New question submitted by any participant
    socket.on('new-question', (question: Question) => {
      setQuestions((prev) => {
        // Add new question and re-sort (pinned first, then by upvotes)
        const updated = [question, ...prev];
        return sortQuestions(updated);
      });
    });

    // Upvote count changed for a question
    socket.on('question-upvoted', (data: { questionId: string; upvoteCount: number }) => {
      setQuestions((prev) => {
        const updated = prev.map((q) =>
          q.id === data.questionId
            ? { ...q, upvoteCount: data.upvoteCount }
            : q
        );
        return sortQuestions(updated);
      });
    });

    // Question marked as answered/unanswered
    socket.on('question-answered', (data: { questionId: string; isAnswered: boolean }) => {
      setQuestions((prev) =>
        prev.map((q) =>
          q.id === data.questionId ? { ...q, isAnswered: data.isAnswered } : q
        )
      );
    });

    // Question pinned/unpinned
    socket.on('question-pinned', (data: { questionId: string; isPinned: boolean }) => {
      setQuestions((prev) => {
        const updated = prev.map((q) =>
          q.id === data.questionId ? { ...q, isPinned: data.isPinned } : q
        );
        return sortQuestions(updated);
      });
    });

    return () => {
      socket.off('new-question');
      socket.off('question-upvoted');
      socket.off('question-answered');
      socket.off('question-pinned');
    };
  }, [socket, isConnected]);

  // --- Sort questions: pinned first, then by upvote count ---
  function sortQuestions(questions: Question[]): Question[] {
    return [...questions].sort((a, b) => {
      // Pinned questions always at the top
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      // Then sort by upvote count (most upvoted first)
      return b.upvoteCount - a.upvoteCount;
    });
  }

  // --- Actions ---

  const askQuestion = useCallback((content: string) => {
    socket?.emit('ask-question', { content });
  }, [socket]);

  // Toggle upvote: optimistically update the UI, then send to server
  const upvoteQuestion = useCallback((questionId: string) => {
    const userId = (session?.user as any)?.id;

    // Optimistic UI update: toggle immediately for snappy UX
    setQuestions((prev) => {
      const updated = prev.map((q) => {
        if (q.id !== questionId) return q;
        const newHasUpvoted = !q.hasUpvoted;
        return {
          ...q,
          hasUpvoted: newHasUpvoted,
          upvoteCount: newHasUpvoted ? q.upvoteCount + 1 : q.upvoteCount - 1,
        };
      });
      return sortQuestions(updated);
    });

    // Send to server (server broadcasts the canonical count to everyone)
    socket?.emit('upvote-question', { questionId });
  }, [socket, session]);

  const markAnswered = useCallback((questionId: string) => {
    socket?.emit('mark-answered', { questionId });
  }, [socket]);

  const pinQuestion = useCallback((questionId: string) => {
    socket?.emit('pin-question', { questionId });
  }, [socket]);

  return {
    questions,
    isLoading,
    askQuestion,
    upvoteQuestion,
    markAnswered,
    pinQuestion,
  };
}
