// =============================================================================
// NextAuth Session Provider Wrapper
// Makes the authentication session available to all client components
// via the useSession() hook from next-auth/react
// =============================================================================

'use client';

import { SessionProvider as NextAuthProvider } from 'next-auth/react';

export default function SessionProvider({ children }: { children: React.ReactNode }) {
  return <NextAuthProvider basePath="/meet/api/auth">{children}</NextAuthProvider>;
}
