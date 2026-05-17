import { NextResponse } from 'next/server';
import type { Token } from '@/lib/types';
import { getChainMeta } from '@/lib/chainsMeta';
import { normalizeTokenAddressForChain } from '@/lib/addresses';

const LIFI_BASE = process.env.LIFI_BASE_URL || 'https://li.quest';
const INTEGRATOR = process.env.LIFI_INTEGRATOR || 'swapdex-starter';

function normalizeToken(t: any, chainId: number): Token | null {
  if (!t) return null;
  const address = normalizeTokenAddressForChain(chainId, String(t.address || ''));
  if (!address) return null;

  return {
    chainId,
    address,
    symbol: String(t.symbol || '').slice(0, 32),
    name: String(t.name || '').slice(0, 64),
    decimals: Number(t.decimals ?? 18),
    logoURI: t.logoURI ? String(t.logoURI) : undefined,
    coinKey: t.coinKey ? String(t.coinKey) : undefined,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = Number(url.searchParams.get('chainId') || '0');
  const nativeOnly = url.searchParams.get('nativeOnly') === '1';
  if (!chainId) return new NextResponse('Missing chainId', { status: 400 });
  const meta = getChainMeta(chainId);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;

  try {
    // LiFi tokens endpoint: returns a map keyed by chainId for requested chains.
    const r = await fetch(`${LIFI_BASE}/v1/tokens?chains=${chainId}&integrator=${encodeURIComponent(INTEGRATOR)}`, {
      headers,
      cache: 'no-store',
    });

    const json = await r.json();
    if (!r.ok) return new NextResponse(JSON.stringify(json), { status: r.status });

    const byChain = (json?.tokens && json.tokens[String(chainId)]) || json?.tokens?.[chainId] || json?.tokens;
    const arr: any[] = Array.isArray(byChain) ? byChain : [];

    const tokens: Token[] = arr.map((t) => normalizeToken(t, chainId)).filter(Boolean) as Token[];

    // Always include the chain's native placeholder if missing.
    if (!tokens.some((t) => String(t.address).toLowerCase() === meta.nativeTokenAddress.toLowerCase())) {
      tokens.unshift({
        chainId,
        address: meta.nativeTokenAddress,
        symbol: json?.nativeToken?.symbol || meta.nativeSymbol,
        name: json?.nativeToken?.name || meta.nativeSymbol,
        decimals: Number(json?.nativeToken?.decimals || meta.nativeDecimals),
        logoURI: meta.logoUrl,
      });
    }

    if (nativeOnly) {
      const native =
        tokens.find((t) => String(t.address).toLowerCase() === meta.nativeTokenAddress.toLowerCase()) || null;
      return NextResponse.json({ token: native });
    }

    return NextResponse.json({ tokens });
  } catch (e: any) {
    return new NextResponse(e?.message || 'Failed to fetch tokens', { status: 500 });
  }
}
