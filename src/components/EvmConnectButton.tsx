'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LogOut, Wallet } from 'lucide-react';
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
  'data:image/svg+xml,%3Csvg%20width%3D%2228%22%20height%3D%2228%22%20viewBox%3D%220%200%2028%2028%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%3Crect%20width%3D%2228%22%20height%3D%2228%22%20fill%3D%22%233B99FC%22%2F%3E%0A%3Cpath%20d%3D%22M8.38969%2010.3739C11.4882%207.27538%2016.5118%207.27538%2019.6103%2010.3739L19.9832%2010.7468C20.1382%2010.9017%2020.1382%2011.1529%2019.9832%2011.3078L18.7076%2012.5835C18.6301%2012.6609%2018.5045%2012.6609%2018.4271%2012.5835L17.9139%2012.0703C15.7523%209.9087%2012.2477%209.9087%2010.0861%2012.0703L9.53655%2012.6198C9.45909%2012.6973%209.3335%2012.6973%209.25604%2012.6198L7.98039%2011.3442C7.82547%2011.1893%207.82547%2010.9381%207.98039%2010.7832L8.38969%2010.3739ZM22.2485%2013.012L23.3838%2014.1474C23.5387%2014.3023%2023.5387%2014.5535%2023.3838%2014.7084L18.2645%2019.8277C18.1096%2019.9827%2017.8584%2019.9827%2017.7035%2019.8277C17.7035%2019.8277%2017.7035%2019.8277%2017.7035%2019.8277L14.0702%2016.1944C14.0314%2016.1557%2013.9686%2016.1557%2013.9299%2016.1944C13.9299%2016.1944%2013.9299%2016.1944%2013.9299%2016.1944L10.2966%2019.8277C10.1417%2019.9827%209.89053%2019.9827%209.73561%2019.8278C9.7356%2019.8278%209.7356%2019.8277%209.7356%2019.8277L4.61619%2014.7083C4.46127%2014.5534%204.46127%2014.3022%204.61619%2014.1473L5.75152%2013.012C5.90645%2012.857%206.15763%2012.857%206.31255%2013.012L9.94595%2016.6454C9.98468%2016.6841%2010.0475%2016.6841%2010.0862%2016.6454C10.0862%2016.6454%2010.0862%2016.6454%2010.0862%2016.6454L13.7194%2013.012C13.8743%2012.857%2014.1255%2012.857%2014.2805%2013.012C14.2805%2013.012%2014.2805%2013.012%2014.2805%2013.012L17.9139%2016.6454C17.9526%2016.6841%2018.0154%2016.6841%2018.0541%2016.6454L21.6874%2013.012C21.8424%2012.8571%2022.0936%2012.8571%2022.2485%2013.012Z%22%20fill%3D%22white%22%2F%3E%0A%3C%2Fsvg%3E%0A';
const METAMASK_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2228%22%20height%3D%2228%22%20fill%3D%22none%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3Cg%20clip-path%3D%22url(%23a)%22%3E%3Cpath%20fill%3D%22%23ff5c16%22%20d%3D%22m24.024%2023.824-4.846-1.434-3.655%202.172-2.55-.001-3.656-2.171-4.844%201.434L3%2018.88l1.473-5.488L3%208.751%204.473%203l7.569%204.496h4.413L24.024%203l1.473%205.751-1.473%204.64%201.473%205.488z%22%2F%3E%3Cpath%20fill%3D%22%23ff5c16%22%20d%3D%22m4.474%203%207.57%204.499-.302%203.087zm4.844%2015.881%203.33%202.522-3.33.987zm3.064-4.17-.64-4.123-4.097%202.804h-.002v.001l.013%202.886%201.661-1.567zM24.024%203l-7.57%204.499.3%203.087zM19.18%2018.881l-3.33%202.522%203.33.987zm1.674-5.488v-.002zl-4.097-2.804-.64%204.124h3.064l1.662%201.567z%22%2F%3E%3Cpath%20fill%3D%22%23e34807%22%20d%3D%22m9.317%2022.39-4.844%201.434L3%2018.881h6.317zm3.064-7.68.925%205.962-1.282-3.315-4.37-1.078%201.662-1.568zm6.799%207.68%204.844%201.434%201.473-4.943H19.18zm-3.064-7.68-.925%205.962%201.282-3.315%204.37-1.078-1.663-1.568z%22%2F%3E%3Cpath%20fill%3D%22%23ff8d5d%22%20d%3D%22m3%2018.88%201.473-5.489h3.169l.012%202.887%204.37%201.078%201.282%203.314-.659.73-3.33-2.522H3zm22.497%200-1.473-5.489h-3.17l-.01%202.887-4.371%201.078-1.282%203.314.659.73%203.33-2.522h6.317zM16.455%207.495h-4.413l-.3%203.087%201.565%2010.084h1.884l1.565-10.084z%22%2F%3E%3Cpath%20fill%3D%22%23661800%22%20d%3D%22M4.473%203%203%208.751l1.473%204.64h3.169l4.1-2.805zm6.992%2012.908H10.03l-.781.761%202.776.685-.56-1.447M24.024%203l1.473%205.751-1.473%204.64h-3.17l-4.098-2.805zm-6.99%2012.908h1.437l.782.762-2.78.686.56-1.45zm-1.512%206.687.328-1.193-.66-.73h-1.885l-.659.73.327%201.192%22%2F%3E%3Cpath%20fill%3D%22%23c0c4cd%22%20d%3D%22M15.522%2022.594v1.969h-2.548v-1.969z%22%2F%3E%3Cpath%20fill%3D%22%23e7ebf6%22%20d%3D%22m9.318%2022.388%203.658%202.174v-1.969l-.328-1.192zm9.862%200-3.658%202.174v-1.969l.328-1.192z%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3CclipPath%20id%3D%22a%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M3%203h22.5v21.563H3z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E';

