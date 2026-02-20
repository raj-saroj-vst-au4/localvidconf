// =============================================================================
// Root Layout
// Wraps the entire application with providers (Chakra UI + NextAuth)
// This is a Server Component; client providers are imported as wrappers
// =============================================================================

import type { Metadata } from 'next';
import ChakraProvider from '@/components/providers/ChakraProvider';
import SessionProvider from '@/components/providers/SessionProvider';

export const metadata: Metadata = {
  title: 'Confera - Video Conferencing',
  description: 'Video conferencing with breakout rooms, Q&A, and more',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* SessionProvider: makes useSession() available app-wide */}
        <SessionProvider>
          {/* ChakraProvider: theme, color mode, responsive breakpoints */}
          <ChakraProvider>
            {children}
          </ChakraProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
