// =============================================================================
// CORS Configuration
// Whitelist of allowed origins for API and Socket.IO connections
// In production, only the frontend domain should be allowed
// =============================================================================

// Fail closed in production: a missing CORS_ORIGIN must not silently fall back
// to a permissive localhost default on a live deployment. Throwing here aborts
// module load (and therefore startup) so the misconfiguration is caught early.
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  throw new Error(
    'CORS_ORIGIN must be set in production (refusing to default to http://localhost:3000).'
  );
}

export const CORS_OPTIONS = {
  // Allow requests from the Next.js frontend.
  // CORS_ORIGIN env var should be set to the production domain (comma-separated
  // for multiple origins). In dev it defaults to the local Next.js server.
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true, // Required for cookies/auth headers
};
