// =============================================================================
// Structured Logger
// Simple logging utility with log levels and timestamps
// In production, these logs are captured by Docker's log driver
// =============================================================================

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// Read log level from environment (default: 'info' in production, 'debug' in development)
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] <= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, context: string, message: string, data?: any): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`;
  return data ? `${base} ${JSON.stringify(data)}` : base;
}

/**
 * Create a logger scoped to a specific context (e.g., 'Room', 'Peer', 'Socket').
 * Usage: const log = createLogger('Room'); log.info('Room created', { roomId });
 */
export function createLogger(context: string) {
  return {
    error: (message: string, data?: any) => {
      if (shouldLog('error')) console.error(formatMessage('error', context, message, data));
    },
    warn: (message: string, data?: any) => {
      if (shouldLog('warn')) console.warn(formatMessage('warn', context, message, data));
    },
    info: (message: string, data?: any) => {
      if (shouldLog('info')) console.log(formatMessage('info', context, message, data));
    },
    debug: (message: string, data?: any) => {
      if (shouldLog('debug')) console.log(formatMessage('debug', context, message, data));
    },
  };
}
