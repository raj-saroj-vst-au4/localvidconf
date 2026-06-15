// =============================================================================
// Environment Configuration
// Zod-validated environment config loaded once at boot.
// Importing modules read the typed `env` object instead of process.env directly.
// Call validateEnv() early in startup to fail fast on misconfiguration.
// =============================================================================

import { z } from 'zod';

// In non-production environments we relax a few requirements so that local
// development and tests don't need a fully-provisioned SMTP/CORS setup.
const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === undefined;

// A required-in-production-only string: required when NODE_ENV is production,
// optional otherwise.
const prodRequiredString = (schema: z.ZodString) =>
  isProduction ? schema : schema.optional();

// --- Schema ---
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Auth
  NEXTAUTH_SECRET: z.string().min(16),

  // mediasoup networking
  MEDIASOUP_LISTEN_IP: z.string().default('0.0.0.0'),
  // No default: the announced IP must be explicitly set, otherwise WebRTC
  // clients would be told to connect to the wrong address.
  MEDIASOUP_ANNOUNCED_IP: z.string().min(1),

  // TURN/STUN
  TURN_SERVER_URL: z.string().min(1),
  TURN_SECRET: z.string().min(1),

  // CORS — required (and must be a URL) in production, optional elsewhere.
  CORS_ORIGIN: prodRequiredString(z.string().url()),

  // SMTP — required in production, optional elsewhere.
  SMTP_HOST: prodRequiredString(z.string().min(1)),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: prodRequiredString(z.string().min(1)),
  SMTP_PASSWORD: prodRequiredString(z.string().min(1)),
  SMTP_FROM: prodRequiredString(z.string().min(1)),

  // App config
  NODE_ENV: z.enum(['dev', 'production', 'test']).default('production'),
  LOG_LEVEL: z.string().default('info'),

  // Capacity limits
  MAX_ROOMS: z.coerce.number().default(500),
  MAX_PEERS_PER_ROOM: z.coerce.number().default(100),

  // RTC port range
  RTC_MIN_PORT: z.coerce.number().default(40000),
  RTC_MAX_PORT: z.coerce.number().default(49999),
});

// Inferred type of the validated environment.
export type Env = z.infer<typeof envSchema>;

// --- Parse + cache ---
// Parsing happens once and the result is memoized so repeated imports share
// the same validated object.
let cachedEnv: Env | undefined;

function parseEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Print human-readable zod issues, then abort startup.
    console.error('[ENV] Invalid environment configuration:');
    for (const issue of result.error.issues) {
      const path = issue.path.join('.') || '(root)';
      console.error(`  - ${path}: ${issue.message}`);
    }
    process.exit(1);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Validate process.env against the schema. On failure, prints the zod issues
 * and exits the process with code 1. Safe to call multiple times (cached).
 */
export function validateEnv(): void {
  parseEnv();
}

/**
 * The validated, typed environment. Accessing this triggers a one-time parse
 * (and process.exit(1) if the environment is invalid).
 */
export const env: Env = parseEnv();
