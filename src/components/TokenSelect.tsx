'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import { useAccount } from 'wagmi';

import type { Token } from '@/lib/types';
import { CHAIN_META, isSolanaChain } from '@/lib/chainsMeta';
import { addressCacheKey, isNativeTokenAddressForChain, normalizeTokenAddressForChain } from '@/lib/addresses';
import { formatTokenAmount } from '@/lib/format';
import { balanceKey, useTokenBalances } from '@/lib/hooks/useTokenBalances';
import { useTokenList } from '@/lib/hooks/useTokenList';
import { useSolanaWallet } from '@/lib/hooks/useSolanaWallet';

type Props = {
  label?: string;
  chainId: number;
  token: Token | null;
  onTokenSelected: (token: Token) => void;
  showChainPicker?: boolean;
  onChainSelected?: (chainId: number) => void | Promise<void>;
  disabled?: boolean;
};

type WalletToken = {
  token_address: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: string; // raw string
  balanceFormatted?: string; // optional pre-formatted from API
  logo?: string | null;
  thumbnail?: string | null;
};

const POPULAR_SYMBOLS = ['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC'];

function normalizeAddr(addr?: string | null) {
  return (addr || '').toLowerCase();
}

function tokenKey(chainId: number, addr?: string | null) {
  return addressCacheKey(chainId, addr || '');
}

function ChainIcon({ chainId, size = 18 }: { chainId: number; size?: number }) {
  const meta = CHAIN_META[chainId];
  const [broken, setBroken] = useState(false);

  if (!meta || broken) return null;

  // Use <img> to avoid next/image remote domain config for dev zips
  return (
    <img
      src={meta.logoUrl}
      alt={meta.name}
      width={size}
      height={size}
      className="rounded-full"
      onError={() => setBroken(true)}
    />
  );
}

function TokenLogo({ token, chainId, size = 28, fallback }: { token: Token; chainId: number; size?: number; fallback?: string }) {
  const [broken, setBroken] = useState(false);

  const logo =
    isNativeTokenAddressForChain(chainId, token.address) ? CHAIN_META[chainId]?.logoUrl : token.logoURI;

  if (!logo || broken) {
    const letter = (fallback || token.symbol || '?').slice(0, 1).toUpperCase();
    return (
      <div
        style={{ width: size, height: size }}
        className="token-fallback"
        aria-hidden="true"
      >
        {letter}
      </div>
    );
  }

  return (
    <img
      src={logo}
      alt={token.symbol}
      width={size}
      height={size}
      className="rounded-full"
      onError={() => setBroken(true)}
    />
  );
}

function TokenRow({
  chainId,
  token,
  balanceText,
  onPick,
}: {
  chainId: number;
  token: Token;
  balanceText: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="token-row"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <TokenLogo token={token} chainId={chainId} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="token-symbol truncate">{token.symbol}</div>
              <div className="token-name truncate">{token.name}</div>
            </div>
            <div className="token-address truncate">{token.address}</div>
          </div>
        </div>

        <div className="token-balance">
          {balanceText}
        </div>
      </div>
    </button>
  );
}

