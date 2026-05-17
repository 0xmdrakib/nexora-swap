'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Token } from '@/lib/types';
import { addressCacheKey } from '@/lib/addresses';

const PRICE_REFRESH_MS = 30_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_POLLS = 10;

function keyFor(chainId: number, address: string) {
  return `${chainId}:${addressCacheKey(chainId, address)}`;
}

export function tokenPriceKey(token: Token | null | undefined, fallbackChainId?: number) {
  if (!token?.address) return '';
  return keyFor(token.chainId || fallbackChainId || 0, token.address);
}

export function useTokenPrices(
  tokens: Array<Token | null | undefined>,
  options: { refreshSignal?: number } = {}
) {
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [activityNonce, setActivityNonce] = useState(0);
  const lastRefreshSignal = useRef(options.refreshSignal || 0);

  const tokensKey = tokens
    .map((token) => (token?.chainId && token.address ? keyFor(token.chainId, token.address) : ''))
    .filter(Boolean)
    .join('|');

  const priceItems = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ chainId: number; address: string }> = [];

    for (const token of tokens) {
      if (!token?.chainId || !token.address) continue;
      const key = keyFor(token.chainId, token.address);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chainId: token.chainId, address: token.address });
    }

    return out;
  }, [tokensKey]);

  const itemsKey = useMemo(
    () => priceItems.map((item) => keyFor(item.chainId, item.address)).join('|'),
    [priceItems]
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (!document.hidden) setActivityNonce((value) => value + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!priceItems.length) return;

    let cancelled = false;
    let pollCount = 0;
    const startedAt = Date.now();
    const refreshSignal = options.refreshSignal || 0;
    const forceFirst = refreshSignal !== lastRefreshSignal.current;
    lastRefreshSignal.current = refreshSignal;

    async function load(force = false) {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - startedAt > ACTIVE_WINDOW_MS) return;
      if (pollCount >= MAX_POLLS) return;

      pollCount += 1;
      setLoading(true);
      try {
        const res = await fetch('/api/prices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tokens: priceItems, force }),
          cache: 'no-store',
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || 'Price fetch failed');
        if (cancelled) return;

        setPrices((prev) => {
          const next = { ...prev };
          for (const price of Array.isArray(json?.prices) ? json.prices : []) {
            const n = Number(price?.priceUSD || 0);
            const key = keyFor(Number(price?.chainId), String(price?.address || ''));
            if (Number.isFinite(n) && n > 0) next[key] = n;
            else delete next[key];
          }
          return next;
        });
      } catch {
        if (!cancelled) {
          setPrices((prev) => {
            const next = { ...prev };
            for (const item of priceItems) delete next[keyFor(item.chainId, item.address)];
            return next;
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load(forceFirst);
    const interval = window.setInterval(() => load(false), PRICE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [itemsKey, activityNonce, options.refreshSignal, priceItems]);

  return { prices, loading };
}
