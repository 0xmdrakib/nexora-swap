'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export type SolanaWalletProvider = {
  id: string;
  name: string;
  icon?: string;
  provider: any;
  installed: boolean;
};

type WalletStandardEntry = {
  name?: string;
  icon?: string;
  chains?: string[];
  features?: Record<string, any>;
  accounts?: WalletStandardAccount[];
};

type WalletStandardAccount = {
  address?: string;
  publicKey?: Uint8Array;
  chains?: string[];
};

type WalletStandardRegisterApi = {
  register: (...wallets: WalletStandardEntry[]) => void;
};

type WalletStandardRegisterCallback = (api: WalletStandardRegisterApi) => void;

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
let standardWalletEventsAttached = false;
let standardWalletAppReadyDispatched = false;
let standardWallets: WalletStandardEntry[] = [];
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
    bitkeep?: { solana?: any };
    bitgetWallet?: { solana?: any };
    ethereum?: any;
    metamask?: { solana?: any };
    navigator?: Navigator & {
      wallets?:
        | {
            get?: () => WalletStandardEntry[];
            on?: (event: 'register', listener: (wallet: WalletStandardEntry) => void) => () => void;
          }
        | Array<WalletStandardEntry | WalletStandardRegisterCallback>;
    };
  };
}

function standardWalletKey(wallet: WalletStandardEntry) {
  return `${wallet.name || 'Solana Wallet'}:${wallet.icon || ''}`;
}

function registerStandardWallets(...wallets: WalletStandardEntry[]) {
  let changed = false;
  for (const wallet of wallets) {
    if (!wallet?.features) continue;
    const key = standardWalletKey(wallet);
    if (standardWallets.some((item) => item === wallet || standardWalletKey(item) === key)) continue;
    standardWallets.push(wallet);
    changed = true;
  }
  return changed;
}

function makeStandardRegisterApi(onChange?: () => void): WalletStandardRegisterApi {
  return {
    register: (...wallets: WalletStandardEntry[]) => {
      if (registerStandardWallets(...wallets)) onChange?.();
    },
  };
}

function collectDeprecatedStandardWallets(onChange?: () => void) {
  const wallets = getProviderWindow()?.navigator?.wallets as any;
  if (!wallets) return;

  const api = makeStandardRegisterApi(onChange);
  if (Array.isArray(wallets)) {
    for (const item of wallets) {
      if (typeof item === 'function') item(api);
      else api.register(item);
    }
    return;
  }

  if (typeof wallets.get === 'function') {
    const current = wallets.get();
    if (Array.isArray(current)) api.register(...current);
  }

  if (!standardWalletUnsubscribe && typeof wallets.on === 'function') {
    standardWalletUnsubscribe = wallets.on('register', (wallet: WalletStandardEntry) => {
      api.register(wallet);
    });
  }
}

function ensureWalletStandardEvents(onChange?: () => void) {
  const w = getProviderWindow();
  if (!w) return;

  const api = makeStandardRegisterApi(onChange);
  collectDeprecatedStandardWallets(onChange);

  if (!standardWalletEventsAttached) {
    const onRegister = (event: Event) => {
      const detail = (event as CustomEvent<WalletStandardRegisterCallback>).detail;
      if (typeof detail === 'function') detail(api);
    };

    w.addEventListener('wallet-standard:register-wallet', onRegister as EventListener);
    standardWalletEventsAttached = true;
  }

  if (!standardWalletAppReadyDispatched) {
    standardWalletAppReadyDispatched = true;
    w.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  }
}

function currentStandardWallets() {
  collectDeprecatedStandardWallets();
  return standardWallets;
}

function providerKey(provider: any, fallback: string) {
  if (!provider) return fallback;
  return provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.() || provider.name || fallback;
}

function providerPublicKey(provider: any): string | null {
  return provider?.publicKey?.toBase58?.() || provider?.publicKey?.toString?.() || null;
}

