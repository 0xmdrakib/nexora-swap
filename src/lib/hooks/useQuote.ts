'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MinAmountHint, QuoteErrorReason, QuoteRequest, QuoteResponse } from '@/lib/types';

export function useQuote(req?: QuoteRequest) {
  const [data, setData] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<QuoteErrorReason | null>(null);
  const [minAmount, setMinAmount] = useState<MinAmountHint | null>(null);
  const [loading, setLoading] = useState(false);

  const key = useMemo(() => {
    if (!req) return '';
    return JSON.stringify({
      r: req.router,
      f: req.fromChainId,
      t: req.toChainId,
      fa: req.fromToken.address,
      ta: req.toToken.address,
      a: req.fromAmount,
      s: req.slippage,
      u: req.fromAddress,
    });
  }, [req]);

  useEffect(() => {
    if (!req) {
      setData(null);
      setError(null);
      setReason(null);
      setMinAmount(null);
      setLoading(false);
      return;
    }
    if (!req.fromAmount || req.fromAmount === '0') {
      setData(null);
      setError(null);
      setReason(null);
      setMinAmount(null);
      setLoading(false);
      return;
    }

    let ignore = false;
    const ac = new AbortController();
    let retried = false;
    setLoading(true);
    setData(null);
    setError(null);
    setReason(null);
    setMinAmount(null);

    (async () => {
      try {
        const fetchOnce = async () => {
          const r = await fetch('/api/quote', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(req),
            signal: ac.signal,
          });

          const txt = await r.text();
          let payload: any | null = null;
          if (txt) {
            try {
              payload = JSON.parse(txt);
            } catch {
              payload = null;
            }
          }

          return { r, txt, payload };
        };

        let { r, txt, payload } = await fetchOnce();

        // LiFi occasionally returns transient "no quote" results. A single fast retry
        // smooths this out so users don't have to retype the same amount.
        if (!r.ok && payload?.retryable && !retried) {
          retried = true;
          await new Promise((res) => setTimeout(res, 250));
          if (ignore) return;
          ({ r, txt, payload } = await fetchOnce());
        }

        if (!r.ok) {
          const msg =
            payload?.error ||
            payload?.message ||
            payload?.description ||
            (typeof payload === 'string' ? payload : null) ||
            txt ||
            r.statusText;
          const hint = payload?.minAmount as MinAmountHint | undefined;
          const why = (payload?.reason as QuoteErrorReason) || null;

          if (!ignore) {
            setError(String(msg).slice(0, 280));
            setReason(why);
            setMinAmount(hint || null);
            setData(null);
          }
          return;
        }

        if (!payload) throw new Error('Invalid quote response');
        if (ignore) return;
        setData(payload as QuoteResponse);
        setError(null);
        setReason(null);
        setMinAmount(null);
      } catch (e: any) {
        if (ignore) return;
        if (e?.name === 'AbortError' || /aborted/i.test(e?.message || '')) return;
        setError(e?.message || 'Failed to fetch quote');
        setReason(null);
        setMinAmount(null);
        setData(null);
      } finally {
        if (ignore) return;
        setLoading(false);
      }
    })();

    return () => {
      ignore = true;
      ac.abort();
    };
  }, [key]);

  // If quote fails due to MIN_AMOUNT, compute the exact minimum in parallel.
  // This keeps /api/quote snappy, while still giving the user the actionable minimum.
  useEffect(() => {
    if (!req) return;
    if (reason !== 'MIN_AMOUNT') return;
    if (minAmount) return;

    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      try {
        const r = await fetch('/api/min-amount', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          signal: ac.signal,
        });

        const txt = await r.text();
        let payload: any | null = null;
        try {
          payload = txt ? JSON.parse(txt) : null;
        } catch {
          payload = null;
        }

        if (cancelled) return;
        if (r.ok && payload?.minAmount) setMinAmount(payload.minAmount as MinAmountHint);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [key, reason, minAmount]);

  return { data, error, reason, loading, minAmount };
}
