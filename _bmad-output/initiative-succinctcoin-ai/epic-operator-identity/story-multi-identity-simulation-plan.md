---
ticket: "8"
title: "Multi-identity simulation (acceptance cap + uptime + re-attestation)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "f3b58e60976bd5d03d4ad702f3023053250063e2"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [R1, R2]
context:
  - packages/core/src/consensus/sim.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/acceptance-cap.ts
  - packages/core/src/consensus/uptime.ts
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/identity/identity.ts
  - packages/core/src/identity/reattestation.ts
  - packages/core/src/identity/gate-verifier.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/index.ts
  - packages/core/test/simulation.test.ts
  - packages/core/test/consensus-accept-winner.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/registration-design.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.8 Multi-identity simulation (acceptance cap + uptime + re-attestation)

## Story of truth

Build the **multi-identity memory-transport simulation** (the epic's high-risk
wiring story) that proves the registration design's R1/R2 and the Done-when:
in a sim of N gate-verified identities, an identity's slot-eligibility is
bounded at **one share** (the acceptance cap makes its extra tickets worth
nothing), while **N distinct** gate-verified identities add a full share each
(uptime) — a **linear, operator-blind** aggregation (the "identity rental is
linear-cost, per-identity floor, not per-operator equality" accepted
limitation). A **lapsed** identity's tickets stop being accepted, and **every
slot winner is verifiable from public data** while an **unselected node's block
is rejected**. The sim **reuses** 3.3's `drawWindow` + 3.4's `verifyDraw` (never
re-implements the draw — AD-7) and uses epic-4's **signed tickets** (4.2,
AD-12), the **uptime** seam (4.5), the **acceptance cap** (4.4), and the
**re-attestation** seam (4.6). K/L come from genesis.

This is the ONE story of epic 4 that **adds source** (a new sim module) — unlike
4.7 (a pure test guard). It is the integration harness that wires 4.2–4.6 into
epic-3's draw/acceptance path. It is **ADDITIVE**: a new module + new tests; it
does NOT modify `sim.ts` (epic-3's 5-suite stays green), `draw.ts`,
`verify-draw.ts`, `accept-winner.ts`, `acceptance-cap.ts`, `uptime.ts`, any
`src/identity` module, the genesis seam, `ports.ts`, or `protocol.proto`.

## The honest R1/R2 model (settles the ticket's `unknown`)

`registration-design.md` R1 is explicit: **"The protocol can never know who an
'operator' is — 'τ per operator' is not enforceable."** What it *can* enforce is
**one valid ticket per IDENTITY per window** (must-hold (a): "N identities = N×
the *creation* cost and **1× the *eligibility* each**"). So the enforceable,
testable model is:

- **R1 — the acceptance cap bounds a SINGLE identity to one share.** An identity
  that submits extra tickets in a window is collapsed to one (keep-first), so
  its draw weight is counted ONCE — its slot-eligibility is **one share, not
  more**. "N identities of one operator earn no more than one" = each identity
  earns at most **one identity's share** (the cap makes per-identity inflation
  worthless). The protocol cannot (and does not) collapse *distinct* identities.
- **R2 — N DISTINCT gate-verified identities add a full share each (uptime),
  LINEARLY and OPERATOR-BLINDLY.** Each of the N distinct identities
  contributes one full uptime share, so the operator's **total draw weight in
  the accepted set is N × L (EXACT)** and its slot-throughput **grows linearly**
  (not superlinearly) in its distinct-identity count — each new identity adds a
  share. This is identical whether the N are "one operator's N persons" or "N
  operators' 1 person each" — the protocol sees only **distinct identityIds**,
  not operators. That linearity **IS** the accepted limitation: "identity rental is linear-cost
  (per-identity floor, not per-operator equality)."

The sim proves **both** sides with EXACT deterministic pins (AD-3: no RNG / wall
clock — every challenge, commitment, and signature is a pinned `sha256` /
Ed25519 of public data): the cap collapses an identity's duplicate tickets
(R1), and distinct identities aggregate linearly, operator-blind (R2 + rental).

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — ONE new module `src/consensus/multi-sim.ts` (ADDITIVE; `sim.ts`
  untouched).** The module generalizes 3.7's `sim.ts` (fixed uptime + empty
  signature) into the epic-4 multi-identity harness: **signed tickets** (4.2),
  **uptime-derived weights** (4.5, `computeUptimeWeight`), **re-attestation
  eligibility** (4.6, `isEligibleAtWindow`), and the **acceptance cap** (4.4,
  `applyAcceptanceCap`) — composing with the imported `drawWindow` (3.3, AD-7)
  and `acceptBlockWinner` (4.3, which composes `verifyDraw` +
  `verifyTicketSignature`). `sim.ts` and its 5-test suite are NOT modified
  (ADDITIVE — the epic-3 `simulation` suite stays green). The module is a
  standalone validation harness, NOT wired into `createCore` (like 3.7's
  `sim.ts`).
