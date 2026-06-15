// =============================================================================
// Zod Validation Schemas
// All input validation schemas for API routes and socket events
// Prevents injection attacks and ensures data integrity at the boundary
// =============================================================================

import { z } from 'zod';
import jwt from 'jsonwebtoken';

// --- Captcha single-use guard ---
// The captcha answer is embedded in a short-lived JWT. Without tracking, that
// token can be replayed until it expires. We record each token's jti the first
// time it is verified and reject any subsequent presentation of the same jti.
//
// NOTE: this Set is per-process (in-memory). It is sufficient for a single
// server instance; a multi-instance deployment would need a shared store.
const consumedCaptchaJtis = new Set<string>();

interface CaptchaPayload {
  type?: string;
  answer?: number;
  jti?: string;
}

/**
 * Verify a captcha token against the expected answer and atomically consume it.
 * Returns true only on the first successful verification of a given token.
 * Pins the HS256 algorithm to prevent algorithm-confusion attacks.
 */
export function verifyAndConsumeCaptcha(
  captchaToken: string,
  expectedAnswer: number
): boolean {
  let decoded: CaptchaPayload;
  try {
    decoded = jwt.verify(captchaToken, process.env.NEXTAUTH_SECRET!, {
      algorithms: ['HS256'],
    }) as CaptchaPayload;
  } catch {
    return false;
  }

  if (decoded.type !== 'captcha' || decoded.answer !== expectedAnswer) {
    return false;
  }

  // Require a jti and reject replays.
  if (!decoded.jti || consumedCaptchaJtis.has(decoded.jti)) {
    return false;
  }

  consumedCaptchaJtis.add(decoded.jti);
  return true;
}

// --- Meeting Validation ---

export const createMeetingSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(200, 'Title must be under 200 characters')
    .trim(),
  description: z.string()
    .max(2000, 'Description must be under 2000 characters')
    .trim()
    .optional(),
  scheduledAt: z.string()
    .datetime()
    .optional(), // ISO 8601 datetime string
  lobbyEnabled: z.boolean().default(true),
});

export const joinMeetingSchema = z.object({
  code: z.string()
    .min(1, 'Meeting code is required')
    // Meeting codes follow the format: abc-defg-hij
    .regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/, 'Invalid meeting code format'),
});

// --- Invitation Validation ---

export const inviteSchema = z.object({
  email: z.string()
    .email('Invalid email address')
    .max(320, 'Email too long'), // RFC 5321 max email length
});

// --- Q&A Validation ---

export const askQuestionSchema = z.object({
  content: z.string()
    .min(1, 'Question cannot be empty')
    .max(1000, 'Question must be under 1000 characters')
    .trim(),
  meetingId: z.string().cuid(),
});

export const upvoteSchema = z.object({
  questionId: z.string().cuid(),
});

// --- Breakout Room Validation ---

export const createBreakoutSchema = z.object({
  rooms: z.array(z.object({
    name: z.string()
      .min(1, 'Room name is required')
      .max(100, 'Room name must be under 100 characters')
      .trim(),
    participantIds: z.array(z.string().cuid()),
  })).min(1, 'At least one breakout room is required')
    .max(20, 'Maximum 20 breakout rooms'),
  duration: z.number()
    .min(1, 'Minimum duration is 1 minute')
    .max(120, 'Maximum duration is 120 minutes')
    .optional(),
});

// --- Chat Validation ---

export const chatMessageSchema = z.object({
  content: z.string()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message must be under 2000 characters')
    .trim(),
});

// --- Auth Validation ---

export const registerSchema = z.object({
  email: z.string().email('Invalid email').max(320),
  password: z.string()
    .min(10, 'Password must be at least 10 characters')
    .max(128)
    .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), {
      message: 'Password must contain at least one letter and one number',
    }),
  name: z.string().min(1, 'Name is required').max(100).trim(),
  captchaToken: z.string().min(1),
  captchaAnswer: z.number().int(),
});

// --- Schedule Reminder Validation ---

export const scheduleReminderSchema = z.object({
  meetingId: z.string().cuid(),
  type: z.enum(['EMAIL', 'IN_APP']),
  minutesBefore: z.number()
    .int()
    .positive()
    .max(1440, 'Reminder cannot be more than 24 hours before'),
});
