---
id: SPEC-succinctcoin
companions:
  - stack.md
  - registration-design.md
  - testing.md
  - ../research-equal-node-js-cryptocurrency-architectur/research-equal-node-js-cryptocurrency-architectur.md
  - ../architecture-succinctcoin/architecture-succinctcoin.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# SuccinctCoin — equal-node JS cryptocurrency

## Why

A vision to realize: a currency whose protocol makes a running node's chance to mine a function of **uptime alone** — no ASIC, no stake advantage, no way to buy more odds. The backdrop is 2026 cost-theory (arXiv:2605.29651): every deployed family (PoW, PoS, proof-of-space) weighs a *parallelizable* resource, which makes N-identity Sybil near-free — so the coin's novel contribution is the **registration economics** (a non-scaling entry/survival cost), not the crypto. Simplicity is a first-class mandate: any developer must be able to read, build, run, and test the whole node.

## Capabilities

- **CAP-1** — slot-based mining
  - **intent:** every running node's probability of winning a mining slot is proportional to its uptime alone — independent of CPU/GPU hashrate and of stake — with the per-slot target trivially reachable by commodity hardware.
  - **success:** in a multi-node simulation, a single always-up node wins slots at the expected slot rate regardless of the hardware it runs on, and no node can win a slot without a valid per-slot ticket.
- **CAP-2** — operator identity with non-scaling sybil cost
  - **intent:** a gate-verified person acquires exactly one base identity through a personhood gate; the protocol enforces an acceptance cap (one valid ticket per identity per window) so a second identity is never cheaper than the first, and the mining reward never scales with identity count.
  - **success:** in a multi-identity simulation, N identities of one operator earn no more slot-eligibility throughput than one (enforced by the acceptance cap, not by challenge hardness); the slot winner is verifiable from public data by any node (public-coin draw); a node not selected by the draw cannot win a slot; lapsing re-attestation loses eligibility.
- **CAP-3** — node network
  - **intent:** nodes join via a static bootstrap list (genesis) and mDNS (LAN), traverse home NAT via circuit-relay v2, and propagate blocks and transactions via gossipsub over tcp+noise+yamux.
  - **success:** a node behind a simulated NAT discovers peers, syncs, and gossips a test block to k peers within a bounded time, with no real sockets in CI.
- **CAP-4** — desktop app
  - **intent:** an Electron shell runs the node in its main process (plain Node) with a React UI for balance, mining status, and network peers.
  - **success:** the packaged app starts a node on a testnet and shows blocks being mined, while the same core package's test suite passes unchanged under a plain-Node runner with no shell.
- **CAP-5** — exact money
  - **intent:** all balances and transactions are exact decimal amounts in integer base units (big.js); the fee is amount × rate computed exactly once per transaction.
  - **success:** property tests assert conservation of supply, no-negative-balance, and fee invariants over long random transaction sequences, and no float artifact (e.g. `0.1+0.2` drift) ever appears in a persisted balance.
- **CAP-6** — testable in plain Node
  - **intent:** the core's full test suite (unit + property) runs with a plain-Node runner, no desktop shell, and no real network sockets.
  - **success:** CI runs the entire core suite headless in a bare Node environment, with all libp2p-dependent tests on the in-process memory transport.

## Constraints

- One language for core + shell + tests (JS/TS); building, running, or testing the core must not require any second language's toolchain.
- big.js records all money; js-libp2p provides networking, discovery, and bootstrap (user-mandated, not a choice).
- Registration/survival cost is enforced by plain protocol rules: an acceptance cap (one valid ticket per identity per window), tickets windowed in **chain-time**, a periodic re-attestation, and a slot reward that never scales with identity count. Money, compute, and storage are structurally disqualified as cost bases (C(s,T)=o(sT), arXiv:2605.29651 — motivation for this constraint, not a load-bearing dependency).
- No VDF anywhere as a time anchor (Ethereum abandoned its Minroot-VDF plan after a discovered attack); long-range anchoring is PoW-like accumulated work.
- The per-PoW-attempt path must not call big.js `times` (~1000× slower than `plus`, measured) nor pure-JS keccak (~35× slower than native sha256, measured); node:crypto sha256 + plain integer counter only.
- The node core (libp2p + consensus + ledger + chain store) is a pure Node package with zero UI imports; only the shell imports electron.

## Non-goals

- No DHT at launch — bootstrap + mDNS; Kad-DHT deferred until the network outgrows them.
- No browser-runtime node (the node is a Node.js process; browser transports are not in scope).
- No proof-of-space.
- No EVM-compatible execution layer.
- No merge-mining / proof-of-authority.

## Success signal

In a multi-node simulation over the in-process transport, slot odds track uptime alone: an operator running N identities wins no more than the acceptance cap allows, while a distinct operator running N gate-verified persons wins ~N×; and every slot winner is verifiable from public data — a node not selected by the draw cannot win a slot. And the core's full test suite passes in plain-Node CI with no shell and no sockets.

## Assumptions

- TypeScript + Vitest + pnpm + Node 24 toolchain (settled by two independent production JS consensus clients, Lodestar and EthereumJS).
- Small community scale at launch (10 → few thousand mostly-stable nodes); bootstrap + mDNS suffice at that size.

## Open Questions

- At what node count do bootstrap + mDNS stop sufficing and Kad-DHT become warranted? (Resolve by memory-transport simulation, or adopt DHT day-one for the "always works" story.)
- Personhood gate: dual gate at launch (biometric + social graph) is the recommended config after the attack pass (a cheap weak gate is the sybil faucet — gates are addable only by protocol upgrade, never auto-valid). Residual: which two gates, and the re-attestation cadence K.
- τ-erosion: AI-solver throughput trend is unknown (the BPC paper's 97–100%-yet-throughput-bounded result is a snapshot, not a trend line); challenge-family rotation cadence is undecided.
- Gate uniqueness: the #1 external trust is the personhood gate (iris fakery, colluding vouching clusters); the dual-gate config and re-attestation bound the damage, but gate-specific attack research is per-gate, not protocol-level.