- **D2 — The draw is IMPORTED, never re-implemented (AD-7); the signature and
  cap/uptime/eligibility are IMPORTED (AD-12 / 4.4 / 4.5 / 4.6).** The module
  calls `drawWindow` for the winner, `applyAcceptanceCap` for the cap,
  `computeUptimeWeight` for the weight, `isEligibleAtWindow`/
  `reattestationWindow` for the re-attestation gate/cadence, and `signTicket` /
  `acceptBlockWinner` for the signature/acceptance. It NEVER re-derives the draw
  (argmin `c^W`), the challenge (`deriveWindowChallenge`), the fee, or the
  signature digest. It imports from the **module barrels** (`./draw.js`,
  `./acceptance-cap.js`, `./uptime.js`, `./accept-winner.js`, `./verify-draw.js`,
  `./miner.js`, `./apply-block.js`, `./slot-loop.js`, `../identity/index.js`,
  `../ledger/index.js`) — the same intra-package imports `sim.ts` and
  `accept-winner.ts` already use (consensus→identity is an established pattern).
- **D3 — The sim identity carries the keypair (core-internal), NOT the read-API
  surface (AD-11).** `MultiSimIdentity { keypair, attestedUntilWindow,
  validWindows }` holds the AD-11 key material **inside core** (the sim is a
  core validation harness, not the `ReadPeer`/`ReadBlock`/`CoreEvents[K]`
  public surface). It calls `signTicket(keypair, fields)` (the identity module's
  OWN `.secret` read) — the module NEVER reads `.secret` directly, so 4.7's
  single-reader invariant ("only `identity/identity.ts` reads `.secret`") stays
  green. The keypair is never projected onto a public-surface type.
