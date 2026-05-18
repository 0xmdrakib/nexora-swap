import { getAddress, isAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';

import { getChainMeta, isSolanaChain } from '@/lib/chainsMeta';
import type { Address } from '@/lib/types';

export const EVM_ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
export const SOLANA_NATIVE_ADDRESS = '11111111111111111111111111111111';
export const SOLANA_WRAPPED_SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
const SOLANA_ADDRESS_CACHE = new Map<string, string | null>();

export function isEvmAddress(value?: string | null): value is Address {
  return Boolean(value && isAddress(value, { strict: false }));
}

export function toChecksumAddress(value?: string | null): Address | null {
  const s = (value || '').trim();
  if (!isAddress(s, { strict: false })) return null;
  try {
    return getAddress(s) as Address;
  } catch {
    return null;
  }
}

export function isSolanaAddress(value?: string | null) {
  const s = (value || '').trim();
  if (!s) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export function normalizeSolanaAddress(value?: string | null): string | null {
  const s = (value || '').trim();
  if (!s) return null;
  const cached = SOLANA_ADDRESS_CACHE.get(s);
  if (cached !== undefined) return cached;
  try {
    const normalized = new PublicKey(s).toBase58();
    if (SOLANA_ADDRESS_CACHE.size > 5000) SOLANA_ADDRESS_CACHE.clear();
    SOLANA_ADDRESS_CACHE.set(s, normalized);
    return normalized;
  } catch {
    if (SOLANA_ADDRESS_CACHE.size > 5000) SOLANA_ADDRESS_CACHE.clear();
    SOLANA_ADDRESS_CACHE.set(s, null);
    return null;
  }
}

export function normalizeTokenAddressForChain(chainId: number, value?: string | null): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;

  const meta = getChainMeta(chainId);
  if (meta.chainType === 'EVM') {
    const checksum = toChecksumAddress(raw);
    return checksum;
  }

  const normalized = normalizeSolanaAddress(raw);
  return normalized;
}

export function normalizeWalletAddressForChain(chainId: number, value?: string | null): string | null {
  return normalizeTokenAddressForChain(chainId, value);
}

export function isNativeTokenAddressForChain(chainId: number, address?: string | null) {
  const meta = getChainMeta(chainId);
  return (address || '').trim().toLowerCase() === meta.nativeTokenAddress.toLowerCase();
}

export function isNativeTokenAddress(address?: string | null) {
  const a = (address || '').trim();
  return a.toLowerCase() === EVM_ZERO_ADDRESS || a === SOLANA_NATIVE_ADDRESS;
}

export function nativeTokenAddressForChain(chainId: number) {
  return getChainMeta(chainId).nativeTokenAddress;
}

export function lookupTokenAddressForPricing(chainId: number, address: string) {
  const meta = getChainMeta(chainId);
  if (isNativeTokenAddressForChain(chainId, address)) return meta.wrappedNativeAddress;
  return address;
}

export function tokenAddressEquals(a?: string | null, b?: string | null) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

export function addressCacheKey(chainId: number, address?: string | null) {
  const meta = getChainMeta(chainId);
  const normalized = normalizeTokenAddressForChain(chainId, address || '') || (address || '').trim();
  return meta.chainType === 'EVM' ? normalized.toLowerCase() : normalized;
}

export function isSolanaNativeOrWrapped(chainId: number, address?: string | null) {
  if (!isSolanaChain(chainId)) return false;
  const a = (address || '').trim();
  return a === SOLANA_NATIVE_ADDRESS || a === SOLANA_WRAPPED_SOL_ADDRESS;
}
