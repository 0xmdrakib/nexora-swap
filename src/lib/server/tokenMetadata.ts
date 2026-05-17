import { getAddress, isAddress } from 'viem';

import { getChainMeta } from '@/lib/chainsMeta';
import { addressCacheKey, normalizeSolanaAddress, normalizeTokenAddressForChain } from '@/lib/addresses';
import { findLifiToken } from '@/lib/server/lifiTokens';
import type { Address, Token } from '@/lib/types';
import { cacheGet, cacheSet } from '@/lib/server/cache';
import { getCacheSql, isDatabaseConfigured } from '@/lib/server/db';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const METADATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_TTL_MS = 60 * 60 * 1000;

type CachedMetadataRow = {
  chain_id: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logo_uri: string | null;
  thumbnail_uri: string | null;
  possible_spam: boolean | null;
  fetched_at: string;
};

type MoralisMetadata = {
  address?: string;
  name?: string;
  symbol?: string;
  decimals?: string | number;
  logo?: string | null;
  thumbnail?: string | null;
  possible_spam?: boolean;
};

export type TokenMetadataResult = {
  token: Token;
  source: 'local-native' | 'neon' | 'neon-stale' | 'memory' | 'moralis' | 'lifi';
  dbCache: 'enabled' | 'disabled' | 'error';
};

export function toChecksumAddress(value: string): Address | null {
  const s = value.trim();
  if (!isAddress(s, { strict: false })) return null;
  try {
    return getAddress(s) as Address;
  } catch {
    return null;
  }
}

