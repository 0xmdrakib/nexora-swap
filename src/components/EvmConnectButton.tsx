'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

import { formatWalletAddress } from '@/lib/format';

type EvmConnector = ReturnType<typeof useConnect>['connectors'][number] & {
  rkDetails?: {
    iconUrl?: string | (() => Promise<string>);
    iconBackground?: string;
    isRainbowKitConnector?: boolean;
    isWalletConnectModalConnector?: boolean;
    installed?: boolean;
    rdns?: string;
  };
  icon?: string;
  uid?: string;
  rdns?: string | readonly string[];
  isRainbowKitConnector?: boolean;
  isWalletConnectModalConnector?: boolean;
};

type Props = {
  onError?: (message: string) => void;
  compactAddress?: boolean;
};

const WALLETCONNECT_ICON =
  'data:image/svg+xml,%3Csvg%20width%3D%22256%22%20height%3D%22256%22%20viewBox%3D%220%200%20256%20256%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20rx%3D%2256%22%20fill%3D%22%233B99FC%22%2F%3E%3Cpath%20d%3D%22M76.8%20101.9C105.1%2074.3%20150.9%2074.3%20179.2%20101.9L184.4%20107C186.6%20109.1%20186.6%20112.6%20184.4%20114.7L166.5%20132.2C165.4%20133.2%20163.7%20133.2%20162.6%20132.2L155.4%20125.2C140.3%20110.5%20115.7%20110.5%20100.6%20125.2L93.4%20132.2C92.3%20133.2%2090.6%20133.2%2089.5%20132.2L71.6%20114.7C69.4%20112.6%2069.4%20109.1%2071.6%20107L76.8%20101.9Z%22%20fill%3D%22white%22%2F%3E%3C%2Fsvg%3E';

function isDataImage(value?: string) {
  return Boolean(value && value.startsWith('data:image'));
}

function isWalletConnect(connector: EvmConnector) {
  return connector.id === 'walletConnect' || Boolean(connector.rkDetails?.isWalletConnectModalConnector || connector.isWalletConnectModalConnector);
}

function isInstalledConnector(connector: EvmConnector) {
  if (isWalletConnect(connector)) return false;
  if (isEip6963Connector(connector)) return true;
  const installed = connector.rkDetails?.installed ?? (connector as any).installed;
  return installed === true;
}

function isEip6963Connector(connector: EvmConnector) {
  return Boolean(
    !connector.isRainbowKitConnector &&
      !connector.rkDetails?.isRainbowKitConnector &&
      connector.uid &&
      connector.name &&
      isDataImage(connector.icon),
  );
}

function connectorIdentity(connector: EvmConnector) {
  const rdns = Array.isArray(connector.rdns) ? connector.rdns[0] : connector.rdns;
  return String(connector.rkDetails?.rdns || rdns || connector.id || connector.name).toLowerCase();
}

function uniqueConnectors(connectors: EvmConnector[]) {
  const out: EvmConnector[] = [];
  const seen = new Set<string>();

  for (const connector of connectors) {
    const genericInjected = connector.name.toLowerCase() === 'injected' || connector.id === 'injected';
    const key = genericInjected ? `generic:${connector.id}` : connectorIdentity(connector);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(connector);
  }

  const specific = out.filter((connector) => !(connector.name.toLowerCase() === 'injected' || connector.id === 'injected'));
  return specific.length ? specific : out.slice(0, 1);
}

async function iconForConnector(connector: EvmConnector) {
  const icon = connector.rkDetails?.iconUrl || connector.icon;
  if (typeof icon === 'function') return icon();
  if (typeof icon === 'string' && icon) return icon;
  if (isWalletConnect(connector)) return WALLETCONNECT_ICON;
  return '';
}

export default function EvmConnectButton({ onError, compactAddress }: Props) {
  const { address, connector, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const shellRef = useRef<HTMLDivElement | null>(null);
  const currentConnector = connector as EvmConnector | undefined;

  const installedConnectors = useMemo(
    () => uniqueConnectors((connectors as EvmConnector[]).filter(isInstalledConnector)),
    [connectors],
  );
  const walletConnectConnector = useMemo(
    () => (connectors as EvmConnector[]).find(isWalletConnect) || null,
    [connectors],
  );
  const activeIcon = currentConnector ? icons[currentConnector.uid || currentConnector.id] || currentConnector.icon : '';
  const shortAddress = formatWalletAddress(address, compactAddress ? 1 : 4);

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

  useEffect(() => {
    let alive = true;
    async function loadIcons() {
      const next: Record<string, string> = {};
      await Promise.all(
        (connectors as EvmConnector[]).map(async (item) => {
          const icon = await iconForConnector(item).catch(() => '');
          if (icon) next[item.uid || item.id] = icon;
        }),
      );
      if (alive) setIcons(next);
    }
    loadIcons();
    return () => {
      alive = false;
    };
  }, [connectors]);

  async function connectConnector(nextConnector: EvmConnector) {
    try {
      setOpen(false);
      await connectAsync({ connector: nextConnector });
    } catch (e: any) {
      onError?.(e?.shortMessage || e?.message || 'Failed to connect EVM wallet');
    }
  }

  async function disconnectWallet() {
    try {
      setOpen(false);
      await disconnectAsync();
    } catch (e: any) {
      onError?.(e?.shortMessage || e?.message || 'Failed to disconnect EVM wallet');
    }
  }

  return (
    <div className="wallet-picker" ref={shellRef}>
      <button
        type="button"
        className={clsx('control-button wallet-button', !isConnected && 'wallet-muted')}
        onClick={() => setOpen((value) => !value)}
        disabled={isPending}
        title={isConnected ? 'EVM wallet account' : 'Choose an EVM wallet'}
      >
        {isConnected && activeIcon ? (
          <img src={activeIcon} alt="" className="wallet-provider-icon" />
        ) : (
          <Wallet size={16} className="muted-icon" />
        )}
        <span className="max-w-[130px] truncate">
          {isPending ? 'Connecting...' : isConnected && address ? shortAddress : 'Connect EVM'}
        </span>
        <ChevronDown size={14} className={clsx('muted-icon transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="wallet-menu evm-wallet-menu" role="menu">
          {installedConnectors.length ? (
            installedConnectors.map((item) => {
              const key = item.uid || item.id;
              const active = currentConnector?.uid === item.uid || currentConnector?.id === item.id;
              return (
                <button
                  key={key}
                  type="button"
                  className={clsx('wallet-menu-row', active && 'wallet-menu-row-active')}
                  onClick={() => connectConnector(item)}
                >
                  {icons[key] ? (
                    <img src={icons[key]} alt="" className="wallet-provider-icon" />
                  ) : (
                    <Wallet size={16} />
                  )}
                  <span>{item.name}</span>
                </button>
              );
            })
          ) : (
            <div className="wallet-menu-empty">
              No injected EVM wallet detected in this browser.
            </div>
          )}

          {isConnected && (
            <button
              type="button"
              className="wallet-menu-row wallet-menu-disconnect"
              onClick={disconnectWallet}
            >
              Disconnect
            </button>
          )}

          {walletConnectConnector && (
            <button
              type="button"
              className="wallet-menu-row wallet-menu-walletconnect"
              onClick={() => connectConnector(walletConnectConnector)}
            >
              {icons[walletConnectConnector.uid || walletConnectConnector.id] ? (
                <img
                  src={icons[walletConnectConnector.uid || walletConnectConnector.id]}
                  alt=""
                  className="wallet-provider-icon"
                />
              ) : (
                <Wallet size={16} />
              )}
              <span>WalletConnect</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
