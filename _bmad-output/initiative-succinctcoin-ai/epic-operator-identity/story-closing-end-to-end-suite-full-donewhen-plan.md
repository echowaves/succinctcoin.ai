---
ticket: "10"
title: "Closing end-to-end suite (full Done-when)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "fa6966a79c27e6683cb727cb9dec05aec8da261b"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [R1, R2, R3, R4, E1, E2]
context:
  - packages/core/test/epic-end-to-end.test.ts
  - packages/core/test/multi-sim.test.ts
  - packages/core/test/identity-key-surface.test.ts
  - packages/core/test/identity-gate.test.ts
  - packages/core/src/consensus/multi-sim.ts
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/consensus/acceptance-cap.ts
  - packages/core/src/consensus/uptime.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/identity/gate-verifier.ts
  - packages/core/src/identity/identity.ts
  - packages/core/src/identity/reattestation.ts
  - packages/core/src/proto/protocol.proto
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/story-multi-identity-simulation-plan.md
---

# Story Plan — 4.10 Closing end-to-end suite (full Done-when)

## Story of truth

Run the **closing end-to-end suite** for epic 4 (operator-identity / CAP-2): the full
Done-when as **ONE integrated, headless, memory-transport scenario**. Like 3.9's
closing suite for epic 3, this is **TEST-ONLY** — one new file
(`packages/core/test/epic4-end-to-end.test.ts`) that COMPOSES the already-built
epic-4 identity seams (verifier 4.1, signature 4.2, acceptance seam 4.3, cap 4.4,
uptime 4.5, re-attestation 4.6) with the 4.8 multi-identity harness
(`simulateMultiNetwork` / `multiDrawSchedule` / `eligibleSignedSet` / `buildCappedSet`
/ `signedTicket`) and 3.3's `drawWindow` + 3.4's `verifyDraw` — **imported from the
root barrel only, NEVER re-implementing the draw (AD-7)**. It proves **ALL FIVE**
Done-when green together, in one headless memory-transport scenario (real
`FileChainStore` single-writer chain, no sockets, AD-10).

This story ADDS NO SOURCE. It is the integration proof the whole epic has been
building toward: the Done-when is not just true per-story, it holds in one
coherent sim of gate-verified identities over a mined chain.

## The five Done-when → rows (one integrated scenario)

ONE shared memory-transport run (real `FileChainStore`, `simulateMultiNetwork`) + the
pure `multiDrawSchedule` (no store) for the rate/cap/lapsed/rental rows + the offline
gate row. All rows run over the SAME pinned 4.8 fixture (below), so the pinned
counts are the EXACT 4.8 integers (deterministic, AD-3/AD-5 — no float, no rate
numbers, only exact integer counts / cross-multiplied weight comparisons).

