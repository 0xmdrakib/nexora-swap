export type ChainMeta = {
  id: number;
  name: string;
  chainType: 'EVM' | 'SVM';
  moralisChain?: string; // hex chain id for Moralis (0x...)
  dexScreenerChain: string; // DexScreener chain slug
  wrappedNativeAddress: string; // used for DexScreener native-token pricing
  nativeTokenAddress: string; // canonical router/API address for the native token
  nativeDecimals: number;
  logoUrl: string;
  nativeSymbol: string;
  explorerUrl?: string;
};

export const SOLANA_CHAIN_ID = 1151111081099710;

export const CHAIN_META: Record<number, ChainMeta> = {
  1: {
    id: 1,
    name: 'Ethereum',
    chainType: 'EVM',
    moralisChain: '0x1',
    dexScreenerChain: 'ethereum',
    wrappedNativeAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
  },
  137: {
    id: 137,
    name: 'Polygon',
    chainType: 'EVM',
    moralisChain: '0x89',
    dexScreenerChain: 'polygon',
    wrappedNativeAddress: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/info/logo.png',
    nativeSymbol: 'MATIC',
    explorerUrl: 'https://polygonscan.com',
  },
  42161: {
    id: 42161,
    name: 'Arbitrum',
    chainType: 'EVM',
    moralisChain: '0xa4b1',
    dexScreenerChain: 'arbitrum',
    wrappedNativeAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://arbiscan.io',
  },
  10: {
    id: 10,
    name: 'Optimism',
    chainType: 'EVM',
    moralisChain: '0xa',
    dexScreenerChain: 'optimism',
    wrappedNativeAddress: '0x4200000000000000000000000000000000000006',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/optimism/info/logo.png',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
  },
  8453: {
    id: 8453,
    name: 'Base',
    chainType: 'EVM',
    moralisChain: '0x2105',
    dexScreenerChain: 'base',
    wrappedNativeAddress: '0x4200000000000000000000000000000000000006',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://basescan.org',
  },
  56: {
    id: 56,
    name: 'BSC',
    chainType: 'EVM',
    moralisChain: '0x38',
    dexScreenerChain: 'bsc',
    wrappedNativeAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png',
    nativeSymbol: 'BNB',
    explorerUrl: 'https://bscscan.com',
  },
  43114: {
    id: 43114,
    name: 'Avalanche',
    chainType: 'EVM',
    moralisChain: '0xa86a',
    dexScreenerChain: 'avalanche',
    wrappedNativeAddress: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    nativeTokenAddress: '0x0000000000000000000000000000000000000000',
    nativeDecimals: 18,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/avalanchec/info/logo.png',
    nativeSymbol: 'AVAX',
    explorerUrl: 'https://snowtrace.io',
  },
  [SOLANA_CHAIN_ID]: {
    id: SOLANA_CHAIN_ID,
    name: 'Solana',
    chainType: 'SVM',
    dexScreenerChain: 'solana',
    wrappedNativeAddress: 'So11111111111111111111111111111111111111112',
    nativeTokenAddress: '11111111111111111111111111111111',
    nativeDecimals: 9,
    logoUrl: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png',
    nativeSymbol: 'SOL',
    explorerUrl: 'https://solscan.io',
  },
};

export function getChainMeta(chainId: number): ChainMeta {
  const meta = CHAIN_META[chainId];
  if (!meta) throw new Error(`Unsupported chainId: ${chainId}`);
  return meta;
}

export function isSolanaChain(chainId: number) {
  return getChainMeta(chainId).chainType === 'SVM';
}

export function isEvmChain(chainId: number) {
  return getChainMeta(chainId).chainType === 'EVM';
}

export function getSupportedChainIds() {
  return Object.keys(CHAIN_META).map(Number);
}
