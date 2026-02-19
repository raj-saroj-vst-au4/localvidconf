// =============================================================================
// Reusable Loading Spinner
// Full-page centered spinner with optional message
// =============================================================================

'use client';

import { Center, Spinner, Text, VStack } from '@chakra-ui/react';

interface LoadingSpinnerProps {
  message?: string;
}

export default function LoadingSpinner({ message = 'Loading...' }: LoadingSpinnerProps) {
  return (
    <Center h="100vh">
      <VStack spacing={4}>
        <Spinner size="xl" color="brand.500" thickness="4px" />
        <Text color="gray.400">{message}</Text>
      </VStack>
    </Center>
  );
}
