---
ticket: "8"
title: "Refactor sweep"
epic: epic-equal-node-mining
status: "built"
route: full
baseline_revision: "4af44a8253c2aa46e61b8f321c0f9bf1dc6d02ba"
review: "quick"
review_source: "pinned"
lenses_ran: ['quick']
review_loop_iteration: 0
covers: []
context:
  - packages/core/src/consensus/miner.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/index.ts
  - packages/core/src/events/types.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/pow.ts
  - packages/core/test/consensus-tracer.test.ts
  - packages/core/test/no-float-guard.test.ts
  - _bmad-output/initiative-succinctcoin-ai/deferred-work.md
---

# Story Plan — 3.8 Refactor sweep

## Story of truth

Run the **closing refactor sweep** (cleanup only) of epic 3 and confirm the
consensus suite is green headless. **No capability logic is added.** The sweep's
scope is set from the build records (3.1–3.7) and the deferred-review findings.

This is a **docs-hygiene sweep**. A read-only survey of `src/**` found:
**no dead exports, no stale `TODO`/`FIXME`/`@deprecated`, and all six build-record
decisions hold** (draw = one `drawWindow`; big.js only in `ledger/display.ts` +
`ledger/fee.ts`; fee → `BURN_ID`; `FEE_RATE` in `economics.ts`; sim standalone). The
only concrete cleanup is a set of **comments/JSDoc that drifted wrong after
3.4/3.5/3.6/3.7** (they still describe the pre-draw, pre-boot-path, reward-only
world), plus **marking one already-resolved `deferred-work.md` item as RESOLVED**.

## Design Notes (decisions)

- **D1 — Docs-only; no behavior change.** Every edit is a comment, JSDoc, or
  the `deferred-work.md` bookkeeping line. NO function body, export, signature,
  constant value, test expectation, golden vector, or generated proto is touched.
  The only "code" file edits are inside `/** … */` or `//` blocks.
- **D2 — DEFER the byte-helper DRY extraction (recorded, not done).** The survey
  found `u64be` / `bytesToBig` / `concat` are near-duplicated across `pow.ts` and
  `draw.ts`. Extracting them into a shared `bytes.ts` is behavior-preserving BUT
  touches **pinned, consensus-critical modules** (AD-6 / AD-7 / AD-12) that carry
  golden vectors + import-scan guards, and `u64be` is coupled to module-specific
  error codes (`PowError` SC-POW-1 vs `DrawError` SC-CONSENSUS-2). Per the 2.6
  precedent (do not invent churn), this is **deferred**, not done. It is noted in
  the Implementation Notes as a candidate for a later, dedicated sweep.
- **D3 — Do NOT merge `tracerTicket` (slot-loop.ts, private) with `syntheticTicket`
  (sim.ts, public).** They are intentionally distinct: different domain tags
  (`SC-TRACER-COMMIT/1` vs `SC-SIM-COMMIT/1`), different commitment inputs (the
  tracer omits the identity term; the sim includes it + a different field order),
  and different roles. Merging would obscure two pinned commitment formulas.
- **D4 — Keep the accurate "later epic / epic 4 / epic 5" forward-refs.** They are
  correct ownership notes (real future work); removing them would delete info.

## Frozen edit list (EXACTLY these — behavior-preserving doc fixes)

1. `src/consensus/miner.ts` — module JSDoc (~lines 18–19): "The trivial fixed
   winner … (replaced by the draw at 3.3 …) are the tracer's only protocol
   choices" → state the draw (wired at 3.4) now selects the winner and
   `TRACER_WINNER_ID` is the single-node default; the reserved mint id is the
   treasury. Keep it short.
2. `src/consensus/miner.ts` — `TRACER_WINNER_ID` JSDoc (~lines 37–40): drop
   "the slot loop always mines for", "EMPTY placeholder ticket", "No draw /
   ticket verification exists" → it is the single-node default winner; the slot
   loop mines for the **draw winner** and carries the winner's **real encoded
   proto Ticket** (3.4).
3. `src/consensus/miner.ts` — `BlockTemplate` JSDoc (~lines 44–49): "
   `winnerIdentityId` is the tracer's fixed winner; `winnerTicket` is the empty
   placeholder ticket (3.3 replaces it with the winning ticket)" → the winner is
   draw-selected and the ticket is the real winning ticket (3.4).
