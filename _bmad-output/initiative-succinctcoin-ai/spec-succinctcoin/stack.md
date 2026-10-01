# Stack — concrete choices and measured numbers

Companion to `spec-succinctcoin.md`. The kernel states WHAT; this file states the concrete HOW (versions, transports, measured rates). All facts sourced in the adopted recon report.

## Consensus (CAP-1)

- **Family:** slot-paced low-difficulty PoW (simplest family to implement and unit-test in JS; validity = one hash-vs-target check).
- **Hash:** `node:crypto` sha256 + plain integer counter, per attempt. Measured on the project machine (Node v24.14.0, macOS arm64): sha256 3.085 GB/s vs pure-JS keccak (js-sha3) 0.0896 GB/s — ~35× cheaper, and keccak would break the "simple JS" story.
- **Target:** set so commodity hardware reaches one valid hash per slot trivially (low difficulty); difficulty adjusts to keep slots filling.
- **Election among eligible:** verifiable public-coin draw — weighted (uptime) Eppstein random-priority over nonces committed in per-window tickets; winner recomputable from public data; a block whose ticket+nonce does not verify the draw is rejected (see `registration-design.md` R2).
- **Long-range anchor:** accumulated PoW work (Bitcoin-style). **No VDF** — Ethereum abandoned its Minroot-VDF plan after a discovered attack (IACR 2025/637).
- **Planning assumption (selfish mining):** Eyal–Sirer — profitability threshold in vanilla Bitcoin ≈ 0 (1/3 upper bound); treat "small pools can profit" as the assumption, not "only 25%+ pools" (25% is the paper's *proposed* fix threshold).

## Identity / registration (CAP-2)

See `registration-design.md` for the full composition, must-holds, and attack surface. Summary (post-attack-pass): one-time personhood gate (dual at launch, addable by protocol upgrade only) → per-window ticket to `H(last block hash, window index)` with a protocol acceptance cap (one ticket per identity per chain-time window) → re-attestation every K windows → verifiable uptime-weighted election with fixed emission.

## Network (CAP-3) — js-libp2p 3.3.11 (2026-09-02, 392 npm dependents, production in Ethereum/Lodestar, IPFS/Helia, HOPR, OrbitDB)

| Concern | Component | Version (2026-09) |
|---|---|---|
| Transport | `@libp2p/tcp` (Node-only) | — |
| Security | `@libp2p/noise` | 17.0.3 |
| Multiplexer | `@libp2p/yamux` | 8.0.3 |
| Pubsub | `@libp2p/gossipsub` (floodsub is "not suitable for production" per official examples) | 17.1.2 |
| Bootstrap | `@libp2p/bootstrap` — static list from genesis config | — |
| LAN discovery | `@libp2p/mdns` (Node-only) | — |
| NAT traversal | `@libp2p/circuit-relay` v2 — public relay + `circuitRelayTransport()` | — |
| Test transport | `@libp2p/memory` — in-process, socket-free ("intended for testing") | — |
| Conformance | `@libp2p/multidim-interop` (`test:interop`) | — |

- **DHT:** deferred (non-goal). Revisit when bootstrap + mDNS stop sufficing — see spec open question.
- **NAT caveat:** WebRTC/WebTransport exist as first-class transports but host-to-host NAT behavior was unverified in recon; circuit-relay v2 is the documented behind-NAT pattern.

## Shell + bundler (CAP-4)

- **Shell:** Electron (main process IS Node — core, shell, tests share one language and one test suite). Current: Electron 44.5.0 / 45.0.0-alpha.13, `@electron-forge/cli` 8.0.1.
- **Bundler:** Vite 8 (8.3.1, 2026-09-24; production build powered by Rolldown — a Rust-based, Rollup-API-compatible engine). Webpack is in maintenance posture — do not start new work on it.
- **Runner-up:** Tauri v2 (on v2 for stability; v3 in alpha) if bundle size/RAM becomes a hard gate — costs a Rust toolchain, a Node sidecar process, and a per-platform binary matrix. The core-seam constraint (zero UI imports) is what keeps this swap cheap.
- **Electron testability:** first-party aegir `electron-main` test target exists in the js-libp2p monorepo (`@libp2p/utils`) — running libp2p in Electron's main process is a supported, tested configuration.

## Money (CAP-5) — big.js 7.0.1, measured on project machine

| Operation | Rate | Consequence |
|---|---|---|
| big.js `plus` | ~8.6M ops/s | fine per-transaction |
| big.js `times` | ~10.9K ops/s (~1000× slower than `plus`) | one call per tx max (fee = amount × rate); never per-PoW-attempt |
| BigInt add | ~385M ops/s | integer base-units for bulk amounts |
| `JSON.stringify(Big)` | string via `toJSON` | persistence-friendly; `BigInt` throws — prefer Big for wire/JSON |
| `0.1 + 0.2` | float `0.30000000000000004` vs big.js `"0.3"` | why big.js exists |

## Toolchain (CAP-6)

- TypeScript + Vitest + pnpm + Node 24 (settled by Lodestar and EthereumJS).
- Property testing: fast-check.
- libp2p tests: `@libp2p/memory` transport (zero real sockets).

## Precedent

**Lodestar** is the load-bearing proof that JS can run a production consensus client (TypeScript Ethereum PoS on mainnet, v1.49.0, TS 98.4%, 262 releases, 150 contributors). Its architecture validates this design: consensus-critical crypto offloaded to native (Zig via NAPI), compression to WASM, networking in worker threads. JS execution-layer (EVM) remains unproven — another reason execution is a non-goal.
