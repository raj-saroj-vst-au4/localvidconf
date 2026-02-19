// =============================================================================
// Protected Route Component
// Wraps pages that require authentication
// Redirects unauthenticated users to the sign-in page
// Shows a loading spinner while checking auth status
// =============================================================================

'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Center, Spinner, Text, VStack } from '@chakra-ui/react';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    // Redirect to sign-in if not authenticated
    if (status === 'unauthenticated') {
      router.push('/auth/signin');
    }
  }, [status, router]);

  // Show loading spinner while NextAuth checks the session
  if (status === 'loading') {
    return (
      <Center h="100vh">
        <VStack spacing={4}>
          <Spinner size="xl" color="brand.500" thickness="4px" />
          <Text color="gray.400">Authenticating...</Text>
        </VStack>
      </Center>
    );
  }

  // Don't render children until authenticated
  if (!session) return null;

  return <>{children}</>;
}
