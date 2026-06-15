import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import prisma from '@/lib/prisma';
import { registerSchema, verifyAndConsumeCaptcha } from '@/lib/validators';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { email, password, name, captchaToken, captchaAnswer } = parsed.data;

  // Verify captcha (single-use: rejects expired, wrong, or already-consumed tokens)
  if (!verifyAndConsumeCaptcha(captchaToken, captchaAnswer)) {
    return NextResponse.json({ error: 'Captcha expired, invalid, or already used' }, { status: 400 });
  }

  // Check existing user
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
  }

  // Create user
  const hashed = await bcrypt.hash(password, 12);
  await prisma.user.create({ data: { email, name, password: hashed } });

  return NextResponse.json({ message: 'Registration successful' }, { status: 201 });
}
