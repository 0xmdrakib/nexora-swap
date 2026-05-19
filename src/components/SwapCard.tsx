'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  useAccount,
  useChainId,
  useFeeData,
  useReadContract,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { parseUnits } from 'viem';
import { AlertTriangle, ArrowDownUp, CheckCircle2, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

import type { Address, QuoteRequest, RouterId, Token } from '@/lib/types';
import { ERC20_ABI } from '@/lib/erc20';
import { formatHash, formatTokenAmount, formatUSD, safeParseFloat } from '@/lib/format';
import { getChainMeta, isEvmChain, isSolanaChain } from '@/lib/chainsMeta';
import { isNativeTokenAddressForChain, nativeTokenAddressForChain } from '@/lib/addresses';
import { useDebounce } from '@/lib/hooks/useDebounce';
import { useQuote } from '@/lib/hooks/useQuote';
import { balanceKey, useMultiWalletTokenBalances } from '@/lib/hooks/useTokenBalances';
import { tokenPriceKey, useTokenPrices } from '@/lib/hooks/useTokenPrices';
import { useSolanaWallet } from '@/lib/hooks/useSolanaWallet';
import {
  buildSwapPairPath,
  isNativeTokenAddress,
  parseSwapPairPath,
  type SwapPairUrl,
} from '@/lib/swapUrl';
import TokenSelect from './TokenSelect';
import ChainSelect from './ChainSelect';
import SolanaConnectButton from './SolanaConnectButton';
import EvmConnectButton from './EvmConnectButton';
import { Select } from './ui/Select';


function aggregatorName(router: RouterId) {
  const r = String(router);
  if (r.startsWith('lifi')) return 'LI.FI';
  if (r.startsWith('oneinch')) return '1inch';
  if (r.startsWith('gaszip')) return 'gas.zip';
  if (r.startsWith('uniswap')) return 'Uniswap';
  if (r.startsWith('pancake')) return 'PancakeSwap';
  return '-';
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function sanitizeAmountInput(value: string, maxDecimals = 18) {
  // Keep only digits and a single dot.
  let v = value.replace(/[^0-9.]/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = `${parts[0]}.${parts.slice(1).join('')}`;
  if (v.startsWith('.')) v = `0${v}`;

  if (v.includes('.')) {
    const [i, f] = v.split('.');
    v = `${i}.${(f || '').slice(0, maxDecimals)}`;
  }

  // Prevent "00..." unless it's "0.".
  if (!v.includes('.')) v = v.replace(/^0+(\d)/, '$1');
  if (v === '') return '';
  return v;
}

function defaultSwapGasLimit(chainId: number): bigint {
  // Conservative-but-not-crazy defaults (swap transactions vary a lot).
  // Used only for the "Max" button gas buffer on native tokens.
  switch (chainId) {
    case 1:
      return 300_000n; // Ethereum mainnet
    case 8453:
      return 220_000n; // Base
    case 10:
      return 220_000n; // Optimism
    case 42161:
      return 240_000n; // Arbitrum
    case 137:
      return 350_000n; // Polygon
    case 56:
      return 300_000n; // BSC
    case 43114:
      return 350_000n; // Avalanche
    default:
      return 250_000n;
  }
}

function minNativeReserve(chainId: number): string {
  // Minimum buffer to avoid "Max" stranding the user with zero gas.
  // (Units are native token, all our supported chains use 18 decimals.)
  switch (chainId) {
    case 1:
      return '0.003';
    case 8453:
      return '0.00003';
    case 10:
      return '0.00005';
    case 42161:
      return '0.00005';
    case 137:
      return '0.03';
    case 56:
      return '0.0003';
    case 43114:
      return '0.005';
    default:
      return '0.0002';
  }
}

async function loadSharedToken(chainId: number, address: string): Promise<Token> {
  if (isNativeTokenAddress(address)) {
    try {
      const res = await fetch(`/api/tokens?chainId=${chainId}&nativeOnly=1`, { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.token?.address) return json.token as Token;
    } catch {
      // Use the local chain metadata fallback below.
    }

    const meta = getChainMeta(chainId);
    return {
      chainId,
      address: nativeTokenAddressForChain(chainId),
      symbol: meta.nativeSymbol,
      name: meta.nativeSymbol,
      decimals: meta.nativeDecimals,
      logoURI: meta.logoUrl,
    };
  }

  const res = await fetch(
    `/api/token-metadata?chainId=${chainId}&address=${encodeURIComponent(address)}`,
    { cache: 'no-store' }
  );
  const json = await res.json().catch(() => null);
  if (res.ok && json?.token?.address) {
    return json.token as Token;
  }

  if (!res.ok || !json?.token?.address) {
    throw new Error(json?.error || 'Token metadata could not be loaded.');
  }
  return json.token as Token;
}

function replaceBrowserPath(path: string) {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === path) return;
  window.history.replaceState(null, '', path);
}

export default function SwapCard() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();
  const { chains, switchChainAsync } = useSwitchChain();
  const solanaWallet = useSolanaWallet();

  const [fromChainId, setFromChainId] = useState<number>(walletChainId);
  const [fromChainManual, setFromChainManual] = useState(false);
  const [fromToken, setFromToken] = useState<Token | null>(null);
  const chainId = fromChainId;
  const fromChainIsSolana = isSolanaChain(chainId);
  const fromChainIsEvm = isEvmChain(chainId);

  const [toChainId, setToChainId] = useState<number>(walletChainId);
  const [toChainManual, setToChainManual] = useState(false);
  const [toToken, setToToken] = useState<Token | null>(null);
  const toChainIsSolana = isSolanaChain(toChainId);
  const toChainIsEvm = isEvmChain(toChainId);
  const needsDualWallets = (fromChainIsEvm && toChainIsSolana) || (fromChainIsSolana && toChainIsEvm);
  const missingDualWallet = needsDualWallets && (!isConnected || !solanaWallet.connected);

  const [amountUI, setAmountUI] = useState('');
  const debouncedAmountUI = useDebounce(amountUI, 350);

  // Slippage UI is expressed in percent (0.01 .. 20). Quote APIs expect a fraction (0.0001 .. 0.2).
  // Default: Auto slippage ON.
  const [slippageAuto, setSlippageAuto] = useState(true);
  const [slippageUI, setSlippageUI] = useState(0.5); // % (manual)

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [router, setRouter] = useState<RouterId>('auto');

  // Used when chain changes are expected to preserve URL-hydrated or swapped tokens.
  const suppressTokenResetOnChainChange = useRef(false);
  const suppressToTokenResetOnToChainChange = useRef(false);
  const hydratedPairPath = useRef<string | null>(null);

  // Used to force fresh balance reads right after a confirmed swap.
  const [balanceNonce, setBalanceNonce] = useState(0);
  const [shareHydrating, setShareHydrating] = useState(false);
  const [shareHydrationError, setShareHydrationError] = useState<string | null>(null);
  const [solanaNativeReserveLamports, setSolanaNativeReserveLamports] = useState<bigint>(20_000n);
  const [compactWalletLabels, setCompactWalletLabels] = useState(false);

  const sharedPairFromPath = useMemo(() => parseSwapPairPath(pathname), [pathname]);

  useEffect(() => {
    if (fromChainManual) return;
    setFromChainId(walletChainId);
  }, [walletChainId, fromChainManual]);

  // Keep destination chain synced by default, but let the user override.
  useEffect(() => {
    if (!toChainManual) setToChainId(chainId);
  }, [chainId, toChainManual]);

  // When the selected source chain changes, reset tokens to avoid mismatches.
  useEffect(() => {
    if (suppressTokenResetOnChainChange.current) {
      suppressTokenResetOnChainChange.current = false;
      return;
    }
    setFromToken(null);
    setToToken(null);
  }, [chainId]);

  // If user switches destination chain, clear the destination token (chain-first UX).
  useEffect(() => {
    if (suppressToTokenResetOnToChainChange.current) {
      suppressToTokenResetOnToChainChange.current = false;
      return;
    }
    // Changing destination chain invalidates the current quote/tx state
    setToToken(null);
    setLastTx(null);
  }, [toChainId]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSharedPair(pair: SwapPairUrl) {
      setShareHydrating(true);
      setShareHydrationError(null);

      try {
        const [from, to] = await Promise.all([
          loadSharedToken(pair.fromChainId, pair.fromTokenAddress),
          loadSharedToken(pair.toChainId, pair.toTokenAddress),
        ]);
        if (cancelled) return;

        suppressTokenResetOnChainChange.current = true;
        suppressToTokenResetOnToChainChange.current = true;
        setFromChainManual(true);
        setToChainManual(pair.toChainId !== pair.fromChainId);
        setFromChainId(pair.fromChainId);
        setToChainId(pair.toChainId);
        setFromToken({ ...from, chainId: pair.fromChainId });
        setToToken({ ...to, chainId: pair.toChainId });
        setLastTx(null);
        hydratedPairPath.current = pathname;
      } catch (e: any) {
        if (cancelled) return;
        setShareHydrationError(e?.message || 'Shared pair link could not be loaded.');
        setFromToken(null);
        setToToken(null);
        setFromChainManual(false);
        setToChainManual(false);
        setFromChainId(walletChainId);
        setToChainId(walletChainId);
        hydratedPairPath.current = pathname;
        replaceBrowserPath('/');
      } finally {
        if (!cancelled) setShareHydrating(false);
      }
    }

    if (sharedPairFromPath.kind === 'none') {
      hydratedPairPath.current = null;
      setShareHydrationError(null);
      setShareHydrating(false);
      return () => {
        cancelled = true;
      };
    }

    if (hydratedPairPath.current === pathname) {
      return () => {
        cancelled = true;
      };
    }

    if (sharedPairFromPath.kind === 'invalid') {
      setShareHydrating(false);
      setShareHydrationError(sharedPairFromPath.reason);
      setFromToken(null);
      setToToken(null);
      setFromChainManual(false);
      setToChainManual(false);
      setFromChainId(walletChainId);
      setToChainId(walletChainId);
      hydratedPairPath.current = pathname;
      replaceBrowserPath('/');
      return () => {
        cancelled = true;
      };
    }

    hydrateSharedPair(sharedPairFromPath);
    return () => {
      cancelled = true;
    };
  }, [pathname, sharedPairFromPath, walletChainId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (shareHydrating) return;
    if (sharedPairFromPath.kind !== 'none' && hydratedPairPath.current !== pathname) return;

    if (fromToken && toToken) {
      const nextPath = buildSwapPairPath({
        fromChainId: chainId,
        fromTokenAddress: fromToken.address,
        toChainId,
        toTokenAddress: toToken.address,
      });
      hydratedPairPath.current = nextPath;
      replaceBrowserPath(nextPath);
      return;
    }

    if (window.location.pathname.startsWith('/swap')) {
      hydratedPairPath.current = null;
      replaceBrowserPath('/');
    }
  }, [chainId, fromToken, pathname, shareHydrating, sharedPairFromPath.kind, toChainId, toToken]);

  const fromAmountRaw = useMemo(() => {
    if (!fromToken) return '0';
    // IMPORTANT: never pass a JS Number into parseUnits.
    // Numbers like 0.0000001 become "1e-7" when stringified, and viem rejects scientific notation.
    // Keep the user's decimal string.
    const raw = (debouncedAmountUI || '').trim();
    if (!raw) return '0';
    const s = raw.endsWith('.') ? raw.slice(0, -1) : raw;
    if (!s || s === '0') return '0';
    if (!/^\d+(\.\d+)?$/.test(s)) return '0';
    try {
      return parseUnits(s, fromToken.decimals).toString();
    } catch {
      return '0';
    }
  }, [debouncedAmountUI, fromToken]);

  // Live balance for the "from" token (used to show instant "insufficient balance" UX).
  const fromIsNative = fromToken ? isNativeTokenAddressForChain(chainId, fromToken.address) : false;
  const { prices } = useTokenPrices([fromToken, toToken], { refreshSignal: balanceNonce });
  const { balances: selectedBalances, loading: selectedBalancesLoading } = useMultiWalletTokenBalances(
    {
      evm: address as string | undefined,
      solana: solanaWallet.publicKey || undefined,
    },
    [fromToken, toToken],
    { refreshSignal: balanceNonce }
  );

  const fromPrice = prices[tokenPriceKey(fromToken, chainId)] || 0;
  const toPrice = prices[tokenPriceKey(toToken, toChainId)] || 0;
  const fromBalanceRaw = fromToken ? selectedBalances[balanceKey(chainId, fromToken.address)] : undefined;
  const toBalanceRaw = toToken ? selectedBalances[balanceKey(toChainId, toToken.address)] : undefined;
  const fromBalanceValue = useMemo(() => {
    if (fromBalanceRaw === undefined) return undefined;
    try {
      return BigInt(fromBalanceRaw);
    } catch {
      return 0n;
    }
  }, [fromBalanceRaw]);

  const fromTokenForQuote = useMemo(() => {
    if (!fromToken) return null;
    return { ...fromToken, priceUSD: fromPrice > 0 ? String(fromPrice) : undefined };
  }, [fromToken, fromPrice]);

  const toTokenForQuote = useMemo(() => {
    if (!toToken) return null;
    return { ...toToken, priceUSD: toPrice > 0 ? String(toPrice) : undefined };
  }, [toToken, toPrice]);

  const insufficientBalance = useMemo(() => {
    if (!fromToken || fromBalanceValue === undefined) return false;
    try {
      const need = BigInt(fromAmountRaw || '0');
      return need > 0n && need > fromBalanceValue;
    } catch {
      return false;
    }
  }, [fromToken, fromBalanceValue, fromAmountRaw]);

  const isCrossChain = chainId !== toChainId;
  const oneInchEligible = !isCrossChain && fromChainIsEvm && toChainIsEvm;

  const autoSlippageUI = useMemo(() => {
    const a = (fromToken?.symbol || '').toUpperCase();
    const b = (toToken?.symbol || '').toUpperCase();
    const stable = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'USDE']);
    const isStablePair = stable.has(a) && stable.has(b);
    if (isStablePair) return 0.1;
    if (isCrossChain) return 1.0;
    return 0.5;
  }, [fromToken?.symbol, toToken?.symbol, isCrossChain]);

  const slippageUIEffective = slippageAuto ? autoSlippageUI : slippageUI;
  const slippage = clamp(slippageUIEffective, 0.01, 20) / 100;

  useEffect(() => {
    // Safety: same-chain-only routers must not be used for cross-chain swaps.
    // Cross-chain swaps are handled by LiFi. We allow forcing gas.zip bridge
    // on cross-chain, otherwise default to LiFi Smart Routing.
    if (isCrossChain) {
      if (router !== 'lifi-smart' && router !== 'gaszip') setRouter('lifi-smart');
      return;
    }

    // gas.zip is cross-chain only; if user switches back to same-chain, fall back.
    if (router === 'gaszip') {
      setRouter(oneInchEligible ? 'auto' : 'lifi-smart');
      return;
    }
    if (!oneInchEligible && (router === 'auto' || router === 'oneinch-direct')) setRouter('lifi-smart');
  }, [isCrossChain, router, oneInchEligible]);

  const routeOptions = useMemo(() => {
    const options = [{ value: 'lifi-smart', label: 'LiFi Smart Routing' }];
    if (oneInchEligible) {
      options.unshift({ value: 'auto', label: 'Auto (best)' });
      options.push({ value: 'oneinch-direct', label: '1inch Direct (EVM same-chain)' });
    }
    if (isCrossChain) {
      options.push({ value: 'gaszip', label: 'gas.zip (cross-chain only)' });
    }
    return options;
  }, [isCrossChain, oneInchEligible]);

  // Auto routing strategy (production-realistic):
  // - Cross-chain => LiFi only
  // - Same-chain + Auto => compare 1inch vs LiFi and pick the better quote (fallback gracefully)
  const autoEnabled = router === 'auto' && oneInchEligible;

  const quoteReqCommon = useMemo(() => {
    const fromAddress = fromChainIsSolana ? solanaWallet.publicKey : address;
    const toAddress = toChainIsSolana ? solanaWallet.publicKey : address;
    if (!fromAddress || !toAddress) return null;
    if (!fromTokenForQuote || !toTokenForQuote) return null;
    if (!fromAmountRaw || fromAmountRaw === '0') return null;

    return {
      fromChainId: chainId,
      toChainId,
      fromToken: fromTokenForQuote,
      toToken: toTokenForQuote,
      fromAmount: fromAmountRaw,
      fromAddress,
      toAddress,
      slippage,
    };
  }, [
    fromChainIsSolana,
    toChainIsSolana,
    solanaWallet.publicKey,
    address,
    fromTokenForQuote,
    toTokenForQuote,
    fromAmountRaw,
    chainId,
    toChainId,
    slippage,
  ]);

  const quoteReqOneInch: QuoteRequest | undefined = useMemo(() => {
    if (!oneInchEligible) return undefined;
    if (!quoteReqCommon) return undefined;
    if (!(autoEnabled || router === 'oneinch-direct')) return undefined;
    return { ...quoteReqCommon, router: 'oneinch-direct' };
  }, [quoteReqCommon, autoEnabled, router, oneInchEligible]);

  const quoteReqLiFi: QuoteRequest | undefined = useMemo(() => {
    if (!quoteReqCommon) return undefined;
    if (isCrossChain) {
      // Cross-chain: allow gas.zip forcing, otherwise use LiFi Smart Routing.
      return { ...quoteReqCommon, router: router === 'gaszip' ? 'gaszip' : 'lifi-smart' };
    }

    // Same-chain: allow LiFi Smart Routing.
    if (!(autoEnabled || router === 'lifi-smart')) return undefined;
    return { ...quoteReqCommon, router: autoEnabled ? 'lifi-smart' : router };
  }, [quoteReqCommon, autoEnabled, router, isCrossChain]);

  const one = useQuote(quoteReqOneInch);
  const li = useQuote(quoteReqLiFi);

  const autoPicked: RouterId | null = useMemo(() => {
    if (!autoEnabled) return null;

    const oneAmt = one.data?.estimate?.toAmount;
    const liAmt = li.data?.estimate?.toAmount;

    const oneOk = !!oneAmt && (() => { try { return BigInt(oneAmt) > 0n; } catch { return false; } })();
    const liOk = !!liAmt && (() => { try { return BigInt(liAmt) > 0n; } catch { return false; } })();

    if (oneOk && liOk) {
      try {
        return BigInt(oneAmt as string) >= BigInt(liAmt as string) ? 'oneinch-direct' : 'lifi-smart';
      } catch {
        return 'lifi-smart';
      }
    }
    if (oneOk) return 'oneinch-direct';
    if (liOk) return 'lifi-smart';

    return null;
  }, [autoEnabled, one.data, li.data]);

  const effectiveRouter: RouterId = useMemo(() => {
    if (isCrossChain) return router === 'gaszip' ? 'gaszip' : 'lifi-smart';
    if (!oneInchEligible && router !== 'lifi-smart') return 'lifi-smart';
    if (router === 'auto') return autoPicked ?? 'lifi-smart';
    return router;
  }, [router, isCrossChain, autoPicked, oneInchEligible]);

  const active =
    effectiveRouter === 'oneinch-direct'
      ? one
      : li;

  const {
    data: quote,
    error: quoteError,
    reason: quoteReason,
    loading: quoteLoading,
    minAmount,
  } = active;

  const quoteBusy = quoteLoading || (router === 'auto' && oneInchEligible && (one.loading || li.loading));

  // USD under the input (instant, based on the user's typed amount).
  const fromAmountFloat = safeParseFloat(amountUI);
  const fromUsd = fromPrice > 0 ? fromAmountFloat * fromPrice : 0;

  // "Max" helper: for native tokens keep a small buffer for gas so users don't strand themselves.
  const { data: feeData } = useFeeData({
    chainId,
    query: {
      enabled: Boolean(fromIsNative && fromChainIsEvm),
      staleTime: 12_000,
    },
  });

  useEffect(() => {
    if (!fromIsNative || !fromChainIsSolana) return;

    const controller = new AbortController();
    async function loadSolanaReserve() {
      try {
        const res = await fetch('/api/solana-fee-reserve', {
          signal: controller.signal,
          cache: 'no-store',
        });
        const json = await res.json().catch(() => null);
        const lamports = BigInt(String(json?.lamports || '0'));
        if (!controller.signal.aborted && lamports > 0n) {
          setSolanaNativeReserveLamports(lamports);
        }
      } catch {
        // Keep the local fallback reserve.
      }
    }

    loadSolanaReserve();
    return () => controller.abort();
  }, [fromIsNative, fromChainIsSolana]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 420px)');
    const update = () => setCompactWalletLabels(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const nativeGasBuffer = useMemo(() => {
    if (!fromIsNative) return 0n;
    if (fromChainIsSolana) return solanaNativeReserveLamports;
    if (!fromChainIsEvm) return 0n;
    // Chain-aware buffer based on current fee data.
    // L2s tend to have lower fees than L1, while mainnet needs more headroom.
    const gasLimit = defaultSwapGasLimit(chainId);
    const feePerGas = (feeData?.maxFeePerGas ?? feeData?.gasPrice ?? 0n) as bigint;
    const est = feePerGas > 0n ? feePerGas * gasLimit : 0n;

    let buffer = est > 0n ? (est * 15n) / 10n : 0n; // 1.5x safety
    let minReserve = 0n;
    try {
      minReserve = parseUnits(minNativeReserve(chainId), 18);
    } catch {
      minReserve = 0n;
    }
    if (buffer < minReserve) buffer = minReserve;
    return buffer;
  }, [
    fromIsNative,
    fromChainIsSolana,
    solanaNativeReserveLamports,
    fromChainIsEvm,
    chainId,
    feeData?.maxFeePerGas,
    feeData?.gasPrice,
  ]);


  const toAmountFloat = quote && toToken ? safeParseFloat(formatTokenAmount(quote.estimate.toAmount, toToken.decimals, 8)) : 0;
  const toUsd = toPrice > 0 ? toAmountFloat * toPrice : 0;

  const minToAmountStr = quote?.estimate?.toAmountMin && toToken
    ? formatTokenAmount(quote.estimate.toAmountMin, toToken.decimals, 8)
    : '';
  const minToAmountFloat = safeParseFloat(minToAmountStr);
  const minToUsd = toPrice > 0 && minToAmountFloat > 0 ? minToAmountFloat * toPrice : 0;

  const [nativePriceUsdForFees, setNativePriceUsdForFees] = useState(0);

  // Cross-chain swaps can require extra native value (bridge / messaging fee).
  // Wallets often show this as a bigger 'You send' than the typed amount because it
  // includes both the swap amount and the bridge/message fee inside tx.value.
  const quoteTxValueRaw = useMemo(() => {
    try {
      return quote?.tx?.value ? parseTxValue(quote.tx.value) : 0n;
    } catch {
      return 0n;
    }
  }, [quote?.tx?.value]);

  const nativeDecimals = useMemo(() => {
    try {
      return getChainMeta(chainId).nativeDecimals || 18;
    } catch {
      return 18;
    }
  }, [chainId]);

  const estimatedCrossChainFeeRaw = useMemo(() => {
    if (!isCrossChain) return 0n;
    if (quoteTxValueRaw > 0n) return 0n;
    if (quote?.estimate?.gasUSD && nativePriceUsdForFees > 0) {
      const feeUsd = Number(quote.estimate.gasUSD);
      if (Number.isFinite(feeUsd) && feeUsd > 0) {
        try {
          return parseUnits((feeUsd / nativePriceUsdForFees).toFixed(nativeDecimals), nativeDecimals);
        } catch {
          return 0n;
        }
      }
    }
    return fromChainIsSolana ? solanaNativeReserveLamports : 0n;
  }, [
    isCrossChain,
    quoteTxValueRaw,
    quote?.estimate?.gasUSD,
    nativePriceUsdForFees,
    nativeDecimals,
    fromChainIsSolana,
    solanaNativeReserveLamports,
  ]);

  const txValueWei = useMemo(() => {
    if (!quote || !isCrossChain) return quoteTxValueRaw;
    if (quoteTxValueRaw > 0n) return quoteTxValueRaw;
    if (!fromIsNative) return 0n;

    let fromRaw = 0n;
    try {
      fromRaw = BigInt(quote.estimate.fromAmount || fromAmountRaw || '0');
    } catch {
      fromRaw = 0n;
    }
    return fromRaw + estimatedCrossChainFeeRaw;
  }, [quote, isCrossChain, quoteTxValueRaw, fromIsNative, estimatedCrossChainFeeRaw, fromAmountRaw]);

  const nativeSymbol = useMemo(() => {
    try {
      return getChainMeta(chainId).nativeSymbol || 'ETH';
    } catch {
      return 'ETH';
    }
  }, [chainId]);

  // For bridge/messaging fees we need the USD price of the source-chain native token.
  // Previously we only computed USD when the "from" token was native, which caused
  // fee USD to disappear when swapping from an ERC20 (e.g. USDC -> ... cross-chain).
  useEffect(() => {
    // Always clear first to avoid showing a stale USD value while we resolve.
    setNativePriceUsdForFees(0);

    // Only relevant for cross-chain (bridge) routes.
    if (!isCrossChain) return;

    const controller = new AbortController();

    const resolve = async () => {
      // Fast-path: if the *source* token is native, we already have its USD price.
      // Note: In cross-chain routes, fees are always paid in the source-chain native token,
      // so we intentionally do NOT use destination-native prices.
      const direct = fromIsNative && fromPrice > 0 ? fromPrice : 0;
      if (direct > 0) {
        setNativePriceUsdForFees(direct);
        return;
      }

      // Reliable fallback: resolve source-chain native USD price.
      try {
        const res = await fetch(`/api/native-price?chainId=${chainId}`, {
          signal: controller.signal,
        });
        const json = await res.json().catch(() => null);
        // API returns `{ usd: number }`.
        // Keep a tiny backward-compat fallback (`usdPrice`) so old builds won't break.
        const p = Number((json as any)?.usd ?? (json as any)?.usdPrice ?? 0);
        if (!controller.signal.aborted) {
          setNativePriceUsdForFees(Number.isFinite(p) && p > 0 ? p : 0);
        }
      } catch {
        // ignore
      }
    };

    resolve();
    return () => controller.abort();
  }, [chainId, isCrossChain, fromIsNative, fromPrice]);

  const bridgeFeeWei = useMemo(() => {
    if (!quote || !isCrossChain) return 0n;
    if (txValueWei === 0n && estimatedCrossChainFeeRaw === 0n) return 0n;

    let fromWei = 0n;
    try {
      fromWei = BigInt(fromAmountRaw || '0');
    } catch {
      fromWei = 0n;
    }

    if (fromIsNative) {
      // Native token swaps: tx.value typically = amount + message/bridge fee
      if (txValueWei > fromWei) return txValueWei - fromWei;
      return estimatedCrossChainFeeRaw;
    }
    // ERC20 swaps: tx.value is usually only the message/bridge fee (paid in native)
    return txValueWei;
  }, [quote, isCrossChain, txValueWei, fromIsNative, fromAmountRaw, estimatedCrossChainFeeRaw]);

  const bridgeFeeStr = useMemo(() => {
    // For cross-chain routes we show this row even when the fee is 0.
    if (!isCrossChain) return '';
    return formatTokenAmount(bridgeFeeWei.toString(), nativeDecimals, 8);
  }, [isCrossChain, bridgeFeeWei, nativeDecimals]);

  const bridgeFeeUsd = useMemo(() => {
    if (!bridgeFeeStr) return 0;
    if (nativePriceUsdForFees <= 0) return 0;
    const fee = safeParseFloat(bridgeFeeStr);
    return fee > 0 ? fee * nativePriceUsdForFees : 0;
  }, [bridgeFeeStr, nativePriceUsdForFees]);

  const totalValueStr = useMemo(() => {
    // For cross-chain routes we show this row even when tx.value is 0.
    if (!quote || !isCrossChain) return '';
    return formatTokenAmount(txValueWei.toString(), nativeDecimals, 8);
  }, [quote, isCrossChain, txValueWei, nativeDecimals]);

  const totalValueUsd = useMemo(() => {
    if (!totalValueStr) return 0;
    if (nativePriceUsdForFees <= 0) return 0;
    const v = safeParseFloat(totalValueStr);
    return v > 0 ? v * nativePriceUsdForFees : 0;
  }, [totalValueStr, nativePriceUsdForFees]);

  const bridgeFeeDominates = useMemo(() => {
    // Only relevant for cross-chain routes where there is a non-zero native tx value (bridge/messaging gas).
    // `QuoteResponse` is our internal shape; it doesn't expose an `isCrossChain` flag.
    // Use the derived boolean from the selected chains.
    if (!quote || !isCrossChain || bridgeFeeWei <= 0n) return false;

    // Prefer USD comparison (works for ERC20 inputs too).
    if (bridgeFeeUsd > 0 && fromUsd > 0) {
      return bridgeFeeUsd > fromUsd;
    }

    // Fallback: only safe to compare raw units when the "from" token is native.
    if (!fromIsNative) return false;

    try {
      const fromWei = BigInt(fromAmountRaw || '0');
      return bridgeFeeWei > fromWei;
    } catch {
      return false;
    }
  }, [quote, isCrossChain, bridgeFeeWei, bridgeFeeUsd, fromUsd, fromIsNative, fromAmountRaw]);

  const priceDeviationPct = useMemo(() => {
    if (!fromUsd || !toUsd) return 0;
    const dev = Math.abs(toUsd - fromUsd) / Math.max(fromUsd, 1e-9);
    return dev * 100;
  }, [fromUsd, toUsd]);

  const bigDeviation = priceDeviationPct >= 5; // heuristic
  const lowLiquidity =
    quoteReason === 'NO_LIQUIDITY' ||
    quoteError?.toLowerCase().includes('insufficient') ||
    quoteError?.toLowerCase().includes('liquidity');

  // Approval logic (LiFi quote provides approvalAddress when needed)
  const spender = quote?.estimate.approvalAddress;
  const needsApproval = fromChainIsEvm && !!spender && fromToken ? !isNativeTokenAddressForChain(chainId, fromToken.address) : false;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    abi: ERC20_ABI,
    address: fromChainIsEvm ? (fromToken?.address as Address | undefined) : undefined,
    functionName: 'allowance',
    args: address && spender ? [address as Address, spender as Address] : undefined,
    chainId,
    query: {
      enabled: Boolean(isConnected && fromChainIsEvm && address && spender && fromToken && !isNativeTokenAddressForChain(chainId, fromToken.address)),
      // Approvals should reflect quickly; stale allowance makes the UI look "stuck".
      staleTime: 0,
      refetchInterval: 4_000,
    },
  });

  // Use the quote's fromAmount (raw units) as the source of truth.
  // This prevents "approved but still asks to approve" issues if UI parsing rounds differently.
  const requiredAllowance = useMemo(() => {
    if (!needsApproval) return 0n;
    const raw = quote?.estimate?.fromAmount || fromAmountRaw || '0';
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }, [needsApproval, quote?.estimate?.fromAmount, fromAmountRaw]);

  const allowanceOk = useMemo(() => {
    if (!needsApproval) return true;
    try {
      if (!allowance) return false;
      return BigInt(allowance as any) >= requiredAllowance;
    } catch {
      return false;
    }
  }, [needsApproval, allowance, requiredAllowance]);

  const { writeContractAsync, isPending: approvePending } = useWriteContract();
  const { sendTransactionAsync, isPending: swapPending } = useSendTransaction();

  // Track approval confirmation separately from the initial wallet signature.
  // `approvePending` only covers the wallet confirmation step.
  const [approveTx, setApproveTx] = useState<{ hash: `0x${string}`; chainId: number } | null>(null);
  const {
    data: approveReceipt,
    isLoading: approveReceiptLoading,
  } = useWaitForTransactionReceipt({
    hash: approveTx?.hash,
    chainId: approveTx?.chainId,
    query: { enabled: Boolean(approveTx?.hash) },
  });

  // Keep "Approving..." visible from the moment the tx hash exists until allowance refresh clears the flow.
  const approving = approvePending || approveReceiptLoading || Boolean(approveTx?.hash);

  // Once the approve tx is mined, refresh allowance immediately so the UI flips to "Swap".
  useEffect(() => {
    if (!approveReceipt || !approveTx?.hash) return;
    (async () => {
      try {
        await refetchAllowance();
      } finally {
        setApproveTx(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt]);

  const [lastTx, setLastTx] = useState<{ hash: string; chainId: number; txType?: 'evm' | 'solana' } | null>(null);
  const { data: receipt, isLoading: receiptLoading } = useWaitForTransactionReceipt({
    hash: lastTx?.txType === 'solana' ? undefined : (lastTx?.hash as `0x${string}` | undefined),
    chainId: lastTx?.chainId,
    query: { enabled: Boolean(lastTx?.hash && lastTx?.txType !== 'solana') },
  });
  const [solanaReceiptLoading, setSolanaReceiptLoading] = useState(false);
  const [solanaReceiptConfirmed, setSolanaReceiptConfirmed] = useState(false);
  const receiptConfirmed = lastTx?.txType === 'solana' ? solanaReceiptConfirmed : Boolean(receipt);
  const receiptBusy = lastTx?.txType === 'solana' ? solanaReceiptLoading : receiptLoading;

  const [uiError, setUiError] = useState<string | null>(null);

  // Ensure we only run post-swap refresh once per confirmed tx.
  const [lastRefreshedTx, setLastRefreshedTx] = useState<string | null>(null);

  // After a successful swap, refresh Alchemy balances and DexScreener prices immediately.
  // The token selector also refreshes its wallet-token list when it is open.
  useEffect(() => {
    if (!receiptConfirmed || !lastTx?.hash) return;
    if (lastRefreshedTx === lastTx.hash) return;

    setLastRefreshedTx(lastTx.hash);
    setBalanceNonce((x) => x + 1);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('swapdex:refreshTokens', {
          detail: { chainIds: [chainId, toChainId] },
        })
      );
    }
  }, [receiptConfirmed, lastTx?.hash, chainId, toChainId, lastRefreshedTx]);

  // Clear transient UI errors (e.g., "User rejected the request") as soon as the user changes inputs.
  useEffect(() => {
    if (uiError) setUiError(null);
    if (shareHydrationError) setShareHydrationError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromAmountRaw, chainId, toChainId, fromToken?.address, toToken?.address, router]);

  useEffect(() => {
    setUiError(null);
    setLastTx(null);
    setSolanaReceiptConfirmed(false);
    setSolanaReceiptLoading(false);
  }, [router, fromChainId, toChainId, fromToken?.address, toToken?.address]);


  // Clear tx status when switching wallet network. Otherwise wagmi may look for the receipt on the new chain
  // and the UI can incorrectly show 'Waiting for confirmation...' for an already-confirmed tx.
  useEffect(() => {
    setLastTx(null);
  }, [walletChainId]);

  async function ensureCorrectChain() {
    if (fromChainIsSolana) return;
    if (!switchChainAsync) return;
    const targetChainId = fromToken?.chainId || chainId;
    if (walletChainId !== targetChainId) {
      await switchChainAsync({ chainId: targetChainId });
    }
  }

  async function onApprove() {
    setUiError(null);
    // Reset any previous approval tracking.
    setApproveTx(null);
    if (!isConnected || !address) return setUiError('Connect wallet first.');
    if (!fromChainIsEvm) return setUiError('Solana swaps do not use ERC-20 approvals.');
    if (!fromToken || isNativeTokenAddressForChain(chainId, fromToken.address)) return setUiError('No approval needed for native token.');
    if (!spender) return setUiError('Missing approval address (no quote).');

    try {
      await ensureCorrectChain();
      const approveAmount = requiredAllowance;
      if (approveAmount <= 0n) return setUiError('Enter an amount to approve.');
      const hash = await writeContractAsync({
        abi: ERC20_ABI,
        address: fromToken.address as Address,
        functionName: 'approve',
        // Safer UX: approve only the exact amount entered (not unlimited).
        args: [spender as Address, approveAmount],
        chainId: fromToken.chainId || chainId,
      });

      // Keep the button in "Approving..." state until the tx is mined.
      if (hash) setApproveTx({ hash, chainId: fromToken.chainId || chainId });
    } catch (e: any) {
      setUiError(e?.shortMessage || e?.message || 'Approve failed');
    }
  }

  function parseTxValue(value?: string) {
    if (!value) return 0n;
    try {
      if (value.startsWith('0x')) return BigInt(value);
      return BigInt(value);
    } catch {
      return 0n;
    }
  }

  async function onSwap() {
    setUiError(null);
    if (fromChainIsSolana) {
      if (!solanaWallet.connected || !solanaWallet.publicKey) return setUiError('Connect Solana wallet first.');
    } else if (!isConnected || !address) {
      return setUiError('Connect wallet first.');
    }
    if (!quote?.tx) return setUiError('No transaction data. Get a quote first.');
    if (needsApproval && !allowanceOk) return setUiError('Approval required.');
    if (lowLiquidity) return setUiError('Liquidity looks insufficient for this trade.');

    try {
      if (quote.tx.txType === 'solana') {
        if (!quote.tx.data) return setUiError('Missing Solana transaction payload.');
        const signature = await solanaWallet.sendBase64Transaction(quote.tx.data);
        setLastTx({ hash: signature, chainId: quote.tx.chainId, txType: 'solana' });
        setSolanaReceiptConfirmed(false);
        setSolanaReceiptLoading(true);
        try {
          await solanaWallet.confirmSignature(signature);
          setSolanaReceiptConfirmed(true);
        } finally {
          setSolanaReceiptLoading(false);
        }
        return;
      }

      await ensureCorrectChain();
      const hash = await sendTransactionAsync({
        chainId: quote.tx.chainId,
        to: quote.tx.to as Address,
        data: (quote.tx.data as any) || '0x',
        value: parseTxValue(quote.tx.value),
      });
      setLastTx({ hash, chainId: quote.tx.chainId, txType: 'evm' });
    } catch (e: any) {
      setUiError(e?.shortMessage || e?.message || 'Swap failed');
    }
  }

  async function selectSourceChain(id: number) {
    if (id === chainId) return;

    setUiError(null);
    setShareHydrationError(null);
    setFromChainManual(true);
    setFromChainId(id);
    setLastTx(null);
    setSolanaReceiptConfirmed(false);

    if (isSolanaChain(id)) return;
    if (!isConnected) return;
    if (!switchChainAsync) {
      setUiError('Wallet does not support network switching.');
      return;
    }

    try {
      await switchChainAsync({ chainId: id });
    } catch (e: any) {
      setUiError(e?.shortMessage || e?.message || 'Failed to switch network');
    }
  }

  const txUrl = useMemo(() => {
    if (!lastTx?.hash) return null;
    if (lastTx.txType === 'solana' || isSolanaChain(lastTx.chainId)) {
      return `https://solscan.io/tx/${lastTx.hash}`;
    }
    const c = chains.find((x) => x.id === lastTx.chainId);
    const base = c?.blockExplorers?.default?.url;
    if (!base) return null;
    return `${base.replace(/\/$/, '')}/tx/${lastTx.hash}`;
  }, [lastTx, chains]);

  return (
    <div className="swap-card">
      <div className={clsx('swap-toolbar', needsDualWallets ? 'swap-toolbar-dual-wallets' : 'swap-toolbar-single-wallet')}>
        <ChainSelect
          chainId={chainId}
          onSelect={selectSourceChain}
        />

        <div className={clsx('wallet-stack', needsDualWallets ? 'wallet-stack-dual' : 'wallet-stack-single')}>
          {(fromChainIsEvm || needsDualWallets) && (
            <EvmConnectButton
              compactAddress={compactWalletLabels && needsDualWallets}
              onError={(message) => setUiError(message)}
            />
          )}

          {(fromChainIsSolana || needsDualWallets) && (
            <SolanaConnectButton
              providerReady={solanaWallet.providerReady}
              connected={solanaWallet.connected}
              connecting={solanaWallet.connecting}
              publicKey={solanaWallet.publicKey}
              walletName={solanaWallet.walletName}
              walletIcon={solanaWallet.walletIcon}
              providers={solanaWallet.providers}
              selectedName={solanaWallet.selectedName}
              onSelectWallet={solanaWallet.selectWallet}
              onConnect={async (walletName?: string) => {
                try {
                  await solanaWallet.connect(walletName);
                } catch (e: any) {
                  setUiError(e?.message || 'Failed to connect Solana wallet');
                }
              }}
              onDisconnect={solanaWallet.disconnect}
              compactAddress={compactWalletLabels && needsDualWallets}
            />
          )}
        </div>
      </div>

      {!fromChainIsSolana && !process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID && (
        <div className="warning-box mt-3">
          Missing <span className="font-mono">NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</span>. WalletConnect-based wallets
          will not work until you set it.
        </div>
      )}

      {missingDualWallet && (
        <div className="warning-box mt-3 compact-warning">
          Connect both EVM and Solana wallets for this swap.
        </div>
      )}

      <div className="swap-stack">
        <div className="swap-asset-card">
          <div className="asset-label">You pay</div>
          {/*
            Prevent the amount input from squeezing the token button down to a single character.
            In flex layouts, a child with `w-full` can take the whole row and force siblings to shrink.
            We instead make the input `flex-1 min-w-0` and keep the token button `shrink-0`.
          */}
          <div className="asset-row">
            <input
              className="amount-input"
              placeholder="0.0"
              value={amountUI}
              onChange={(e) => {
                const maxDec = fromToken?.decimals ?? 18;
                setAmountUI(sanitizeAmountInput(e.target.value, maxDec));
              }}
              inputMode="decimal"
            />
            <TokenSelect
              label="From"
              chainId={chainId}
              token={fromToken}
              onTokenSelected={(t) => setFromToken(t)}
              showChainPicker
              onChainSelected={selectSourceChain}
            />
          </div>
          <div className="asset-meta-row">
            <span>{fromUsd ? formatUSD(fromUsd) : '-'}</span>
            <div className="asset-balance-tools">
              <button
                type="button"
                className="pill-button"
                disabled={!fromToken || fromBalanceValue === undefined}
                onClick={() => {
                  if (!fromToken || fromBalanceValue === undefined) return;
                  let raw = fromBalanceValue;
                  if (isNativeTokenAddressForChain(chainId, fromToken.address) && nativeGasBuffer > 0n) {
                    raw = raw > nativeGasBuffer ? raw - nativeGasBuffer : 0n;
                  }
                  const maxFraction = Math.min(6, fromToken.decimals);
                  const ui = formatTokenAmount(raw.toString(), fromToken.decimals, maxFraction);
                  setAmountUI(sanitizeAmountInput(ui, fromToken.decimals));
                }}
                title={fromToken && isNativeTokenAddressForChain(chainId, fromToken.address) ? 'Leaves a small amount for gas' : 'Use your full balance'}
              >
                Max
              </button>

              <BalanceLine
                address={fromChainIsSolana ? solanaWallet.publicKey || undefined : address}
                token={fromToken}
                priceUSD={fromPrice}
                balanceRaw={fromBalanceRaw}
                loading={selectedBalancesLoading}
              />
            </div>
          </div>
        </div>

        <div className="switch-row">
          <button
            type="button"
            className="switch-button"
            onClick={async () => {
              if (!fromToken || !toToken) return;

              // Same-chain: just swap tokens.
              if (toChainId === chainId) {
                const a = fromToken;
                setFromToken(toToken);
                setToToken(a);
                return;
              }

              // Cross-chain: swap tokens AND swap source/destination chains.
              const nextFromChainId = toChainId;
              const nextToChainId = chainId;
              suppressTokenResetOnChainChange.current = true;
              suppressToTokenResetOnToChainChange.current = true;
              setFromChainManual(true);
              setToChainManual(true);
              setFromChainId(nextFromChainId);
              setToChainId(nextToChainId);
              setFromToken(toToken);
              setToToken(fromToken);
              setLastTx(null);

              if (isSolanaChain(nextFromChainId)) return;
              if (!isConnected) return;
              if (!switchChainAsync) {
                setUiError('Wallet does not support network switching.');
                return;
              }

              try {
                await switchChainAsync({ chainId: nextFromChainId });
              } catch (e: any) {
                setUiError(e?.shortMessage || e?.message || 'Failed to switch network');
              }
            }}
            title={toChainId !== chainId ? 'Swap sides (will switch network)' : 'Swap tokens'}
          >
            <ArrowDownUp size={18} />
          </button>
        </div>

        <div className="swap-asset-card">
          <div className="asset-label">You receive</div>
          <div className="asset-row">
            <div className="amount-output">
              {quoteBusy ? (
                <span className="amount-output-loading">...</span>
              ) : quote && toToken ? (
                formatTokenAmount(quote.estimate.toAmount, toToken.decimals, 8)
              ) : (
                <span className="amount-output-placeholder">0.0</span>
              )}
            </div>

            <TokenSelect
              label="To"
              chainId={toChainId}
              token={toToken}
              onTokenSelected={(t) => setToToken(t)}
              showChainPicker
              onChainSelected={(id) => {
                setUiError(null);
                setToChainManual(id !== chainId);
                setToChainId(id);
              }}
            />
          </div>
          <div className="asset-meta-row">
            <span>{toUsd ? formatUSD(toUsd) : '-'}</span>
            <BalanceLine
              address={toChainIsSolana ? solanaWallet.publicKey || undefined : address}
              token={toToken}
              priceUSD={toPrice}
              balanceRaw={toBalanceRaw}
              loading={selectedBalancesLoading}
            />
          </div>
        </div>

        <div className="details-grid">
          <div className="detail-card">
            <div className="detail-header">
              <div className="detail-label">Slippage</div>
              <button
                type="button"
                onClick={() => setSlippageAuto((v) => !v)}
                className="pill-button"
                title={slippageAuto ? 'Auto slippage is ON' : 'Auto slippage is OFF'}
              >
                {slippageAuto ? 'Auto' : 'Manual'}
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                className="ui-input"
                type="number"
                min={0.01}
                max={20}
                step={0.01}
                value={slippageUIEffective}
                disabled={slippageAuto}
                onChange={(e) => {
                  if (slippageAuto) return;
                  setSlippageUI(clamp(safeParseFloat(e.target.value), 0.01, 20));
                }}
                onBlur={() => {
                  if (slippageAuto) return;
                  setSlippageUI((v) => clamp(v, 0.01, 20));
                }}
                inputMode="decimal"
              />
              <span className="detail-label">%</span>
            </div>
            <div className="helper-text">Allowed: 0.01% - 20%</div>
            {slippageAuto ? (
              <div className="helper-text">
                Auto is using {autoSlippageUI.toFixed(2).replace(/\.00$/, '')}%
              </div>
            ) : null}
          </div>

          <div className="detail-card">
            <div className="detail-label">Route</div>
            <div className="mt-2">
              <Select
                value={router}
                onChange={(v) => setRouter(v as RouterId)}
                options={routeOptions}
              />
            </div>
            <div className="helper-text select-note">
              {isCrossChain
                ? 'Cross-chain swaps are handled by LiFi. gas.zip is available only when that bridge supports the route.'
                : oneInchEligible
                  ? 'Same-chain EVM swaps can use 1inch Direct or LiFi.'
                  : 'Solana swaps use LiFi Smart Routing. 1inch Direct is EVM same-chain only.'}
              {router === 'auto' && oneInchEligible && (
                <div className="mt-2 font-semibold" style={{ color: 'var(--muted)' }}>
                  {quoteBusy && !quote
                    ? 'Auto is comparing routes...'
                    : `Auto picked: ${effectiveRouter === 'oneinch-direct' ? '1inch Direct' : 'LiFi Smart Routing'}`}
                </div>
              )}
            </div>
          </div>
        </div>

        {quote && (
          <div className="quote-card">
            <div className="quote-grid">
              <div>
                <div className="quote-label">Minimum received (est.)</div>
                <div className="quote-value">
                  {minToAmountStr && toToken
                    ? `${minToAmountStr} ${toToken.symbol}${minToUsd ? ` (${formatUSD(minToUsd)})` : ''}`
                    : '-'}
                </div>

                {isCrossChain ? (
                  <div className="mt-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="quote-muted">Bridge DEX fee (est.)</span>
                      <span className="font-semibold tabular-nums">
                        {bridgeFeeStr
                          ? `${bridgeFeeStr} ${nativeSymbol} (${formatUSD(bridgeFeeUsd)})`
                          : `-`}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="quote-muted">Wallet will send</span>
                      <span className="font-semibold tabular-nums">
                        {totalValueStr ? `${totalValueStr} ${nativeSymbol} (${formatUSD(totalValueUsd)})` : '-'}
                      </span>
                    </div>
                    {bridgeFeeDominates ? (
                      <div className="bridge-warning-text mt-2 text-[11px]">
                        Bridge fee is higher than the swap amount. Cross-chain routes usually need a larger amount.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="quote-side">
                <div className="quote-label">Aggregator</div>
                <div className="quote-value">{aggregatorName(quote.router)}</div>
                <div className="quote-label mt-2">DEX</div>
                <div className="quote-value">{quote.tool || '-'}</div>
              </div>
            </div>

            {quote.estimate.routes?.length ? (
              <div className="mt-3 text-xs">
                <button
                  type="button"
                  className="advanced-button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                >
                  <span>Advanced</span>
                  <ChevronDown
                    className={clsx('h-4 w-4 transition-transform', advancedOpen && 'rotate-180')}
                  />
                </button>

                {advancedOpen ? (
                  <div className="advanced-panel">
                    <div className="mb-1 font-semibold">Liquidity sources</div>
                    <div className="flex flex-wrap gap-2">
                      {quote.estimate.routes.map((r) => (
                        <span
                          key={r.name}
                          className="route-pill"
                          title={`${r.part}%`}
                        >
                          {r.name} - {r.part}%
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {(quoteError || uiError || shareHydrationError || bigDeviation || lowLiquidity || insufficientBalance) && (
          <div
            className={clsx(
              lowLiquidity ? 'danger-box' : 'warning-box',
            )}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5" size={16} />
              <div className="space-y-1">
                {insufficientBalance && (
                  <div>
                    Insufficient {fromToken?.symbol || ''} balance for this amount.
                  </div>
                )}
                {quoteError && (
                  <div>
                    {quoteReason === 'MIN_AMOUNT'
                      ? minAmount
                        ? `Amount too low. Minimum for this pair is ${minAmount.fromAmountFormatted} ${fromToken?.symbol || ''}${
                            minAmount.fromAmountUSD ? ` (about $${minAmount.fromAmountUSD})` : ''
                          }.`
                        : 'Amount too low for this route. Try a larger amount or another route.'
                      : quoteReason === 'NO_LIQUIDITY'
                        ? effectiveRouter === 'gaszip'
                          ? 'This pair is not supported on gas.zip. Try LiFi Smart Routing.'
                          : 'Liquidity not found for this pair.'
                        : quoteError}
                  </div>
                )}
                {uiError && <div>{uiError}</div>}
                {shareHydrationError && <div>{shareHydrationError}</div>}
                {bigDeviation && (
                  <div>
                    Output differs from input USD by ~{priceDeviationPct.toFixed(1)}%. Double-check token addresses and
                    liquidity.
                  </div>
                )}
                {/* lowLiquidity only controls styling/disable; we keep the message single-line above */}
              </div>
            </div>
          </div>
        )}

        <div className="action-stack">
          {needsApproval && !allowanceOk && (
            <button
              type="button"
              className={clsx(
                'outline-action',
                approving && 'opacity-70',
              )}
              onClick={onApprove}
              disabled={!isConnected || !fromChainIsEvm || approving || !fromToken}
            >
              {approving ? 'Approving...' : `Approve ${fromToken?.symbol || ''}`}
            </button>
          )}

          <button
            type="button"
            className={clsx(
              'primary-action',
              (swapPending || receiptBusy) && 'opacity-80',
            )}
            onClick={onSwap}
            disabled={
              (fromChainIsSolana ? !solanaWallet.connected : !isConnected) ||
              missingDualWallet ||
              !quote ||
              !quote.tx ||
              quoteBusy ||
              lowLiquidity ||
              insufficientBalance ||
              (needsApproval && !allowanceOk) ||
              swapPending ||
              receiptBusy
            }
          >
            {swapPending ? 'Confirm in wallet...' : receiptBusy ? 'Waiting for confirmation...' : 'Swap'}
          </button>

          {lastTx?.hash && (
            <div className="tx-card">
              <div className="tx-row">
                <div className="min-w-0">
                  <div className="quote-muted">Tx hash</div>
                  <div className="tx-hash">
                    {txUrl ? (
                      <a href={txUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        {formatHash(lastTx.hash)}
                      </a>
                    ) : (
                      formatHash(lastTx.hash)
                    )}
                  </div>
                </div>
                {receiptConfirmed ? (
                  <span className="status-pill status-pill-success">
                    <CheckCircle2 size={14} />
                    Confirmed
                  </span>
                ) : (
                  <span className="status-pill">Pending</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Dev notes removed for a cleaner production-like UI */}
      </div>
    </div>
  );
}

function BalanceLine({
  address,
  token,
  priceUSD,
  balanceRaw,
  loading,
}: {
  address?: string;
  token: Token | null;
  priceUSD?: number;
  balanceRaw?: string;
  loading?: boolean;
}) {
  if (!address || !token) return <span className="balance-line">Balance: -</span>;
  if (loading && balanceRaw === undefined) return <span className="balance-line">Balance: ...</span>;

  const amount = balanceRaw ? safeParseFloat(formatTokenAmount(balanceRaw, token.decimals, 6)) : 0;
  const usd = priceUSD && priceUSD > 0 ? amount * priceUSD : 0;

  return (
    <span className="balance-line">
      Balance: {balanceRaw !== undefined ? formatTokenAmount(balanceRaw, token.decimals, 6) : '-'}
      {usd > 0 ? ` (${formatUSD(usd)})` : ''}
    </span>
  );
}
