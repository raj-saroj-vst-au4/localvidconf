// =============================================================================
// NextAuth Session Provider Wrapper
// Makes the authentication session available to all client components
// via the useSession() hook from next-auth/react
// =============================================================================

'use client';

import { SessionProvider as NextAuthProvider } from 'next-auth/react';

export default function SessionProvider({ children }: { children: React.ReactNode }) {
  // The app runs under Next's basePath '/meet', but NextAuth's client does NOT
  // inherit it — it defaults to '/api/auth', so signIn/csrf/callback/session
  // would hit '/api/auth/*' (the main site, not this app) and login bounces to
  // '/api/auth/error'. Pin the client to the real, proxied NextAuth path.
  return <NextAuthProvider basePath="/meet/api/auth">{children}</NextAuthProvider>;
}
