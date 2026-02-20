export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

export async function GET() {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const ops = ['+', '-'] as const;
  const op = ops[Math.floor(Math.random() * ops.length)];
  // Ensure non-negative result for subtraction
  const [x, y] = op === '-' && b > a ? [b, a] : [a, b];
  const answer = op === '+' ? x + y : x - y;

  const captchaToken = jwt.sign(
    { answer, type: 'captcha' },
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: '5m' }
  );

  return NextResponse.json({ question: `${x} ${op} ${y}`, captchaToken });
}
