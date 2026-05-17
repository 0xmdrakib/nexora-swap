'use client';

import { Wallet } from 'lucide-react';
import clsx from 'clsx';

import { formatHash } from '@/lib/format';

type Props = {
  providerReady: boolean;
  connected: boolean;
  connecting: boolean;
  publicKey: string | null;
  walletName: string;
  onConnect: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
};

export default function SolanaConnectButton({
  providerReady,
  connected,
  connecting,
  publicKey,
  walletName,
  onConnect,
  onDisconnect,
}: Props) {
  const label = !providerReady
    ? 'Install Phantom'
    : connected && publicKey
      ? `${walletName} ${formatHash(publicKey)}`
      : connecting
        ? 'Connecting...'
        : 'Connect Solana';

  return (
    <button
      type="button"
      className={clsx('control-button wallet-button', !connected && 'wallet-muted')}
      onClick={connected ? onDisconnect : onConnect}
      disabled={connecting}
      title={providerReady ? label : 'Install a browser Solana wallet such as Phantom'}
    >
      <Wallet size={16} className="muted-icon" />
      <span className="max-w-[180px] truncate">{label}</span>
    </button>
  );
}
