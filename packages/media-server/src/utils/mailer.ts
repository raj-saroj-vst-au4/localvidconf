// =============================================================================
// Mailer
// A single pooled Nodemailer transporter shared across the process, plus
// helpers for escaping HTML and sending mail. Reusing one pooled transporter
// avoids the overhead/connection churn of building a new one per message.
// =============================================================================

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { createLogger } from '../utils/logger';

const log = createLogger('Mailer');

/**
 * Escape HTML-significant characters so user-supplied strings can be safely
 * interpolated into email HTML bodies.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Lazily-created, module-level pooled transporter. Created on first use so that
// importing this module has no side effects at boot.
let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  return transporter;
}

/**
 * Send an email via the shared pooled transporter. Uses SMTP_FROM as the
 * 'from' address. Logs and rethrows on failure.
 */
export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
  } catch (err) {
    log.error('Failed to send email', {
      to: opts.to,
      subject: opts.subject,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