| Row | Done-when | What it proves (composition, root-barrel only) |
|-----|-----------|------------------------------------------------|
| `E2E4_R1_CAP_THROUGHPUT` | **#1** (R1+R2) | (a) the **cap**: one identity submitting 3 tickets/window collapses to ONE share — the 3-ticket/window `multiDrawSchedule` is byte-identical to the 1-ticket schedule (extra tickets are dead weight, dropped by `buildCappedSet` before `drawWindow`). (b) the **N×**: a distinct operator running N gate-verified persons wins ~N× — over the 4000-window pure schedule, the N=1 operator's aggregate win count (`multiDrawSchedule([OP1∪BG])`) vs the N=3 operator's (`multiDrawSchedule([OP3∪BG])`): the N=3 aggregate ∈ [2×, 3×] the N=1 aggregate (exact BigInt cross-multiplication) and the operator's total draw weight = **N × L EXACT** (`3 × L` for N=3). ONE row = the full Done-when #1. |
| `E2E4_R2_WINNER_PUBLIC_REJECT` | **#2** (E2, AD-12) | the slot winner is verifiable from public data by ANY node (public-coin draw); a node NOT selected cannot win. Over the shared real-store `simulateMultiNetwork` run: EVERY mined block's winner is accepted from public data (`acceptBlockWinner(block, tickets, weights, challenge) === true`, re-deriving `challenge = deriveWindowChallenge(block.parentHash, block.slot)`); an unselected node's block is REJECTED — a non-drawn-winner claim → `false`; replaying the winner's EXACT public ticket fields with an EMPTY signature → `acceptBlockWinner false` while `verifyDraw` alone is `true`; with a FOREIGN identity's signature → `false` (the 3.4/3.7 residual replay closed end-to-end by the AD-12 signature). |
| `E2E4_R3_LAPSED_STOPS_K` | **#3** (R4) | a node whose re-attestation lapses stops producing valid tickets within K windows and loses eligibility. An identity with `attestedUntilWindow = D` (100n) is EXCLUDED from the accepted set from `D+1` onward (`isEligibleAtWindow` false — its win count stops rising after `D`); re-attesting at `W` (120n) re-includes it with the guaranteed-monotonic deadline `max(D, reattestationWindow(W, K))` = `max(100n, 120n+100n)` = **220n** (the 4.6 lesson). Over the pure schedule: X's wins = 32 in `[0..D]`, **0** in the lapsed band `[D+1 .. W-1]`, and 27 re-included in `[W .. run-end]`. All chain-time (AD-3). |
| `E2E4_R4_GATE_OFFLINE_NO_BLOB` | **#4** (R3, AD-4) | the `GateVerifier` port is the ONLY place credential fields are read; a `Ticket` never carries the credential blob (schema + test). (a) the OFFLINE verifier round-trips: `issueGateCredential(gateId, identityId, window)` → `createOfflineGateVerifier().verify(cred, window)` → `{ valid:true, identityId, attestedUntilWindow }`; a non-accepted gateId → `{ valid:false }` (the accepted-gate registry, must-hold (c)). (b) the proto `Ticket` message has NO blob/credential field (schema: `Ticket` fields are exactly the five identity/draw fields). (c) the `.blob` reader scan (comment-stripped `src/**`, `/\.blob(?![\w(])/`) resolves to EXACTLY `['identity/gate-verifier.ts']` — the verifier is the single credential reader. |
| `E2E4_R5_RENTAL_LINEAR` | **#5** (R1, accepted limitation) | identity rental is **linear-cost** (per-identity floor, not per-operator equality). The SAME 3 operator `identityId`s grouped two genuinely-different ways ("one operator, 3 identities" vs "3 operators, 1 each" — different array ORDERINGS of the same identityIds, guarded non-identical + same sorted multiset) yield BYTE-IDENTICAL aggregate win counts over the pure schedule (the protocol is operator-blind — it sees only distinct `identityId`s); and the aggregate is a LINEAR function of distinct-identity count (N identities → N×, not N²/√N). The accepted limitation holds. |

## The pinned fixture (REUSE 4.8 EXACTLY — deterministic, AD-3/AD-5)

Same as `test/multi-sim.test.ts` (so the pinned counts are the same 4.8 integers):
- `seedFor(i)` = 32 bytes filled `0x40 + i`; `makeIdentity(i)` = `{ keypair:
  deriveIdentityKeypair(seedFor(i)), attestedUntilWindow: 100000n, validWindows:
  [0..RATE_WINDOWS) }` (fully up, weight `L` at every window ≥ L).
- `BG = [makeIdentity(0), makeIdentity(1), makeIdentity(2)]`; `OP1 =
  [makeIdentity(3)]`; `OP3 = [makeIdentity(3), makeIdentity(4), makeIdentity(5)]`.
- `K = 100n`, `L = 50n` (genesis `loadGenesis` via `fileURLToPath` 4-up to
  `config/genesis.json`, as 4.8 does; assert `K===100n`, `L===50n`).
- `RATE_WINDOWS = 4000` (pure schedule); `REWARD_DISPLAY = '12.5'`,
  `MAX_SUPPLY_DISPLAY = '21000000'`; the shared real-store run uses a small pinned
  window count (e.g. 5) for the mined-path row.