4. `src/consensus/index.ts` — module JSDoc (~line 11): "Additive surface —
   `createCore` untouched." → past tense (3.5 wired the boot path: `createCore
   ().start()` calls `mineAndApply`).
5. `src/consensus/index.ts` — comment near the draw re-export (~line 37): "the
   tracer's fixed winner (3.2) is untouched here." → the tracer's winner was
   rewired to the draw at 3.4.
6. `src/index.ts` — tracer re-export comment (~line 207): "`createCore` is
   untouched — 3.5 wires the tracer into the core lifecycle." → past tense (3.5
   wired it).
7. `src/index.ts` — verifyDraw re-export comment (~line 228): "Additive surface —
   `createCore` untouched." → past tense.
8. `src/index.ts` — draw re-export comment (~line 235): "Additive surface — 3.4
   wires the tracer's winner to it; `createCore` untouched." → past tense.
   **Leave the sim comment (~line 250) "NOT wired into `createCore` — additive
   surface only." UNCHANGED — it is correct (the sim really is standalone).**
9. `src/events/types.ts` — `CoreCommands` doc (~lines 62–63): "`startMining` is a
   capability command — a stub throwing `{ code: 'SC-CORE-1' }` until epic 3
   implements it" → accurate: epic 3 added the draw/mining seams, but the
   `startMining` command remains a stub pending its owning capability epic.
10. `src/consensus/slot-loop.ts` — `mineAndApply` JSDoc step-6 bullet (~lines
    143–144): "`applyBlock` (R5): credit the reward `MINT_ID → winner`, commit
    the block, save the snapshot." → add "(+ any tx fees — none in this
    0-tx path)" so it is not read as reward-only.
11. `_bmad-output/initiative-succinctcoin-ai/deferred-work.md` — the single OPEN
    item (the `createCore().start()` / `loadGenesis` boot-path gap from the 1.6
    plan) is **already resolved in code at 3.5**. Convert it to a `<!-- RESOLVED
    2026-10-07 (story 3.5) … -->` note (matching the two existing RESOLVED
    entries above it), pointing at 3.5. No code change.

## Never

- NEVER change any function body, export, signature, constant value, test
  expectation, golden vector, or generated proto — docs/comments + the
  `deferred-work.md` line ONLY.
- NEVER delete the accurate "epic 4 / epic 5" forward-refs or the sim's
  "NOT wired into `createCore`" comment.
- NEVER merge `tracerTicket` / `syntheticTicket` (D3) or extract the
  `u64be`/`bytesToBig`/`concat` helpers (D2 — deferred).
- NEVER break the AD-6/AD-7 guards: `test/consensus-tracer.test.ts`
  (MINING_PATH_GUARD import-scan) and `test/no-float-guard.test.ts` must stay
  green, and `pow.ts` / `draw.ts` stay byte-identical.

## Verification (acceptance gate)

- `corepack pnpm test` → **158 tests / 20 files, all passing** (unchanged — a
  docs-only sweep adds no tests).
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK).
- The pinned guards + invariants hold: `corepack pnpm test
  no-float-guard consensus-tracer consensus-draw consensus-verify-draw
  consensus-economics` all pass (6 + 12 + 11 + 12 + 7 = 48).
- `git diff --stat` shows changes ONLY to the listed doc/comment lines + the
  `deferred-work.md` note; `git diff` shows NO non-comment source changes (a
  `git diff -U0 -- packages/core/src | grep '^[+-]' | grep -vE '^[+-]\s*(//|
  \*|\*)|^[+-]{3}'` yields no changed code lines).

## Tasks

- [x] Apply the 11 frozen doc/comment edits (list above), each behavior-preserving.
- [x] Confirm via `git diff` that NO non-comment source line changed and NO
  generated proto changed.
- [x] Run the full verification gate (test / typecheck / build + proto / pinned
  guards).
- [x] Record in Implementation Notes the deferred DRY item (D2) and the
  excluded candidates (proto surface, port types, `tracerTicket`/`syntheticTicket`,
  the accurate forward-refs).

## Acceptance criteria

1. All 11 frozen doc/comment fixes are applied; the stale "pre-draw /
   pre-boot-path / reward-only / `createCore` untouched / until epic 3"
   phrasing is corrected to match the current code.