function providerFlags(provider: any) {
  const raw = [
    provider?.name,
    provider?.walletName,
    provider?.providerName,
    provider?.appName,
    provider?._walletName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return {
    raw,
    isBitget:
      Boolean(provider?.isBitget || provider?.isBitgetWallet || provider?.isBitKeep || provider?.isBitKeepWallet) ||
      raw.includes('bitget') ||
      raw.includes('bitkeep'),
    isMetaMask:
      Boolean(provider?.isMetaMask || provider?.isMetaMaskWallet) ||
      raw.includes('metamask') ||
      raw.includes('meta mask'),
  };
}

function nameFromInjectedProvider(provider: any, fallback = 'Solana Wallet') {
  if (!provider) return fallback;
  const flags = providerFlags(provider);
  if (flags.isBitget) return 'Bitget Wallet';
  if (flags.isMetaMask) return 'MetaMask';
  if (provider.isPhantom) return 'Phantom';
  if (provider.isSolflare) return 'Solflare';
  if (provider.isBackpack) return 'Backpack';
  if (provider.isGlow) return 'Glow';
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider.isTrust) return 'Trust Wallet';
  return provider.name || fallback;
}

function publicKeyStringFromAccount(account?: WalletStandardAccount | null): string | null {
  if (account?.address) return account.address;
  if (account?.publicKey) return bs58.encode(account.publicKey);
  return null;
}

function standardPublicKey(wallet: WalletStandardEntry): string | null {
  return publicKeyStringFromAccount(wallet.accounts?.[0]);
}

function standardSolanaChain(wallet: WalletStandardEntry, account?: WalletStandardAccount | null) {
  return (
    account?.chains?.find((chain) => String(chain).startsWith('solana:')) ||
    wallet.chains?.find((chain) => String(chain).startsWith('solana:')) ||
    'solana:mainnet'
  );
}

function standardSignedTransactionFromResult(result: any) {
  const signed =
    (Array.isArray(result) ? result[0]?.signedTransaction : result?.signedTransaction) ||
    result?.transaction ||
    result;

  if (signed instanceof VersionedTransaction) return signed;
  if (signed?.serialize) return signed as VersionedTransaction;
  if (signed instanceof Uint8Array) return VersionedTransaction.deserialize(signed);
  if (Array.isArray(signed)) return VersionedTransaction.deserialize(Uint8Array.from(signed));
  throw new Error('Wallet did not return a signed Solana transaction.');
}

function standardSignatureFromResult(result: any) {
  const signature = (Array.isArray(result) ? result[0]?.signature : result?.signature) || result;
  if (typeof signature === 'string') return signature;
  if (signature instanceof Uint8Array) return bs58.encode(signature);
  if (Array.isArray(signature)) return bs58.encode(Uint8Array.from(signature));
  throw new Error('Wallet did not return a Solana transaction signature.');
}