const RABBY_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2028%2028%22%3E%3Cg%20clip-path%3D%22url(%23a)%22%3E%3Cpath%20fill%3D%22%238697FF%22%20d%3D%22M28%200H0v28h28V0Z%22%2F%3E%3Cpath%20fill%3D%22url(%23b)%22%20d%3D%22M22.54%2015.078c.677-1.514-2.673-5.744-5.874-7.506-2.017-1.365-4.12-1.178-4.545-.579-.935%201.316%203.094%202.43%205.788%203.731-.58.252-1.125.703-1.446%201.28-1.004-1.096-3.209-2.04-5.796-1.28-1.743.513-3.191%201.721-3.751%203.546a1.097%201.097%200%201%200-.445%202.1c.112%200%20.463-.075.463-.075l5.612.041c-2.244%203.56-4.018%204.081-4.018%204.698s1.697.45%202.335.22c3.05-1.1%206.327-4.531%206.89-5.519%202.36.295%204.345.33%204.786-.657Z%22%2F%3E%3Cpath%20fill%3D%22url(%23c)%22%20fill-rule%3D%22evenodd%22%20d%3D%22m17.885%2010.713.025.01c.125-.049.105-.233.07-.378-.078-.333-1.438-1.676-2.715-2.277-1.743-.82-3.025-.777-3.212-.398.356.726%201.998%201.408%203.714%202.12.723.3%201.46.606%202.118.923Z%22%20clip-rule%3D%22evenodd%22%2F%3E%3Cpath%20fill%3D%22url(%23d)%22%20fill-rule%3D%22evenodd%22%20d%3D%22M15.701%2018.036a10.296%2010.296%200%200%200-1.2-.37c.482-.862.583-2.138.128-2.945-.639-1.133-1.44-1.736-3.304-1.736-1.024%200-3.783.346-3.832%202.648-.005.242%200%20.464.017.667l5.036.037a17.264%2017.264%200%200%201-1.871%202.483c.669.172%201.221.316%201.728.448.48.125.92.24%201.38.357a21.003%2021.003%200%200%200%201.918-1.59Z%22%20clip-rule%3D%22evenodd%22%2F%3E%3Cpath%20fill%3D%22url(%23e)%22%20d%3D%22M6.848%2016.063c.206%201.75%201.2%202.435%203.232%202.638%202.032.203%203.197.067%204.749.208%201.296.118%202.453.778%202.882.55.386-.205.17-.947-.347-1.423-.67-.617-1.597-1.046-3.229-1.199.325-.89.234-2.138-.27-2.817-.731-.982-2.079-1.426-3.785-1.232-1.782.202-3.49%201.08-3.232%203.275Z%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22b%22%20x1%3D%2210.464%22%20x2%3D%2222.394%22%20y1%3D%2213.737%22%20y2%3D%2217.12%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23fff%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23fff%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22c%22%20x1%3D%2220.386%22%20x2%3D%2211.779%22%20y1%3D%2213.509%22%20y2%3D%224.879%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%237258DC%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23797DEA%22%20stop-opacity%3D%220%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22d%22%20x1%3D%2215.94%22%20x2%3D%227.673%22%20y1%3D%2218.337%22%20y2%3D%2213.584%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%237461EA%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23BFC2FF%22%20stop-opacity%3D%220%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22e%22%20x1%3D%2211.177%22%20x2%3D%2216.765%22%20y1%3D%2213.648%22%20y2%3D%2220.749%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23fff%22%2F%3E%3Cstop%20offset%3D%22.984%22%20stop-color%3D%22%23D5CEFF%22%2F%3E%3C%2FlinearGradient%3E%3CclipPath%20id%3D%22a%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h28v28H0z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E';

