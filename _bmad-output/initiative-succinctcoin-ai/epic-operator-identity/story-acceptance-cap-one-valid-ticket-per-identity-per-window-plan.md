---
ticket: "4"
title: "Acceptance cap (one valid ticket per identity per window)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "abb51d500f374be1a7ce1683638db494a390da84"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [R1]
context:
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/sim.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/economics.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/index.ts
  - packages/core/src/proto/protocol.proto
  - packages/core/test/consensus-accept-winner.test.ts
  - packages/core/test/simulation.test.ts
  - packages/core/test/epic-end-to-end.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.4 Acceptance cap (one valid ticket per identity per window)

## Story of truth

Enforce the **acceptance cap** — at most **one valid ticket per identity per
chain-window** — as a **pre-draw filter on the per-window accepted set**: when
the raw accepted set for a window contains more than one ticket for the same
`identityId`, the extra tickets are **dropped**, so an identity earns **no extra
eligibility** (no extra draw weight) from submitting multiple tickets, and the
mining reward **never scales with identity count** (the enforceable form of the
registration design's R1). The cap is **applied at ticket acceptance, BEFORE the
draw** — it is a filter on the accepted set, NOT a change to the draw. `drawWindow`
(epic 3, 3.3) is **UNCHANGED** — the cap is applied upstream of the draw, so the
draw always consumes a capped (one-ticket-per-identity) set.

This is a **NEW-MODULE story**: one new `src/consensus/acceptance-cap.ts` +
additive barrel re-exports + one new test file. It does **NOT** change `draw.ts`
(the draw is imported, never re-implemented — AD-7), `accept-winner.ts` (4.3's
acceptance seam), `sim.ts` (3.7), `apply-block.ts` / `economics.ts` (3.6), the
proto, or `ports.ts`. It is the enforceable **rule** (a pure filter) that **4.8**
(multi-identity sim) wires into the sim's accepted-set construction and **4.10**
(closing suite) drives end-to-end.

## The epic requirement this delivers (R1, the enforceable form)

- **The cap** — the per-window accepted set accepts **at most one valid ticket per
  identity per chain-window**; in a multi-ticket set, a **second ticket from the
  same identity in the same window is dropped** so it earns no extra eligibility.
- **No scaling** — an identity's draw weight is counted **once** (one surviving
  ticket), so its draw odds do NOT scale with how many tickets it submits; combined
  with 3.6's **fixed** reward (the winner earns `rewardBaseUnits`, a constant), the
  reward never scales with identity count.
- **Pre-draw** — the cap is applied to the accepted set **before** the draw;
  `drawWindow` (epic 3) is **imported, never re-implemented** (AD-7) and **UNCHANGED**.

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — A standalone pre-draw filter, not a `drawWindow` change.** The cap is a
  **PURE** function in NEW `src/consensus/acceptance-cap.ts`:
  `applyAcceptanceCap(set: { tickets: ReadonlyArray<ProtoTicket>,
  weights: ReadonlyArray<bigint> }): { tickets: ProtoTicket[], weights: bigint[] }`.
  It takes the raw per-window accepted set (proto `Ticket`s + their aligned draw
  weights) and returns a **NEW** set with **at most one ticket per
  `ticket.identityId`** — the **first** occurrence (lowest input index) is kept, the
  second/subsequent are dropped, and each kept ticket's aligned weight is kept with
  it. The result's `tickets[i]` / `weights[i]` stay **aligned** (the same-order
  contract `drawWindow` requires). It does **NOT** change `drawWindow` (epic 3 owns
  the draw — the cap is applied UPSTREAM of the draw, so the draw always consumes a
  capped set). It does **NOT** validate signatures (4.3's `acceptBlockWinner` owns
  the draw + signature gate) — "one **valid** ticket per identity per window" is
  enforced by the cap (one ticket per identity survives) **composed with** the
  acceptance path (the survivor must verify the draw + signature).
