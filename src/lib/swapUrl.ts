import { CHAIN_META } from '@/lib/chainsMeta';
import { EVM_ZERO_ADDRESS, isNativeTokenAddress as isKnownNativeTokenAddress, normalizeTokenAddressForChain } from '@/lib/addresses';

export const NATIVE_TOKEN_ADDRESS = EVM_ZERO_ADDRESS;

export type SwapPairUrl = {
  fromChainId: number;
  fromTokenAddress: string;
  toChainId: number;
  toTokenAddress: string;
};

export type ParsedSwapPairPath =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | ({ kind: 'pair' } & SwapPairUrl);

function isSupportedChainId(chainId: number) {
  return Number.isInteger(chainId) && Boolean(CHAIN_META[chainId]);
}

export function isNativeTokenAddress(address?: string | null) {
  return isKnownNativeTokenAddress(address);
}

export function normalizeTokenAddress(value: string, chainId?: number): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  if (chainId) return normalizeTokenAddressForChain(chainId, raw);
  if (isNativeTokenAddress(raw)) return raw;
  return null;
}

export function buildSwapPairPath(pair: SwapPairUrl) {
  return [
    '',
    'swap',
    String(pair.fromChainId),
    pair.fromTokenAddress,
    String(pair.toChainId),
    pair.toTokenAddress,
  ].join('/');
}

export function parseSwapPairPath(pathname: string): ParsedSwapPairPath {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'swap') return { kind: 'none' };
  if (parts.length !== 5) return { kind: 'invalid', reason: 'Invalid shared pair link.' };

  const fromChainId = Number(parts[1]);
  const toChainId = Number(parts[3]);
  if (!isSupportedChainId(fromChainId) || !isSupportedChainId(toChainId)) {
    return { kind: 'invalid', reason: 'Unsupported chain in shared pair link.' };
  }

  const fromTokenAddress = normalizeTokenAddress(parts[2], fromChainId);
  const toTokenAddress = normalizeTokenAddress(parts[4], toChainId);
  if (!fromTokenAddress || !toTokenAddress) {
    return { kind: 'invalid', reason: 'Invalid token address in shared pair link.' };
  }

  return {
    kind: 'pair',
    fromChainId,
    fromTokenAddress,
    toChainId,
    toTokenAddress,
  };
}
