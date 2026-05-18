'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Connection, VersionedTransaction } from '@solana/web3.js';

export type SolanaWalletProvider = {
  name: string;
  icon?: string;
  provider: any;
  installed: boolean;
};

type WalletStandardEntry = {
  name?: string;
  icon?: string;
  features?: Record<string, any>;
  accounts?: Array<{ address?: string; publicKey?: Uint8Array }>;
};

type SolanaWalletSnapshot = {
  providers: SolanaWalletProvider[];
  selectedName: string | null;
  providerReady: boolean;
  connected: boolean;
  connecting: boolean;
  publicKey: string | null;
  walletName: string;
  walletIcon?: string;
};

const EMPTY_SNAPSHOT: SolanaWalletSnapshot = {
  providers: [],
  selectedName: null,
  providerReady: false,
  connected: false,
  connecting: false,
  publicKey: null,
  walletName: 'Solana Wallet',
};

let snapshot: SolanaWalletSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
let initialized = false;
let listenerProvider: any | null = null;
let standardWalletUnsubscribe: (() => void) | null = null;
let connection: Connection | null = null;

function getSolanaRpcUrl() {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

function getConnection() {
  if (!connection) connection = new Connection(getSolanaRpcUrl(), 'confirmed');
  return connection;
}

function emit(next: Partial<SolanaWalletSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function getProviderWindow() {
  if (typeof window === 'undefined') return null;
  return window as Window & {
    solana?: any;
    phantom?: { solana?: any };
    solflare?: any;
    backpack?: any;
    glow?: any;
    coinbaseSolana?: any;
    trustwallet?: { solana?: any };
    navigator?: Navigator & {
      wallets?: {
        get?: () => WalletStandardEntry[];
        on?: (event: 'register', listener: (wallet: WalletStandardEntry) => void) => () => void;
      };
    };
  };
}

function providerKey(provider: any, fallback: string) {
  if (!provider) return fallback;
  return provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.() || provider.name || fallback;
}

function nameFromInjectedProvider(provider: any, fallback = 'Solana Wallet') {
  if (!provider) return fallback;
  if (provider.isPhantom) return 'Phantom';
  if (provider.isSolflare) return 'Solflare';
  if (provider.isBackpack) return 'Backpack';
  if (provider.isGlow) return 'Glow';
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider.isTrust) return 'Trust Wallet';
  return provider.name || fallback;
}

function standardPublicKey(wallet: WalletStandardEntry): string | null {
  const account = wallet.accounts?.[0];
  if (account?.address) return account.address;
  return null;
}

function providerFromStandard(wallet: WalletStandardEntry) {
  const connectFeature = wallet.features?.['standard:connect'];
  const disconnectFeature = wallet.features?.['standard:disconnect'];
  const signTxFeature = wallet.features?.['solana:signTransaction'];
  const signAndSendTxFeature = wallet.features?.['solana:signAndSendTransaction'];
  const eventsFeature = wallet.features?.['standard:events'];

  return {
    name: wallet.name || 'Solana Wallet',
    icon: wallet.icon,
    get publicKey() {
      return standardPublicKey(wallet);
    },
    get isConnected() {
      return Boolean(standardPublicKey(wallet));
    },
    connect: async () => {
      if (!connectFeature?.connect) throw new Error(`${wallet.name || 'Wallet'} does not support connect.`);
      const result = await connectFeature.connect();
      const address = result?.accounts?.[0]?.address || standardPublicKey(wallet);
      return { publicKey: address ? { toString: () => address, toBase58: () => address } : null };
    },
    disconnect: async () => {
      await disconnectFeature?.disconnect?.();
    },
    signTransaction: async (tx: VersionedTransaction) => {
      if (!signTxFeature?.signTransaction) {
        throw new Error(`${wallet.name || 'Wallet'} does not support transaction signing.`);
      }
      const [signed] = await signTxFeature.signTransaction({ transaction: tx });
      return signed;
    },
    signAndSendTransaction: signAndSendTxFeature?.signAndSendTransaction,
    on: (event: string, listener: () => void) => {
      if (event !== 'connect' && event !== 'disconnect' && event !== 'accountChanged') return;
      return eventsFeature?.on?.('change', listener);
    },
    off: () => undefined,
  };
}

function candidateProviders(): SolanaWalletProvider[] {
  const w = getProviderWindow();
  if (!w) return [];

  const out: SolanaWalletProvider[] = [];
  const seen = new Set<string>();
  const push = (provider: any, name?: string, icon?: string) => {
    if (!provider) return;
    const walletName = name || nameFromInjectedProvider(provider);
    const key = providerKey(provider, walletName);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: walletName, icon: icon || provider.icon, provider, installed: true });
  };

  push(w.phantom?.solana, 'Phantom');
  push(w.solflare, 'Solflare');
  push(w.backpack, 'Backpack');
  push(w.glow, 'Glow');
  push(w.coinbaseSolana, 'Coinbase Wallet');
  push(w.trustwallet?.solana, 'Trust Wallet');
  push(w.solana);

  const standardWallets = w.navigator?.wallets?.get?.() || [];
  for (const wallet of standardWallets) {
    const chains: string[] = wallet.features?.['standard:chains']?.chains || [];
    const supportsSolana =
      wallet.features?.['solana:signTransaction'] ||
      wallet.features?.['solana:signAndSendTransaction'] ||
      chains.some((chain) => String(chain).startsWith('solana:'));
    if (!supportsSolana) continue;
    push(providerFromStandard(wallet), wallet.name || 'Solana Wallet', wallet.icon);
  }

  return out.sort((a, b) => {
    const order = ['Phantom', 'Solflare', 'Backpack', 'Glow', 'Coinbase Wallet', 'Trust Wallet'];
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function readPublicKey(provider: any) {
  return provider?.publicKey?.toBase58?.() || provider?.publicKey?.toString?.() || null;
}

function syncProvider(provider = currentProvider()) {
  const providers = candidateProviders();
  const key = provider ? readPublicKey(provider) : null;
  const connected = Boolean(provider?.isConnected && key);
  const selectedName = provider ? nameFromInjectedProvider(provider) : snapshot.selectedName;
  const foundSelected =
    (selectedName && providers.find((item) => item.name === selectedName)) ||
    (provider && providers.find((item) => item.provider === provider)) ||
    null;

  emit({
    providers,
    selectedName: foundSelected?.name || selectedName || providers[0]?.name || null,
    providerReady: providers.length > 0,
    connected,
    publicKey: key,
    walletName: foundSelected?.name || nameFromInjectedProvider(provider, 'Solana Wallet'),
    walletIcon: foundSelected?.icon,
  });
}

function syncCurrentProvider() {
  syncProvider(listenerProvider || currentProvider());
}

function currentProvider() {
  const providers = snapshot.providers.length ? snapshot.providers : candidateProviders();
  if (!providers.length) return null;
  const selected = snapshot.selectedName
    ? providers.find((item) => item.name === snapshot.selectedName)
    : null;
  return (selected || providers[0]).provider;
}

function attachProviderListeners(provider: any | null) {
  if (listenerProvider === provider) return;
  if (listenerProvider) {
    listenerProvider.off?.('connect', syncCurrentProvider);
    listenerProvider.off?.('disconnect', syncCurrentProvider);
    listenerProvider.off?.('accountChanged', syncCurrentProvider);
  }
  listenerProvider = provider;
  if (!provider) return;
  provider.on?.('connect', syncCurrentProvider);
  provider.on?.('disconnect', syncCurrentProvider);
  provider.on?.('accountChanged', syncCurrentProvider);
}

function initialize() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  syncProvider(null);
  attachProviderListeners(currentProvider());

  const refresh = () => {
    syncProvider(currentProvider());
    attachProviderListeners(currentProvider());
  };

  window.addEventListener('focus', refresh);
  window.addEventListener('wallet-standard:app-ready', refresh as EventListener);
  window.addEventListener('wallet-standard:register-wallet', refresh as EventListener);

  const wallets = getProviderWindow()?.navigator?.wallets;
  standardWalletUnsubscribe = wallets?.on?.('register', refresh) || null;
}

function getSnapshot() {
  return snapshot;
}

function subscribe(listener: () => void) {
  initialize();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function base64ToBytes(base64: string) {
  if (typeof window === 'undefined') return new Uint8Array();
  const bin = window.atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function connectWallet(walletName?: string) {
  initialize();
  const providers = candidateProviders();
  const entry = walletName
    ? providers.find((item) => item.name === walletName)
    : providers.find((item) => item.name === snapshot.selectedName) || providers[0];
  if (!entry?.provider) throw new Error('No Solana wallet found.');

  emit({
    providers,
    selectedName: entry.name,
    walletName: entry.name,
    walletIcon: entry.icon,
    providerReady: true,
    connecting: true,
  });
  attachProviderListeners(entry.provider);

  try {
    const res = await entry.provider.connect();
    const key =
      res?.publicKey?.toBase58?.() ||
      res?.publicKey?.toString?.() ||
      readPublicKey(entry.provider);
    emit({
      connected: Boolean(key),
      publicKey: key || null,
      walletName: entry.name,
      walletIcon: entry.icon,
    });
    return key || null;
  } finally {
    emit({ connecting: false });
  }
}

async function disconnectWallet() {
  const provider = currentProvider();
  if (!provider) return;
  await provider.disconnect?.();
  emit({ connected: false, publicKey: null });
}

async function sendBase64Transaction(base64: string) {
  const provider = currentProvider();
  if (!provider) throw new Error('Connect a Solana wallet first.');
  const tx = VersionedTransaction.deserialize(base64ToBytes(base64));

  let signed: VersionedTransaction;
  if (provider.signTransaction) {
    signed = await provider.signTransaction(tx);
  } else {
    throw new Error(`${snapshot.walletName || 'Solana wallet'} does not support transaction signing.`);
  }

  return getConnection().sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
}

async function confirmSignature(signature: string) {
  const latest = await getConnection().getLatestBlockhash('confirmed');
  await getConnection().confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );
}

export function useSolanaWallet() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  const selectWallet = useCallback((walletName: string) => {
    const providers = candidateProviders();
    const entry = providers.find((item) => item.name === walletName);
    if (!entry) return;
    emit({
      providers,
      selectedName: entry.name,
      walletName: entry.name,
      walletIcon: entry.icon,
      providerReady: true,
    });
    attachProviderListeners(entry.provider);
    syncProvider(entry.provider);
  }, []);

  const connect = useCallback((walletName?: string) => connectWallet(walletName), []);
  const disconnect = useCallback(() => disconnectWallet(), []);
  const send = useCallback((base64: string) => sendBase64Transaction(base64), []);
  const confirm = useCallback((signature: string) => confirmSignature(signature), []);

  return useMemo(
    () => ({
      ...state,
      selectWallet,
      connect,
      disconnect,
      sendBase64Transaction: send,
      confirmSignature: confirm,
      connection: getConnection(),
    }),
    [state, selectWallet, connect, disconnect, send, confirm],
  );
}

export function cleanupSolanaWalletStoreForTests() {
  standardWalletUnsubscribe?.();
}