- **Pinned counts (the 4.8 integers, re-asserted here as ONE integrated suite):**
  R1 cap-collapse 3-ticket ≡ 1-ticket (A=1330/B=1313/C=1357 over the 1-ticket
  schedule); R1 N×: N=1 aggregate = 1007, N=3 aggregate total = 2031 (ratio band
  [2×,3×] via exact BigInt cross-multiplication `2n*n1 <= n3total <= 3n*n1`), operator
  total weight = `3n * L` EXACT; R3 lapsed X = 32/0/27, `max(D,W+K)=220n`; R5 rental
  the two groupings byte-identical.

## Acceptance criteria

- **AC-1 — TEST-ONLY:** the ONLY new file is `packages/core/test/epic4-end-to-end.test.ts`
  (+ the plan). `git diff <baseline>` over `packages/core/src` is EMPTY (no source
  changed). The test imports ONLY from `../src/index.js` (the root barrel) + `node:*`
  builtins (crypto, fs, os, path, url) — never from a sub-module path, never
  `big.js`.
- **AC-2 — ALL FIVE Done-when:** the file has exactly 5 rows, one per Done-when
  (`E2E4_R1_CAP_THROUGHPUT`, `E2E4_R2_WINNER_PUBLIC_REJECT`, `E2E4_R3_LAPSED_STOPS_K`,
  `E2E4_R4_GATE_OFFLINE_NO_BLOB`, `E2E4_R5_RENTAL_LINEAR`), each asserting its
  Done-when over the pinned fixture.
- **AC-3 — ONE integrated headless memory-transport scenario:** the rows share ONE
  memory-transport context — a single real `FileChainStore` (single-writer chain, no
  sockets) for the mined-path row + the pure `multiDrawSchedule` for the schedule
  rows — proving the Done-when together (the 3.9 pattern). No real sockets, no new
  runtime deps (AD-10).
- **AC-4 — NEVER re-implement:** the draw (`drawWindow`), the challenge
  (`deriveWindowChallenge`), the cap (`buildCappedSet`/`applyAcceptanceCap`), the
  uptime (`computeUptimeWeight`), the signature (`signTicket`), the acceptance
  (`acceptBlockWinner`), the eligibility (`isEligibleAtWindow`/`reattestationWindow`),
  and the gate (`issueGateCredential`/`createOfflineGateVerifier`/`verifyReattestation`)
  are all IMPORTED from the barrel. No `Math.random`, no wall clock (AD-3); no float /
  no `big.js` in the test (AD-5 — every "~N×"/"linear" assertion is an exact integer
  count or cross-multiplied comparison).
- **AC-5 — Green headless:** `pnpm test` passes — the suite goes **203 → 208 tests
  (29 → 30 files)** (+5, the new rows only; every prior suite unchanged); `pnpm build`
  passes; the suite is **deterministic** (the pinned counts are stable across 2 runs).

## Never (hard constraints)

- NEVER touch `packages/core/src/**` (no source change — this is the test-only
  closing suite, 3.9/4.7 precedent). No new source file, no barrel change.
- NEVER re-implement the draw / challenge / cap / uptime / signature / acceptance /
  gate — compose the imported seams only (AD-7).
- NEVER import from a non-root path (`../src/consensus/...`, `../src/identity/...`) or
  from `big.js` — root barrel `../src/index.js` + `node:*` only.
- NEVER use `Math.random`, a wall clock, a float rate, or `number` for a protocol
  quantity (AD-3/AD-5) — exact `bigint` counts / cross-multiplication.
- NEVER weaken or edit any existing guard test (the 2.5 no-float, 3.9 mining-path,
  4.1 `.blob` scan, 4.7 key-surface, or any 4.x identity suite) — they stay green and
  byte-identical.
- NEVER change the proto.

## Verification (acceptance gate)