- **D2 — Keep-first, input-order (deterministic, AD-3).** When an `identityId`
  appears multiple times in the accepted set, the **first** ticket (lowest input
  index) is kept and the rest are dropped. Input order is the accepted-set order
  (deterministic, no RNG / clock). This makes the cap fully reproducible (AD-3) and
  matches the ticket's "a **second** ticket from the same identity in the same
  window is dropped." A real attack (same identity, **different** commitments,
  hoping for multiple draw weights) is exactly the case the cap collapses to one.
- **D3 — ADDITIVE (the epic-3 suites are untouched).** The cap is a **NEW** function;
  it is **NOT** wired into `windowAcceptedSet` (3.7 sim), `acceptBlockWinner` (4.3),
  or `drawWindow` (3.3). Epic-3's accepted sets have **DISTINCT** identities (one per
  node) → the cap is a **no-op** on them → the epic-3 `verify-draw` (12), `sim` (5),
  and `e2e` (5) suites **stay green by construction**. Wiring the cap into the
  multi-identity sim's accepted-set construction is **4.8** (the story that models
  an operator holding multiple identities); 4.10 drives it end-to-end.
- **D4 — One eligibility each (the weight is counted once).** After the cap, each
  identity contributes **exactly one** draw weight (one surviving ticket). A dropped
  duplicate does **NOT** contribute draw weight, so an identity's draw odds do not
  scale with its ticket count in the window. Combined with 3.6's **fixed** reward
  (`applyBlock` credits `rewardBaseUnits`, a constant, to ONE winner — independent of
  identity count), the reward never scales with identity count (R1).
- **D5 — No big.js; no proto change; the draw is imported (AD-7).** `src/consensus`
  still imports no `big.js` (the no-float guard stays green). The cap is a de-dup
  over `identityId` **strings** (no math, no float, no float literal). The proto is
  unchanged (no field added). Where the test composes the cap with the draw,
  `drawWindow` is **imported** (never re-implemented — AD-7).

## Frozen I/O matrix (each row a passing test)

Shared deterministic fixture (AD-3: no RNG, no wall clock): one window
(`SLOT = 7n`), a fixed non-zero 32-byte `PARENT_HASH`, the window challenge
`deriveWindowChallenge(PARENT_HASH, SLOT)`, and three identities with **fixed
seeds** (A = `0x00..0x1f`, B = `0x42`-filled, C = `0x99`-filled). Identity **A
submits THREE tickets** in the window (distinct commitments, to model the real
attack — same identity, different commitments); B and C submit ONE each. Draw
weights: each of A's three tickets `5n`, B `3n`, C `1n` (aligned with the tickets).

