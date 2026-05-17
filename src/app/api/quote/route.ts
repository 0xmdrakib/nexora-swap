import { NextResponse } from 'next/server';
import { formatUnits, parseUnits, getAddress, isAddress } from 'viem';
import type { QuoteErrorReason, QuoteRequest, QuoteResponse, RouterId } from '@/lib/types';
import { getCachedMinAmountHint } from '@/lib/server/minAmount';
import { cacheGet, cacheSet } from '@/lib/server/cache';
import { getChainMeta, isEvmChain } from '@/lib/chainsMeta';
import { normalizeWalletAddressForChain } from '@/lib/addresses';

const LIFI_BASE = process.env.LIFI_BASE_URL || 'https://li.quest';
const INTEGRATOR = process.env.LIFI_INTEGRATOR || 'swapdex-starter';

// 1inch represents native assets using a special sentinel address.
// Nexora's internal token model uses 0x000.. for native tokens, so we must map it for 1inch.
// (See 1inch swagger examples for src/dst.)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ONEINCH_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Convert an unknown value into a checksummed EVM address (0x...).
 * We keep `strict: false` so we accept non-checksummed upstream addresses.
 */
function toSafeAddress(value: unknown): `0x${string}` | undefined {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return undefined;
  // LI.FI / 1inch may return lowercased addresses.
  if (!isAddress(s, { strict: false })) return undefined;
  return getAddress(s);
}

function toOneInchTokenAddress(addr: string): string {
  const a = String(addr || '').trim();
  if (!a) return ONEINCH_NATIVE;
  if (a.toLowerCase() === ZERO_ADDRESS) return ONEINCH_NATIVE;
  if (a.toLowerCase() === ONEINCH_NATIVE.toLowerCase()) return ONEINCH_NATIVE;
  return a;
}

function isOneInchSupportedForBody(body: QuoteRequest) {
  return body.fromChainId === body.toChainId && isEvmChain(body.fromChainId);
}

function validateQuoteAddresses(body: QuoteRequest): string | null {
  try {
    getChainMeta(body.fromChainId);
    getChainMeta(body.toChainId);
  } catch {
    return 'Unsupported chain id';
  }

  if (!normalizeWalletAddressForChain(body.fromChainId, body.fromAddress)) {
    return `Invalid ${getChainMeta(body.fromChainId).name} from address`;
  }
  if (!normalizeWalletAddressForChain(body.toChainId, body.toAddress)) {
    return `Invalid ${getChainMeta(body.toChainId).name} recipient address`;
  }
  return null;
}

type QuoteApiError = Error & { status?: number; payload?: any | null; text?: string };

