import type { Token } from '@/lib/types';
import { getChainMeta } from '@/lib/chainsMeta';
import { normalizeTokenAddressForChain } from '@/lib/addresses';
import { cacheGet, cacheSet } from '@/lib/server/cache';

const LIFI_BASE = process.env.LIFI_BASE_URL || 'https://li.quest';
const INTEGRATOR = process.env.LIFI_INTEGRATOR || 'swapdex-starter';
const TOKEN_LIST_TTL_MS = 15 * 60 * 1000;

function normalizeToken(t: any, chainId: number): Token | null {
  const address = normalizeTokenAddressForChain(chainId, String(t?.address || ''));
  if (!address) return null;

  const symbol = String(t?.symbol || '').trim();
  const name = String(t?.name || '').trim();
  const decimals = Number(t?.decimals ?? 18);
  if (!symbol || !name || !Number.isFinite(decimals)) return null;

  return {
    chainId,
    address,
    symbol: symbol.slice(0, 32),
    name: name.slice(0, 96),
    decimals,
    logoURI: t?.logoURI ? String(t.logoURI).trim() : undefined,
    coinKey: t?.coinKey ? String(t.coinKey) : undefined,
    priceUSD: t?.priceUSD ? String(t.priceUSD) : undefined,
  };
}

export async function getLifiTokenList(chainId: number): Promise<Token[]> {
  const meta = getChainMeta(chainId);
  const cacheKey = `lifiTokens:${chainId}`;
  const cached = cacheGet<Token[]>(cacheKey);
  if (cached) return cached;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;

  const r = await fetch(`${LIFI_BASE}/v1/tokens?chains=${chainId}&integrator=${encodeURIComponent(INTEGRATOR)}`, {
    headers,
    cache: 'no-store',
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(json?.message || json?.error || `LI.FI tokens error ${r.status}`);

  const byChain = (json?.tokens && json.tokens[String(chainId)]) || json?.tokens?.[chainId] || json?.tokens;
  const tokens = (Array.isArray(byChain) ? byChain : [])
    .map((item: any) => normalizeToken(item, chainId))
    .filter(Boolean) as Token[];

  if (!tokens.some((token) => String(token.address).toLowerCase() === meta.nativeTokenAddress.toLowerCase())) {
    tokens.unshift({
      chainId,
      address: meta.nativeTokenAddress,
      symbol: meta.nativeSymbol,
      name: meta.nativeSymbol,
      decimals: meta.nativeDecimals,
      logoURI: meta.logoUrl,
    });
  }

  cacheSet(cacheKey, tokens, TOKEN_LIST_TTL_MS);
  return tokens;
}

export async function findLifiToken(chainId: number, address: string): Promise<Token | null> {
  const normalized = normalizeTokenAddressForChain(chainId, address);
  if (!normalized) return null;
  const tokens = await getLifiTokenList(chainId);
  return tokens.find((token) => String(token.address).toLowerCase() === normalized.toLowerCase()) || null;
}
