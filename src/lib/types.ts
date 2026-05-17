export type Address = `0x${string}`;
export type TokenAddress = Address | string;

export type Token = {
  chainId: number;
  address: TokenAddress; // EVM 0x..., Solana base58; native token uses chain-specific canonical address
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  priceUSD?: string; // DexScreener-derived USD hint for quote/minimum helpers
  coinKey?: string; // some APIs provide
  // Optional UI enrichment (Alchemy wallet scanning)
  balanceRaw?: string;
  balanceFormatted?: string;
  balanceUsd?: string;
};

export type RouterId =
  | 'auto'
  | 'lifi-smart'
  | 'lifi-uniswap'
  | 'lifi-1inch'
  | 'lifi-pancake'
  | 'oneinch-direct'
  | 'uniswap-subgraph-only'
  | 'gaszip';

export type QuoteRequest = {
  router: RouterId;
  fromChainId: number;
  toChainId: number;
  fromToken: Token;
  toToken: Token;
  fromAmount: string; // raw (wei)
  fromAddress: string;
  toAddress: string;
  slippage: number; // 0.0001 .. 0.2
};

export type TxRequest = {
  from?: string;
  to?: string;
  data?: string;
  value?: string; // hex or decimal string
  chainId: number;
  txType?: 'evm' | 'solana';
};

export type QuoteResponse = {
  router: RouterId;
  tool?: string;
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin?: string;
    approvalAddress?: string;
    gasUSD?: string;
    routes?: Array<{ name: string; part: number }>;
  };
  tx?: TxRequest;
  raw?: any;
};

// Optional hint returned by /api/quote when the requested amount is too small.
// This lets the UI show a clean, actionable message like:
// "Minimum swap amount for this pair is 0.0003 ETH (≈$0.90)".
export type MinAmountHint = {
  fromAmount: string; // raw units
  fromAmountFormatted: string; // human units
  fromAmountUSD?: string; // best-effort
};

// Quote failures fall into a few UX-relevant buckets.
// - MIN_AMOUNT: the pair likely has liquidity, but the input is below router minimum.
// - NO_LIQUIDITY: no route / no liquidity / token unsupported.
// - OTHER: everything else (bad params, upstream errors, etc.).
export type QuoteErrorReason = 'MIN_AMOUNT' | 'NO_LIQUIDITY' | 'TIMEOUT' | 'OTHER';
