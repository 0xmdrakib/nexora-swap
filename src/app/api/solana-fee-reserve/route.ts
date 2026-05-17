import { NextResponse } from 'next/server';

import { cacheGet, cacheSet } from '@/lib/server/cache';
import { getSolanaConnection } from '@/lib/server/solana';

const FALLBACK_SOLANA_RESERVE_LAMPORTS = 20_000n;
const MAX_SOLANA_RESERVE_LAMPORTS = 250_000n;
const TOKEN_ACCOUNT_RENT_BYTES = 165;

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * p)));
  return sorted[index] || 0;
}

function clampLamports(value: bigint) {
  if (value < FALLBACK_SOLANA_RESERVE_LAMPORTS) return FALLBACK_SOLANA_RESERVE_LAMPORTS;
  if (value > MAX_SOLANA_RESERVE_LAMPORTS) return MAX_SOLANA_RESERVE_LAMPORTS;
  return value;
}

export async function GET() {
  const cacheKey = 'solana:feeReserve:v1';
  const cached = cacheGet<{ lamports: string; source: string; cached?: boolean }>(cacheKey);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  try {
    const connection = getSolanaConnection();
    const [priorityFees, tokenAccountRent] = await Promise.all([
      connection.getRecentPrioritizationFees().catch(() => []),
      connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_RENT_BYTES, 'confirmed').catch(() => 0),
    ]);

    const p75PriorityFee = percentile(
      priorityFees
        .map((fee) => Number(fee?.prioritizationFee || 0))
        .filter((fee) => Number.isFinite(fee) && fee > 0),
      0.75,
    );

    // Base signatures are cheap on Solana. Add priority fee headroom and a small
    // slice of ATA rent so Max leaves enough SOL for common LI.FI swap setup paths.
    const baseSignatureFees = 10_000n;
    const priorityHeadroom = BigInt(Math.ceil(p75PriorityFee * 2));
    const rentHeadroom = BigInt(Math.ceil(Number(tokenAccountRent || 0) * 0.05));
    const lamports = clampLamports(baseSignatureFees + priorityHeadroom + rentHeadroom);
    const payload = { lamports: lamports.toString(), source: 'solana-rpc' };
    cacheSet(cacheKey, payload, 20_000);
    return NextResponse.json(payload);
  } catch {
    const payload = { lamports: FALLBACK_SOLANA_RESERVE_LAMPORTS.toString(), source: 'fallback' };
    cacheSet(cacheKey, payload, 10_000);
    return NextResponse.json(payload);
  }
}
