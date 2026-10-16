# succinctcoin.ai

An AI-generated cryptocurrency designed around simplicity, with code that engineers can easily understand.

SuccinctCoin is a small, self-contained cryptocurrency: a TypeScript consensus + ledger core, an Electron + React desktop app, and an **uptime-only** mining model — no proof-of-work. The core is deterministic by construction (chain-time only, no wall clock or RNG in consensus), the ledger uses decimal money at exactly two boundaries, and the whole system is testable headless: every test runs under plain Node over an in-memory network transport, with zero real sockets.

## Repository layout

| Path | What it is |
|------|------------|
| `packages/core` | The consensus + ledger core: block production, uptime-weighted draw, signed tickets, the single mutation path (`applyBlock`), identity (Ed25519), a libp2p net adapter, and file-based chain persistence. |
| `packages/app` | The desktop app (Electron 44 + React 19): a thin main process that hosts the core, a `contextBridge` preload, a display-only renderer, and electron-forge packaging. |
| `config/genesis.json` | The ONE genesis source: protocol version, gate registry, and the emission schedule (max supply 21,000,000 / 12.5 block reward). The app build copies it byte-identical into the package. |
| `_bmad-output/` | Project artifacts: the architecture spine, epic/story plans, and the deferred-work ledger. |

## Prerequisites

- **Node.js 24** (the repo pins `packageManager: pnpm@12.8.1` — run everything through `corepack pnpm …`)
- macOS, Linux, or Windows (the dev environment is macOS; packaging targets all three)

## Quickstart

```sh
corepack pnpm install     # installs the workspace (+ the Electron binary)
corepack pnpm build       # builds the core (regenerates the protocol code, then tsc)
corepack pnpm test        # the full workspace test suite (273 tests / 42 files)
corepack pnpm typecheck   # core typecheck
```

The root `test` runs every package's suite: the core's 256-test suite (38 files) plus the app's 17-test suite (4 files). The app's packaged-boot rows are self-sufficient — they build what they scan — so a fresh `install → build → test` is all that's needed.

## Run the desktop app

```sh
cd packages/app
corepack pnpm build       # clean → typecheck → renderer → main bundle → preload bundle → genesis copy
corepack pnpm exec electron .
```

On boot the app opens the window, loads the bundled renderer, and **auto-starts the node and mining** — the UI shows blocks being mined, balances, and peers (driven by the event stream, never polling). The chain is persisted under Electron's `userData` directory; the network transport is the in-memory testnet default.

## Package for distribution

```sh
cd packages/app
corepack pnpm package     # electron-forge package → out/ (a platform .zip via maker-zip)
```

The package is self-contained: the main and preload processes are Vite bundles with the entire core (and its libp2p graph) **inlined** — externals are exactly `{ electron, node builtins }` — and the genesis ships inside the package as `dist/config/genesis.json` (a byte-identical copy of the repo genesis). No workspace `node_modules` is needed at runtime. The preload is emitted as `dist/preload.mjs` — Electron's ESM-preload scripts must use the `.mjs` extension (preloads ignore `"type": "module"`).

## Scripts

| Command | Where | What |
|---------|-------|------|
| `corepack pnpm build` | repo root | Core build: protocol codegen + `tsc`. |
| `corepack pnpm test` | repo root | Full workspace test suite (headless). |
| `corepack pnpm typecheck` | repo root | Core typecheck. |
| `corepack pnpm build` | `packages/app` | Clean emit → typecheck → renderer Vite → main Vite bundle → preload Vite bundle → genesis copy. |
| `corepack pnpm test` | `packages/app` | App suite (core-host parity, renderer, closing e2e, packaged-boot matrix). |
| `corepack pnpm package` | `packages/app` | `electron-forge package` → distributable zip in `out/`. |

## Architecture & documentation

- **The architecture spine** (the rule set for the codebase — decisions AD-1…AD-12): `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`
- **Epic & story plans** (the full build history, 45 stories across 6 epics): `_bmad-output/initiative-succinctcoin-ai/epic-*/`
- **Deferred work** (known, deliberately-deferred items with dispositions): `_bmad-output/initiative-succinctcoin-ai/deferred-work.md`

Key design boundaries worth knowing before reading the code:

- **Single mutation path** — every state change goes through `applyBlock`; the rest of the core is read-only.
- **Chain-time only** — consensus uses the chain's own clock and deterministic draws; no `Date.now()` / `Math.random()` in the core.
- **Decimal money at two boundaries** — `big.js` appears only in the ledger's display conversion and the fee calculation; the wire and the store are integers.
- **Key material boundary** — the identity keypair lives in the app's main process; the renderer sees only peer IDs, status, and key-free signed artifacts.
- **Testability seam** — the network is a port; tests run the real core over `@libp2p/memory` under plain Node (no Electron spawn, no DOM, zero real sockets).

## Notes

- The testnet's default network transport is `@libp2p/memory` (single-node testnet). Choosing a real network transport (tcp + noise + yamux) is recorded deferred work.
- The node identity is currently a pinned seed; a per-install random seed is recorded deferred work.
- `electron-forge package` needs the Electron binary; a plain `corepack pnpm install` fetches it. (In this repository's CI/dev environment the download is skipped via `ELECTRON_SKIP_BINARY_DOWNLOAD`, so the package step is a local operation.)