async function fetchWithTimeout(input: string, init: RequestInit, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError' || /aborted/i.test(e?.message || '')) {
      throw makeQuoteApiError('Quote request timed out', 504, { reason: 'TIMEOUT' }, '');
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// 1inch hosts differ:
// - Public: https://api.1inch.io  (paths like /v6.1/{chainId}/quote)
// - Business: https://api.1inch.dev (some setups historically used /swap/v6.1/{chainId}/quote)
//
// To avoid 404s, we auto-detect whether the host needs the optional "/swap" prefix and cache it.
// Prefix cache: some deployments mount 1inch routes under "/swap" while others don't.
// Use a Partial record so missing keys are correctly typed as undefined.
const ONEINCH_PREFIX_CACHE: Partial<Record<string, '' | '/swap'>> = {};

function getOneInchAuthorizationHeader(): string | null {
  // Some guides store the *whole* header value as env ("Bearer <token>").
  // Others store just the token. Support both safely.
  const raw = (process.env.ONEINCH_AUTHORIZATION || process.env.ONEINCH_API_KEY || '').trim();
  if (!raw) return null;
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function isPublicOneInchHost(base: string): boolean {
  return /api\.1inch\.io\/?$/i.test(base.trim());
}

function buildOneInchHeaders(base: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    // Some edge/CDN layers behave better when a UA is present.
    'user-agent': 'NexoraSwap/1.0 (+https://nexora.app)',
  };

  // Public host usually doesn't need auth. Sending Authorization can sometimes trigger gateway/HTML responses.
  if (!isPublicOneInchHost(base)) {
    const auth = getOneInchAuthorizationHeader();
    if (auth) headers['Authorization'] = auth;
  }

  return headers;
}

function getOneInchBaseCandidates(): string[] {
  const explicit = (process.env.ONEINCH_BASE_URL || '').trim();
  const auth = getOneInchAuthorizationHeader();

  // If user explicitly set a base URL, respect it first.
  // Then fall back to public host as a robustness measure (dev UX), because
  // misconfigured base URLs often return HTML 200 pages (non-JSON).
  if (explicit) {
    const out = [explicit];
    if (!/api\.1inch\.io\/?$/i.test(explicit)) out.push('https://api.1inch.io');
    return out;
  }

  // Default: use Business host only when we have auth; otherwise public.
  return auth ? ['https://api.1inch.dev', 'https://api.1inch.io'] : ['https://api.1inch.io'];
}

async function oneInchFetch(
  base: string,
  path: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const cached = ONEINCH_PREFIX_CACHE[base];
  // NOTE: "" (no prefix) is a valid cached value but is falsy, so we must not
  // use a truthy check here.
  const prefixes: Array<'' | '/swap'> =
    cached !== undefined ? [cached, cached === '' ? '/swap' : ''] : ['', '/swap'];

  let last: Response | null = null;
  for (const pref of prefixes) {
    const url = `${base}${pref}${path}`;
    const r = timeoutMs ? await fetchWithTimeout(url, init, timeoutMs) : await fetch(url, init);
    last = r;
    if (r.status === 404) continue;
    ONEINCH_PREFIX_CACHE[base] = pref;
    return r;
  }
  return last as Response;
}


function isTimeoutError(e: any): boolean {
  // fetchWithTimeout throws a QuoteApiError on AbortError
  return (
    e?.status === 504 ||
    e?.payload?.reason === 'TIMEOUT' ||
    e?.name === 'AbortError' ||
    /timed out/i.test(String(e?.message || '')) ||
    /aborted/i.test(String(e?.message || ''))
  );
}

function usdToUnits(usd: number, priceUsd: number, decimals: number): bigint | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const tokens = usd / priceUsd;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  // toFixed avoids scientific notation, which breaks parseUnits.
  const dp = Math.min(18, Math.max(0, decimals));
  const s = tokens.toFixed(dp);
  try {
    return parseUnits(s, decimals);
  } catch {
    return null;
  }
}

function buildProbeAmounts(body: QuoteRequest, baseAmt: bigint): bigint[] {
  const out: bigint[] = [];
  // Multipliers cover cases where price is missing.
  const multA = baseAmt * 200n;
  const multB = baseAmt * 2000n;

  const price = Number(body.fromToken.priceUSD || 0);
  const u10 = usdToUnits(10, price, body.fromToken.decimals);
  const u30 = usdToUnits(30, price, body.fromToken.decimals);

  const p1 = [multA, u10].filter(Boolean) as bigint[];
  const p2 = [multB, u30].filter(Boolean) as bigint[];

  const probe1 = p1.length ? p1.reduce((a, b) => (a > b ? a : b)) : multA;
  const probe2 = p2.length ? p2.reduce((a, b) => (a > b ? a : b)) : multB;

  if (probe1 > baseAmt) out.push(probe1);
  if (probe2 > baseAmt) out.push(probe2);

  // Dedup + keep stable order.
  return [...new Set(out.map((x) => x.toString()))].map((s) => BigInt(s));
}

async function disambiguateNoQuote(
  body: QuoteRequest,
  baseAmt: bigint,
  okFn: (amt: bigint) => Promise<boolean>,
): Promise<QuoteErrorReason> {
  // Idea: "no quote" can mean MIN_AMOUNT or NO_LIQUIDITY. We probe a couple of
  // larger amounts (fast + parallel). If any larger amount works => MIN_AMOUNT.
  // If probes time out => treat as TIMEOUT (don't mislabel as liquidity).
  const probes = buildProbeAmounts(body, baseAmt);
  if (!probes.length) return 'NO_LIQUIDITY';

  const settled = await Promise.allSettled(probes.map((p) => okFn(p)));
  const anyOk = settled.some((x) => x.status === 'fulfilled' && x.value === true);
  if (anyOk) return 'MIN_AMOUNT';

  const anyTimeout = settled.some((x) => x.status === 'rejected' && isTimeoutError(x.reason));
  if (anyTimeout) return 'TIMEOUT';

  return 'NO_LIQUIDITY';
}

