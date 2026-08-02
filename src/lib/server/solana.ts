import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
  type ParsedAccountData,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { SOLANA_CHAIN_ID } from '@/lib/chainsMeta';
import { SOLANA_NATIVE_ADDRESS, normalizeSolanaAddress } from '@/lib/addresses';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export function getSolanaRpcUrl() {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (!rpcUrl) throw new Error('Missing SOLANA_RPC_URL environment variable.');
  return rpcUrl;
}

export function getSolanaConnection() {
  return new Connection(getSolanaRpcUrl(), 'confirmed');
}

export function assertSolanaAddress(value: string) {
  const normalized = normalizeSolanaAddress(value);
  if (!normalized) throw new Error('Invalid Solana address');
  return normalized;
}

export async function getSolanaNativeBalance(walletAddress: string) {
  const connection = getSolanaConnection();
  const lamports = await connection.getBalance(new PublicKey(assertSolanaAddress(walletAddress)), 'confirmed');
  return String(lamports);
}

async function getSplBalanceForProgram(connection: Connection, owner: PublicKey, mint: PublicKey, programId: PublicKey) {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed');
  let total = 0n;
  for (const account of accounts.value) {
    const data = account.account.data as ParsedAccountData;
    const amount = data?.parsed?.info?.tokenAmount?.amount;
    const accountMint = String(data?.parsed?.info?.mint || '');
    if (accountMint !== mint.toBase58()) continue;
    try {
      total += BigInt(String(amount || '0'));
    } catch {
      // ignore malformed token account
    }
  }
  return total;
}

export async function getSolanaTokenBalance(walletAddress: string, mintAddress: string) {
  const owner = new PublicKey(assertSolanaAddress(walletAddress));
  const mint = new PublicKey(assertSolanaAddress(mintAddress));
  const connection = getSolanaConnection();

  const [legacy, token2022] = await Promise.all([
    getSplBalanceForProgram(connection, owner, mint, TOKEN_PROGRAM_ID),
    getSplBalanceForProgram(connection, owner, mint, TOKEN_2022_PROGRAM_ID).catch(() => 0n),
  ]);
  return (legacy + token2022).toString();
}

export async function getSolanaSelectedBalances(
  walletAddress: string,
  tokens: Array<{ chainId: number; address: string }>,
) {
  const out: Array<{ chainId: number; address: string; balance: string }> = [];
  await Promise.all(
    tokens.map(async (token) => {
      const address = assertSolanaAddress(token.address);
      const balance =
        address === SOLANA_NATIVE_ADDRESS
          ? await getSolanaNativeBalance(walletAddress)
          : await getSolanaTokenBalance(walletAddress, address);
      out.push({ chainId: SOLANA_CHAIN_ID, address, balance });
    }),
  );
  return out;
}

export async function getSolanaWalletTokens(walletAddress: string, limit = 100) {
  const owner = new PublicKey(assertSolanaAddress(walletAddress));
  const connection = getSolanaConnection();
  const [nativeLamports, legacy, token2022] = await Promise.all([
    connection.getBalance(owner, 'confirmed'),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed').catch(() => ({
      value: [],
    })),
  ]);

  const byMint = new Map<string, { mint: string; balance: bigint; decimals: number }>();
  for (const account of [...legacy.value, ...token2022.value]) {
    const data = account.account.data as ParsedAccountData;
    const info = data?.parsed?.info;
    const mint = String(info?.mint || '');
    const amount = String(info?.tokenAmount?.amount || '0');
    const decimals = Number(info?.tokenAmount?.decimals ?? 0);
    if (!mint) continue;
    let balance = 0n;
    try {
      balance = BigInt(amount);
    } catch {
      continue;
    }
    if (balance <= 0n) continue;
    const prev = byMint.get(mint);
    byMint.set(mint, {
      mint,
      balance: (prev?.balance || 0n) + balance,
      decimals: Number.isFinite(decimals) ? decimals : prev?.decimals || 0,
    });
  }

  return {
    nativeBalance: {
      balance: String(nativeLamports),
      balanceFormatted: String(nativeLamports / LAMPORTS_PER_SOL),
    },
    tokenAccounts: Array.from(byMint.values()).slice(0, limit),
  };
}

export function solanaSignatureFromResponse(signature: string | Uint8Array | number[]) {
  if (typeof signature === 'string') return signature;
  return bs58.encode(signature instanceof Uint8Array ? signature : Uint8Array.from(signature));
}

export function deserializeSolanaTransaction(data: string) {
  const bytes = Buffer.from(data, 'base64');
  return VersionedTransaction.deserialize(bytes);
}
