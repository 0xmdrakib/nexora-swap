'use client';

import { useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

function getSolanaRpcUrl() {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

function getProvider(): any | null {
  if (typeof window === 'undefined') return null;
  const anyWindow = window as Window & {
    solana?: any;
    phantom?: { solana?: any };
  };
  return anyWindow.solana || anyWindow.phantom?.solana || null;
}

function base64ToBytes(base64: string) {
  if (typeof window === 'undefined') return new Uint8Array();
  const bin = window.atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function useSolanaWallet() {
  const [providerReady, setProviderReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string>('Solana Wallet');

  useEffect(() => {
    const provider = getProvider();
    setProviderReady(Boolean(provider));

    if (!provider) return;

    const sync = () => {
      try {
        const key = provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.() || null;
        setPublicKey(key);
        setConnected(Boolean(provider.isConnected && key));
        setWalletName(provider.isPhantom ? 'Phantom' : provider.isSolflare ? 'Solflare' : 'Solana Wallet');
      } catch {
        setPublicKey(null);
        setConnected(false);
      }
    };

    sync();
    provider.on?.('connect', sync);
    provider.on?.('disconnect', sync);
    provider.on?.('accountChanged', sync);

    return () => {
      provider.off?.('connect', sync);
      provider.off?.('disconnect', sync);
      provider.off?.('accountChanged', sync);
    };
  }, []);

  const connection = useMemo(() => new Connection(getSolanaRpcUrl(), 'confirmed'), []);

  async function connect() {
    const provider = getProvider();
    if (!provider) throw new Error('No Solana wallet found.');
    setConnecting(true);
    try {
      const res = await provider.connect();
      const key = res?.publicKey?.toBase58?.() || provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.();
      setPublicKey(key || null);
      setConnected(Boolean(key));
      setWalletName(provider.isPhantom ? 'Phantom' : provider.isSolflare ? 'Solflare' : 'Solana Wallet');
      return key || null;
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    const provider = getProvider();
    if (!provider) return;
    await provider.disconnect?.();
    setConnected(false);
    setPublicKey(null);
  }

  async function sendBase64Transaction(base64: string) {
    const provider = getProvider();
    if (!provider) throw new Error('Connect a Solana wallet first.');
    const tx = VersionedTransaction.deserialize(base64ToBytes(base64));
    const signed = await provider.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    return signature;
  }

  async function confirmSignature(signature: string) {
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );
  }

  return {
    providerReady,
    connected,
    connecting,
    publicKey,
    walletName,
    connect,
    disconnect,
    sendBase64Transaction,
    confirmSignature,
    connection,
  };
}