function makeQuoteApiError(message: string, status: number, payload: any | null, text: string): QuoteApiError {
  const err: QuoteApiError = new Error(message);
  err.status = status;
  err.payload = payload;
  err.text = text;
  return err;
}

function formatTokenUnits(amount: bigint, decimals: number, maxDp = 8): string {
  const raw = formatUnits(amount, decimals);
  const [i, f] = raw.split('.');
  if (!f) return raw;
  const trimmed = f.slice(0, maxDp).replace(/0+$/, '');
  return trimmed ? `${i}.${trimmed}` : i;
}

function amountUsd(amount: bigint, decimals: number, priceUSD?: string): string | undefined {
  const p = Number(priceUSD || 0);
  if (!Number.isFinite(p) || p <= 0) return undefined;
  const a = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(a) || a <= 0) return undefined;
  const usd = a * p;
  if (!Number.isFinite(usd)) return undefined;
  // Keep it short but not misleading.
  const s = usd < 0.01 ? usd.toFixed(6) : usd.toFixed(4);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function pickTool(router: RouterId): string | null {
  // This starter does NOT force LiFi tools yet (because the exact query params vary per route type).
  // We keep these placeholders for you to implement once you decide the exact LiFi options you want to use.
  switch (router) {
    case 'lifi-1inch':
      return '1inch';
    case 'lifi-uniswap':
      return 'uniswap';
    case 'lifi-pancake':
      return 'pancake';
    default:
      return null;
  }
}

function flattenProtocols(protocols: any): Array<{ name: string; part: number }> {
  const out: Array<{ name: string; part: number }> = [];
  const seen = new Map<string, number>();

  const walk = (x: any) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object' && x.name && typeof x.part === 'number') {
      const name = String(x.name);
      const part = Number(x.part);
      seen.set(name, (seen.get(name) || 0) + part);
    } else if (x && typeof x === 'object') {
      Object.values(x).forEach(walk);
    }
  };

  walk(protocols);

  for (const [name, part] of seen.entries()) out.push({ name, part });
  out.sort((a, b) => b.part - a.part);
  return out.slice(0, 6);
}

