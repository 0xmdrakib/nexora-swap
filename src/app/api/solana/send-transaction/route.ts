import { NextRequest, NextResponse } from 'next/server';
import { VersionedTransaction } from '@solana/web3.js';

import { getSolanaConnection } from '@/lib/server/solana';

export const runtime = 'nodejs';

const MAX_TRANSACTION_BASE64_LENGTH = 1_000_000;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const transaction =
    body && typeof body === 'object' && 'transaction' in body
      ? (body as { transaction?: unknown }).transaction
      : undefined;

  if (
    typeof transaction !== 'string' ||
    transaction.length === 0 ||
    transaction.length > MAX_TRANSACTION_BASE64_LENGTH
  ) {
    return NextResponse.json({ error: 'Invalid signed Solana transaction.' }, { status: 400 });
  }

  try {
    const signedTransaction = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    const signature = await getSolanaConnection().sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    return NextResponse.json({ signature });
  } catch {
    return NextResponse.json({ error: 'Failed to submit the signed Solana transaction.' }, { status: 502 });
  }
}
