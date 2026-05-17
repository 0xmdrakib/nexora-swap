import { NextRequest, NextResponse } from 'next/server';

import { getAlchemyTokenBalances, getNativeBalance } from '@/lib/server/alchemy';
import { getSolanaWalletTokens } from '@/lib/server/solana';
import { cacheGet, cacheSet } from '@/lib/server/cache';
import { getTokenMetadata } from '@/lib/server/tokenMetadata';
import { getChainMeta, isSolanaChain } from '@/lib/chainsMeta';
import { formatTokenAmount } from '@/lib/format';
import { normalizeWalletAddressForChain, toChecksumAddress } from '@/lib/addresses';
import type { Address } from '@/lib/types';

export type WalletToken = {
  token_address: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: string;
  balanceFormatted?: string;
  logo?: string | null;
  thumbnail?: string | null;
};

function toAddress(value: string): Address | null {
  return toChecksumAddress(value);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      out.push(await fn(current));
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const chainId = Number(searchParams.get('chainId'));
  const walletRaw = (searchParams.get('address') || '').trim();
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || '100'), 1), 100);

  if (!chainId || !walletRaw) {
    return NextResponse.json({ error: 'chainId and address are required' }, { status: 400 });
  }
  const meta = getChainMeta(chainId);
  const wallet = meta.chainType === 'EVM' ? toAddress(walletRaw) : normalizeWalletAddressForChain(chainId, walletRaw);
  if (!wallet) return NextResponse.json({ error: 'chainId and valid address are required' }, { status: 400 });

  const cacheKey = `walletTokens:alchemy:${chainId}:${wallet.toLowerCase()}:${limit}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    if (isSolanaChain(chainId)) {
      const solana = await getSolanaWalletTokens(wallet, limit);
      const resolved = await mapLimit(solana.tokenAccounts, 8, async (account) => {
        try {
          const metadata = await getTokenMetadata(chainId, account.mint);
          const token = metadata.token;
          return {
            token_address: String(token.address),
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            balance: account.balance.toString(),
            balanceFormatted: formatTokenAmount(account.balance.toString(), token.decimals || account.decimals || 0, 6),
            logo: token.logoURI || null,
            thumbnail: null,
          } satisfies WalletToken;
        } catch {
          return null;
        }
      });

      const payload = {
        nativeBalance: {
          balance: solana.nativeBalance.balance,
          balanceFormatted: formatTokenAmount(solana.nativeBalance.balance || '0', meta.nativeDecimals, 6),
        },
        tokens: resolved.filter(Boolean),
        source: 'solana-rpc',
      };
      cacheSet(cacheKey, payload, 30_000);
      return NextResponse.json(payload);
    }

    const [nativeBalance, tokenBalances] = await Promise.all([
      getNativeBalance(chainId, wallet as Address),
      getAlchemyTokenBalances(chainId, wallet as Address),
    ]);

    const nonZero = tokenBalances
      .filter((balance) => {
        try {
          return BigInt(balance.tokenBalance || '0') > 0n;
        } catch {
          return false;
        }
      })
      .slice(0, limit);

    const resolved = await mapLimit(nonZero, 8, async (balance) => {
      try {
        const metadata = await getTokenMetadata(chainId, balance.contractAddress);
        const token = metadata.token;
        return {
          token_address: token.address.toLowerCase(),
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          balance: balance.tokenBalance,
          balanceFormatted: formatTokenAmount(balance.tokenBalance || '0', token.decimals || 18, 6),
          logo: token.logoURI || null,
          thumbnail: null,
        } satisfies WalletToken;
      } catch {
        return null;
      }
    });

    const payload = {
      nativeBalance: {
        balance: nativeBalance,
        balanceFormatted: formatTokenAmount(nativeBalance || '0', 18, 6),
      },
      tokens: resolved.filter(Boolean),
      source: 'alchemy',
    };

    cacheSet(cacheKey, payload, 30_000);
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to fetch Alchemy wallet tokens' }, { status: 502 });
  }
}
