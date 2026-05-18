'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Token } from '@/lib/types';
import { addressCacheKey, normalizeTokenAddressForChain } from '@/lib/addresses';

const LS_KEY = 'swapdex:customTokens:v1';
const REMOTE_CACHE = new Map<number, Token[]>();
const REMOTE_INFLIGHT = new Map<number, Promise<Token[]>>();

function readCustomTokens(): Token[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Token[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCustomTokens(tokens: Token[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY, JSON.stringify(tokens.slice(0, 200)));
}

export function useTokenList(chainId?: number) {
  const [remote, setRemote] = useState<Token[]>([]);
  const [custom, setCustom] = useState<Token[]>(() => readCustomTokens());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    setCustom(readCustomTokens());
  }, []);

  useEffect(() => {
    if (!chainId) return;
    let ignore = false;

    // Important: clear the previous chain's token list immediately so the UI doesn't
    // flash stale results when the user switches chains while the modal is open.
    setRemote([]);

    const cached = REMOTE_CACHE.get(chainId);
    if (cached) {
      setRemote(cached);
      setLoading(false);
      setError(null);
      return () => {
        ignore = true;
      };
    }

    setLoading(true);
    setError(null);

    const inflight =
      REMOTE_INFLIGHT.get(chainId) ||
      (async () => {
        const r = await fetch(`/api/tokens?chainId=${chainId}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(await r.text());
        const data = (await r.json()) as { tokens: Token[] };
        const tokens = data.tokens || [];
        REMOTE_CACHE.set(chainId, tokens);
        return tokens;
      })();

    REMOTE_INFLIGHT.set(chainId, inflight);

    inflight
      .then((tokens) => {
        if (ignore) return;
        setRemote(tokens);
      })
      .catch((e) => {
        if (ignore) return;
        setError(e?.message || 'Failed to load token list');
      })
      .finally(() => {
        if (ignore) return;
        setLoading(false);
        if (REMOTE_INFLIGHT.get(chainId) === inflight) REMOTE_INFLIGHT.delete(chainId);
      });

    return () => {
      ignore = true;
    };
  }, [chainId, refreshNonce]);

  // Allow other parts of the app (e.g., after a confirmed swap) to request a refresh.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function onRefresh(e: Event) {
      try {
        const ce = e as CustomEvent<any>;
        const ids: number[] | undefined = ce?.detail?.chainIds;
        if (!chainId) return;
        if (!ids || !Array.isArray(ids)) return;
        if (!ids.includes(chainId)) return;
        setRefreshNonce((x) => x + 1);
      } catch {
        // ignore
      }
    }
    window.addEventListener('swapdex:refreshTokens', onRefresh);
    return () => window.removeEventListener('swapdex:refreshTokens', onRefresh);
  }, [chainId]);

  const tokens = useMemo(() => {
    const list = [...remote, ...custom.filter((t) => t.chainId === chainId)];
    const map = new Map<string, Token>();
    for (const t of list) {
      const k = `${t.chainId}:${addressCacheKey(t.chainId, t.address)}`;
      if (!map.has(k)) map.set(k, t);
    }
    return Array.from(map.values());
  }, [remote, custom, chainId]);

  async function addCustomToken(address: string) {
    if (!chainId) throw new Error('Missing chainId');
    const addr = normalizeTokenAddressForChain(chainId, address);
    if (!addr) throw new Error('Invalid token address');

    // Fetch metadata (Moralis → on-chain fallback) from the server route.
    const res = await fetch(`/api/token-metadata?chainId=${chainId}&address=${addr}`, { cache: 'no-store' });
    const txt = await res.text();
    let json: any = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      // leave as null
    }
    if (!res.ok) {
      const msg = json?.error || txt || 'Failed to fetch token metadata';
      throw new Error(msg);
    }

    const t = json?.token as Token | undefined;
    if (!t?.address) throw new Error('Token metadata missing');

    setCustom((prev) => {
      const next = [...prev];
      const k = `${t.chainId}:${addressCacheKey(t.chainId, t.address)}`;
      const exists = next.some((x) => `${x.chainId}:${addressCacheKey(x.chainId, x.address)}` === k);
      const filtered = exists ? next.filter((x) => `${x.chainId}:${addressCacheKey(x.chainId, x.address)}` !== k) : next;
      const out = [t, ...filtered];
      writeCustomTokens(out);
      return out;
    });
    if (chainId) REMOTE_CACHE.delete(chainId);
  }

  return { tokens, loading, error, addCustomToken, refresh: () => setRefreshNonce((x) => x + 1) };
}