function connectorRdns(connector: EvmConnector) {
  const rdns = Array.isArray(connector.rdns) ? connector.rdns[0] : connector.rdns;
  return connector.rkDetails?.rdns || rdns || '';
}

function connectorIdentity(connector: EvmConnector) {
  return String(
    connectorRdns(connector) ||
      connector.id ||
      connector.name ||
      connector.uid ||
      'connector',
  ).toLowerCase();
}

function connectorKey(connector: EvmConnector) {
  return String(connector.uid || connectorIdentity(connector)).toLowerCase();
}

function isGenericInjectedConnector(connector: EvmConnector) {
  const name = connector.name.toLowerCase();
  return name === 'injected' || connector.id === 'injected';
}

function isWalletConnect(connector: EvmConnector) {
  return connector.id === 'walletConnect' || Boolean(connector.rkDetails?.isWalletConnectModalConnector || connector.isWalletConnectModalConnector);
}

function isWalletConnectModal(connector: EvmConnector) {
  return connector.id === 'walletConnect' && Boolean(connector.rkDetails?.isWalletConnectModalConnector || connector.isWalletConnectModalConnector);
}

function isMetaMask(connector: EvmConnector) {
  return connectorIdentity(connector).includes('metamask') || connector.name.toLowerCase().includes('metamask');
}

function isRabby(connector: EvmConnector) {
  return connectorIdentity(connector).includes('rabby') || connector.name.toLowerCase().includes('rabby');
}

function isInstalledConnector(connector: EvmConnector) {
  if (isWalletConnect(connector)) return false;
  const installed = connector.rkDetails?.installed ?? (connector as any).installed;
  return installed === true || Boolean(connector.uid && connector.name);
}

function uniqueConnectors(connectors: EvmConnector[]) {
  const out: EvmConnector[] = [];
  const seen = new Set<string>();

  for (const connector of connectors) {
    const genericInjected = isGenericInjectedConnector(connector);
    const key = genericInjected ? `generic:${connectorKey(connector)}` : connectorIdentity(connector);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(connector);
  }

  const specific = out.filter((connector) => !isGenericInjectedConnector(connector));
  return specific.length ? specific : out.slice(0, 1);
}

function syncIconForConnector(connector: EvmConnector) {
  if (isWalletConnect(connector)) return WALLETCONNECT_ICON;
  if (isMetaMask(connector)) return METAMASK_ICON;
  if (isRabby(connector)) return RABBY_ICON;
  return typeof connector.icon === 'string' ? connector.icon : '';
}

async function iconForConnector(connector: EvmConnector) {
  const syncIcon = syncIconForConnector(connector);
  if (syncIcon) return syncIcon;

  const icon = connector.rkDetails?.iconUrl;
  if (typeof icon === 'function') return icon();
  if (typeof icon === 'string' && icon) return icon;
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
    () => (connectors as EvmConnector[]).find(isWalletConnectModal) || (connectors as EvmConnector[]).find(isWalletConnect) || null,
    [connectors],
  );
  const activeIcon = currentConnector ? icons[connectorKey(currentConnector)] || syncIconForConnector(currentConnector) : '';
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
          if (icon) next[connectorKey(item)] = icon;
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
              const key = connectorKey(item);
              const active = currentConnector ? connectorIdentity(currentConnector) === connectorIdentity(item) : false;
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
              <LogOut size={16} aria-hidden="true" />
              <span>Disconnect</span>
            </button>
          )}

          {walletConnectConnector && (
            <button
              type="button"
              className="wallet-menu-row wallet-menu-walletconnect"
              onClick={() => connectConnector(walletConnectConnector)}
            >
              {icons[connectorKey(walletConnectConnector)] || syncIconForConnector(walletConnectConnector) ? (
                <img
                  src={icons[connectorKey(walletConnectConnector)] || syncIconForConnector(walletConnectConnector)}
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