function providerFromStandard(wallet: WalletStandardEntry) {
  const connectFeature = wallet.features?.['standard:connect'];
  const disconnectFeature = wallet.features?.['standard:disconnect'];
  const signTxFeature = wallet.features?.['solana:signTransaction'];
  const signAndSendTxFeature = wallet.features?.['solana:signAndSendTransaction'];
  const eventsFeature = wallet.features?.['standard:events'];
  let activeAccount: WalletStandardAccount | null = wallet.accounts?.[0] || null;

  const readAccount = () => wallet.accounts?.[0] || activeAccount;
  const transactionInput = (tx: VersionedTransaction) => {
    const account = readAccount();
    if (!account) throw new Error(`${wallet.name || 'Wallet'} is not connected.`);
    return {
      transaction: tx.serialize(),
      account,
      chain: standardSolanaChain(wallet, account),
    };
  };

  return {
    name: wallet.name || 'Solana Wallet',
    icon: wallet.icon,
    _walletStandardName: wallet.name || 'Solana Wallet',
    get publicKey() {
      return publicKeyStringFromAccount(readAccount());
    },
    get isConnected() {
      return Boolean(publicKeyStringFromAccount(readAccount()));
    },
    connect: async () => {
      if (!connectFeature?.connect) throw new Error(`${wallet.name || 'Wallet'} does not support connect.`);
      const result = await connectFeature.connect();
      activeAccount = result?.accounts?.[0] || wallet.accounts?.[0] || activeAccount;
      const address = publicKeyStringFromAccount(activeAccount);
      return { publicKey: address ? { toString: () => address, toBase58: () => address } : null };
    },
    disconnect: async () => {
      await disconnectFeature?.disconnect?.();
      activeAccount = null;
    },
    signTransaction: async (tx: VersionedTransaction) => {
      if (!signTxFeature?.signTransaction) {
        throw new Error(`${wallet.name || 'Wallet'} does not support transaction signing.`);
      }
      return standardSignedTransactionFromResult(
        await signTxFeature.signTransaction(transactionInput(tx)),
      );
    },
    signAndSendTransaction: signAndSendTxFeature?.signAndSendTransaction
      ? async (tx: VersionedTransaction) => ({
        signature: standardSignatureFromResult(
          await signAndSendTxFeature.signAndSendTransaction(transactionInput(tx)),
        ),
      })
      : undefined,
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
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const seenProviders = new Set<any>();
  const push = (provider: any, name?: string, icon?: string, id?: string) => {
    if (!provider) return;
    const walletName = name || nameFromInjectedProvider(provider);
    const nameKey = walletName.toLowerCase();
    const key = id || walletName.toLowerCase();
    if (seenIds.has(key)) return;
    if (nameKey !== 'solana wallet' && seenNames.has(nameKey)) return;
    if (seenProviders.has(provider)) return;
    seenIds.add(key);
    seenNames.add(nameKey);
    seenProviders.add(provider);
    out.push({ id: key, name: walletName, icon: icon || provider.icon, provider, installed: true });
  };

  const standardWalletEntries = currentStandardWallets();
  for (const wallet of standardWalletEntries) {
    const chains: string[] = [
      ...(wallet.chains || []),
      ...((wallet.accounts || []).flatMap((account) => account.chains || [])),
    ];
    const supportsSolana =
      wallet.features?.['solana:signTransaction'] ||
      wallet.features?.['solana:signAndSendTransaction'] ||
      chains.some((chain) => String(chain).startsWith('solana:'));
    if (!supportsSolana) continue;
    const standardName = wallet.name || 'Solana Wallet';
    push(providerFromStandard(wallet), standardName, wallet.icon, `standard:${standardName.toLowerCase()}`);
  }

  push(w.bitgetWallet?.solana, 'Bitget Wallet', undefined, 'injected:bitget');
  push(w.bitkeep?.solana, 'Bitget Wallet', undefined, 'injected:bitget');
  push(w.metamask?.solana, 'MetaMask', undefined, 'injected:metamask');
  push(w.phantom?.solana, 'Phantom', undefined, 'injected:phantom');
  push(w.solflare, 'Solflare', undefined, 'injected:solflare');
  push(w.backpack, 'Backpack', undefined, 'injected:backpack');
  push(w.glow, 'Glow', undefined, 'injected:glow');
  push(w.coinbaseSolana, 'Coinbase Wallet', undefined, 'injected:coinbase');
  push(w.trustwallet?.solana, 'Trust Wallet', undefined, 'injected:trust');
  push(w.solana, undefined, undefined, `injected:${nameFromInjectedProvider(w.solana).toLowerCase()}`);

  return out.sort((a, b) => {
    const order = ['MetaMask', 'Bitget Wallet', 'Phantom', 'Solflare', 'Backpack', 'Glow', 'Coinbase Wallet', 'Trust Wallet'];
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function readPublicKey(provider: any) {
  return providerPublicKey(provider);
}

function syncProvider(provider = currentProvider()) {
  const providers = candidateProviders();
  const key = provider ? readPublicKey(provider) : null;
  const connected = Boolean(provider?.isConnected && key);
  const selectedName =
    provider?._walletStandardName ||
    (provider ? nameFromInjectedProvider(provider) : snapshot.selectedName);
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

  const refresh = () => {
    syncProvider(currentProvider());
    attachProviderListeners(currentProvider());
  };

  ensureWalletStandardEvents(refresh);
  syncProvider(null);
  attachProviderListeners(currentProvider());

  window.addEventListener('focus', refresh);
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
  } catch (e: any) {
    const message = String(e?.message || e?.reason || e?.error || '');
    if (/plugin closed/i.test(message)) {
      throw new Error(`${entry.name} connection was closed. Open the wallet extension and try again.`);
    }
    throw e;
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

  if (provider.signTransaction) {
    const signed: VersionedTransaction = await provider.signTransaction(tx);
    return getConnection().sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }

  if (provider.signAndSendTransaction) {
    const result = await provider.signAndSendTransaction(tx);
    return standardSignatureFromResult(result);
  }

  throw new Error(`${snapshot.walletName || 'Solana wallet'} does not support transaction signing.`);
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
