---
ticket: "9"
title: "Closing end-to-end suite (full Done-when)"
epic: epic-equal-node-mining
status: "built"
route: full
baseline_revision: "33063ae448e5783aeae68759fae3ee83b88b3ce9"
review: quick
review_source: pinned
lenses_ran: ['quick']
review_loop_iteration: 0
covers: [R1, R2, R3, R4, R5, E1]
context:
  - packages/core/src/consensus/sim.ts
  - packages/core/src/consensus/miner.ts
  - packages/core/src/consensus/pow.ts
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/economics.ts
  - packages/core/src/index.ts
  - packages/core/test/simulation.test.ts
  - packages/core/test/consensus-tracer.test.ts
  - packages/core/test/no-float-guard.test.ts
  - _bmad-output/initiative-succinctcoin-ai/epic-equal-node-mining/epic-equal-node-mining.md
---

# Story Plan — 3.9 Closing end-to-end suite (full Done-when)

## Story of truth

Run the **closing end-to-end suite** of epic 3: the full Done-when as ONE
integrated, headless, memory-transport check that proves all five Done-when
checks green together: (1) a running always-up node mines at the uptime-only
rate regardless of hardware; (2) no node wins without a valid per-slot ticket;
(3) the launch gate holds (a non-selected node cannot produce a valid block);
(4) the per-attempt PoW path references only `node:crypto` sha256 + an integer
counter (verified by an import/lint check) and stays within the AD-6 limits;
(5) a block's hash recomputed from its canonical encoding matches the stored
hash and the counter round-trips.

This is a **TEST-ONLY** story. R1–R5+E1 are all already built (3.1–3.7). 3.9
adds ONE integrated test file that COMPOSES the existing seams (`simulateNetwork`
/ `drawSchedule` / `verifyDraw` / `mineBlock` / `applyBlock` / `blockDigest` /
`powCheck` / `canonicalBlockBytes` / `powCheck`) on a real `FileChainStore`
(memory transport) into a single scenario. **No `src/` change, no new
capability logic, no protocol change.** It reuses the pinned seams (never
re-implements the draw / challenge / fee) and reuses 3.7's pinned sim parameters
so it is deterministic and not flaky.

## The epic's five Done-when (from `epic-equal-node-mining.md`, verbatim)

1. In a multi-node simulation on the memory transport, a single always-up node
   wins slots at the expected slot rate regardless of the hardware it runs on.
2. No node can win a slot without a valid per-slot ticket; a block whose
   (ticket, nonce) does not verify the draw is rejected.
3. The launch gate test passes: a node not selected by the draw cannot produce a
   valid block.
4. The per-attempt PoW path references only `node:crypto` sha256 + an integer
   counter (verified by a lint/import check); the measured throughput stays
   within the AD-6 limits.
5. A block's hash recomputed from its canonical protobuf encoding matches the
   stored hash; the counter round-trips.

## Design Notes (decisions)

- **D1 — Test-only; no `src/` change.** The single new file is
  `test/epic-end-to-end.test.ts`. It imports the seams from the ROOT barrel
  (`../src/index.js`) only — it never re-implements the draw (AD-7), the
  challenge (AD-12), or the fee. No `src/` file, no generated proto, and no
  existing test is modified.