- **D4 — Uptime is DERIVED from the lookback, not a fixed input (R2/4.5).** Each
  identity's draw weight at window `w` is `computeUptimeWeight(validWindows, w,
  lookbackL)` — the count of its DISTINCT valid windows in `[w−L, w−1]` (ramp
  from zero, moving window). For the "~N×" rows the N identities are all
  fully-up (weight `L` each in steady state); a fresh identity ramps from 0.
  `lookbackL` = genesis `uptimeLookbackL`.
- **D5 — Re-attestation is the eligibility gate (R4/4.6, chain-time).** An
  identity is in the accepted set at window `w` only while
  `isEligibleAtWindow(attestedUntilWindow, w)`; a lapse at `w = D+1` excludes it
  from `D+1` onward (stops producing valid tickets). Re-attesting at `W` sets a
  new deadline `reattestationWindow(W, K)`; the sim applies
  `max(oldDeadline, W + K)` for a **guaranteed-monotonic** deadline (the 4.6
  lesson — a pure `W+K` can shorten on an early re-attest). `K` = genesis
  `reattestationK`.
- **D6 — REAL signed tickets close the residual replay (AD-12/4.2/4.3).** Every
  ticket is `signTicket(keypair, { windowIndex, challenge, nonceCommitment })`
  over the EXACT AD-12 digest; the block carries the winner's SIGNED proto
  `Ticket` (encoded); the acceptance check is `acceptBlockWinner` (composes
  `verifyDraw` + `verifyTicketSignature`). An **unselected** node reusing the
  winner's public ticket fields but without the winner's key → empty/foreign
  signature → REJECTED (the 3.4/3.7 residual replay is closed end-to-end here).
- **D7 — Determinism by pinning (AD-3/AD-10; the 3.3/3.7 precedent).** NO
  `Math.random`, NO wall clock. Every challenge = `deriveWindowChallenge`
  (pinned `sha256`), every commitment = a pinned per-(identity, window) `sha256`
  of public data, every signature = deterministic Ed25519. The winner counts
  over a pinned schedule are EXACT integers → **pin them** (the 3.3
  `PROPORTIONAL_RATE` / 3.7 `SIM_RATE` precedent: 2696/4000, 2111/4000). The
  "~N×" / "linear" / "≤ one share" assertions are EXACT integer comparisons
  (counts and cross-multiplied weight totals) — NO float rate (AD-5; the
  no-float guard + spine rule). The test verifies 2-run stability.
- **D8 — Pinned sim parameters (the ticket's `unknown` — a build decision).**
  Identity seeds are fixed 32-byte values (4.2-style, no RNG); the background
  set is 3 fixed identities (weight `L`); the operator set is N fixed
  identities (weight `L`); `lookbackL = 50`, `K = 100` (from genesis); the
  window count for the rate rows is pinned (e.g. 4000, matching 3.7). These are
  PINNED constants in the test (deterministic, reproducible). The statistical
  tolerance for "~N×" is an INTEGER band around the pinned exact counts (the
  draw is deterministic, so the band is a guard against a pin drift, not a
  flake absorber).

## The module API (new `src/consensus/multi-sim.ts`, additive exports)

- `MultiSimIdentity { keypair: IdentityKeypair; attestedUntilWindow: bigint;
  validWindows: ReadonlyArray<bigint> }` — the sim identity: its AD-11 keypair
  (for signing, core-internal), its re-attestation deadline, and its valid-
  ticket history (for the uptime weight).
- `signedTicket(keypair, slot, parentHash, challenge): ProtoTicket` — one REAL
  signed proto `Ticket` (AD-12): `nonceCommitment` = a pinned per-(identity,
  slot, parent) `sha256` of public data, `signature` = `signTicket(keypair,
  { windowIndex: slot, challenge, nonceCommitment })` (64-byte Ed25519). The
  commitment is domain-separated (`"SC-MULTISIM-COMMIT/1"`), distinct per
  (identity, slot) — so an identity CAN submit multiple distinct tickets in a
  window (the R1 cap case) and they are byte-different.
- `buildCappedSet(rawProtoTickets, rawWeights): CappedSet` — applies
  `applyAcceptanceCap` (4.4, imported) to a raw aligned set (allowing multiple
  tickets per identity) → the capped (one-ticket-per-identity) aligned set.
- `eligibleSignedSet(identities, slot, parentHash, challenge, lookbackL):
  WindowAcceptedSet` — the normal builder: for each identity ELIGIBLE at `slot`
  (`isEligibleAtWindow`, 4.6), one `signedTicket` + weight
  `computeUptimeWeight(validWindows, slot, lookbackL)` (4.5); in `identities`
  order (so `tickets[i]`/`weights[i]`/`protoTickets[i]` align).
- `simulateMultiWindow({ store, rewardDisplay, maxSupplyDisplay, identities,
  lookbackL }): Promise<MultiSimWindowResult>` — one window end-to-end on the
  memory transport: `nextSlotAndParent` → `deriveWindowChallenge` →
  `eligibleSignedSet` → `applyAcceptanceCap` → **`drawWindow` (AD-7)** →
  `mineBlock` (winner, winner's SIGNED proto ticket) → `applyBlock` →
  **`acceptBlockWinner` (4.3: `verifyDraw` + `verifyTicketSignature`)**.
  Returns `{ block, winnerId, accept, tickets, weights, challenge }`.
- `simulateMultiNetwork({ ..., identities, windows }): Promise<Array<{ block,
  winnerId, accept }>>` — thread the store head across `windows` windows (ONE
  chain, ONE accepted set per window — the memory transport, D1).
- `multiDrawSchedule(identities, windows, lookbackL): Array<{ winnerId, slot }>`
  — the PURE rate schedule (NO mining/store): `FIXED_PARENT` (32 zeros) + slot
  = window index → `deriveWindowChallenge` → `eligibleSignedSet` → cap →
  `drawWindow` → winner. Fully deterministic (AD-3) — the fast path the rate
  rows consume (mirrors 3.7's `drawSchedule`).

## Frozen I/O matrix (each row a passing test)

Shared deterministic fixture (AD-3: no RNG / wall clock): fixed 32-byte seeds
→ keypairs (via the **IMPORTED** `deriveIdentityKeypair`); a background set of 3
fixed identities (all fully-up, weight `L`); an operator set of N fixed
identities (all fully-up, weight `L`); `lookbackL = 50`, `K = 100` (from
genesis `loadGenesis`); a pinned window count (e.g. 4000). All seams imported
from the ROOT barrel (`../src/index.js`); the sim module's new exports imported
from the same root barrel (additive re-exports). **No float** — exact integer
count / weight comparisons (AD-5).

| Row | Input | Expected |
|-----|-------|----------|
| MSIM_R1_CAP_PER_IDENTITY | one identity A submitting **3 distinct signed tickets** in a window (3 distinct pinned commitments, weight counted per ticket) + B + C; the raw aligned set → `buildCappedSet` (the 4.4 cap) → `drawWindow` (AD-7) | the cap **collapses A to ONE ticket** (keep-first, 4.4); A's draw weight is counted **ONCE** — A's slot-eligibility is **one share, not more** (R1: "a second identity/ticket from the same identity earns no extra eligibility"); the capped set's total weight slots = **distinct identity count (3)**, not raw ticket count (5); over a pinned schedule, A's win count with **3 tickets/window === A's win count with 1 ticket/window** (the extra tickets are pure dead weight, dropped before the draw) — an identity's extra tickets earn **no extra** eligibility |
| MSIM_R2_N_PERSONS_NX | the PURE `multiDrawSchedule` over a fixed **background** (3 identities, weight `L`) + the **operator's N identities** (each weight `L`, all fully-up) for a pinned window count; compare N=1 vs N=3 | against the fixed background, the operator's throughput is **LINEAR in distinct-identity count** (each new distinct identity adds one full uptime share): the operator's **total draw weight in the accepted set = N × L (EXACT)** — the strongest, exact form of "N DISTINCT gate-verified persons add a full share each" (R2). The operator's **win-COUNT/throughput** scales ~N× linearly: with this fixed 3-identity background the operator's weight *share* goes `L/4L → 3L/6L` (1/4 → 1/2), so N=3 ≈ **2×** the N=1 win count (asserted in the **integer band [2×, 3×]**, EXACT cross-multiplication, no float — separating LINEAR growth from flat 1× / superlinear ≥4×); each of the 3 distinct identities carries the SAME per-identity weight `L` as the N=1 identity. The draw is the **IMPORTED** `drawWindow` (AD-7 — never re-implemented). NOTE: the honest claim is the EXACT `N×L` total weight + LINEAR (not superlinear) win growth — NOT "N identities win N× the single identity's TOTAL win count" (that would be an operator-level cap the protocol cannot enforce — registration-design R1 / the Never clause) |
| MSIM_RENTAL_LINEAR_PER_IDENTITY | the operator's N identities grouped two ways: (a) "ONE operator, N identities" and (b) "N operators, 1 identity each" — the SAME N distinct identityIds, same uptimes | the accepted set and the operator's aggregate win counts are **IDENTICAL** in (a) and (b) (the protocol sees only **distinct identityIds**, no operator concept — **operator-blind**); the operator's aggregate is a **LINEAR** function of distinct-identity count (N identities → N×, not N² or √N) — **identity rental is linear-cost (per-identity floor, not per-operator equality)**, the accepted limitation made concrete (R2 / registration-design "Known, accepted limitations") |
| MSIM_LAPSED_STOPS_K | an identity with `attestedUntilWindow = D` (eligible through `D`, lapses at `D+1`), the `isEligibleAtWindow` gate (4.6) + `reattestationWindow` cadence (`max(old, W+K)` for monotonic), `K` from genesis | a **lapsed** identity is **excluded from the accepted set** from `D+1` onward (`isEligibleAtWindow` false) → its tickets **stop being accepted** and its win count **stops increasing after `D`** (R4 / must-hold (d): "a node whose re-attestation lapses stops producing valid tickets within K windows and loses eligibility"); re-attesting at `W` re-includes it with deadline `max(D, W + K)` (monotonic — the 4.6 lesson); all **chain-time** (AD-3, no wall clock) |
| MSIM_WINNER_PUBLIC_VERIFY | the full `simulateMultiNetwork` (real `FileChainStore` memory transport) with **REAL signed tickets** (AD-12); the winner's block carries its SIGNED proto `Ticket`; the acceptance check is `acceptBlockWinner` (4.3: `verifyDraw` + `verifyTicketSignature`) | **every** mined block's winner is **accepted** from PUBLIC data (`acceptBlockWinner === true` — the draw is recomputable by any node, R2 "public-coin draw"); an **unselected** node's block is **REJECTED**: (a) a block claiming a non-drawn winner → `acceptBlockWinner === false`; (b) the winner's public ticket fields with an **empty / foreign / forged signature** (an unselected node that does not hold the winner's key) → `acceptBlockWinner === false` **even though** `verifyDraw` alone passes — the 3.4/3.7 **residual replay is closed end-to-end** by the AD-12 signature (Done-when: "a node not selected by the draw cannot win a slot") |

## Tasks

- [x] Add `src/consensus/multi-sim.ts` (the additive multi-identity sim module —
  `MultiSimIdentity`, `signedTicket`, `buildCappedSet`, `eligibleSignedSet`,
  `simulateMultiWindow`, `simulateMultiNetwork`, `multiDrawSchedule`) composing
  the IMPORTED seams (`drawWindow` AD-7, `applyAcceptanceCap` 4.4,
  `computeUptimeWeight` 4.5, `isEligibleAtWindow`/`reattestationWindow` 4.6,
  `signTicket`/`acceptBlockWinner` 4.2/4.3, `mineBlock`/`applyBlock`/
  `nextSlotAndParent`, `deriveWindowChallenge`); NEVER re-implement the draw /
  challenge / fee / signature digest. **ADDITIVE:** do NOT modify `sim.ts` or
  any existing `src/consensus` / `src/identity` module. No `big.js` (AD-5); no
  float; no RNG / wall clock (AD-3).
- [x] Add additive barrel re-exports in `src/consensus/index.ts` + `src/index.ts`
  (the new module's exports + the `MultiSimIdentity` type). **ADDITIVE only.**
- [x] Add `test/multi-sim.test.ts` (imports from the ROOT barrel `../src/index.js`
  only — never re-implements the keypair / signature / draw / cap / uptime;
  `node:fs`/`os`/`path` only for a real `FileChainStore` temp dir in the
  full-path row, as 3.7's `simulation.test.ts` does): the 5 matrix rows
  (MSIM_R1_CAP_PER_IDENTITY / MSIM_R2_N_PERSONS_NX / MSIM_RENTAL_LINEAR_PER_IDENTITY
  / MSIM_LAPSED_STOPS_K / MSIM_WINNER_PUBLIC_VERIFY), with the D8 pinned
  parameters (fixed seeds, 3-identity background, N operator identities,
  `lookbackL = 50`, `K = 100`, pinned window count) and the D7 pinned exact
  winner counts.
- [x] Run the verification gate; confirm the epic-3 `verify-draw` (12), `sim`
  (5), `e2e` (5) suites — and the 4.1 `identity-gate` (5), 4.2
  `identity-signature` (5), 4.3 `accept-winner` (5), 4.4 `acceptance-cap` (5),
  4.5 `uptime` (5), 4.6 `re-attestation` (5), 4.7 `identity-key-surface` (5)
  suites — stay green (the ADDITIVE constraint) and the new suite is
  deterministic.

## Acceptance criteria

1. **R1 — the acceptance cap bounds a single identity to one share:** an
   identity submitting multiple tickets in a window is collapsed to one
   (keep-first, 4.4) — its draw weight is counted ONCE; over a pinned schedule,
   its win count with 3 tickets/window === its win count with 1 ticket/window
   (extra tickets earn **no extra** eligibility); the capped set's weight slots
   = the distinct-identity count, not the raw ticket count.
2. **R2 — N distinct gate-verified identities add a full share each, LINEARLY:**
   the operator's **total draw weight in the accepted set = N × L (EXACT)**
   (each of the N distinct identities contributes one full uptime share — the
   strongest, exact form); the operator's **win-COUNT/throughput** scales ~N×
   linearly — with the fixed 3-identity background the weight share goes 1/4→1/2
   so N=3 ≈ 2× the N=1 win count (integer band [2×, 3×], EXACT cross-
   multiplication, no float); the draw is the IMPORTED `drawWindow` (AD-7).
3. **Rental is linear-cost (per-identity floor, operator-blind):** the operator's
   aggregate is a linear function of distinct-identity count and IDENTICAL
   whether "one operator/N identities" or "N operators/1 each" — the accepted
   limitation holds (R2 / registration-design).
4. **R4 — a lapsed identity stops producing valid tickets within K windows:** an
   identity with `attestedUntilWindow = D` is excluded from the accepted set at
   `D+1` (its win count stops increasing after `D`); re-attesting at `W`
   re-includes it with a monotonic deadline `max(D, W + K)` (4.6); chain-time
   (AD-3).
5. **R2 / launch gate — every slot winner is verifiable from public data; an
   unselected node's block is rejected:** every mined block's winner passes
   `acceptBlockWinner` (public data + AD-12 signature); a non-drawn-winner claim
   AND an empty/foreign/forged-signature replay both → `acceptBlockWinner ===
   false` (the residual replay is closed end-to-end).
6. **ADDITIVE:** `sim.ts` / `draw.ts` / `verify-draw.ts` / `accept-winner.ts` /
   `acceptance-cap.ts` / `uptime.ts` / every `src/identity` module / the genesis
   seam / `ports.ts` / `protocol.proto` / `config/genesis.json` are UNCHANGED;
   the epic-3 `verify-draw` (12), `sim` (5), `e2e` (5) suites — and the 4.1
   `identity-gate` (5), 4.2 `identity-signature` (5), 4.3 `accept-winner` (5),
   4.4 `acceptance-cap` (5), 4.5 `uptime` (5), 4.6 `re-attestation` (5), 4.7
   `identity-key-surface` (5) suites — stay green; no `big.js` in the new module
   (AD-5).

## Never

- NEVER re-implement the draw (argmin `c^W`), the challenge
  (`deriveWindowChallenge`), the fee, or the signature digest — the draw is
  IMPORTED (`drawWindow`, AD-7); the cap/uptime/eligibility/signature/acceptance
  are the IMPORTED 4.4/4.5/4.6/4.2/4.3 seams.
- NEVER modify an existing `src/consensus` module (`sim.ts`, `draw.ts`,
  `verify-draw.ts`, `accept-winner.ts`, `acceptance-cap.ts`, `uptime.ts`,
  `miner.ts`, `apply-block.ts`, `slot-loop.ts`), any `src/identity` module, the
  genesis seam, `ports.ts`, `protocol.proto`, or `config/genesis.json` — 4.8 is
  ADDITIVE (new module + tests + additive barrel re-exports only); `sim.ts`'s
  epic-3 5-suite stays green.
- NEVER let the sim read the keypair `.secret` directly (AD-11 / 4.7's
  single-reader invariant) — it calls `signTicket(keypair, fields)`; the keypair
  is a core-internal sim value, NEVER projected onto a `ReadPeer`/`ReadBlock`/
  `CoreEvents[K]` public-surface type.
- NEVER claim "N identities of one operator win N× more than ONE identity's
  TOTAL" as if the total pool scaled — the honest, enforceable model is the
  **per-identity cap** (R1) + **linear, operator-blind distinct-identity
  aggregation** (R2 / rental limitation); do not overclaim an operator-level
  cap the protocol cannot enforce (registration-design R1).
- NEVER use `big.js` or a float (AD-5) in the module or test — the "~N×" /
  "linear" / "≤ one share" assertions are EXACT integer count / cross-multiplied
  weight comparisons; the no-float guard's big.js specifier set stays exactly
  `[ledger/display.ts, ledger/fee.ts]`.
- NEVER use `Math.random` or the wall clock (AD-3) — every challenge /
  commitment / signature is a pinned `sha256` / Ed25519 of public data; the
  winner counts are pinned EXACT integers (2-run stable); the "~N×" band is a
  pin-drift guard, not a flake absorber.
- NEVER make the re-attestation deadline non-monotonic — apply
  `max(oldDeadline, reattestationWindow(W, K))` (the 4.6 lesson: a pure `W + K`
  can shorten on an early re-attest).

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **198 prior + 5 new = 203 tests,
  29 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.8 adds no proto.
- **ADDITIVE constraint (the HARD one):** `corepack pnpm test
  consensus-verify-draw` → **12 passed**; `corepack pnpm test simulation` →
  **5 passed** (epic-3 `sim.ts` UNCHANGED); `corepack pnpm test
  epic-end-to-end` → **5 passed**; `corepack pnpm test identity-gate` →
  **5 passed**; `corepack pnpm test identity-signature` → **5 passed**;
  `corepack pnpm test consensus-accept-winner` → **5 passed**; `corepack pnpm
  test consensus-acceptance-cap` → **5 passed**; `corepack pnpm test
  consensus-uptime` → **5 passed**; `corepack pnpm test identity-re-attestation`
  → **5 passed**; `corepack pnpm test identity-key-surface` → **5 passed** (4.7's
  single-reader scan still yields exactly `['identity/identity.ts']`) — all
  UNCHANGED.
- **ADDITIVE source check:** `git diff --name-only -- packages/core/src/` shows
  ONLY the new `consensus/multi-sim.ts` + the two barrel files
  (`consensus/index.ts`, `index.ts`) — `sim.ts` and every pre-existing module
  are byte-identical.
- Determinism: run `corepack pnpm test multi-sim` **TWICE** — both pass with the
  identical pinned winner counts (2-run stable, AD-3/AD-10).
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]` — the new module does NOT import `big.js`).

