import { formatUnits } from 'viem';
import type { MinAmountHint, QuoteRequest, RouterId } from '@/lib/types';
import { cacheGet, cacheSet } from '@/lib/server/cache';
import { isEvmChain } from '@/lib/chainsMeta';

const LIFI_BASE = process.env.LIFI_BASE_URL || 'https://li.quest';
const INTEGRATOR = process.env.LIFI_INTEGRATOR || 'swapdex-starter';

async function fetchWithTimeout(input: string, init: RequestInit, ms = 3500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// 1inch hosts differ (public vs business). To avoid 404s, detect optional "/swap" prefix once and cache it.
// NOTE: cache values are '' or '/swap'. Missing key => undefined.
const ONEINCH_PREFIX_CACHE: Partial<Record<string, '' | '/swap'>> = {};

async function oneInchFetch(
  base: string,
  path: string,
  init: RequestInit,
  timeoutMs = 3500,
): Promise<Response> {
  const cached = ONEINCH_PREFIX_CACHE[base];
  const prefixes: Array<'' | '/swap'> =
    cached !== undefined ? [cached, cached === '' ? '/swap' : ''] : ['', '/swap'];

  let last: Response | null = null;
  for (const pref of prefixes) {
    const url = `${base}${pref}${path}`;
    const r = await fetchWithTimeout(url, init, timeoutMs);
    last = r;
    if (r.status === 404) continue;
    ONEINCH_PREFIX_CACHE[base] = pref;
    return r;
  }
  return last as Response;
}


async function readJsonSafely(res: Response): Promise<{ json: any | null; text: string }> {
  const text = await res.text().catch(() => '');
  if (!text) return { json: null, text: '' };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

type LifiTools = {
  exchanges?: Array<{ key: string; name?: string; supportedChains?: Array<string | number> }>;
  bridges?: any[];
};

async function getLifiTools(): Promise<LifiTools> {
  const cached = cacheGet<LifiTools>('lifi:tools:v1');
  if (cached) return cached;

  const r = await fetchWithTimeout(`${LIFI_BASE}/v1/tools`, { headers: { accept: 'application/json' }, cache: 'no-store' }, 6500);
  const { json } = await readJsonSafely(r);

  const tools = (json || {}) as LifiTools;
  if (r.ok && tools) {
    cacheSet('lifi:tools:v1', tools, 60 * 60 * 1000); // 1h
    return tools;
  }
  return { exchanges: [], bridges: [] };
}

function chainIdToString(x: any): string {
  try {
    return String(x);
  } catch {
    return '';
  }
}

async function resolveExchangeKeyByName(partialName: string, chainId: number): Promise<string | null> {
  const cacheKey = `lifi:exchangeKey:${partialName.toLowerCase()}:${chainId}`;
  const hit = cacheGet<string>(cacheKey);
  if (hit) return hit;

  const tools = await getLifiTools();
  const exchanges = Array.isArray(tools?.exchanges) ? tools.exchanges : [];

  const want = partialName.toLowerCase();
  const chain = String(chainId);

  const match = exchanges.find((e: any) => {
    const n = String(e?.name || '').toLowerCase();
    if (!n.includes(want)) return false;
    const sc = Array.isArray(e?.supportedChains) ? e.supportedChains.map(chainIdToString) : [];
    return sc.length ? sc.includes(chain) : true;
  });

  const key = match?.key ? String(match.key) : null;
  if (key) cacheSet(cacheKey, key, 6 * 60 * 60 * 1000); // 6h
  return key;
}

function formatTokenUnits(amount: bigint, decimals: number, maxDp = 8): string {
  try {
    const s = formatUnits(amount, decimals);
    if (!s.includes('.')) return s;
    const [i, f] = s.split('.');
    const ff = (f || '').slice(0, maxDp).replace(/0+$/, '');
    return ff ? `${i}.${ff}` : i;
  } catch {
    return '0';
  }
}

function amountUsd(amount: bigint, decimals: number, priceUSD?: string): string | undefined {
  const p = Number(priceUSD || 0);
  if (!Number.isFinite(p) || p <= 0) return undefined;
  const a = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(a) || a <= 0) return undefined;
  const usd = a * p;
  if (!Number.isFinite(usd) || usd <= 0) return undefined;
  const s = usd < 0.01 ? usd.toFixed(6) : usd.toFixed(4);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function minCacheKey(body: QuoteRequest): string {
  return `min:${String(body.router)}:${body.fromChainId}:${body.toChainId}:${String(body.fromToken.address).toLowerCase()}:${String(
    body.toToken.address,
  ).toLowerCase()}`;
}

export function getCachedMinAmountHint(body: QuoteRequest): MinAmountHint | null {
  return cacheGet<MinAmountHint>(minCacheKey(body));
}

async function lifiQuoteOk(body: QuoteRequest, headers: Record<string, string>, fromAmount: bigint): Promise<boolean> {
  const slippage = Number(body.slippage);

  const router = body.router;

  // Route capability guards
  // - gaszip: cross-chain only
  if (router === 'gaszip' && body.fromChainId === body.toChainId) return false;

  const params = new URLSearchParams({
    fromChain: String(body.fromChainId),
    toChain: String(body.toChainId),
    fromToken: String(body.fromToken.address),
    toToken: String(body.toToken.address),
    fromAmount: String(fromAmount),
    fromAddress: String(body.fromAddress),
    toAddress: String(body.toAddress),
    slippage: String(slippage),
    integrator: INTEGRATOR,
  });

  const allowBridges = router === 'gaszip' ? 'gasZipBridge' : null;

  if (allowBridges) params.set('allowBridges', allowBridges);

  const r = await fetchWithTimeout(`${LIFI_BASE}/v1/quote?${params.toString()}`, { headers, cache: 'no-store' });
  const { json } = await readJsonSafely(r);
  if (!r.ok || !json) return false;
  try {
    const toAmt = BigInt(String(json?.estimate?.toAmount || '0'));
    return toAmt > 0n;
  } catch {
    return false;
  }
}

async function oneInchQuoteOk(body: QuoteRequest, fromAmount: bigint, timeoutMs = 3500): Promise<boolean> {
  if (body.fromChainId !== body.toChainId || !isEvmChain(body.fromChainId)) return false;

  const base =
    process.env.ONEINCH_BASE_URL || (process.env.ONEINCH_API_KEY ? 'https://api.1inch.dev' : 'https://api.1inch.io');
  const chainId = body.fromChainId;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.ONEINCH_API_KEY) headers['Authorization'] = `Bearer ${process.env.ONEINCH_API_KEY}`;

  const qs = new URLSearchParams({
    src: String(body.fromToken.address),
    dst: String(body.toToken.address),
    amount: String(fromAmount),
    includeGas: 'false',
  });

  const r = await oneInchFetch(base, `/v6.1/${chainId}/quote?${qs.toString()}`, { headers, cache: 'no-store' }, timeoutMs);
  const { json } = await readJsonSafely(r);
  if (!r.ok || !json) return false;

  try {
    const toAmt = BigInt(String((json as any)?.dstAmount || '0'));
    return toAmt > 0n;
  } catch {
    return false;
  }
}


function isOneInch(router: RouterId): boolean {
  return String(router).startsWith('oneinch');
}

function canUseOneInch(body: QuoteRequest): boolean {
  return isOneInch(body.router) && body.fromChainId === body.toChainId && isEvmChain(body.fromChainId);
}

export async function computeMinAmountHint(body: QuoteRequest): Promise<MinAmountHint | null> {
  const cacheKey = minCacheKey(body);
  const cached = cacheGet<MinAmountHint>(cacheKey);
  if (cached) return cached;

  let start: bigint;
  try {
    start = BigInt(body.fromAmount || '0');
  } catch {
    return null;
  }
  if (start <= 0n) return null;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;

  const ok = (x: bigint) => (canUseOneInch(body) ? oneInchQuoteOk(body, x) : lifiQuoteOk(body, headers, x));

  // Exponential search for an amount that yields a quote.
  const candidates: bigint[] = [];
  let a = start;
  for (let i = 0; i < 8; i++) {
    candidates.push(a);
    a = a * 10n;
  }

  const results = await Promise.all(
    candidates.map(async (x) => {
      try {
        return await ok(x);
      } catch {
        return false;
      }
    }),
  );

  const idx = results.findIndex(Boolean);
  if (idx === -1) return null;

  let lo = idx === 0 ? start : candidates[idx - 1];
  let hi = candidates[idx];

  // Binary search in (lo, hi] for the smallest amount that yields a quote.
  const MAX_BIN = 6;
  for (let i = 0; i < MAX_BIN; i++) {
    const mid = (lo + hi) / 2n;
    const m = mid <= lo ? lo + 1n : mid;
    if (m >= hi) break;
    if (await ok(m)) hi = m;
    else lo = m;
  }

  const hint: MinAmountHint = {
    fromAmount: hi.toString(),
    fromAmountFormatted: formatTokenUnits(hi, body.fromToken.decimals, 8),
    ...(amountUsd(hi, body.fromToken.decimals, body.fromToken.priceUSD)
      ? { fromAmountUSD: amountUsd(hi, body.fromToken.decimals, body.fromToken.priceUSD) }
      : {}),
  };

  cacheSet(cacheKey, hint, 120_000);
  return hint;
}
