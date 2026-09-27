import { NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@supabase/nextjs-edge';
import { cookies } from 'next/headers';

export async function GET(request: Request) {
  const supa = createRouteHandlerClient({ cookies });
  const { data } = await supa.auth.getUser();
  return NextResponse.json({ user: data.user });
}