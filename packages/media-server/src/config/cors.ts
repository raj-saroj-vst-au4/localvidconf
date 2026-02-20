// =============================================================================
// CORS Configuration
// Whitelist of allowed origins for API and Socket.IO connections
// In production, only the frontend domain should be allowed
// =============================================================================

export const CORS_OPTIONS = {
  // Allow requests from the Next.js frontend
  // CORS_ORIGIN env var should be set to the production domain
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true, // Required for cookies/auth headers
};
