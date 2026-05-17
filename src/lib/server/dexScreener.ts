import { getAddress } from 'viem';

import { getChainMeta } from '@/lib/chainsMeta';
import { addressCacheKey, normalizeSolanaAddress, normalizeTokenAddressForChain } from '@/lib/addresses';
import type { TokenAddress } from '@/lib/types';
import { cacheGet, cacheSet } from '@/lib/server/cache';
import { getCacheSql, isDatabaseConfigured } from '@/lib/server/db';

const PRICE_TTL_MS = 30_000;
const FORCE_MIN_TTL_MS = 10_000;

type PriceCacheRow = {
  chain_id: number;
  address: string;
  price_usd: string;
  pair_address: string | null;
  dex_id: string | null;
  liquidity_usd: string | null;
  fetched_at: string;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number | string };
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
};

export type TokenPrice = {
  chainId: number;
  address: TokenAddress;
  priceUSD: string | null;
  source: 'dexscreener' | 'neon' | 'memory' | 'none';
  pairAddress?: string;
  dexId?: string;
  liquidityUsd?: string;
  cached?: boolean;
};

function normalizeAddress(chainId: number, address: string): TokenAddress | null {
  return normalizeTokenAddressForChain(chainId, address);
}

function lookupAddress(chainId: number, address: string): TokenAddress {
  const meta = getChainMeta(chainId);
  if (address.toLowerCase() === meta.nativeTokenAddress.toLowerCase()) {
    return meta.chainType === 'EVM'
      ? (getAddress(meta.wrappedNativeAddress) as TokenAddress)
      : normalizeSolanaAddress(meta.wrappedNativeAddress) || meta.wrappedNativeAddress;
  }
  return meta.chainType === 'EVM' ? (getAddress(address) as TokenAddress) : normalizeSolanaAddress(address) || address;
}

function outputAddress(chainId: number, address: string): TokenAddress {
  const meta = getChainMeta(chainId);
  if (address.toLowerCase() === meta.nativeTokenAddress.toLowerCase()) return meta.nativeTokenAddress;
  return meta.chainType === 'EVM' ? (getAddress(address) as TokenAddress) : normalizeSolanaAddress(address) || address;
}

function cacheKey(chainId: number, address: string) {
  return `price:${chainId}:${addressCacheKey(chainId, address)}`;
}

function rowToPrice(row: PriceCacheRow, source: 'neon'): TokenPrice {
  return {
    chainId: Number(row.chain_id),
    address: outputAddress(Number(row.chain_id), row.address),
    priceUSD: row.price_usd,
    pairAddress: row.pair_address || undefined,
    dexId: row.dex_id || undefined,
    liquidityUsd: row.liquidity_usd || undefined,
    source,
    cached: true,
  };
}

async function getDbPrice(chainId: number, address: string, maxAgeMs: number) {
  if (!isDatabaseConfigured()) return null;
  try {
    const sql = await getCacheSql();
    if (!sql) return null;
    const rows = (await sql`
      SELECT chain_id, address, price_usd, pair_address, dex_id, liquidity_usd, fetched_at
      FROM token_price_cache
      WHERE chain_id = ${chainId} AND address = ${addressCacheKey(chainId, address)}
      LIMIT 1
    `) as PriceCacheRow[];
    const row = rows[0];
    if (!row) return null;
    const age = Date.now() - new Date(row.fetched_at).getTime();
    return age < maxAgeMs ? rowToPrice(row, 'neon') : null;
  } catch {
    return null;
  }
}

async function upsertDbPrice(price: TokenPrice) {
  if (!isDatabaseConfigured() || !price.priceUSD) return;
  try {
    const sql = await getCacheSql();
    if (!sql) return;
    await sql`
      INSERT INTO token_price_cache (
        chain_id, address, price_usd, pair_address, dex_id, liquidity_usd, fetched_at
      )
      VALUES (
        ${price.chainId},
        ${addressCacheKey(price.chainId, String(price.address))},
        ${price.priceUSD},
        ${price.pairAddress || null},
        ${price.dexId || null},
        ${price.liquidityUsd || null},
        now()
      )
      ON CONFLICT (chain_id, address)
      DO UPDATE SET
        price_usd = EXCLUDED.price_usd,
        pair_address = EXCLUDED.pair_address,
        dex_id = EXCLUDED.dex_id,
        liquidity_usd = EXCLUDED.liquidity_usd,
        fetched_at = now()
    `;
  } catch {
    // DB cache is best-effort; never block live prices on it.
  }
}

