import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { http } from 'wagmi';
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'wagmi/chains';

export const SUPPORTED_CHAINS = [mainnet, polygon, arbitrum, optimism, base, bsc, avalanche] as const;

const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  // Build-safe placeholder. WalletConnect wallets still require a real project id in production.
  '00000000000000000000000000000000';

function rpcUrl(chainId: number) {
  return (
    process.env[`ALCHEMY_RPC_URL_${chainId}` as keyof typeof process.env] ||
    // Backwards compat if you ever used e.g. ALCHEMY_RPC_URL_1
    (process.env as any)[`ALCHEMY_RPC_URL_${chainId}`] ||
    ''
  );
}

export const config = getDefaultConfig({
  appName: 'Nexora Swap',
  projectId,
  wallets: [
    {
      groupName: 'WalletConnect',
      wallets: [walletConnectWallet],
    },
  ],
  // Prefer EIP-6963 direct injected-provider discovery over the legacy window.ethereum fallback.
  // This keeps Rabby, MetaMask, Phantom EVM, Bitget, Coinbase, etc. as distinct wallet choices.
  multiInjectedProviderDiscovery: true,
  chains: [...SUPPORTED_CHAINS],
  transports: {
    [mainnet.id]: rpcUrl(mainnet.id) ? http(rpcUrl(mainnet.id)) : http(),
    [polygon.id]: rpcUrl(polygon.id) ? http(rpcUrl(polygon.id)) : http(),
    [arbitrum.id]: rpcUrl(arbitrum.id) ? http(rpcUrl(arbitrum.id)) : http(),
    [optimism.id]: rpcUrl(optimism.id) ? http(rpcUrl(optimism.id)) : http(),
    [base.id]: rpcUrl(base.id) ? http(rpcUrl(base.id)) : http(),
    [bsc.id]: rpcUrl(bsc.id) ? http(rpcUrl(bsc.id)) : http(),
    [avalanche.id]: rpcUrl(avalanche.id) ? http(rpcUrl(avalanche.id)) : http(),
  },
  ssr: true,
});
