import { Attribution } from 'ox/erc8021';
import type { Hex } from 'viem';

export const BASE_CHAIN_ID = 8453;

// Builder Codes are public attribution identifiers, not secrets. Keep the
// value in the public app environment so it is available to the client.
const builderCode = process.env.NEXT_PUBLIC_BASE_BUILDER_CODE?.trim();

const baseBuilderDataSuffix: Hex | undefined = builderCode
  ? Attribution.toDataSuffix({ codes: [builderCode] })
  : undefined;

/**
 * Return the ERC-8021 suffix only for transactions submitted on Base.
 * An unset Builder Code intentionally disables attribution without affecting
 * swaps on any chain.
 */
export function baseBuilderDataSuffixForChain(chainId?: number): Hex | undefined {
  return chainId === BASE_CHAIN_ID ? baseBuilderDataSuffix : undefined;
}