export function normalizeTokenAddress(value: string): string | null {
  const addr = toChecksumAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function isNativeAddress(address: string) {
  return address.toLowerCase() === ZERO;
}

function tokenFromRow(row: CachedMetadataRow): Token {
  const meta = getChainMeta(Number(row.chain_id));
  const address =
    meta.chainType === 'EVM'
      ? (getAddress(row.address) as Address)
      : (normalizeSolanaAddress(row.address) || row.address);

  return {
    chainId: Number(row.chain_id),
    address,
    name: row.name,
    symbol: row.symbol,
    decimals: Number(row.decimals || 18),
    logoURI: row.logo_uri || row.thumbnail_uri || undefined,
  };
}

function localNativeToken(chainId: number): Token {
  const meta = getChainMeta(chainId);
  return {
    chainId,
    address: meta.nativeTokenAddress,
    symbol: meta.nativeSymbol,
    name: meta.nativeSymbol,
    decimals: meta.nativeDecimals,
    logoURI: meta.logoUrl,
  };
}

async function getDbToken(chainId: number, address: string) {
  if (!isDatabaseConfigured()) return { dbCache: 'disabled' as const, row: null };

  try {
    const sql = await getCacheSql();
    if (!sql) return { dbCache: 'disabled' as const, row: null };
    const rows = (await sql`
      SELECT chain_id, address, name, symbol, decimals, logo_uri, thumbnail_uri, possible_spam, fetched_at
      FROM token_metadata
      WHERE chain_id = ${chainId} AND address = ${address}
      LIMIT 1
    `) as CachedMetadataRow[];
    return { dbCache: 'enabled' as const, row: rows[0] || null };
  } catch {
    return { dbCache: 'error' as const, row: null };
  }
}

async function upsertDbToken(
  token: Token,
  source: 'moralis' | 'lifi',
  thumbnailUri?: string | null,
  possibleSpam?: boolean | null,
) {
  if (!isDatabaseConfigured()) return 'disabled' as const;

  try {
    const meta = getChainMeta(token.chainId);
    const storedAddress =
      meta.chainType === 'EVM'
        ? String(token.address).toLowerCase()
        : normalizeSolanaAddress(String(token.address)) || String(token.address);
    const sql = await getCacheSql();
    if (!sql) return 'disabled' as const;
    await sql`
      INSERT INTO token_metadata (
        chain_id, address, name, symbol, decimals, logo_uri, thumbnail_uri, possible_spam, source, fetched_at, updated_at
      )
      VALUES (
        ${token.chainId},
        ${storedAddress},
        ${token.name},
        ${token.symbol},
        ${token.decimals},
        ${token.logoURI || null},
        ${thumbnailUri || null},
        ${possibleSpam ?? null},
        ${source},
        now(),
        now()
      )
      ON CONFLICT (chain_id, address)
      DO UPDATE SET
        name = EXCLUDED.name,
        symbol = EXCLUDED.symbol,
        decimals = EXCLUDED.decimals,
        logo_uri = EXCLUDED.logo_uri,
        thumbnail_uri = EXCLUDED.thumbnail_uri,
        possible_spam = EXCLUDED.possible_spam,
        source = EXCLUDED.source,
        fetched_at = now(),
        updated_at = now()
    `;
    return 'enabled' as const;
  } catch {
    return 'error' as const;
  }
}

async function moralisFetch(url: string, init: RequestInit = {}) {
  const key = process.env.MORALIS_API_KEY;
  if (!key) throw new Error('Missing MORALIS_API_KEY');
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'X-API-Key': key,
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Moralis error ${res.status}: ${txt}`);
  }
  return res.json();
}

async function fetchMoralisMetadata(chainId: number, address: string): Promise<{
  token: Token;
  thumbnailUri?: string | null;
  possibleSpam?: boolean | null;
}> {
  const meta = getChainMeta(chainId);
  if (!meta.moralisChain) throw new Error('Moralis metadata is not configured for this chain.');
  const base = process.env.MORALIS_BASE_URL || 'https://deep-index.moralis.io/api/v2.2';
  const url = `${base.replace(/\/$/, '')}/erc20/metadata?chain=${encodeURIComponent(
    meta.moralisChain
  )}&addresses%5B0%5D=${encodeURIComponent(address)}`;
  const data: MoralisMetadata[] = await moralisFetch(url);
  const item = data?.[0];

  if (!item?.address) {
    throw new Error('Token metadata was not found on Moralis.');
  }

  const checksum = toChecksumAddress(item.address) || toChecksumAddress(address);
  if (!checksum) throw new Error('Moralis returned an invalid token address.');

  const decimals = Number(item.decimals ?? 18);
  const symbol = String(item.symbol || '').trim();
  const name = String(item.name || '').trim();

  if (!symbol || !name || !Number.isFinite(decimals)) {
    throw new Error('Moralis returned incomplete token metadata.');
  }

  return {
    token: {
      chainId,
      address: checksum,
      name,
      symbol: symbol.slice(0, 32),
      decimals,
      logoURI: item.logo || item.thumbnail || undefined,
    },
    thumbnailUri: item.thumbnail ?? null,
    possibleSpam: item.possible_spam ?? null,
  };
}

export async function getTokenMetadata(chainId: number, addressInput: string): Promise<TokenMetadataResult> {
  const normalized = normalizeTokenAddressForChain(chainId, addressInput);
  if (!normalized) throw new Error('Invalid address');
  const normalizedKey = addressCacheKey(chainId, normalized);

  const meta = getChainMeta(chainId);
  if (normalizedKey === addressCacheKey(chainId, meta.nativeTokenAddress) || isNativeAddress(normalizedKey)) {
    return {
      token: localNativeToken(chainId),
      source: 'local-native',
      dbCache: isDatabaseConfigured() ? 'enabled' : 'disabled',
    };
  }

  const memoryKey = `tokenMeta:${chainId}:${normalizedKey}`;
  const memoryHit = cacheGet<Token>(memoryKey);
  if (memoryHit) {
    return {
      token: memoryHit,
      source: 'memory',
      dbCache: isDatabaseConfigured() ? 'enabled' : 'disabled',
    };
  }

  const dbHit = await getDbToken(chainId, normalizedKey);
  const row = dbHit.row;
  const rowAge = row ? Date.now() - new Date(row.fetched_at).getTime() : Number.POSITIVE_INFINITY;
  if (row && rowAge < METADATA_TTL_MS) {
    const token = tokenFromRow(row);
    cacheSet(memoryKey, token, MEMORY_TTL_MS);
    return { token, source: 'neon', dbCache: dbHit.dbCache };
  }

  if (meta.chainType !== 'EVM') {
    try {
      const lifiToken = await findLifiToken(chainId, normalized);
      if (!lifiToken) throw new Error('Token metadata was not found on LI.FI.');
      const dbCache = await upsertDbToken(lifiToken, 'lifi');
      cacheSet(memoryKey, lifiToken, MEMORY_TTL_MS);
      return { token: lifiToken, source: 'lifi', dbCache };
    } catch (e) {
      if (row) {
        const token = tokenFromRow(row);
        cacheSet(memoryKey, token, 15 * 60 * 1000);
        return { token, source: 'neon-stale', dbCache: dbHit.dbCache };
      }
      throw e;
    }
  }

  try {
    const moralis = await fetchMoralisMetadata(chainId, normalizedKey);
    const dbCache = await upsertDbToken(moralis.token, 'moralis', moralis.thumbnailUri, moralis.possibleSpam);
    cacheSet(memoryKey, moralis.token, MEMORY_TTL_MS);
    return { token: moralis.token, source: 'moralis', dbCache };
  } catch (e) {
    if (row) {
      const token = tokenFromRow(row);
      cacheSet(memoryKey, token, 15 * 60 * 1000);
      return { token, source: 'neon-stale', dbCache: dbHit.dbCache };
    }
    throw e;
  }
}
