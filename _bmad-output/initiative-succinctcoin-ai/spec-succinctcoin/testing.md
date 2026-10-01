# Testing strategy — CAP-6 (testable in plain Node)

Companion to `spec-succinctcoin.md`. The point: "properly covered by tests" must be a property of the **core**, not of the app.

## Shape

- **Runner:** Vitest under plain Node (no desktop shell, no Electron, no browser). Toolchain: TypeScript + Vitest + pnpm + Node 24 (settled by Lodestar and EthereumJS).
- **Network:** all libp2p-dependent tests run on `@libp2p/memory` — an in-process transport intended for testing, so the full protocol stack (transports/crypto/muxer/pubsub) is exercised with **zero real sockets** in CI.
- **Electron path:** the core never imports `electron`, so the same suite passes unchanged in the packaged app's main process; a first-party aegir `electron-main` test target in the js-libp2p monorepo confirms running libp2p in Electron main is a supported, tested configuration.

## Layers

| Layer | What | How |
|---|---|---|
| Unit (ledger) | big.js accounting: add/sub, fee = amount × rate, base-unit conversion | plain-Node Vitest, seeded inputs; assert exact strings (e.g. `0.1+0.2 → "0.3"`) |
| Property (ledger invariants) | conservation of supply, no-negative-balance, fee invariants over long random tx sequences | fast-check; every persisted balance is a clean decimal string (no float drift) |
| Unit (PoW) | one hash-vs-target check: valid nonce accepted, invalid rejected, target reachable by commodity hardware | node:crypto sha256 + integer counter, seeded; assert the slot target is trivially reachable at measured 3.085 GB/s |
| Network (gossip/sync) | block + tx propagation, peer discovery over bootstrap/mDNS, NAT relay path | `@libp2p/memory` multi-node sim; no real sockets |
| Identity (registration) | acceptance cap: N identities of one operator earn no more eligibility than one (per-identity cap, not per-operator); chain-window tickets lapse; re-attestation lapse = lose eligibility (K windows); fork changes the challenge (no replay) | multi-identity sim over memory transport; assert per-identity cap, window lapsing, re-attestation expiry, fork invalidation |
| Consensus (election) | **launch gate test:** a node not selected by the verifiable draw cannot produce a valid block; odds track uptime alone (lookback ramp, no inflation from fresh identities) | sim with controlled uptime + committed nonces; assert draw recomputes identically on all nodes, and an unselected node's block is rejected |
| Conformance | cross-implementation libp2p behavior | `@libp2p/multidim-interop` (`test:interop`) where applicable |

## The success-signal demonstration

Two runnable sims (the spec's Success signal):

1. **Uptime-odds sim:** over the memory transport, an operator running N identities wins no more than the acceptance cap allows, while a distinct operator running N gate-verified persons wins ~N×; and every slot winner is verifiable from public data (the unselected-node block is rejected).
2. **Headless suite:** the entire core suite passes in a bare Node CI environment — no shell, no sockets.

## Out of scope for the core suite

- UI (React) tests — those live with the shell, not the core.
- Real-socket integration / NAT on real home networks — the circuit-relay v2 path is simulated, not run against live NATs, in CI.