| Row | Input | Expected |
|-----|-------|----------|
| CAP_DEDUPES_SECOND_TICKET | an accepted set where identity A has 3 tickets (same window) + B (1) + C (1) = 5 input tickets | `applyAcceptanceCap` → exactly **ONE** ticket for A (the 2nd + 3rd dropped); the result has A once + B once + C once = **3** tickets (from 5 input) |
| CAP_FIRST_OCCURRENCE_WINS | identity A at input indices 0, 2, 4 (distinct commitments), B at 1, C at 3 | the **FIRST** (index-0) A ticket is kept (its exact commitment); the index-2 and index-4 A tickets are dropped; kept order = input order `[A(0), B, C]` (deterministic) |
| CAP_DISTINCT_IDENTITIES_UNCHANGED | an all-**distinct** accepted set (B, C, A — one each; the epic-3 sim shape) | `applyAcceptanceCap` is a **NO-OP**: same length, same order, byte-identical tickets (ADDITIVE — epic-3's distinct-identity accepted sets are unaffected, so the epic-3 `verify-draw`/`sim`/`e2e` suites stay green) |
| CAP_PRE_DRAW_FILTER | the **capped** set (A once + B + C) fed to the IMPORTED `drawWindow` (AD-7, never re-implemented) over the capped weights | the draw over the capped set selects a winner among the capped identities; a **dropped A-duplicate's commitment does NOT affect the draw** — the capped draw == the draw over the de-duplicated identities only (the cap is a pre-draw filter; `drawWindow` imported, unchanged) |
| CAP_ONE_ELIGIBILITY_EACH | identity A with 3 tickets (3 aligned `5n` weight slots) + B (1× `3n`) + C (1× `1n`) | after the cap, A contributes **exactly ONE** draw weight (one surviving ticket — counted once, not 3×); the total number of draw-weight slots = the number of **distinct** identities (3), not the number of input tickets (5) — combined with 3.6's fixed reward, the reward never scales with identity count (R1) |

## Tasks

- [x] Add `src/consensus/acceptance-cap.ts` — `applyAcceptanceCap(set:
  { tickets: ReadonlyArray<ProtoTicket>, weights: ReadonlyArray<bigint> }):
  { tickets: ProtoTicket[], weights: bigint[] }` — the PURE pre-draw cap filter:
  keep the FIRST ticket per `identityId` (input order), drop second/subsequent, keep
  each kept ticket's aligned weight; return a NEW aligned set. Additive re-exports in
  `src/consensus/index.ts` + `src/index.ts`. Do NOT change `draw.ts`,
  `accept-winner.ts`, `sim.ts`, `apply-block.ts`, `economics.ts`, `protocol.proto`,
  or `ports.ts`.
- [x] Add `test/consensus-acceptance-cap.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the draw or the cap): the 5 matrix
  rows (CAP_DEDUPES_SECOND_TICKET / CAP_FIRST_OCCURRENCE_WINS /
  CAP_DISTINCT_IDENTITIES_UNCHANGED / CAP_PRE_DRAW_FILTER /
  CAP_ONE_ELIGIBILITY_EACH), with a deterministic fixture (fixed seeds, a fixed
  non-zero 32-byte parent, identity A with 3 distinct-commitment tickets, B/C with
  one each, aligned weights).
- [x] Run the verification gate; confirm the epic-3 `verify-draw` (12), `sim` (5),
  and `e2e` (5) suites stay green (the ADDITIVE constraint) and the new suite is
  deterministic.

## Acceptance criteria

1. The per-window accepted set accepts **at most one valid ticket per identity per
   chain-window**: a set with a second ticket from the same `identityId` in the same
   window has the extra ticket **dropped** by the cap.
2. The cap is **deterministic** (AD-3): the **first** occurrence (input order) is
   kept; no RNG / wall clock.
3. The cap is a **pre-draw filter**: it is applied to the accepted set **before** the
   draw; a dropped duplicate does **NOT** affect the draw (the capped draw == the
   draw over the de-duplicated identities); `drawWindow` is **imported, never
   re-implemented** (AD-7) and **UNCHANGED**.
4. An identity's draw weight is counted **once** (one surviving ticket) — its draw
   odds do not scale with its ticket count; the total draw-weight slots = the number
   of **distinct** identities.
5. The cap is **ADDITIVE**: the epic-3 `verify-draw` (12), `sim` (5), and `e2e` (5)
   suites (distinct-identity accepted sets) stay green; `draw.ts` /
   `accept-winner.ts` / `sim.ts` / `apply-block.ts` / `economics.ts` /
   `protocol.proto` / `ports.ts` are **UNCHANGED**; no `big.js` in `src/consensus`.

## Never

- NEVER change `drawWindow`'s behavior or signature (epic 3 owns the draw; the cap is
  a pre-draw filter applied to the accepted set, not a modification of the draw).
- NEVER re-implement the draw — `drawWindow` is imported from `./draw.js` (AD-7); the
  cap de-duplicates the accepted set, it does not compute the draw.
- NEVER change `accept-winner.ts` (4.3's acceptance seam), `sim.ts` (3.7),
  `apply-block.ts` / `economics.ts` (3.6), `protocol.proto`, or `ports.ts` — the cap
  is a NEW standalone filter that composes with them (wiring it into the sim is 4.8).
- NEVER let a dropped duplicate ticket contribute draw weight — each identity's
  weight is counted exactly once (one surviving ticket per identity per window).
- NEVER make the cap depend on RNG or the wall clock (AD-3) — keep-first, input
  order, fully reproducible.
- NEVER import `big.js` in `src/consensus` (AD-5 / the 2.5 no-float guard) — the cap
  is a de-dup over `identityId` strings.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **178 prior + 5 new = 183 tests,
  25 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.4 adds no proto.
- **ADDITIVE constraint (the HARD one):** `corepack pnpm test
  consensus-verify-draw` → **12 passed**; `corepack pnpm test simulation` →
  **5 passed**; `corepack pnpm test epic-end-to-end` → **5 passed** — all
  UNCHANGED (distinct-identity accepted sets are a no-op for the cap; the cap is a
  NEW standalone filter, not a change to any epic-3 seam).
- Determinism: run `corepack pnpm test consensus-acceptance-cap` TWICE — both pass
  with the identical cap outcomes.
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]`).

