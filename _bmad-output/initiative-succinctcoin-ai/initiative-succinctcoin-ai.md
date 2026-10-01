---
type: initiative
title: "SuccinctCoin — an equal-node JS cryptocurrency"
parent: none
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6]
after: []
assignee: ""
risk: high
estimate: ""
estimate_basis: ""
---

# SuccinctCoin — an equal-node JS cryptocurrency

## Description

Build a cryptocurrency whose protocol makes a running node's chance to mine a function of **uptime alone** — no ASIC, no stake advantage, no way to buy more odds — written in one language (TypeScript) that any developer can read, build, run, and test. The spec `../spec-succinctcoin/spec-succinctcoin.md` owns the capabilities, constraints, non-goals, assumptions, and open questions; the architecture spine `../architecture-succinctcoin/architecture-succinctcoin.md` owns the invariants (AD-1..AD-12) the code must hold. This initiative delivers the spec's six capabilities as a working node + desktop app whose core is fully testable in plain Node.

## Outcome

A packaged desktop app runs a SuccinctCoin node on a testnet and shows blocks being mined, while the same core's full test suite passes headless in plain-Node CI with no shell and no real sockets — the spec's success signal (uptime-only slot odds + verifiable draw + headless core suite) is demonstrable end to end.

## Requirements

The requirement source is the spec `../spec-succinctcoin/spec-succinctcoin.md`; its `CAP-N` ids are the stable ids children cite. Each maps upward to itself.

- CAP-1 — slot-based mining (uptime-only slot odds, trivially-reachable per-slot target)
- CAP-2 — operator identity with non-scaling sybil cost (acceptance cap, verifiable draw, re-attestation)
- CAP-3 — node network (bootstrap + mDNS + circuit-relay-v2; gossipsub over tcp+noise+yamux)
- CAP-4 — desktop app (Electron shell, node in main process, React UI)
- CAP-5 — exact money (integer base units, big.js at the two decimal boundaries, conservation invariants)
- CAP-6 — testable in plain Node (full core suite headless, memory transport)

## Done when

- A multi-node simulation over the in-process transport shows slot odds track uptime alone: an operator running N identities wins no more than the acceptance cap allows, while N gate-verified persons of distinct operators win ~N×.
- Every slot winner is verifiable from public data — a node not selected by the draw cannot win a slot (launch gate test passes).
- Property tests assert supply conservation, no-negative-balance, and fee invariants over long random transaction sequences with no float artifact in a persisted balance.
- The packaged Electron app starts a node on a testnet and shows blocks being mined.
- The core's full test suite (unit + property) passes in plain-Node CI with no shell and no real sockets (all libp2p tests on the memory transport).
- `packages/core` has zero imports of `electron` or any UI library (AD-1).

## Boundaries

The boundary is the capability: each epic owns one spec capability (or a tightly coupled pair) and the code folders the spine assigns it. Non-goals are the spec's non-goals (no DHT at launch, no browser node, no proof-of-space, no EVM, no merge-mining/PoA).

- Touch point: `bench/` (existing perf harness, sha256/big.js numbers) — consumed as evidence for AD-6 hot-path limits; owner: epic-equal-node-mining.
- Touch point: `config/genesis.json` (bootstrap list, emission, K, L, accepted-gate registry, protocol version) — authored by the platform baseline; owner: epic-platform-baseline.
- Tracer path: the platform-baseline epic delivers the first runnable, testable node core + shell skeleton so that each following capability epic ships an incrementally working, end-to-end node.

## References

- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section Capabilities
- constraint — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section Constraints
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections Invariants & Rules (AD-1..AD-12), Consistency Conventions, Stack
- registration — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/registration-design.md`, section R1–R4
- stack — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/stack.md`
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`
- research — `_bmad-output/initiative-succinctcoin-ai/research-equal-node-js-cryptocurrency-architectur/research-equal-node-js-cryptocurrency-architectur.md`

## Notes

- Open question: DHT threshold — when bootstrap+mDNS stop sufficing. Deferred to the network epic's spike; not an architecture branch (spine Deferred).
- Open question: which two personhood gates at launch + re-attestation cadence K. Deferred; architecture binds the verifier interface only (AD-4).
- Open question: difficulty/target adjustment algorithm. Deferred to the mining epic's spike; must satisfy "commodity hardware reaches one hash per slot trivially" (CAP-1).
- Open question: τ-erosion (AI-solver throughput trend). Motivation only, not load-bearing (spec constraint 3).
- Decision: 2026-10-01 — the spine is the home of every cross-epic decision (wire format AD-8/AD-12, draw AD-7, money AD-5, mutation path AD-2); no cross-epic decision lives in a single epic's spike.
- Decision: 2026-10-01 — platform baseline is the opening epic (scaffold + genesis config + CI + test harness), per `slice_to_epics` "the platform baseline is the opening epic."
- Decision: 2026-10-01 — tree validation passed (checks.tree ×6 + checks.dependencies ×4, run inline because the subagent backend was unavailable). One finding fixed: the epic 3 → epic 4 `Ticket`-interface handoff is now stated two-sided (epic 3 defines the draw's ticket input set; epic 4 conforms real tickets to it). `tickets.py status` clean: no cycle, no drift, no `unpinned_after`.