function pairLiquidity(pair: DexPair) {
  const n = Number(pair?.liquidity?.usd || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function priceForRequestedToken(pair: DexPair, requestedAddress: string) {
  const requested = requestedAddress.toLowerCase();
  const base = String(pair.baseToken?.address || '').toLowerCase();
  const quote = String(pair.quoteToken?.address || '').toLowerCase();
  const baseUsd = Number(pair.priceUsd || 0);

  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return null;
  if (base === requested) return String(pair.priceUsd);

  if (quote === requested) {
    const baseInQuote = Number(pair.priceNative || 0);
    if (Number.isFinite(baseInQuote) && baseInQuote > 0) {
      return String(baseUsd / baseInQuote);
    }
  }

  return null;
}

function selectBestPair(pairs: DexPair[], chainSlug: string, requestedAddress: string) {
  const sameChain = pairs.filter(
    (pair) => String(pair.chainId || '').toLowerCase() === chainSlug.toLowerCase()
  );

  const priced = sameChain
    .map((pair) => ({ pair, priceUSD: priceForRequestedToken(pair, requestedAddress) }))
    .filter((item): item is { pair: DexPair; priceUSD: string } => Boolean(item.priceUSD));

  const baseMatches = priced.filter(
    (item) => String(item.pair.baseToken?.address || '').toLowerCase() === requestedAddress.toLowerCase()
  );
  const candidates = baseMatches.length ? baseMatches : priced;
  candidates.sort((a, b) => pairLiquidity(b.pair) - pairLiquidity(a.pair));
  return candidates[0] || null;
}

async function fetchDexPairs(chainSlug: string, addresses: string[]) {
  if (!addresses.length) return [] as DexPair[];

  const base = process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com';
  const batchUrl = `${base.replace(/\/$/, '')}/tokens/v1/${encodeURIComponent(
    chainSlug
  )}/${addresses.map(encodeURIComponent).join(',')}`;

  const batchRes = await fetch(batchUrl, { cache: 'no-store' });
  if (batchRes.ok) {
    const json = await batchRes.json().catch(() => null);
    return Array.isArray(json) ? (json as DexPair[]) : [];
  }

  const perToken = await Promise.all(
    addresses.map(async (address) => {
      const url = `${base.replace(/\/$/, '')}/latest/dex/tokens/${encodeURIComponent(address)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [] as DexPair[];
      const json = await res.json().catch(() => null);
      return Array.isArray(json?.pairs) ? (json.pairs as DexPair[]) : [];
    })
  );
  return perToken.flat();
}

export async function getTokenPrices(
  tokens: Array<{ chainId: number; address: string }>,
  options: { force?: boolean } = {}
): Promise<TokenPrice[]> {
  const deduped = new Map<string, { chainId: number; address: TokenAddress; lookup: TokenAddress }>();

  for (const token of tokens) {
    const normalized = normalizeAddress(token.chainId, token.address);
    if (!normalized) continue;
    const address = outputAddress(token.chainId, normalized);
    const lookup = lookupAddress(token.chainId, normalized);
    deduped.set(`${token.chainId}:${addressCacheKey(token.chainId, String(address))}`, {
      chainId: token.chainId,
      address,
      lookup,
    });
  }

  const output = new Map<string, TokenPrice>();
  const misses: Array<{ chainId: number; address: TokenAddress; lookup: TokenAddress }> = [];
  const cacheMaxAge = options.force ? FORCE_MIN_TTL_MS : PRICE_TTL_MS;

  for (const token of deduped.values()) {
    const key = cacheKey(token.chainId, token.address);
    const memoryHit = cacheGet<TokenPrice>(key);
    if (memoryHit && memoryHit.priceUSD && !options.force) {
      output.set(key, { ...memoryHit, source: 'memory', cached: true });
      continue;
    }

    const dbHit = await getDbPrice(token.chainId, token.address, cacheMaxAge);
    if (dbHit) {
      cacheSet(key, dbHit, PRICE_TTL_MS);
      output.set(key, dbHit);
      continue;
    }

    misses.push(token);
  }

  const missesByChain = new Map<number, Array<{ chainId: number; address: TokenAddress; lookup: TokenAddress }>>();
  for (const miss of misses) {
    const list = missesByChain.get(miss.chainId) || [];
    list.push(miss);
    missesByChain.set(miss.chainId, list);
  }

  await Promise.all(
    Array.from(missesByChain.entries()).map(async ([chainId, chainMisses]) => {
      const meta = getChainMeta(chainId);
      const pairs = await fetchDexPairs(
        meta.dexScreenerChain,
        Array.from(new Set(chainMisses.map((miss) => miss.lookup)))
      );

      for (const miss of chainMisses) {
        const selected = selectBestPair(pairs, meta.dexScreenerChain, miss.lookup);
        const key = cacheKey(miss.chainId, miss.address);

        const price: TokenPrice = selected
          ? {
              chainId: miss.chainId,
              address: miss.address,
              priceUSD: selected.priceUSD,
              source: 'dexscreener',
              pairAddress: selected.pair.pairAddress,
              dexId: selected.pair.dexId,
              liquidityUsd:
                selected.pair.liquidity?.usd !== undefined
                  ? String(selected.pair.liquidity.usd)
                  : undefined,
              cached: false,
            }
          : {
              chainId: miss.chainId,
              address: miss.address,
              priceUSD: null,
              source: 'none',
              cached: false,
            };

        if (price.priceUSD) {
          await upsertDbPrice(price);
          cacheSet(key, price, PRICE_TTL_MS);
        } else {
          cacheSet(key, price, 10_000);
        }
        output.set(key, price);
      }
    })
  );

  return Array.from(deduped.values()).map((token) => {
    const key = cacheKey(token.chainId, token.address);
    return (
      output.get(key) || {
        chainId: token.chainId,
        address: token.address,
        priceUSD: null,
        source: 'none',
        cached: false,
      }
    );
  });
}