## Plan Change Log
_(none — no AC / matrix / Never / Design Notes change during the build; the
ticket's `unknown` was settled by the frozen D1–D5 design notes before
implementation.)

## Review Triage Log
| Lens | Finding (short) | Verdict | Action |
|------|-----------------|---------|--------|
| quick | (none) | n/a | The quick lens returned 0 findings; it independently verified every scrutiny question (a)–(j) with evidence: strictly additive (only the two barrels + new module + new test touched; `draw.ts`/`accept-winner.ts`/`sim.ts`/`apply-block.ts`/`economics.ts`/`protocol.proto`/`ports.ts` byte-identical); pre-draw filter (the cap is a `Set<string>` de-dup — no sha256/c^W/cNum/argmin; `drawWindow` imported, never re-implemented, AD-7); keep-first input-order deterministic (no RNG/clock); one eligibility each (a dropped duplicate's weight is dropped with its ticket; total weight slots = distinct identities); the distinct-set NO-OP is byte-identical (so epic-3's 12/5/5 stay green — re-run live); no big.js (no-float 6/6); TS 5.9 bridging correct (typecheck clean); the cap does NOT overclaim to verify validity (the doc scopes "one VALID ticket" = the cap composed with the 4.3 acceptance path); the function never mutates its input; determinism 5/5 twice. One non-finding note: the cap does not itself validate `tickets.length === weights.length` (it relies on the D1 aligned-pair contract; a misalignment propagates to `drawWindow`, which throws `DrawError SC-CONSENSUS-2`) — a deliberate design boundary consistent with the codebase's precondition style, not an unmet criterion. No action required. |

## Implementation Notes

### What was built (4.4 — the enforceable form of R1)

- **NEW module** `packages/core/src/consensus/acceptance-cap.ts`:
  `applyAcceptanceCap(set: AcceptedSet): CappedSet` — the PURE pre-draw filter.
  It walks the raw per-window accepted set in INPUT order, keeps the FIRST
  ticket per `identityId` (a `Set<string>` of seen ids), drops 2nd/subsequent
  ones, and carries each kept ticket's ALIGNED weight with it (D1/D2/D4).
  Returns a NEW aligned `{ tickets, weights }` pair; never mutates the input.
  Two exported types: `AcceptedSet` (`tickets: ReadonlyArray<ProtoTicket>`,
  `weights: ReadonlyArray<bigint>`) and `CappedSet` (`tickets: ProtoTicket[]`,
  `weights: bigint[]`). No `big.js`, no float, no RNG / wall clock (AD-3/AD-5).
