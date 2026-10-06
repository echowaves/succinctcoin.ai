---
type: epic
title: "Slot-based mining: slot loop, verifiable draw, PoW hot path, applyBlock"
parent: initiative-succinctcoin-ai
covers: ["CAP-1"]
after: []
assignee: ""
risk: high
estimate: ""
estimate_basis: ""
---

# Slot-based mining: slot loop, verifiable draw, PoW hot path, applyBlock

## Description

Implement `core/consensus`: the chain-time slot loop, the **single pinned** `drawWindow()` (the verifiable public-coin draw), the per-attempt PoW hot path (`node:crypto` sha256 + integer counter), and the `applyBlock` invocation that wires consensus to the ledger. Blocks carry the winner's ticket + nonce; the block hash is sha256 over the canonical protobuf `Block` encoding (AD-12). The launch gate test proves an unselected node cannot win a slot. This epic **defines the `Ticket` interface the draw consumes** (the proto message shape + the draw's input set); the identity epic (epic 4) conforms real tickets to that interface, so neither side invents its own.

## Outcome

For the team: a running node's chance to mine is a function of uptime alone — in a multi-node simulation an always-up node wins slots at the expected rate regardless of hardware, and no node wins without a valid per-slot ticket that the public-coin draw selects — so the coin's core promise (uptime-only, no hashrate/stake advantage) is demonstrable.

## Requirements

Reuses the parent's id; the epic adds lines for the draw and the hot path.

- R1 (CAP-1) — every running node's probability of winning a mining slot is proportional to uptime alone — independent of CPU/GPU hashrate and stake — with the per-slot target trivially reachable by commodity hardware.
- R2 (AD-7) — the draw is exactly one exported `drawWindow(tickets, challenge, weights)` in `core/consensus`; winner = argmin `c^uptime` where `c = H(nonce‖challenge)` read uniform in (0,1) — higher uptime ⇒ higher win probability (minimizing `c^(1/uptime)` is banned — it inverts fairness). Input set = tickets accepted at or before the previous window's last block; late tickets never invalidate an accepted block. ≥3 fixed test vectors ship; the verifier and all tests import it — re-implementation is banned.
- R3 (AD-6) — per-attempt PoW = `node:crypto` sha256 + plain integer counter; `big.js` and pure-JS keccak are banned from per-attempt code paths. The block hash = sha256 over the canonical protobuf encoding of the `Block` message, counter included as a field; the PoW check re-hashes exactly those bytes.
- R4 (AD-3) — every protocol decision (window index, lookback, ticket validity, draw, difficulty) uses chain time (slot count + last block hash); wall clock is display-only.
- R5 (AD-2) — `applyBlock(block)` is the single mutation path, invoked only by the consensus loop; it receives a fully validated domain block and credits the reward through the ledger.
- E1 (difficulty) — the difficulty/target adjustment algorithm is settled by a spike in this epic; it must keep "commodity hardware reaches one hash per slot trivially" (CAP-1 success) true.

## Done when

- In a multi-node simulation on the memory transport, a single always-up node wins slots at the expected slot rate regardless of the hardware it runs on.
- No node can win a slot without a valid per-slot ticket; a block whose (ticket, nonce) does not verify the draw is rejected.
- The launch gate test passes: a node not selected by the draw cannot produce a valid block.
- The per-attempt PoW path references only `node:crypto` sha256 + an integer counter (verified by a lint/import check); the measured throughput stays within the AD-6 limits.
- A block's hash recomputed from its canonical protobuf encoding matches the stored hash; the counter round-trips.

## Boundaries

The slot-based-mining capability: `core/consensus` slot loop, draw, PoW, difficulty, and the `applyBlock` wiring. It does NOT implement the ledger arithmetic (epic 2), identity/tickets (epic 4 — it consumes their verified tickets), or networking (epic 5). Non-goals: the spec's non-goals (no proof-of-space, no merge-mining/PoA).

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, section Requirements
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections AD-2, AD-3, AD-6, AD-7, AD-12, Consistency Conventions
- registration — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/registration-design.md`, section R2 (verifiable public-coin draw)
- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section CAP-1
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`

## Notes

