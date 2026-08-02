import { NextRequest, NextResponse } from 'next/server';

import { getSolanaConnection } from '@/lib/server/solana';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const signature =
    body && typeof body === 'object' && 'signature' in body
      ? (body as { signature?: unknown }).signature
      : undefined;

  if (typeof signature !== 'string' || signature.length < 20 || signature.length > 200) {
    return NextResponse.json({ error: 'Invalid Solana transaction signature.' }, { status: 400 });
  }

  try {
    const result = await getSolanaConnection().confirmTransaction(signature, 'confirmed');
    return NextResponse.json({ confirmed: result.value.err === null });
  } catch {
    return NextResponse.json({ error: 'Failed to confirm the Solana transaction.' }, { status: 502 });
  }
}