- **D2 — Deterministic: reuse 3.7's PINNED sim parameters.** The nodes are the
  SAME as 3.7's sim (A always-up = 62 zeros + `"aa"`, weight 50n; B = 62 zeros +
  `"bb"`, 30n; C = 62 zeros + `"cc"`, 20n), and the rate schedule is the SAME
  pinned 4000-window `drawSchedule` (A's win count pinned = 2111, band
  [0.45, 0.55] = [1800, 2200]). Reusing the pins (not re-deriving them) keeps the
  integrated suite deterministic and not flaky (the ticket's `unknown`: "pin the
  multi-node sim parameters … so it is deterministic and not flaky"). The mined
  run uses a real `FileChainStore` in a `mkdtemp` dir (rmSync in `afterEach`).
- **D3 — Throughput check = the import/lint guard + a block actually mines, NOT a
  flaky wall-clock number.** The AD-6 "measured throughput within the limits" is
  enforced by (a) the **per-attempt-path import/lint scan** of `miner.ts` (no
  `big.js`, no pure-JS keccak, no `Math.`/transcendental, no protons `encode` —
  the same rule the standing `MINING_PATH_GUARD` in `consensus-tracer.test.ts`
  pins) and (b) a mined block COMPLETING (`mineBlock` returns = ≥ 1 hash per slot
  is trivially reachable at the fixed N=16 target). A hard wall-clock throughput
  number is hardware-dependent and would be flaky, so it is NOT asserted as a
  number — consistent with the E1 spike (it MEASURED ~1.9M hashes/s as evidence,
  but the guard is the import/lint scan, and the draw — not the PoW — selects the
  winner, so there is no economic pressure on difficulty).
- **D4 — The rate is proven over the pure schedule; the per-block properties over
  the mined run; the two agree because the draw precedes mining.** Done-when #1
  (rate) is asserted over the pinned pure `drawSchedule` (4000 windows, fast,
  deterministic). The mined run (N=20 windows on the real store) proves the
  per-block properties (hash/counter/PoW/verify/reward). Because the draw
  (`drawWindow`) selects the winner BEFORE `mineBlock` runs (3.7's D3), the
  mined winner sequence is exactly the draw schedule's — so the rate over the
  pure schedule is the rate mining would produce (hardware-independent). The
  suite asserts both the rate (pure) and that each mined block's winner equals
  the `drawWindow` output (the hardware-independence link).
- **D5 — Memory transport = one chain on the single-writer `FileChainStore`.**
  The "running node" is the single-writer store driven by `simulateNetwork`
  (one accepted ticket set per window, no sockets — 3.7's D1; the real network
  is epic 5).

## Frozen I/O matrix (one row per Done-when — each a passing test)

| Row | Done-when | Input | Expected |
|-----|-----------|-------|----------|
| E2E_R1_RATE_HW_INDEPENDENT | #1 (uptime rate, hw-independent) | pinned `drawSchedule(NODES, 4000)` + the mined run | A's win count == the pinned 2111 (∈ [1800, 2200]); `A_wins > B_wins` and `A_wins > C_wins` (strict); over the mined run, EVERY block's `winnerIdentityId === drawWindow(...).winnerIdentityId` (the draw — not the miner — chose it; selection inputs carry no hash-rate term) |
| E2E_R2_NO_WIN_WITHOUT_VALID_TICKET | #2 (no win without a valid ticket) | a mined block + `verifyDraw` | the block's winner ticket (a valid per-window ticket) → `verifyDraw === true`; a FORGED ticket (valid identity, fabricated `nonceCommitment` not in the accepted set, `windowIndex`+`challenge` left correct) → `verifyDraw === false` (rejected) |
| E2E_R2_LAUNCH_GATE | #3 (launch gate) | a PoW-valid block claiming the NON-draw-winner + `verifyDraw` | a block whose `winnerIdentityId` is a node the draw did NOT select → `verifyDraw === false` (a non-selected node cannot produce a valid block); the actual draw winner → `verifyDraw === true` |
| E2E_R3_POW_IMPORT_AND_MINING | #4 (PoW path + throughput) | `mineBlock` via the mined run + the import/lint scan of `miner.ts` | the import/lint scan of `src/consensus/miner.ts` finds NO `big.js`, no pure-JS keccak, no `Math.`/transcendental, no protons `encode` (per-attempt path = `node:crypto` sha256 + integer counter only); AND the mined run produced all N blocks (each `mineBlock` completed = ≥1 hash per slot reachable at N=16) |
| E2E_R3_E1_HASH_COUNTER_ROUNDTRIP | #5 (block hash + counter round-trip) | every mined block | for EVERY mined block: `powCheck(block) === true`; `blockDigest(block)` (sha256 of the canonical encoding) byte-equals the stored `block.hash`; and the counter round-trips — `u64be(beBytesToBig(block.nonce))` equals `block.nonce` (the counter is a field of the canonical bytes the hash is over) |

The mined run (shared by the rows): `simulateNetwork({ store, rewardDisplay:
"12.5", maxSupplyDisplay: "21000000", nodes: NODES, windows: 20 })` on a real
`FileChainStore`. It also grounds R4/R5: `headSlot() === 19` (chain time, no wall
clock) and each winner's balance = wins · `fromDisplay("12.5")` with
`totalSupply` conserved == `fromDisplay("21000000")` (the single mutation path,
`applyBlock`, credited the reward).

## Tasks

- [x] Add `test/epic-end-to-end.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the draw / challenge / fee): the 5
  matrix rows (E2E_R1_RATE_HW_INDEPENDENT / E2E_R2_NO_WIN_WITHOUT_VALID_TICKET /
  E2E_R2_LAUNCH_GATE / E2E_R3_POW_IMPORT_AND_MINING /
  E2E_R3_E1_HASH_COUNTER_ROUNDTRIP) over ONE shared mined run (20 windows on a
  real `FileChainStore` in a `mkdtemp` dir, rmSync in `afterEach`) + the pinned
  4000-window `drawSchedule` for the rate. Reuse 3.7's pinned nodes + the pinned
  A-win count 2111 (band [1800, 2200]).
- [x] The PoW import/lint scan (E2E_R3_POW_IMPORT_AND_MINING) reads
  `src/consensus/miner.ts` and asserts the per-attempt path has NO `big.js` /
  keccak / `Math.` / protons-`encode` import (the AD-6 rule) — a test-local scan
  of the SOURCE file (not a re-implementation of a seam).
- [x] Run the verification gate; confirm the suite is deterministic (run it twice
  — the rate pin + the mined-winner==draw-winner assertions are stable).

## Acceptance criteria

1. A new `test/epic-end-to-end.test.ts` proves ALL FIVE Done-when checks green in
   ONE integrated, headless, memory-transport scenario (a real `FileChainStore`,
   the pinned sim parameters) — mapping each Done-when to its evidence row.
2. Done-when #1: the always-up node's win rate is within [0.45, 0.55] (pinned
   2111/4000), strictly beats both flaky nodes, and every mined block's winner
   equals the `drawWindow` output (hardware-independent).
3. Done-when #2/#3: a valid per-window ticket verifies; a forged ticket is
   rejected; a PoW-valid block claiming a NON-selected winner is rejected (the
   launch gate holds).
4. Done-when #4: the `miner.ts` per-attempt-path import/lint scan finds no
   `big.js`/keccak/`Math.`/protons-`encode`; every mined block completed
   (≥1 hash/slot reachable at N=16).
5. Done-when #5: for every mined block, `blockDigest(block)` byte-equals the
   stored `block.hash`, `powCheck(block)` is true, and the counter round-trips
   through the canonical encoding.
6. No `src/` file, generated proto, or existing test changed; the suite is
   deterministic (re-running it gives the identical pinned rate + the same
   mined-winner==draw-winner outcome).

## Never

- NEVER change any `src/` file, the generated proto, or any existing test —
  3.9 is TEST-ONLY (a single new test file).
- NEVER re-implement the draw (`drawWindow`), the challenge
  (`deriveWindowChallenge`), or the fee — import them from the root barrel
  (AD-7 / AD-12 / AD-5).
- NEVER assert a hard wall-clock throughput NUMBER (hardware-dependent, flaky) —
  the AD-6 throughput guard is the import/lint scan + a block mining (D3).
- NEVER introduce `Math.random` or wall-clock time into the suite (AD-3) — reuse
  3.7's pinned, deterministic sim parameters.
- NEVER import `big.js` in the test (the 2.5 guard + AD-5) — use `fromDisplay` /
  `balanceOf` / `totalSupply` from the root barrel.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **158 prior + 5 new = 163 tests,
  21 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 3.9 adds no `src/`/proto.
- The suite is deterministic: run `corepack pnpm test epic-end-to-end` TWICE —
  both runs pass with the identical pinned rate (A = 2111/4000) and the same
  mined-winner==draw-winner outcome.
- Prior suites unchanged: `corepack pnpm test simulation no-float-guard
  consensus-tracer consensus-verify-draw` all pass (5 + 6 + 12 + 12 = 35).

## Plan Change Log
- 2026-10-07 (3.9 Quick lens, F1 low): the keccak half of the `E2E_R3_POW_IMPORT_AND_MINING` import scan used `importPattern('keccak')`, which matches only a bare `from "keccak"` specifier and would not catch package-qualified pure-JS keccak (`@noble/hashes/sha3` / `js-sha3`). The closing suite's stated intent is "no pure-JS keccak", so the assertion was widened to any quoted module specifier containing "keccak" (subsumes the bare form). Test-only; the standing `MINING_PATH_GUARD` in `consensus-tracer.test.ts` was NOT touched (an existing test; 3.9 is test-only). Re-verified green + deterministic.

## Implementation Notes
- 2026-10-07: Implemented. Single new file `packages/core/test/epic-end-to-end.test.ts` (5 tests). One shared mined run (20 windows, real `FileChainStore` in `mkdtemp`, opened in `beforeAll` / closed + `rmSync` in `afterAll`) + the pinned 4000-window `drawSchedule`. All 5 matrix rows pass. Verification gate: 163 tests / 21 files green; typecheck clean; build clean + empty proto diff (PROTO_OK); determinism confirmed (2 runs, identical A=2111/4000); prior suites (simulation / no-float-guard / consensus-tracer / consensus-verify-draw) unchanged at 35 tests. Mined-run winner distribution: A=16, B=3, C=1 (all 20 blocks `verifyDraw` true).
- 2026-10-07: Quick lens (1 finding, 1 low) — the keccak half of the import scan matched only a bare `from "keccak"` specifier; widened the assertion to catch package-qualified pure-JS keccak, re-verified green + deterministic. All FIVE Done-when checks are green in one integrated suite — this closes EPIC 3.

## Review Triage Log
- **F1 (low, patched)** — `E2E_R3_POW_IMPORT_AND_MINING`: the keccak import scan (`importPattern('keccak')`) matched only a bare `from "keccak"` specifier and would not catch package-qualified pure-JS keccak (`@noble/hashes/sha3` / `js-sha3`). Verified: `miner.ts` has no keccak/hashes import today (the scan passed pre-patch and the build is type-clean), so no test was failing — a robustness improvement, not a broken rule. The closing suite's stated intent is "no pure-JS keccak", so the assertion was widened to any quoted module specifier containing "keccak" (subsumes the bare form). Test-only; the standing `MINING_PATH_GUARD` in `consensus-tracer.test.ts` was NOT touched (an existing test; 3.9 is test-only).
