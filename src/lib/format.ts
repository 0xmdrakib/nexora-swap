import { formatUnits } from 'viem';

export function safeParseFloat(x?: string) {
  if (!x) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export function formatTokenAmount(raw: string, decimals: number, maxFraction = 6) {
  try {
    const s = formatUnits(BigInt(raw), decimals);
    const [i, f] = s.split('.');
    if (!f) return i;
    return `${i}.${f.slice(0, maxFraction)}`.replace(/\.$/, '');
  } catch {
    return '0';
  }
}

export function formatUSD(n: number) {
  if (!Number.isFinite(n) || n === 0) return '$0.00';

  // Small swap amounts are common; show more precision so we don't display $0.00.
  const abs = Math.abs(n);
  let maximumFractionDigits = 2;
  if (abs > 0 && abs < 0.01) maximumFractionDigits = 6;
  else if (abs < 1) maximumFractionDigits = 4;

  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  });
}

export function formatHash(hash?: string, left = 8, right = 6) {
  if (!hash) return '';
  if (hash.length <= left + right + 3) return hash;
  return `${hash.slice(0, left)}...${hash.slice(-right)}`;
}