2. No non-comment source line changed; the generated proto is byte-identical;
   `pow.ts` and `draw.ts` are byte-identical (guards intact).
3. `pnpm test` (158/158) and `pnpm build` pass in plain Node; the AD-6/AD-7
   guards + the draw/PoW/applyBlock invariants are green.
4. No capability logic was added (the sweep is cleanup-only).
5. The one already-resolved `deferred-work.md` item is marked RESOLVED.

## Review Triage Log
- Quick lens (pass 1, 2026-10-07): **1 finding, 1 low** (docs-only sweep; all 6
  scrutiny points (a)–(f) otherwise PASS, and the orchestrator independently
  re-ran the full gate: `pnpm test` 158/158 (20 files), `typecheck` clean,
  `pnpm build` clean + PROTO_OK, and a `git diff -U0` comment-only filter that
  returned ZERO non-comment source lines — i.e. only comments + the
  `deferred-work.md` note changed, `pow.ts`/`draw.ts` byte-identical).
  - **F1 (low, PATCHED) — `deferred-work.md` near-duplicate RESOLVED note.** The
    plan's frozen item 11 assumed the boot-path gap was still an OPEN item and
    that only the 1.6 + 2.6 entries were already resolved. In fact 3.5 had
    ALREADY added a `RESOLVED 2026-10-06 (story 3.5)` entry for this same
    gap, so the sweep's new `RESOLVED 2026-10-07 (story 3.5)` entry was a
    near-duplicate (same fix, same pinning test; only the date + the 1.6
    provenance line differed). Routed as a patch (not bad_plan — the code
    behavior was already correct and the sweep is docs-only): **consolidated**
    the two 3.5 entries into a single `RESOLVED 2026-10-06 (story 3.5)` note
    that keeps the 1.6 source-plan provenance (the one thing the new entry
    contributed) plus the fuller 10-06 detail. `deferred-work.md` now has exactly
    3 RESOLVED entries (1.6 / 3.5 / 2.6), no OPEN items. No source change; the
    gate was re-run after the patch (still 158/158, PROTO_OK).

## Plan Change Log
_(none — the F1 consolidation is a review patch to the `deferred-work.md`
note, not a plan change; the 11-item Frozen edit list stands as implemented)_

## Implementation Notes

All 11 frozen edits applied 2026-10-07 — docs/comments only (the
`deferred-work.md` note + JSDoc/`//` fixes in `miner.ts`,
`consensus/index.ts`, `index.ts`, `events/types.ts`, `slot-loop.ts`). No
function body, export, signature, constant, test expectation, golden vector,
or generated proto touched; `pow.ts` / `draw.ts` byte-identical. (Item 11
detail corrected by review — see the Review Triage Log: the boot-path item was
ALREADY resolved at 3.5, so the sweep CONSOLIDATED the two 3.5 notes into one
rather than adding a second.)

- **D2 (deferred, recorded — NOT done):** `u64be` / `bytesToBig` / `concat`
  are near-duplicated across `pow.ts` and `draw.ts`. Extracting a shared
  `bytes.ts` is behavior-preserving but touches the pinned,
  consensus-critical modules (AD-6 / AD-7 / AD-12: golden vectors +
  import-scan guards), and `u64be` is coupled to module-specific error
  codes (`PowError` SC-POW-1 vs `DrawError` SC-CONSENSUS-2). Deferred per
  the 2.6 precedent (no invented churn) — a candidate for a later,
  dedicated sweep.
- **Excluded candidates (surveyed, intentionally left unchanged):**
  - the generated proto surface (`src/proto/`) — generated code; the `Block`
    dual type+value re-export is documented and accurate;
  - the port types (`src/ports.ts`) — no stale doc found;
  - `tracerTicket` (slot-loop.ts, private) vs `syntheticTicket` (sim.ts,
    public) — intentionally distinct (D3): different domain tags
    (`SC-TRACER-COMMIT/1` vs `SC-SIM-COMMIT/1`), different commitment
    inputs (the tracer omits the identity term; the sim includes it + a
    different field order), and different roles — merging would obscure
    two pinned commitment formulas;
  - the accurate "epic 4 / epic 5" forward-refs — correct ownership notes
    (real future work), kept (D4).