function gasUsdFromLiFi(step: any): string | undefined {
  const costs = step?.estimate?.gasCosts;
  if (!Array.isArray(costs) || !costs.length) return undefined;
  // LiFi returns a list of gas cost objects with amountUSD strings.
  const sum = costs.reduce((acc: number, c: any) => acc + Number(c?.amountUSD || 0), 0);
  if (!Number.isFinite(sum)) return undefined;
  return sum.toFixed(4);
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

function lifiHumanError(status: number, payload: any | null, text: string): string {
  const p = payload as any;
  const msg: string =
    String(
      p?.message ||
        p?.error ||
        p?.description ||
        (typeof p === 'string' ? p : '') ||
        text ||
        `LI.FI error ${status}`,
    ) || `LI.FI error ${status}`;

  // Common LI.FI quote failures: no route/no quote.
  // Example payloads include: { message: 'No available quotes for the requested transfer', code: 1002, ... }
  // and/or nested errors with { errorType: 'NO_QUOTE', ... }.
  const msgLc = msg.toLowerCase();
  const code = Number(p?.code);

  const hasNoQuote =
    code === 1002 ||
    p?.errorType === 'NO_QUOTE' ||
    msgLc.includes('no available quotes') ||
    msgLc.includes('no quote') ||
    msgLc.includes('no route') ||
    JSON.stringify(p || {}).toLowerCase().includes('"errorType":"no_quote"'.toLowerCase());

  // Don't collapse this into "liquidity" here — we disambiguate later with a probe.
  if (hasNoQuote) return 'No route found for this pair.';

  // Amount too low / min amount cases.
  if (msgLc.includes('amount too low') || msgLc.includes('too low') || msgLc.includes('min amount')) {
    return 'Amount too low for this pair.';
  }

  // Keep anything else short.
  return msg.slice(0, 280);
}

function oneInchHumanError(status: number, payload: any | null, text: string): string {
  // 1inch errors are sometimes JSON, sometimes empty, sometimes a plain string.
  const p = payload as any;
  const msg =
    p?.description || p?.error || p?.message || (typeof p === 'string' ? p : null) || text || `1inch error ${status}`;
  // Keep it short (UI-friendly)
  return String(msg).slice(0, 280);
}

function isUnfixableForBiggerAmount(s: string) {
  return (
    s.includes('buy or sell tax') ||
    s.includes('tax above acceptable threshold') ||
    s.includes('fee on transfer') ||
    s.includes('transfer fee')
  );
}

function isMinAmountLike(s: string) {
  return (
    s.includes('amount too low') ||
    s.includes('too low') ||
    s.includes('min amount') ||
    s.includes('minimum amount') ||
    s.includes('below the minimum') ||
    s.includes('return amount is not enough') ||
    s.includes('insufficient input')
  );
}

function isNoQuoteLike(s: string) {
  return (
    s.includes('no available quotes') ||
    s.includes('no route') ||
    s.includes('no quote') ||
    s.includes('no_quote') ||
    s.includes('no routes found')
  );
}

function baseReason(raw: string, human: string): QuoteErrorReason {
  const s = `${raw} ${human}`.toLowerCase();
  if (s.includes('timed out') || s.includes('timeout') || s.includes('time out')) return 'TIMEOUT';
  if (isMinAmountLike(s)) return 'MIN_AMOUNT';
  if (isUnfixableForBiggerAmount(s)) return 'NO_LIQUIDITY';
  if (isNoQuoteLike(s) || s.includes('liquidity')) return 'NO_LIQUIDITY';
  return 'OTHER';
}

function normalizeQuoteError(reason: QuoteErrorReason, fallback: string): string {
  if (reason === 'MIN_AMOUNT') return 'Amount too low for this pair.';
  if (reason === 'NO_LIQUIDITY') return 'Liquidity not found for this pair.';
  if (reason === 'TIMEOUT') return 'Network is slow. Please try again.';
  return String(fallback || 'Quote failed').slice(0, 280);
}

async function oneInchQuoteOk(
  body: QuoteRequest,
  fromAmount: bigint,
  timeoutMs = 2500,
): Promise<boolean> {
  if (!isOneInchSupportedForBody(body)) return false;

  const bases = getOneInchBaseCandidates();
  const chainId = body.fromChainId;

  const qs = new URLSearchParams({
    // 1inch v6.1 expects src/dst (see swagger)
    src: toOneInchTokenAddress(body.fromToken.address),
    dst: toOneInchTokenAddress(body.toToken.address),
    amount: String(fromAmount),
    includeGas: 'true',
    includeTokensInfo: 'false',
  });

  for (const base of bases) {
    const headers = buildOneInchHeaders(base);
    const r = await oneInchFetch(
      base,
      `/v6.1/${chainId}/quote?${qs.toString()}`,
      { headers, cache: 'no-store' },
      timeoutMs,
    );
    const { json } = await readJsonSafely(r);
    if (!r.ok || !json) continue;
    try {
      const toAmt = BigInt(String((json as any)?.dstAmount || '0'));
      if (toAmt > 0n) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

async function lifiQuoteOk(
  body: QuoteRequest,
  headers: Record<string, string>,
  fromAmount: bigint,
  timeoutMs = 2500,
): Promise<boolean> {
  const s = Number(body.slippage);
  const slippage = Number.isFinite(s) ? Math.max(0.0001, Math.min(0.2, s)) : 0.005;

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

  const r = await fetchWithTimeout(
    `${LIFI_BASE}/v1/quote?${params.toString()}`,
    { headers, cache: 'no-store' },
    timeoutMs,
  );
  const { json } = await readJsonSafely(r);
  if (!r.ok || !json) return false;
  try {
    const toAmt = BigInt(String(json?.estimate?.toAmount || '0'));
    return toAmt > 0n;
  } catch {
    return false;
  }
}

async function oneInchQuote(body: QuoteRequest): Promise<QuoteResponse> {
  // 1inch is same-chain only.
  if (!isOneInchSupportedForBody(body)) {
    throw new Error('1inch Direct only supports same-chain EVM swaps. Use LiFi for Solana or cross-chain routes.');
  }

  const bases = getOneInchBaseCandidates();
  const chainId = body.fromChainId;

  // 1inch expects slippage in percent.
  // Our client sends slippage as a *fraction* (e.g. 0.005 means 0.5%).
  const rawSlip = Number(body.slippage);
  const slipPct = Number.isFinite(rawSlip) ? rawSlip * 100 : 0.5;
  const slippagePct = Math.max(0.01, Math.min(50, slipPct));

  const authHeader = getOneInchAuthorizationHeader();

  const qs = new URLSearchParams({
    // 1inch v6.1 expects src/dst (see swagger)
    src: toOneInchTokenAddress(body.fromToken.address),
    dst: toOneInchTokenAddress(body.toToken.address),
    amount: String(body.fromAmount),
    from: String(body.fromAddress),
    origin: String(body.fromAddress),
    receiver: String(body.toAddress),
    slippage: String(slippagePct),
    includeGas: 'true',
    includeProtocols: 'true',
    // Avoid server-side onchain simulation checks (balance/allowance heuristics can be noisy).
    // We'll handle "insufficient balance" UX in the client before letting the user send the tx.
    disableEstimate: 'true',
  });

  let lastNonJsonHint = '';
  // NOTE: Keep this type explicit AND avoid mutating `bestErr` via a captured
  // closure (TS control-flow analysis can decide the value never changes and
  // narrow it to `null`, making `if (bestErr)` unreachable and turning it into
  // `never` during `next build` typecheck).
  type OneInchBestErr = {
    status: number;
    payload: any | null;
    text: string;
    base: string;
    contentType: string;
  };

  const scoreOneInchErr = (e: OneInchBestErr) => {
    const hasJson = !!e.payload;
    // Prefer actionable JSON errors, then 400s (liquidity/min) over auth errors.
    let s = 0;
    if (hasJson) s += 10;
    if (e.status === 400) s += 5;
    if (e.status === 401 || e.status === 403) s += 3;
    if (e.status === 429) s += 2;
    if (e.status >= 500) s += 1;
    return s;
  };

  const pickBestOneInchErr = (best: OneInchBestErr | null, cur: OneInchBestErr) =>
    !best || scoreOneInchErr(cur) >= scoreOneInchErr(best) ? cur : best;

  let bestErr: OneInchBestErr | null = null;

  let approvalAddress: string | undefined;
  for (const base of bases) {
    const headers = buildOneInchHeaders(base);
    // Spender (for approvals) - best effort per base
    approvalAddress = undefined;
    try {
      const sr = await oneInchFetch(base, `/v6.1/${chainId}/approve/spender`, { headers, cache: 'no-store' }, 2500);
      const { json: sj } = await readJsonSafely(sr);
      if (sr.ok && sj?.address) approvalAddress = String(sj.address);
    } catch {
      // ignore
    }

    const r = await oneInchFetch(
      base,
      `/v6.1/${chainId}/swap?${qs.toString()}`,
      { headers, cache: 'no-store' },
      4500,
    );
    const { json, text } = await readJsonSafely(r);
    const ct = r.headers.get('content-type') || '';

    if (!r.ok) {
      // Preserve JSON error payloads so the caller can classify (min amount vs no liquidity).
      bestErr = pickBestOneInchErr(bestErr, { status: r.status, payload: json, text, base, contentType: ct });
      lastNonJsonHint = `status=${r.status} base=${base} content-type=${ct || 'unknown'}`;
      continue;
    }

    if (!json) {
      // Often indicates HTML (wrong base url), or an auth gateway page.
      const preview = (text || '').slice(0, 120).replace(/\s+/g, ' ');
      bestErr = pickBestOneInchErr(bestErr, { status: r.status, payload: null, text, base, contentType: ct });
      lastNonJsonHint = `base=${base} content-type=${ct || 'unknown'} preview=${preview || '(empty)'}`;
      continue;
    }

    // Success
    const toAmount = String((json as any)?.dstAmount || '0');

    // UI-friendly "minimum received" (router estimate minus user slippage)
    let toAmountMin: string | undefined;
    try {
      // Convert percent => basis points (bps): 1% = 100 bps
      const bps = BigInt(Math.round(slippagePct * 100));
      const factor = 10000n - bps;
      toAmountMin = (BigInt(toAmount) * factor / 10000n).toString();
    } catch {
      // ignore
    }

    // Summarize route/protocols for UI (best-effort)
    let routes: Array<{ name: string; part: number }> | undefined;
    try {
      const prot = (json as any)?.protocols;
      if (Array.isArray(prot)) {
        const flat: Array<{ name: string; part: number }> = [];
        for (const tokenSwap of prot) {
          const hops = Array.isArray(tokenSwap?.hops) ? tokenSwap.hops : [];
          for (const hop of hops) {
            const ps = Array.isArray(hop?.protocols) ? hop.protocols : [];
            for (const p of ps) {
              if (p?.name) flat.push({ name: String(p.name), part: Number(p.part || 0) });
            }
          }
        }
        routes = flat.slice(0, 8);
      }
    } catch {
      // ignore
    }


    const txToRaw = (json as any)?.tx?.to ? String((json as any).tx.to) : '';
    const txTo = isAddress(txToRaw, { strict: false }) ? (getAddress(txToRaw) as any) : undefined;

    const out: QuoteResponse = {
      router: body.router,
      tool: '1inch',
      estimate: {
        fromAmount: String(body.fromAmount),
        toAmount,
        toAmountMin,
        approvalAddress: approvalAddress as any,
        routes,
      },
      tx:
        (json as any)?.tx && txTo
          ? {
              chainId,
              to: txTo,
              data: (json as any).tx.data ? String((json as any).tx.data) : undefined,
              value: (json as any).tx.value ? String((json as any).tx.value) : undefined,
            }
          : undefined,
      raw: json,
    };
    return out;
  }

  // If we reach here, nothing worked.
  if (bestErr !== null) {
    const e = bestErr;
    throw makeQuoteApiError(oneInchHumanError(e.status, e.payload, e.text), e.status, e.payload, e.text);
  }

  const authHint = authHeader
    ? 'Auth header is set. If your env already includes "Bearer ", use ONEINCH_AUTHORIZATION instead of ONEINCH_API_KEY to avoid "Bearer Bearer".'
    : 'No auth header found. If you intend to use api.1inch.dev, set ONEINCH_API_KEY (token) or ONEINCH_AUTHORIZATION (Bearer <token>).';
  throw new Error(
    `1inch did not return JSON (${lastNonJsonHint || 'no response details'}). ` +
      `Check ONEINCH_BASE_URL (should be https://api.1inch.dev or https://api.1inch.io) and keys. ${authHint}`,
  );
}

export async function POST(req: Request) {
  let body: QuoteRequest;
  try {
    body = (await req.json()) as QuoteRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body?.fromChainId || !body?.toChainId) return NextResponse.json({ error: 'Missing chain ids' }, { status: 400 });
  if (!body?.fromToken?.address || !body?.toToken?.address)
    return NextResponse.json({ error: 'Missing token addresses' }, { status: 400 });
  if (!body?.fromAmount || body.fromAmount === '0') return NextResponse.json({ error: 'Missing amount' }, { status: 400 });
  if (!body?.fromAddress || !body?.toAddress) return NextResponse.json({ error: 'Missing addresses' }, { status: 400 });

  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;

  // Router dispatch
  // - LiFi: cross-chain + same-chain
  // - 1inch direct: same-chain only (classic swap api)
  // - Auto (Option B): cross-chain => LiFi, same-chain => 1inch (fallback to LiFi if 1inch errors)
  // In auto mode we still probe 1inch even without a Business key, because
  // the public host (api.1inch.io) can return quotes/swaps for many chains.
  const addressError = validateQuoteAddresses(body);
  if (addressError) return NextResponse.json({ error: addressError, reason: 'OTHER' }, { status: 400 });

  if (body.router === 'auto' && isOneInchSupportedForBody(body)) {
    try {
      const out = await oneInchQuote({ ...body, router: 'oneinch-direct' });
      return NextResponse.json(out);
    } catch {
      // Fallback to LiFi.
    }
  }
  if (body.router === 'oneinch-direct') {
    if (!isOneInchSupportedForBody(body)) {
      return NextResponse.json(
        { error: '1inch Direct only supports same-chain EVM swaps. Use LiFi for Solana or cross-chain routes.', reason: 'OTHER' },
        { status: 400 },
      );
    }
    try {
      const out = await oneInchQuote(body);
      return NextResponse.json(out);
    } catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : 400;
      const raw = (e?.text || '') + (e?.payload ? ` ${JSON.stringify(e.payload)}` : '');
      const human = e?.message || '1inch quote failed';
      const s = `${raw} ${human}`.toLowerCase();

      let reason: QuoteErrorReason = baseReason(raw, human);

      // If we already know the pair's minimum from previous probes, classify instantly.
      const cachedMin = getCachedMinAmountHint(body);
      try {
        if (cachedMin && BigInt(body.fromAmount) < BigInt(cachedMin.fromAmount)) reason = 'MIN_AMOUNT';
      } catch {
        // ignore
      }

      // Disambiguate "no quote" (can mean MIN_AMOUNT or NO_LIQUIDITY) using fast parallel probes.
      // Key UX rule: never mislabel a timeout as "liquidity".
      try {
        let inputUsdNum: number | undefined;
        const usdStr = amountUsd(BigInt(body.fromAmount), body.fromToken.decimals, body.fromToken.priceUSD);
        if (usdStr) inputUsdNum = Number(usdStr);

        const shouldDisambiguate = inputUsdNum == null || inputUsdNum < 50;
        if (reason === 'NO_LIQUIDITY' && isNoQuoteLike(s) && !isUnfixableForBiggerAmount(s) && shouldDisambiguate) {
          const baseAmt = BigInt(body.fromAmount);
          const dis = await disambiguateNoQuote(body, baseAmt, (p) => oneInchQuoteOk(body, p, 1800));
          reason = dis === 'MIN_AMOUNT' || dis === 'TIMEOUT' ? dis : reason;
        }
      } catch (e: any) {
        if (isTimeoutError(e)) reason = 'TIMEOUT';
      }

      const minAmount = reason === 'MIN_AMOUNT' ? cachedMin : null;
      const retryable = reason === 'NO_LIQUIDITY' && isNoQuoteLike(s) && !isUnfixableForBiggerAmount(s);
      return NextResponse.json(
        { error: normalizeQuoteError(reason, human), reason, retryable, ...(minAmount ? { minAmount } : {}) },
        { status: status >= 500 ? 502 : 400 },
      );
    }
  }

  const router = body.router as RouterId;
  const isCrossChain = body.fromChainId !== body.toChainId;

  // Router capability guards
  if (router === 'gaszip' && !isCrossChain) {
    return NextResponse.json(
      { error: 'gas.zip route is for cross-chain swaps only.', reason: 'OTHER' },
      { status: 400 },
    );
  }

  // Auto: prefer LiFi for cross-chain; you can extend this to benchmark multiple routers.
  // (For now, auto == LiFi Smart Routing.)
  const isLiFiFamily = String(router).startsWith('lifi') || router === 'auto' || router === 'gaszip';
  if (!isLiFiFamily) {
    return NextResponse.json({ error: 'Router not implemented in this starter.', reason: 'OTHER' }, { status: 400 });
  }

  const s = Number(body.slippage);
  const slippage = Number.isFinite(s) ? Math.max(0.0001, Math.min(0.2, s)) : 0.005;
  const tool = pickTool(router);

  const params = new URLSearchParams({
    fromChain: String(body.fromChainId),
    toChain: String(body.toChainId),
    fromToken: String(body.fromToken.address),
    toToken: String(body.toToken.address),
    fromAmount: String(body.fromAmount),
    fromAddress: String(body.fromAddress),
    toAddress: String(body.toAddress),
    slippage: String(slippage),
    integrator: INTEGRATOR,
  });


  // Tool forcing (best-effort):
  // - gaszip: force gasZipBridge as the bridge for cross-chain
  // - lifi-<dex>: force that DEX on LiFi (if supported)
  let allowExchanges: string | null =
    String(router).startsWith('lifi-') && router !== 'lifi-smart' && isEvmChain(body.fromChainId) ? tool : null;

  const allowBridges = router === 'gaszip' ? 'gasZipBridge' : null;

  if (allowExchanges) params.set('allowExchanges', allowExchanges);
  if (allowBridges) params.set('allowBridges', allowBridges);


  try {
    const r = await fetchWithTimeout(`${LIFI_BASE}/v1/quote?${params.toString()}`, { headers, cache: 'no-store' });
    const { json, text } = await readJsonSafely(r);

    if (!r.ok) {
      const raw = (text || '') + (json ? ` ${JSON.stringify(json)}` : '');
      const fallback = lifiHumanError(r.status, json, text);
      const s = `${raw} ${fallback}`.toLowerCase();

      let reason: QuoteErrorReason = baseReason(raw, fallback);

      // If we already know the pair's minimum from previous probes, classify instantly.
      const cachedMin = getCachedMinAmountHint(body);
      try {
        if (cachedMin && BigInt(body.fromAmount) < BigInt(cachedMin.fromAmount)) reason = 'MIN_AMOUNT';
      } catch {
        // ignore
      }

      // Disambiguate "no quote" (can mean MIN_AMOUNT or NO_LIQUIDITY) using fast parallel probes.
      // Key UX rule: never mislabel a timeout as "liquidity".
      try {
        let inputUsdNum: number | undefined;
        const usdStr = amountUsd(BigInt(body.fromAmount), body.fromToken.decimals, body.fromToken.priceUSD);
        if (usdStr) inputUsdNum = Number(usdStr);

        const shouldDisambiguate = inputUsdNum == null || inputUsdNum < 50;
        if (reason === 'NO_LIQUIDITY' && isNoQuoteLike(s) && !isUnfixableForBiggerAmount(s) && shouldDisambiguate) {
          const baseAmt = BigInt(body.fromAmount);
          const dis = await disambiguateNoQuote(body, baseAmt, (p) => lifiQuoteOk(body, headers, p, 1800));
          reason = dis === 'MIN_AMOUNT' || dis === 'TIMEOUT' ? dis : reason;
        }
      } catch (e: any) {
        if (isTimeoutError(e)) reason = 'TIMEOUT';
      }

      const minAmount = reason === 'MIN_AMOUNT' ? cachedMin : null;
      // Retry once when likely transient (LI.FI sometimes returns "internal error" / 5xx).
      const transient =
        r.status >= 500 ||
        s.includes('internal error') ||
        s.includes('internal server error') ||
        s.includes('temporarily') ||
        s.includes('timeout');
      const retryable =
        transient ||
        (reason === 'NO_LIQUIDITY' && isNoQuoteLike(s) && !isUnfixableForBiggerAmount(s));
      return NextResponse.json(
        { error: normalizeQuoteError(reason, fallback), reason, retryable, ...(minAmount ? { minAmount } : {}) },
        { status: r.status >= 500 ? 502 : 400 },
      );
    }
    if (!json) {
      return NextResponse.json({ error: 'LI.FI returned a non-JSON response.' }, { status: 502 });
    }

    const step = json;
    const protocols = step?.estimate?.data?.protocols;
    const routes = protocols ? flattenProtocols(protocols) : [];

    const txChainId = Number(step?.transactionRequest?.chainId || body.fromChainId);
    const isEvmTx = step?.transactionRequest && isEvmChain(txChainId);
    const txTo = isEvmTx ? toSafeAddress(step.transactionRequest.to) : undefined;
    if (isEvmTx && !txTo) {
      return NextResponse.json({ error: 'LI.FI returned an invalid transaction target address.' }, { status: 502 });
    }

    const out: QuoteResponse = {
      router: body.router,
      tool: step?.tool,
      estimate: {
        fromAmount: String(step?.estimate?.fromAmount || body.fromAmount),
        toAmount: String(step?.estimate?.toAmount || '0'),
        toAmountMin: step?.estimate?.toAmountMin ? String(step.estimate.toAmountMin) : undefined,
        approvalAddress: isEvmTx ? toSafeAddress(step?.estimate?.approvalAddress) : undefined,
        gasUSD: gasUsdFromLiFi(step),
        routes,
      },
      tx: step?.transactionRequest
        ? {
            chainId: txChainId,
            txType: isEvmTx ? 'evm' : 'solana',
            to: isEvmTx ? txTo : step.transactionRequest.to ? String(step.transactionRequest.to) : undefined,
            data: step.transactionRequest.data ? String(step.transactionRequest.data) : undefined,
            value: step.transactionRequest.value ? String(step.transactionRequest.value) : undefined,
          }
        : undefined,
      raw: step,
    };

    return NextResponse.json(out);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to fetch quote' }, { status: 500 });
  }
}