export default function TokenSelect({
  label,
  chainId,
  token,
  onTokenSelected,
  showChainPicker = false,
  onChainSelected,
  disabled = false,
}: Props) {
  const { address } = useAccount();
  const solanaWallet = useSolanaWallet();
  const { tokens, loading, error, addCustomToken } = useTokenList(chainId);
  const walletAddress = isSolanaChain(chainId) ? solanaWallet.publicKey : address;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [customAddr, setCustomAddr] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);

  const [walletTokens, setWalletTokens] = useState<WalletToken[]>([]);
  const [nativeBalanceRaw, setNativeBalanceRaw] = useState<string | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [chainMenuOpen, setChainMenuOpen] = useState(false);
  const chainMenuRef = useRef<HTMLDivElement | null>(null);

  // When chain changes (including while the modal is open), reset transient UI state immediately.
  // This prevents showing stale tokens/balances until refetch completes.
  useEffect(() => {
    setQuery('');
    setCustomAddr('');
    setCustomError(null);
    setAddingCustom(false);
    setWalletTokens([]);
    setNativeBalanceRaw(null);
  }, [chainId]);

  // When the modal closes, clear the custom contract input so it feels "fresh" next time.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setCustomAddr('');
    setCustomError(null);
    setAddingCustom(false);
    setChainMenuOpen(false);
  }, [open]);

  // Close only the modal's chain menu on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!chainMenuOpen) return;
      const el = chainMenuRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setChainMenuOpen(false);
    }

    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [chainMenuOpen]);

  // Fetch wallet tokens and native balance from Alchemy.
  useEffect(() => {
    let alive = true;
    async function loadWalletTokens() {
      if (!open) return;
      if (!walletAddress) {
        setWalletTokens([]);
        setNativeBalanceRaw(null);
        return;
      }
      setWalletLoading(true);
      try {
        const res = await fetch(`/api/wallet-tokens?chainId=${chainId}&address=${walletAddress}`);
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        if (!alive) return;
        setWalletTokens(Array.isArray(json?.tokens) ? json.tokens : []);
        setNativeBalanceRaw(json?.nativeBalance?.balance ? String(json.nativeBalance.balance) : null);
      } catch {
        if (!alive) return;
        setWalletTokens([]);
        setNativeBalanceRaw(null);
      } finally {
        if (alive) setWalletLoading(false);
      }
    }
    loadWalletTokens();
    return () => {
      alive = false;
    };
  }, [open, walletAddress, chainId]);

  const walletByAddr = useMemo(() => {
    const map = new Map<string, WalletToken>();
    for (const wt of walletTokens) {
      map.set(tokenKey(chainId, wt.token_address), wt);
    }
    return map;
  }, [walletTokens]);

  const walletTokensNonZero = useMemo(() => {
    // The API already filters non-zero, but keep a defensive check here too.
    return walletTokens
      .filter((t) => {
        try {
          return BigInt(t.balance || '0') > 0n;
        } catch {
          return false;
        }
      })
			.flatMap((wt) => {
				const addr = normalizeTokenAddressForChain(chainId, wt.token_address);
				if (!addr) return [];
				return [
					({
						chainId,
						address: addr,
						symbol: wt.symbol,
						name: wt.name,
						decimals: wt.decimals,
						logoURI: wt.logo || wt.thumbnail || undefined,
						balanceRaw: wt.balance,
						balanceFormatted:
							wt.balanceFormatted || formatTokenAmount(wt.balance || '0', wt.decimals || 18, 6),
					}) satisfies Token,
				];
			});
  }, [walletTokens, chainId]);

  const popularTokens = useMemo(() => {
    const list: Token[] = [];
    // include native token (already present in /api/tokens results usually)
    const native = tokens.find((t) => isNativeTokenAddressForChain(chainId, t.address));
    if (native) list.push(native);

  for (const sym of POPULAR_SYMBOLS) {
      const t = tokens.find((x) => x.symbol?.toUpperCase() === sym);
      if (t && !list.some((a) => tokenKey(a.chainId || chainId, a.address) === tokenKey(t.chainId || chainId, t.address))) list.push(t);
    }

    // fallback: if /api/tokens doesn't include native, create one
    if (!native) {
      const meta = CHAIN_META[chainId];
      list.unshift({
        chainId,
        address: meta?.nativeTokenAddress || '0x0000000000000000000000000000000000000000',
        symbol: meta?.nativeSymbol || 'NATIVE',
        name: meta?.name ? `${meta.name} Native` : 'Native Token',
        decimals: meta?.nativeDecimals || 18,
        logoURI: undefined,
      });
    }

    return list;
  }, [tokens, chainId]);

  const remainderTokens = useMemo(() => {
    const seen = new Set<string>();
    for (const t of popularTokens) seen.add(tokenKey(t.chainId || chainId, t.address));
    for (const t of walletTokensNonZero) seen.add(tokenKey(t.chainId || chainId, t.address));
    return tokens.filter((t) => !seen.has(tokenKey(t.chainId || chainId, t.address)));
  }, [tokens, popularTokens, walletTokensNonZero]);

  const allTokensForSearch = useMemo(() => {
    const merged: Token[] = [];
    const push = (t: Token) => {
      const key = tokenKey(t.chainId || chainId, t.address);
      if (!key || merged.some((x) => tokenKey(x.chainId || chainId, x.address) === key)) return;
      merged.push(t);
    };
    popularTokens.forEach(push);
    walletTokensNonZero.forEach(push);
    tokens.forEach(push);
    return merged;
  }, [popularTokens, walletTokensNonZero, tokens]);

  const { balances: exactBalances } = useTokenBalances(
    walletAddress || undefined,
    open ? popularTokens : []
  );

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allTokensForSearch
      .filter((t) => {
        return (
          t.symbol?.toLowerCase().includes(q) ||
          t.name?.toLowerCase().includes(q) ||
          normalizeAddr(t.address).includes(q)
        );
      })
      .slice(0, 80);
  }, [query, allTokensForSearch]);

  function getBalanceText(t: Token) {
    if (isNativeTokenAddressForChain(chainId, t.address)) {
      if (walletLoading) return '-';
      if (!nativeBalanceRaw) return '-';
      return formatTokenAmount(nativeBalanceRaw, CHAIN_META[chainId]?.nativeDecimals || 18);
    }
    const exactRaw = exactBalances[balanceKey(t.chainId || chainId, t.address)];
    if (exactRaw !== undefined) {
      try {
        if (BigInt(exactRaw || '0') > 0n) return formatTokenAmount(exactRaw, t.decimals || 18);
      } catch {
        // Fall back to wallet scan data below.
      }
    }
    const wt = walletByAddr.get(tokenKey(t.chainId || chainId, t.address));
    if (!wt) return '-';
    return formatTokenAmount(wt.balance || '0', wt.decimals || 18);
  }

  async function resolveSelectedToken(t: Token): Promise<Token> {
    const clean = { ...t, priceUSD: undefined, balanceUsd: undefined };
    if (isNativeTokenAddressForChain(chainId, t.address)) return clean;

    const res = await fetch(`/api/token-metadata?chainId=${chainId}&address=${encodeURIComponent(t.address)}`, {
      cache: 'no-store',
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.token?.address) {
      return { ...(json.token as Token), priceUSD: undefined, balanceRaw: t.balanceRaw, balanceFormatted: t.balanceFormatted };
    }

    throw new Error(json?.error || 'Token metadata could not be loaded from Moralis.');
  }

  async function pickToken(t: Token) {
    setCustomError(null);
    try {
      const selected = await resolveSelectedToken(t);
      onTokenSelected(selected);
      setOpen(false);
    } catch (e: any) {
      setCustomError(e?.message || 'Token metadata could not be loaded from Moralis.');
    }
  }

  async function handleAddCustom() {
    setCustomError(null);
    const addr = customAddr.trim();
    const normalized = normalizeTokenAddressForChain(chainId, addr);
    if (!normalized) {
      setCustomError(`Please paste a valid ${CHAIN_META[chainId]?.name || 'chain'} token address.`);
      return;
    }

    setAddingCustom(true);
    try {
      await addCustomToken(normalized);
      setCustomAddr('');
    } catch (e: any) {
      setCustomError(e?.message || 'Failed to add this token on the selected chain.');
    } finally {
      setAddingCustom(false);
    }
  }

  const currentChain = CHAIN_META[chainId];

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={[
          'token-trigger shrink-0',
          disabled ? 'opacity-50' : '',
        ].join(' ')}
        aria-label={label ? `${label}: select token` : 'Select token'}
      >
        {token ? <TokenLogo token={token} chainId={chainId} size={20} /> : <ChainIcon chainId={chainId} size={20} />}
        <span className="max-w-[120px] truncate font-semibold">{token?.symbol || 'Select'}</span>
        <ChevronDown className="h-4 w-4 muted-icon" />
      </button>

      {/* Modal */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          className="modal-overlay"
          onClick={() => setOpen(false)}
        >
          <div
            className="token-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="modal-title">Select token</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="icon-button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="modal-scroll-area">

            {showChainPicker && (
              <div className="token-chain-picker" ref={chainMenuRef}>
                <div className="form-label">Chain</div>
                <div className="relative mt-2">
                  <button
                    type="button"
                    onClick={() => setChainMenuOpen((v) => !v)}
                    className="menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={chainMenuOpen}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ChainIcon chainId={chainId} size={18} />
                      <span className="truncate">{currentChain?.name || `Chain ${chainId}`}</span>
                    </div>
                    <ChevronDown className="h-4 w-4 muted-icon" />
                  </button>

                  {chainMenuOpen && (
                    <div className="floating-menu" role="menu" aria-label="Select token chain">
                      {Object.values(CHAIN_META).map((c) => {
                        const active = c.id === chainId;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={async () => {
                              try {
                                if (!active) await onChainSelected?.(c.id);
                              } finally {
                                setChainMenuOpen(false);
                              }
                            }}
                            className={[
                              'menu-row',
                              active ? 'menu-row-active' : '',
                            ].join(' ')}
                            role="menuitem"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <ChainIcon chainId={c.id} size={18} />
                              <span className="truncate">{c.name}</span>
                            </div>
                            {active && <span className="text-[11px] font-semibold">Selected</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Search */}
            <div className="mt-4">
              <div className="relative">
                <Search className="muted-icon pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, symbol, or address..."
                  className="ui-input search-input"
                />
              </div>
            </div>

            {/* Custom token */}
            <div className="custom-token-box">
              <div className="form-label">Add custom token</div>
              <div className="custom-row mt-2 flex gap-2">
                <input
                  value={customAddr}
                  onChange={(e) => setCustomAddr(e.target.value)}
                    placeholder={isSolanaChain(chainId) ? 'Solana mint address' : '0x...'}
                  className="ui-input"
                />
                <button
                  type="button"
                  onClick={handleAddCustom}
                  disabled={addingCustom}
                  className="secondary-button disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Add</span>
                </button>
              </div>
              {customError && <div className="custom-error mt-2 text-xs">{customError}</div>}
              <div className="helper-text">
                Paste a contract address to add a custom token on the selected chain.
              </div>
            </div>

            {/* Table header */}
            <div className="token-table-header">
              <div>Token</div>
              <div>Balance</div>
            </div>

            <div className="tokens-list">
              {(loading || walletLoading) && (
                <div className="list-status">Loading tokens...</div>
              )}

              {error && (
                <div className="list-status list-status-danger">Failed to load token list.</div>
              )}

              {!loading && !walletLoading && !error && (
                <>
                  {query.trim() ? (
                    <>
                      {searchResults.length === 0 ? (
                        <div className="list-status">No results.</div>
                      ) : (
                        searchResults.map((t) => (
                          <TokenRow
                            key={`${chainId}:${t.address}`}
                            chainId={chainId}
                            token={t}
                            balanceText={getBalanceText(t)}
                            onPick={() => void pickToken(t)}
                          />
                        ))
                      )}
                    </>
                  ) : (
                    <>
                      <div className="section-label">POPULAR</div>
                      {popularTokens.map((t) => (
                        <TokenRow
                          key={`${chainId}:pop:${t.address}`}
                          chainId={chainId}
                          token={t}
                          balanceText={getBalanceText(t)}
                          onPick={() => void pickToken(t)}
                        />
                      ))}

                      <div className="section-label">IN YOUR WALLET</div>
                      {walletTokensNonZero.length === 0 ? (
                        <div className="list-status">No tokens found on this chain.</div>
                      ) : (
                        walletTokensNonZero.map((t) => (
                          <TokenRow
                            key={`${chainId}:wallet:${t.address}`}
                            chainId={chainId}
                            token={t}
                            balanceText={getBalanceText(t)}
                            onPick={() => void pickToken(t)}
                          />
                        ))
                      )}

                      <div className="section-label">ALL TOKENS</div>
                      {remainderTokens.slice(0, 250).map((t) => (
                        <TokenRow
                          key={`${chainId}:rest:${t.address}`}
                          chainId={chainId}
                          token={t}
                          balanceText={getBalanceText(t)}
                          onPick={() => void pickToken(t)}
                        />
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
