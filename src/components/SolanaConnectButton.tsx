'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Wallet } from 'lucide-react';
import clsx from 'clsx';

import { formatWalletAddress } from '@/lib/format';
import type { SolanaWalletProvider } from '@/lib/hooks/useSolanaWallet';

type Props = {
  providerReady: boolean;
  connected: boolean;
  connecting: boolean;
  publicKey: string | null;
  walletName: string;
  walletIcon?: string;
  providers: SolanaWalletProvider[];
  selectedName: string | null;
  onSelectWallet: (walletName: string) => void;
  onConnect: (walletName?: string) => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
  compactAddress?: boolean;
};

export default function SolanaConnectButton({
  providerReady,
  connected,
  connecting,
  publicKey,
  walletName,
  walletIcon,
  providers,
  selectedName,
  onSelectWallet,
  onConnect,
  onDisconnect,
  compactAddress,
}: Props) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shortAddress = formatWalletAddress(publicKey, compactAddress ? 1 : 4);
  const showWalletIcon = connected && Boolean(walletIcon);
  const label = !providerReady
    ? 'Connect Solana'
    : connected && publicKey
      ? shortAddress
      : connecting
        ? 'Connecting...'
        : 'Connect Solana';

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      const el = shellRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    }

    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  async function handlePrimaryClick() {
    if (connected) {
      setOpen((value) => !value);
      return;
    }

    setOpen((value) => !value);
  }

  return (
    <div className="wallet-picker" ref={shellRef}>
      <button
        type="button"
        className={clsx('control-button wallet-button', !connected && 'wallet-muted')}
        onClick={handlePrimaryClick}
        disabled={connecting}
        title={
          providerReady
            ? connected
              ? 'Solana wallet account'
              : 'Choose a Solana wallet'
            : 'Install a Solana wallet such as Phantom, MetaMask, Bitget, Solflare, or Backpack'
        }
      >
        {showWalletIcon ? (
          <img src={walletIcon} alt="" className="wallet-provider-icon" />
        ) : (
          <Wallet size={16} className="muted-icon" />
        )}
        <span className="max-w-[130px] truncate">{label}</span>
        <ChevronDown size={14} className={clsx('muted-icon transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="wallet-menu" role="menu">
          {providers.length ? (
            providers.map((wallet) => {
              const active = wallet.name === selectedName;
              return (
                <button
                  key={wallet.name}
                  type="button"
                  className={clsx('wallet-menu-row', active && 'wallet-menu-row-active')}
                  onClick={async () => {
                    onSelectWallet(wallet.name);
                    setOpen(false);
                    if (!connected || wallet.name !== selectedName) {
                      await onConnect(wallet.name);
                    }
                  }}
                >
                  {wallet.icon ? (
                    <img src={wallet.icon} alt="" className="wallet-provider-icon" />
                  ) : (
                    <Wallet size={16} />
                  )}
                  <span>
                    {active && connected && publicKey
                      ? `${wallet.name} ${formatWalletAddress(publicKey)}`
                      : wallet.name}
                  </span>
                </button>
              );
            })
          ) : (
            <>
              <div className="wallet-menu-empty">
                Install Phantom, MetaMask, Bitget, Solflare, or Backpack to use Solana.
              </div>
              <button
                type="button"
                className="wallet-menu-row"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </>
          )}

          {connected && (
            <button
              type="button"
              className="wallet-menu-row wallet-menu-disconnect"
              onClick={async () => {
                setOpen(false);
                await onDisconnect();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
