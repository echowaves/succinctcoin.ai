---
type: epic
title: "Platform baseline: scaffold, CI, core skeleton, test harness"
parent: initiative-succinctcoin-ai
covers: []
after: []
assignee: ""
risk: medium
estimate: ""
estimate_basis: ""
---

# Platform baseline: scaffold, CI, core skeleton, test harness

## Description

Stand up the pnpm + TypeScript monorepo, the `packages/core` pure-Node skeleton (ports + `core/events/` public surface + `protocol.proto` skeleton + chainstore adapter), the `config/genesis.json`, the plain-Node Vitest + fast-check harness on `@libp2p/memory`, and CI. This is the first runnable, testable node core that every later capability epic builds on — a tracer bullet, not just scaffolding.

## Outcome

For the team: a working, headless `packages/core` with the spine's seams in place — `pnpm test` passes in plain-Node CI, `protocol.proto` is the single schema source with generated types, and `core/events/` exposes the command/event/read-API surface — so every following capability epic can ship an incrementally working node against a real harness.

## Requirements

No parent capability id — platform baseline. Each line cites the source section it delivers.

- E1 (AD-1) — `packages/core` pure-Node skeleton: zero UI imports; `core/events/` owns event payload types, commands, and the read-API (getPeers, getBlock) — the complete UI data source.
- E2 (AD-12) — `packages/core/proto/protocol.proto` authored for Block, Tx, Ticket, PeerInfo (field sets + numbering); TS protocol types GENERATED via protons; golden round-trip vector ships and passes.
- E3 (AD-9) — chainstore port + file adapter with an exclusive store lock (write lock + data-directory lockfile); a second core instance against the same directory fails at boot.
- E4 (stack) — pnpm workspace, TS 5.x config, Vitest 5 + fast-check, `@libp2p/memory` wired; CI runs `pnpm test` headless.
- E5 (spec constraint 6) — `config/genesis.json` authored: bootstrap list, emission params, K, L, accepted-gate registry, protocol version; validated at boot.

## Done when

- `pnpm test` passes in plain-Node CI with no shell and no real sockets (memory transport).
- `pnpm build` produces generated protocol types from `protocol.proto`; a hand-written protocol type triggers a lint/type failure.
- The golden round-trip vector (fixed block + ticket hex) passes through encoder, decoder, and (stub) signature verifier.
- Starting a second core against the same store directory fails at boot with a clear error.
- `packages/core` has zero `electron`/UI imports (verified by the test suite or a lint rule).
- `config/genesis.json` is parsed and validated at boot; a malformed config fails fast.

## Boundaries

The platform-baseline capability: the repo scaffold, the core skeleton's seams (not the capability logic), the schema source, the store adapter, and CI. It does NOT implement mining, identity, ledger arithmetic, or networking — only their ports, types, and the empty-but-runnable paths those epics fill. Non-goals: the spec's non-goals (no DHT, no browser node, no PoW-space, no EVM, no merge-mining).

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, section Requirements
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections AD-1, AD-9, AD-12, Consistency Conventions, Stack
- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section Constraints
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`
- stack — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/stack.md`

## Notes

- Assumption: TS 5.x as the default toolchain (spine Stack); 7.0.2 tsgo is a documented opt-in, not the default.
- Decision: 2026-10-01 — `core/events/` is the single owner of the public surface (event types + commands + read-API); capability epics add to it but do not define their own summary types (AD-1/AD-9 tightening).
- Decision: 2026-10-01 (inception, autonomous — user away) — breakdown approved as drafted: 5 stories + closing sweep, build order 1→2→{3∥4}→5→6. Story 1 is the tracer bullet (thin pnpm+Vitest+memory path). Stories 3 (genesis) and 4 (proto) run in parallel — disjoint code, shared setup owned by story 2. Story 4 is high-risk (it defines the field numbering every capability epic conforms to) and carries `plan_checkpoint = true`. No `done_checkpoints` (too heavy for a baseline epic). Publication = `auto` (repo store: the committed `tickets.toml` is the publish).
- Deferred scope (stays in the epic, not a story): concrete store-engine choice (SQLite/LevelDB/custom — decided at story 5 per AD-9 "code-level choice, not an invariant"); the exact proto field numbering (settled at story 4 per AD-12, a protocol change if it moves later).
- Waits on nothing (opening epic).