## Plan Change Log
- 2026-10-08 (4.8 BAD-PLAN loopback, orchestrator) — the frozen matrix row
  MSIM_R2_N_PERSONS_NX (and AC #2, and the "honest R1/R2 model" R2 bullet)
  OVERCLAIMED: it said "N=3 ≈ **3×** the N=1 (each ≈ the N=1 share)" against a
  FIXED 3-identity background — mathematically impossible: the operator's
  weight *share* goes `L/4L → 3L/6L` (1/4 → 1/2), so the win count scales ~2×
  (pinned: N=1 = 1007, N=3 total = 2031, ratio 2.017). The implementer
  CORRECTLY refused to rig the test to 3× and instead proved the honest, exact
  claim — the operator's total draw weight = **N × L (EXACT)** (each distinct
  identity adds one full uptime share) + LINEAR (not superlinear) win growth in
  the integer band [2×, 3×]. The TEST was honest all along; the PLAN PROSE was
  the error (and it contradicted the plan's own Never clause: "NEVER claim N
  identities win N× more than ONE identity's TOTAL"). Fixed: the matrix row,
  AC #2, and the R2 model bullet now state the exact `N × L` total weight +
  linear win growth (band [2×, 3×]), no 3× overclaim. No code change from this
  fix — the test already implemented the honest model.
- 2026-10-08 (4.8 Quick-lens fix, orchestrator) — MSIM_RENTAL_LINEAR_PER_IDENTITY
  operator-blindness half was TAUTOLOGICAL: both "groupings" were the identical
  array expression `[...BG, ...OP3]`, so `schedA`/`schedB` were computed from
  byte-identical inputs (the linearity half was real; the "grouped two ways"
  comparison was vacuous). Fixed: the two groupings are now genuinely DIFFERENT
  ORDERINGS of the same 6 distinct identityIds (same per-identity weight `L`),
  with guards asserting they are not a self-comparison (not element-identical,
  same multiset). The per-identity commitment is keyed on `(identityId, slot,
  ticketIndex, parent)` — NOT position — and the draw's tie-break is by
  `identityId` — NOT position — so the permuted schedule MUST be identical;
  the test now evidences order/grouping-independence (it would fail if the
  commitment or tie-break ever depended on array position).

## Implementation Notes

- **Module** `packages/core/src/consensus/multi-sim.ts` (new) + additive
  re-exports in `consensus/index.ts` + `src/index.ts`. Exports:
  `MultiSimIdentity`, `signedTicket`, `buildCappedSet`, `eligibleSignedSet`,
  `simulateMultiWindow`, `simulateMultiNetwork`, `multiDrawSchedule` (+
  `MultiSimWindowResult`, `WindowAcceptedSet` types). Composes ONLY imported
  seams: `drawWindow`/`deriveWindowChallenge` (3.3), `applyAcceptanceCap`
  (4.4), `computeUptimeWeight` (4.5), `isEligibleAtWindow`/`reattestationWindow`
  (4.6), `signTicket` (4.2), `acceptBlockWinner` (4.3), `mineBlock`/
  `applyBlock`/`nextSlotAndParent` (3.2/3.6/3.2), `fromDisplay`/`fromJson`
  (AD-5 boundary via the ledger barrel). No `big.js`, no float, no RNG / wall
  clock.
- **Commitment domain** is `"SC-MULTISIM-COMMIT/1"`; the per-ticket
  `ticketIndex` (u64be) is part of the commitment so an identity's 3 same-window
  tickets are byte-different (the R1 cap case) — distinct per (identity, slot,
  parent, ticketIndex).
- **Pinned parameters** (D8): seeds = 32 bytes filled `0x40+i` (BG = i 0..2,
  operator = i 3..5); `L = 50`, `K = 100` (read from genesis `loadGenesis`);
  `RATE_WINDOWS = 4000`; full-path = 3 windows on a real `FileChainStore`;
  lapse run = 200 windows, `D = 100`, re-attest `W = 120` → deadline
  `max(D, W + K) = 220`.
- **Pinned deterministic winner counts** (EXACT integers, 2-run stable):
  - R1 (A + B + C, 4000 windows; 3-tickets/window === 1-tickets/window,
    identical per-window winner): A = 1330, B = 1313, C = 1357 (sum 4000).
  - R2 (3-BG + N operator identities, 4000 windows): N=1 operator total =
    1007; N=3 per-identity = [678, 677, 676], N=3 total = 2031 (ratio 2.0169,
    inside the integer band [2×, 3×]; each share ∈ [n1/2, n1]).
  - R4 (200-window lapsed run + 200-window re-attested run): X eligible-phase
    [0..100] wins = 32; X lapsed phase [101..199] wins = 0 (win count stops
    after D); X re-included stretch [120..199] wins = 27; B phases [37, 54];
    C phases [32, 45].
- **R1 3-ticket schedule** is a test-local composition of the imported seams
  (`signedTicket` ×3 per identity → `buildCappedSet` (4.4) → `drawWindow`
  (AD-7)) over the raw per-window set — it does NOT re-implement the draw /
  cap / signature; the module's `multiDrawSchedule` covers the normal
  (one-ticket-per-identity) path.
- **R2 "~N×" band**: the exact weight-proportional expectation is 2×
  (weight share 3L/6L = 1/2 at N=3 vs L/4L = 1/4 at N=1); the test asserts the
  integer band [2×, 3×] (separates LINEAR growth from flat 1× / superlinear ≥
  4×) — an EXACT integer cross-multiplication, no float (AD-5).
- **Per-test timeouts** raised to 60 s on the four schedule-heavy rows (R1/R2/
  RENTAL/LAPSED) — each runs 4000/280 windows of REAL Ed25519 `signTicket`
  calls (~0.03 ms/ticket), which exceeds vitest's default 5 s.
- **R4 re-inclusion model**: the re-attested run covers the SAME 200 windows;
  X's re-included stretch [120..199] (where the lapsed run won exactly 0) is the
  apples-to-apples lapsed-vs-re-included contrast.
- All verification-gate commands pass (orchestrator re-ran post-patch): full
  `corepack pnpm test` = 203 tests / 29 files; `typecheck` clean; `build` clean
  + PROTO_OK (no proto diff); ADDITIVE source diff = exactly
  `consensus/multi-sim.ts` + `consensus/index.ts` + `index.ts`; all ADDITIVE
  suites unchanged (verify-draw 12, sim 5, e2e 5, identity-gate 5,
  identity-signature 5, accept-winner 5, acceptance-cap 5, uptime 5,
  re-attestation 5, identity-key-surface 5, no-float-guard 6);
  `multi-sim` deterministic ×2 (identical pinned counts).

## Review Triage Log
| Lens | Finding | Verdict | Action |
|------|---------|---------|--------|
| quick | (none in the module) — reviewer verified import-only (no re-implementation), R1 real, R2 honest + consistent with the corrected plan, LAPSED real (exclusion at D+1 + monotonic `max(old, W+K)`), WINNER real (every block accepted + non-drawn-winner false + empty/foreign-sig replay false while `verifyDraw` passes), AD-11/4.7 clean (module never reads `.secret`; keypair never on a public-surface type), ADDITIVE clean (only the 2 barrel edits + new module), AD-3/AD-5 clean (no RNG/clock/float/big.js), index alignment + TS bridging clean | n/a | n/a — no code patch |
| quick | MSIM_RENTAL_LINEAR_PER_IDENTITY operator-blindness half TAUTOLOGICAL — both "groupings" were the identical array `[...BG, ...OP3]` (the linearity half was real; the "grouped two ways" comparison passed by construction) | low (test-strength), real | FIXED — the two groupings are now genuinely different ORDERINGS of the same identityIds (same per-identity weight), with guards that they are not a self-comparison; the permuted schedule MUST match (commitment keyed on identity/slot/ticketIndex/parent, draw tie-break by identityId — neither depends on array position). Re-ran full gate: 203/29, deterministic ×2 |
| (orchestrator, pre-review) | Frozen matrix row MSIM_R2 + AC #2 + R2 model bullet OVERCLAIMED "N=3 ≈ 3× the N=1" — impossible against a fixed 3-identity background (weight share 1/4→1/2 = ~2×); contradicted the plan's own Never clause; the test correctly implemented the honest ~2× / exact `N×L` model | low (plan-prose, the 3.3/4.6-F2 BAD-PLAN pattern), real | FIXED (prose only) — matrix row / AC #2 / R2 bullet now state the exact `N × L` total weight + LINEAR win growth (band [2×, 3×]); no code change (the test was already honest) |
  `multi-sim` 2-run stable (5/5 both runs).
