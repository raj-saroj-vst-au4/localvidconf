// =============================================================================
// Prisma Client Singleton
// In development, Next.js hot-reloading creates new PrismaClient instances.
// This singleton pattern prevents exhausting database connections.
// In production, a single instance is reused across all API routes.
// =============================================================================

import { PrismaClient } from '@prisma/client';

// Extend globalThis to hold the prisma instance across hot-reloads
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Reuse existing instance in development, create new one in production
const prisma = globalForPrisma.prisma ?? new PrismaClient({
  // Log slow queries in development for performance debugging
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
});

// Only cache the instance in development (prevents hot-reload connection leaks)
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