- **Additive re-exports** (no other file touched):
  - `packages/core/src/consensus/index.ts` — `applyAcceptanceCap` +
    `type { AcceptedSet, CappedSet }`.
  - `packages/core/src/index.ts` — same, re-exported through the consensus
    barrel so the test imports only from the ROOT barrel.
- **NEW test** `packages/core/test/consensus-acceptance-cap.test.ts` — the 5
  matrix rows (CAP_DEDUPES_SECOND_TICKET / CAP_FIRST_OCCURRENCE_WINS /
  CAP_DISTINCT_IDENTITIES_UNCHANGED / CAP_PRE_DRAW_FILTER /
  CAP_ONE_ELIGIBILITY_EACH), importing ONLY from `../src/index.js`. The fixture
  reuses the 4.3 `accept-winner` pattern: fixed `SLOT = 7n`, a fixed non-zero
  32-byte `PARENT_HASH`, three fixed-seed identities (A = `0x00..0x1f`, B =
  `0x42`, C = `0x99`), and identity A's THREE distinct-commitment tickets (the
  real-attack shape — same identity, different commitments) built as pinned
  `sha256` of public data (`SC-ACCEPT-CAP-COMMIT/1` base +
  `SC-ACCEPT-CAP-ALT/1` per-index salt). All tickets are 4.2-signed
  (`signTicket`) so the set is realistic. CAP_PRE_DRAW_FILTER composes the cap
  with the IMPORTED `drawWindow` (AD-7, never re-implemented) + the IMPORTED
  `protoTicketToDrawTicket`, and asserts the capped draw == the draw over the
  de-duplicated identities only (winner id, `cNum`, `uptime`, `index`).

### Design decisions settled (the ticket's `unknown`)

- The cap is a **standalone PURE function** (`applyAcceptanceCap`), NOT a
  change to `drawWindow` / `acceptBlockWinner` / the sim. It de-duplicates the
  accepted set; the draw + signature gate (4.3) own "valid". "One VALID ticket
  per identity per window" = this cap (one ticket per identity survives)
  **composed with** the 4.3 acceptance path (the survivor must verify the draw
  + signature).
- **Keep-first, input-order** (D2): lowest input index wins; the rest are
  dropped. This makes it fully reproducible (AD-3) and matches the ticket's
  "a second ticket from the same identity in the same window is dropped."

### ADDITIVE constraint — how it was kept green

`draw.ts`, `accept-winner.ts`, `sim.ts`, `apply-block.ts`, `economics.ts`,
`protocol.proto`, and `ports.ts` are all UNCHANGED. The cap is a NEW standalone
filter; epic-3's accepted sets have DISTINCT identities (one per node), so
`applyAcceptanceCap` is a NO-OP on them (proven by CAP_DISTINCT_IDENTITIES_
UNCHANGED). Wiring the cap into the multi-identity sim's accepted-set
construction is 4.8; 4.10 drives it end-to-end.

### Verification (acceptance gate) — all green

- `corepack pnpm test` → **25 files / 183 passed** (178 prior + 5 new).
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean; `git status --porcelain -- packages/core/src/proto/`
  empty (PROTO_OK — 4.4 adds no proto field).
- ADDITIVE: `consensus-verify-draw` → **12 passed**; `simulation` → **5
  passed**; `epic-end-to-end` → **5 passed** (all UNCHANGED).
- Determinism: `consensus-acceptance-cap` run TWICE → **5 passed** both runs,
  identical outcomes (fixed seeds / weights / parent; pinned sha256
  commitments; no RNG / wall clock).
- AD-5 guard: `no-float-guard` → **6 passed** (`big.js` import-specifier set
  over `src/` still exactly `[ledger/display.ts, ledger/fee.ts]`).

### Risk / left incomplete

- None blocking. The cap is NOT yet wired into any live accepted-set
  construction path (by design — that is 4.8's job); 4.4 ships the rule as a
  standalone, tested, deterministic filter that 4.8/4.10 will compose.
