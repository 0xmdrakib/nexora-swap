import { NextRequest, NextResponse } from 'next/server';

import { getSelectedBalances } from '@/lib/server/alchemy';
import { getSolanaSelectedBalances } from '@/lib/server/solana';
import { cacheGet, cacheSet } from '@/lib/server/cache';
import { getChainMeta, isSolanaChain } from '@/lib/chainsMeta';
import { normalizeWalletAddressForChain, normalizeTokenAddressForChain, toChecksumAddress } from '@/lib/addresses';
import type { Address } from '@/lib/types';

function toEvmAddress(value: unknown): Address | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return toChecksumAddress(s);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const walletRaw = typeof body?.address === 'string' ? body.address.trim() : '';
    const tokens = Array.isArray(body?.tokens) ? body.tokens : [];
    const force = Boolean(body?.force);

    if (!walletRaw) {
      return NextResponse.json({ error: 'Valid wallet address is required' }, { status: 400 });
    }

    const normalized = tokens
      .map((token: any) => {
        const chainId = Number(token?.chainId);
        if (!chainId) return null;
        const address = normalizeTokenAddressForChain(chainId, String(token?.address || ''));
        return address ? { chainId, address } : null;
      })
      .filter(Boolean)
      .slice(0, 20) as Array<{ chainId: number; address: string }>;

    if (!normalized.length) {
      return NextResponse.json({ balances: [] });
    }

    const cacheKey = `selectedBalances:${walletRaw.toLowerCase()}:${normalized
      .map((token) => `${token.chainId}:${token.address.toLowerCase()}`)
      .sort()
      .join('|')}`;
    const cached = !force ? cacheGet<any>(cacheKey) : null;
    if (cached) return NextResponse.json(cached);

    const evmTokens = normalized.filter((token) => getChainMeta(token.chainId).chainType === 'EVM');
    const solanaTokens = normalized.filter((token) => isSolanaChain(token.chainId));

    const evmWallet = evmTokens.length ? toEvmAddress(walletRaw) : null;
    const solanaWallet = solanaTokens.length
      ? normalizeWalletAddressForChain(solanaTokens[0].chainId, walletRaw)
      : null;

    if (evmTokens.length && !evmWallet) {
      return NextResponse.json({ error: 'Valid EVM wallet address is required for EVM balances' }, { status: 400 });
    }
    if (solanaTokens.length && !solanaWallet) {
      return NextResponse.json({ error: 'Valid Solana wallet address is required for Solana balances' }, { status: 400 });
    }

    const [evmBalances, solanaBalances] = await Promise.all([
      evmTokens.length ? getSelectedBalances(evmWallet as Address, evmTokens as Array<{ chainId: number; address: Address }>) : [],
      solanaTokens.length ? getSolanaSelectedBalances(solanaWallet as string, solanaTokens) : [],
    ]);
    const balances = [...evmBalances, ...solanaBalances];
    const payload = { balances, source: solanaTokens.length && evmTokens.length ? 'mixed' : solanaTokens.length ? 'solana-rpc' : 'alchemy' };
    cacheSet(cacheKey, payload, force ? 10_000 : 20_000);
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to fetch Alchemy balances' }, { status: 502 });
  }
}