From the repo root (`corepack pnpm`; `pnpm` not on PATH). ALL green:

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → **208 tests / 30 files**
   (203 prior + 5 new).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1 && git diff --name-only -- packages/core/src/ && echo PROTO_OK`
   → **EMPTY src diff** (no source changed) + `PROTO_OK`.
4. **ADDITIVE (hard):** every prior suite UNCHANGED — the 203 prior tests still pass;
   run the key ones explicitly: multi-sim (5), consensus-accept-winner (5),
   consensus-acceptance-cap (5), consensus-uptime (5), identity-re-attestation (5),
   identity-gate (5), identity-signature (5), identity-key-surface (5), no-float (6),
   consensus-verify-draw (12), simulation (5), epic-end-to-end (5).
5. **Determinism:** run the new `epic4-end-to-end` suite twice (or the full suite
   twice); the pinned counts are identical both runs (no flake).
6. **60s timeouts:** the pure-schedule rows (R1, R3, R5) sign ~4000 real Ed25519
   tickets (`signTicket` ~0.03 ms each) and exceed vitest's 5s default — set a 60s
   `timeout` on those rows (the 4.8 precedent). The mined-path (R2) and gate (R4)
   rows are fast (default timeout).

## Task

- [x] Write `packages/core/test/epic4-end-to-end.test.ts` — 5 rows (one per Done-when)
      over the pinned 4.8 fixture, composing the root-barrel seams only, ONE
      integrated headless memory-transport scenario (one real `FileChainStore` run +
      the pure `multiDrawSchedule`); 60s timeouts on the schedule rows.
- [x] Confirm `packages/core/src` diff is EMPTY; run the full verification gate
      (steps 1–6); confirm 208/30, all prior suites unchanged, deterministic ×2.
- [x] Fill the Implementation Notes (the exact pinned counts observed, any
      deviation) + the matrix-row → Done-when mapping.

## Implementation Notes

Implemented 2026-10-09. ONE new file: `packages/core/test/epic4-end-to-end.test.ts`
(5 rows, one per Done-when) over the pinned 4.8 fixture, composing the root-barrel
seams only (`../src/index.js` + `node:*`). TEST-ONLY — `packages/core/src` diff is
EMPTY (verified: `git diff --name-only -- packages/core/src/` → empty, no untracked).

Matrix-row → Done-when mapping:
- `E2E4_R1_CAP_THROUGHPUT` → Done-when #1 (R1+R2): cap-collapse (3-ticket ≡ 1-ticket)
  + N× (N=3 ∈ [2×,3×] N=1, operator weight 3×L EXACT).
- `E2E4_R2_WINNER_PUBLIC_REJECT` → Done-when #2 (E2, AD-12): every mined block
  accepted from public data; non-drawn winner / empty sig / foreign sig all rejected.
- `E2E4_R3_LAPSED_STOPS_K` → Done-when #3 (R4): lapsed identity excluded D+1 onward;
  re-attest at W re-includes with monotonic deadline max(D, W+K)=220n.
- `E2E4_R4_GATE_OFFLINE_NO_BLOB` → Done-when #4 (R3, AD-4): offline verifier round-trip
  + non-accepted gateId reject; proto `Ticket` has no blob field; `.blob` scan ==
  exactly `['identity/gate-verifier.ts']`.
- `E2E4_R5_RENTAL_LINEAR` → Done-when #5 (R1, accepted limitation): two genuinely-different
  orderings (guarded non-identical + same sorted multiset) → byte-identical aggregate;
  aggregate linear in distinct-identity count.

Observed pinned counts (all EXACT, matched the frozen 4.8 pins — NO deviation):
- R1 cap-collapse: 3-ticket/window schedule byte-identical to 1-ticket; per-identity
  win counts over the 1-ticket schedule A=1330 / B=1313 / C=1357 (sum 4000).
- R1 N×: N=1 aggregate = 1007, N=3 aggregate total = 2031; `2n*1007 <= 2031 <= 3n*1007`
  (2014 ≤ 2031 ≤ 3021) holds via exact BigInt cross-multiplication; operator total
  draw weight = 3n*L = 150n EXACT (per-identity weights [50n,50n,50n]).
- R2 (mined-path, 5 windows): every mined block `acceptBlockWinner` true (re-derived
  challenge from block.parentHash+slot); non-drawn-winner claim → false; winner's public
  fields + EMPTY sig → `acceptBlockWinner` false while `verifyDraw` true; foreign-key sig
  → false.
- R3 lapsed X (D=100n, W=120n, K=100n): X wins 32 in [0..100], 0 in [101..119] (lapsed
  band, and 0 across [101..199]), 27 re-included in [120..199]; re-attested deadline
  max(100n, reattestationWindow(120n,100n)=220n) = 220n.
- R4: offline round-trip `{valid:true, identityId, attestedUntilWindow:100000}`; non-accepted
  `rogue-gate` → `{valid:false, identityId:'', attestedUntilWindow:0}`; proto `Ticket`
  field set == [challenge, identityId, nonceCommitment, signature, windowIndex] (no blob);
  comment-stripped src/** `.blob` scan == ['identity/gate-verifier.ts'].
- R5 rental: two orderings guarded non-identical + same sorted multiset → byte-identical
  schedule; N=3 aggregate total = 2031 (same 4.8 pin); `2n*1007 <= 2031 <= 3n*1007` holds;
  per-identity shares each ∈ [n1/2, n1] and sum EXACTLY to the aggregate (linear, not
  N²/√N).

Verification gate (all green):
1. `corepack pnpm test` → **208 tests / 30 files** (203 prior + 5 new).
2. `corepack pnpm typecheck` → clean (tsc exit 0, no diagnostics).
3. `corepack pnpm build` → passes; `git diff --name-only -- packages/core/src/` EMPTY +
   no untracked; `packages/core/src/proto/` byte-identical → **PROTO_OK**.
4. ADDITIVE — all prior suites unchanged (ran explicitly, 12 files / 68 tests):
   multi-sim 5, consensus-accept-winner 5, consensus-acceptance-cap 5, consensus-uptime 5,
   identity-re-attestation 5, identity-gate 5, identity-signature 5, identity-key-surface 5,
   no-float 6, consensus-verify-draw 12, simulation 5, epic-end-to-end 5.
5. Determinism: `epic4-end-to-end` run twice → 5/5 both runs (the pins are hard `toBe`
   integers, so any drift would fail, not pass).
6. 60s timeouts on the pure-schedule rows (R1, R3, R5 — each signs ~4000 real Ed25519
   tickets); the mined-path (R2) and gate (R4) rows use the default timeout.

No deviations. No counts re-pinned. No source / barrel / proto changed.

## Plan Change Log

- 2026-10-09 (implementer): Implemented the story per the plan as written — one new
  test file + these notes. No design, fixture, or acceptance change; the pinned 4.8
  integers reproduced exactly (no re-pinning needed). `status:` left as-is (orchestrator
  owns status transitions). No plan edit beyond this Notes + Change Log append.

## Review Triage Log

Quick lens (1 iteration, 2026-10-09): ZERO blocking findings. All five Done-when
proven honestly by composition over the pinned 4.8 fixture (AD-3/AD-4/AD-5/AD-7/
AD-10/AD-12 all hold); root-barrel-only imports; the frozen 4.8 pins (1330/1313/
1357, 1007, 2031, 32/27, 220n) asserted as EXACT `toBe` integers (deterministic —
no re-pinning, no weakened guards); strictly TEST-ONLY (src diff empty, proto
byte-identical); 208/30 green, typecheck clean, additive suites unchanged,
deterministic ×2. Three non-blocking minor observations (NOTE, no action taken):
1. R2 mined row runs on the default (5s) timeout while mining 5 windows of 16-bit
   PoW — empirically safe (full suite + two isolated runs pass with margin), and it
   matches 4.8's equivalent mined row (3 windows, default timeout). Flagged for
   awareness only; would be the first row to flake if CI slowed. No change.
2. Two 4.8-internal refinement pins are not re-asserted here: the N=3 per-identity
   breakdown [678,677,676] and the B/C per-phase counts — neither is part of the 5
   Done-when nor the enumerated frozen-pin list; 4.10 covers the Done-when essence
   (N=3 total toBe(2031) + the [2×,3×] band + per-share ∈ [n1/2, n1] summing EXACTLY
   to the aggregate in R5; X = 32/0/27 in R3). No Done-when weakened. No change.
3. The store is opened per row (beforeEach) but only R2 uses it, so R1/R3/R4/R5 each
   open+close an unused `FileChainStore`. Harmless + consistent with the plan's
   per-row lifecycle (Q6) and the 3.9 precedent (which uses beforeAll/afterAll with
   one shared store). Cosmetic, no correctness/isolation impact. No change.
