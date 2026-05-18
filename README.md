# Nexora Swap

Nexora Swap is a multi-router DEX interface for fast, cleaner token swaps across major EVM chains and Solana.

**Live app:** https://nexoraswap.online

---

## Overview

Nexora Swap is built for two core flows:

- **Same-chain EVM swaps:** Auto compares available routes between **1inch Direct** and **LI.FI Smart Routing**.
- **Solana and cross-chain swaps:** Uses **LI.FI** for Solana, EVM-to-Solana, Solana-to-EVM, and cross-chain execution, with **gas.zip** available as a dedicated cross-chain route option in the UI.

The app focuses on keeping swap execution more transparent by showing route selection, minimum received, wallet balances, USD estimates, and bridge-related fee details directly in the interface.

## Features

- Multi-router swap experience with **Auto**, **LI.FI Smart Routing**, **1inch Direct**, and **gas.zip** route options
- Same-chain route comparison in **Auto (best)** mode
- Cross-chain swaps across supported EVM networks and Solana routes supported by LI.FI
- Solana token lists, token metadata, USD prices, balances, and LI.FI transaction payload support
- Solana wallet support via Wallet Standard and injected wallets such as Phantom, MetaMask, Bitget, Solflare, and Backpack
- EVM wallets via MetaMask/WalletConnect, with Solana and EVM wallets handled separately in the UI
- Token selector and chain selector for both swap sides
- Wallet token balances in the token picker, plus DexScreener USD estimates for selected swap tokens
- Custom token import by contract address
- Minimum received estimate shown before swap confirmation
- Bridge fee estimate and `tx value` visibility for cross-chain swaps
- Exact ERC-20 approvals instead of unlimited approvals
- Human-readable error states for common quote and liquidity issues
- Liquidity source breakdown in the advanced route view

## Supported chains

- Ethereum
- Polygon
- Arbitrum
- Optimism
- Base
- BNB Chain
- Avalanche
- Solana

## Routing behavior

### Same-chain

- **Auto (best)** compares **1inch Direct** and **LI.FI Smart Routing** for same-chain EVM swaps and picks the better available quote.
- You can manually force **1inch Direct** or **LI.FI Smart Routing** from the route selector on EVM chains.
- Solana same-chain swaps use **LI.FI Smart Routing** because 1inch Direct is EVM-only in this app flow.

### Cross-chain

- Cross-chain swaps are handled through **LI.FI** in the current app flow, including Solana routes when LI.FI supports the pair.
- **gas.zip** is available as a selectable cross-chain route option.
- The UI surfaces estimated bridge fee information and the native token value the wallet will send for the transaction.

## Tech stack

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- Wagmi
- RainbowKit
- viem
- @solana/web3.js
- TanStack Query
- Neon Postgres cache for token metadata and price lookups

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root. then fill all env from [.env.example](./.env.example).

### Wallet setup note

- EVM swaps use MetaMask or any WalletConnect-supported wallet.
- Solana swaps use a Wallet Standard or injected Solana wallet such as Phantom, MetaMask, Bitget, Solflare, or Backpack.
- Cross-chain flows can require both wallet types if the source and destination chains are different families.

### 3. Run the development server

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

### 4. Build for production

```bash
npm run build
npm run start
```

---

## License

This project is licensed under the [MIT License](./LICENSE).
