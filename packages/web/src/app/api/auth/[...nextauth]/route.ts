// =============================================================================
// NextAuth.js API Route Handler
// Handles all authentication endpoints: /api/auth/signin, /api/auth/callback, etc.
// Uses the shared authOptions from lib/auth.ts
// =============================================================================

import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

const handler = NextAuth(authOptions);

// NextAuth needs both GET (for session checks) and POST (for sign in/out)
export { handler as GET, handler as POST };