- Open question (spike here): the difficulty/target adjustment algorithm — must keep the per-slot target trivially reachable by commodity hardware.
- Waits on epic 1 because: it needs the proto `Block` message (AD-12) and the chainstore adapter to hash and persist blocks.
- Waits on epic 2 because: `applyBlock` credits the reward through the ledger (AD-2 single mutation path).
- Assumption: sha256 (not keccak) is the PoW + block-hash primitive, per the bench (sha256 ~35× faster than pure-JS keccak) and AD-6.
- Source conflict: registration-design.md R2 vs architecture AD-7 (this epic's R2) — the draw winner exponent. registration-design R2 states the winner is "the identity minimizing `c^(1/uptime)`"; AD-7 / this epic's R2 state winner = `argmin c^uptime` and explicitly **ban** minimizing `c^(1/uptime)` as "it inverts fairness." **Verified 2026-10-05:** with `c ~ U(0,1)`, `argmin c^uptime` ⟺ `argmax uptime·(−ln c)` ⟺ `argmax uptime·Y` for `Y ~ Exp(1)`, so a 2-identity draw (uptime 1 vs 2) is 1:2 proportional (FAIR); `argmin c^(1/uptime)` ⟺ `argmax Y/uptime`, giving 2:1 (INVERTED). AD-7 is correct; registration-design R2 has the exponent backwards.
- Decision: 2026-10-05 (inception) — the draw uses `argmin c^uptime` (AD-7), not `c^(1/uptime)` (registration-design R2, inverted). The draw slice implements AD-7; the registration-design R2 wording is flagged for a later `bmad-spec` correction (not load-bearing here — the epic R2 is authoritative and already resolved).
- Decision: 2026-10-05 (inception) — breakdown approved as 9 entries (spike + 8), build order: 1 (difficulty spike E1) → 2 (tracer: loop+PoW+applyBlock, one block) → 3 (drawWindow + vectors + Ticket interface) → 4 (draw verification + launch gate) → 5 (boot: start()→loadGenesis) → 6 (reward+fee economic model, burn-vs-credit) → 7 (multi-node sim) → 8 (refactor sweep) → 9 (closing e2e suite). Single owner/lane (`core/consensus`), so the chain is linear to avoid file collisions on the module barrel/loop; the tracer (2) uses a trivial single-node winner check (replaced by the draw slice 3) and a fixed-emission reward credit (refined by the economic model 6).
- Decision: 2026-10-05 (inception) — the difficulty/target algorithm (E1) is settled by the spike (entry 1) FIRST, because the tracer's PoW (entry 2) consumes the target. No `plan_checkpoint`/`done_checkpoint` on most entries (consistent with epics 1–2); estimation OFF. The draw (R2) is the novel contract epic 4 conforms to; the `Ticket` interface (proto message shape + draw input set) is defined by entry 3.
- Decision: 2026-10-05 (inception, resolves the set-validation "ask") — cross-epic sequencing: the initiative's epic-4 `after` already gates on epic 3 (needs = drawWindow contract + fixed vectors), so epic 3 fully precedes epic 4. Entry 6's fee-rate genesis field (a protocol change) therefore cannot collide with epic 4's genesis/proto edits; the fee-rate provenance is entry 6's `unknown`, settled + recorded as a Decision at build.
- Decision: 2026-10-05 (inception, resolves the set-validation shared-setup note) — the 1.1 test harness and 1.2 core skeleton are transitively required by every entry; the earliest entries that need each list them (1.1 on entry 1, 1.2 on entry 2); the rest reach them transitively through the chain.
- Decision: 2026-10-05 (E1 spike, ticket 1) — the PoW difficulty/target is **fixed at launch: N = 16 leading zero bits** in `sha256(canonicalBlockBytes(block))` (1/65536 expected attempts), and the **adjustment rule is "none"** — there is NO retargeting / difficulty-adaptation logic (a fixed-at-launch constant; any change is a protocol version bump, AD-7/AD-12). Rationale: the verifiable draw (AD-7), not the PoW, selects the slot winner, so difficulty carries no economic pressure; a fixed target keeps "≥1 hash per slot on commodity hardware" trivially true. Measured on the build machine (Node 24, `node:crypto` sha256, 322-byte canonical block): ~1.9M hashes/s and time-to-find ~5 ms (tens of ms on commodity hardware) — far under any 1-slot budget, yet a genuine 2^16 search space (not a no-op). The constant `POW_TARGET_LEADING_ZERO_BITS = 16` is the one the PoW check (`powCheck`) uses; the canonical digest form (BE fixed-width, proto field order, `hash` excluded, counter as a u64be field — AD-6/AD-12) is pinned in `packages/core/test/consensus-pow.test.ts` (CANONICAL_HEX) and the throughput evidence lives in `bench/pow-bench.js`.
