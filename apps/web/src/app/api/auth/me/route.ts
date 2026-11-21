import { NextResponse } from 'next/server';

// MVP stub: real auth lives in the NestJS API (JWT).
// This route exists so the web app builds without Supabase.
export async function GET() {
  return NextResponse.json({ user: null }, { status: 501 });
}
