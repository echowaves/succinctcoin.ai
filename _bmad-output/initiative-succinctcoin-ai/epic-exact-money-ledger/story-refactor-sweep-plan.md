---
title: 'Refactor sweep'
type: 'feature'
ticket: 6
created: '2026-10-05'
baseline_revision: '36b73caa8272bdad043bf2a60aa0eb272cbb452d'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/packages/core/src/ledger/ledger.ts'
  - '{project-root}/packages/core/test/ledger.test.ts'
  - '{project-root}/packages/core/test/store-state.test.ts'
  - '{project-root}/packages/core/src/store/file-chain-store.ts'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The epic's one deferred finding is still open: `toJson` (ledger.ts) silently drops a balance whose identity id is a reserved own-property key such as `__proto__` — `out['__proto__'] = '…'` invokes the `Object.prototype.__proto__` setter, which ignores the non-object value, so the entry is lost. `fromJson` and the store's `assertStateDocument` DO accept such an entry, so `toJson → saveState → loadState → fromJson` round-trips a `__proto__` balance with it silently gone. This is the epic's mandated closing story: run the refactor sweep (scope from the build records and deferred findings) and confirm the ledger suite is green headless — the epic's Done-when.

**Approach:** Close the one in-epic deferred finding — make `toJson` build its projection via a prototype-less object so a reserved-key id becomes a normal own property instead of hitting the prototype setter — add regression tests at the seam and through the store round-trip, sweep the tree for genuine leftovers (none expected; per-story reviews already kept it clean), and prove all four epic Done-when checks with the existing suite, recording the check→evidence mapping in the plan.

## Boundaries & Constraints

**Always:**
- Cleanup only: no new capability, no public-surface change, no behavior change except closing this one latent defect (the fix changes only what `toJson` returns for a reserved-key id — a case that cannot occur with the protocol's 32-byte-hex id space).
- Every epic Done-when check maps to a concrete green existing test/command, and each command actually runs green in this story.
- The suite stays plain-Node headless (temp dirs, no real sockets — it already is).
- The `toJson` fix keeps the public signature (`(balances: BalanceMap) => Record<string, string>`) and the AD-5 JSON contract (decimal-string values, `JSON.stringify`-safe, drift-free).

**Never:**
- No refactors without evidence (dead code / unused exports / dupes must be found, not invented).
- No changes to `protocol.proto`, the generated types, `ports.ts`, or any unrelated test's expectations.
- No new dependencies; no push. Do NOT wire `createCore().start()` → `loadGenesis` (that is epic 3's consensus boot path — a separate deferred item).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TO_JSON_PROTO_ROW | a `BalanceMap` with id `__proto__` (balance ≥ 0) | `toJson` preserves the entry: the doc has an own `__proto__` key with the decimal string; `JSON.stringify` includes it; `fromJson(toJson(m))` round-trips it | pre-fix the entry is silently dropped — that is the defect; the test failing pre-fix is the point |
| TO_JSON_NORMAL_ROW | an ordinary balance map (no reserved ids) | `toJson` output is byte-identical to before the fix (decimal strings); `fromJson(toJson(m)) === m` | regression guard — the fix must not change the normal path |
| STORE_PROTO_ROUNDTRIP | `toJson(map)` incl. `__proto__` through real `saveState` → close → `open` → `loadState` | the loaded doc retains `__proto__` → its decimal string; `fromJson` returns the full map | pre-fix the balance is lost on the disk round-trip |
| SUITE_HEADLESS | `corepack pnpm test` from a clean tree | all tests pass in plain Node, headless | a failure fails the epic |
| BUILD_GREEN | `corepack pnpm build` | protons regenerates byte-identically; tsc emits dist/ | — |
| DONE_WHEN_FOUR | the four epic Done-when checks | each maps to a green existing test (mapping in Design Notes) | an unmapped check fails this story |

</frozen-after-approval>

## Code Map

- `packages/core/src/ledger/ledger.ts` -- THE FIX (the only `src/` edit). `toJson` (≈ line 140): `const out: Record<string,string> = {}` → `Object.create(null)`; update its doc comment to note reserved-key ids survive the projection. `fromJson` is UNCHANGED (it already reads `__proto__` via `Object.entries`).
- `packages/core/test/ledger.test.ts` -- seam-level regression. The `DECIMAL_JSON` describe block (≈ line 225) is the home for a new `it` asserting `toJson` preserves a `__proto__` id and `fromJson(toJson(m))` round-trips it.
- `packages/core/test/store-state.test.ts` -- store-level regression. Add a deterministic `it` (real `saveState`→close→open→`loadState` cycle) proving a `__proto__` balance survives the disk round-trip. The `SNAPSHOT_ROUNDTRIP` property's `idArb` `filter(id !== '__proto__')` STAYS (the filter is still the correct test correction; the new deterministic test covers the reserved-key path directly).
- `packages/core/src/store/file-chain-store.ts` -- the read-path half of the same defect. `assertStateDocument` (≈ line 352) had the identical `Object.prototype.__proto__` setter trap: it built a plain `const out = {}` and did `out[key] = value`, so it **dropped** a `__proto__` entry on `loadState` (the plan's original "read, don't change / already accepts" note was wrong — probe-verified at build). Fixed with the same one-line `Object.create(null)` projection. `canonicalJson` (≈ line 332) needed no change: it is `Object.keys`-driven (`JSON.stringify(k)`/`JSON.stringify(doc[k])` per sorted key), not a `JSON.stringify` of the live object, so it serializes a null-prototype own `__proto__` property as a normal key. See Plan Change Log.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ledger/ledger.ts` -- make `toJson` build `out` via `Object.create(null)` so a reserved own-property id (`__proto__`) becomes a normal own property instead of hitting the `Object.prototype.__proto__` setter; note it in the doc comment -- RATIONALE: closes the epic's one deferred finding (the `toJson` write-drops / read-accepts asymmetry) with the smallest behavior-preserving change.
- [x] `packages/core/test/ledger.test.ts` -- add the seam regression in `DECIMAL_JSON`: a `BalanceMap` with id `__proto__` survives `toJson` (own key present, decimal value) and `fromJson(toJson(m))` round-trips it -- RATIONALE: pins TO_JSON_PROTO_ROW at the seam.
- [x] `packages/core/test/store-state.test.ts` -- add a deterministic store round-trip `it` with a `__proto__` balance (real `saveState`→close→open→`loadState`) and assert the loaded doc + `fromJson` retain it -- RATIONALE: pins STORE_PROTO_ROUNDTRIP end-to-end (the path the 2.4 flake originally exposed).
- [x] Run the closing verification + sweep (`corepack pnpm test` / `typecheck` / `build`; scan `src/` for leftovers) -- RATIONALE: prove SUITE_HEADLESS / BUILD_GREEN and DONE_WHEN_FOUR; record the Done-when→evidence mapping in Implementation Notes.

**Acceptance Criteria:**
- Given a `BalanceMap` whose id is `__proto__`, when `toJson` is called, then the returned doc has an own `__proto__` key with the decimal-string balance, and `fromJson(toJson(m))` round-trips the map exactly.
- Given the same map through a real `saveState` → close → `open` → `loadState` cycle, when `loadState` returns, then the doc retains `__proto__` → its decimal string and `fromJson` returns the full map (no balance lost).
- Given an ordinary balance map (no reserved ids), when `toJson` runs, then its output is byte-identical to the pre-fix behavior.
- Given a clean tree, when `corepack pnpm test`, `typecheck`, and `build` run in plain Node, then all pass and the four epic Done-when checks each map to a green test (recorded in Implementation Notes).

## Implementation Notes

### What changed

1. **`packages/core/src/ledger/ledger.ts` — `toJson` (the mandated one-line fix).**
   `const out: Record<string, string> = {}` → `Object.create(null)`. A reserved
   own-property id (`__proto__`) now becomes an ordinary own data property
   instead of hitting the `Object.prototype.__proto__` setter (which silently
   drops a non-object value). Doc comment updated to note it. Public signature
   and the AD-5 contract are unchanged; `fromJson` is unchanged (it already
   reads via `Object.entries`).

2. **`packages/core/src/store/file-chain-store.ts` — `assertStateDocument`
   (one-line fix, SAME pattern as the mandated `toJson` fix — see Deviation
   below).** `const out: Record<string, string> = {}` → `Object.create(null)`,
   with a doc comment noting the read side mirrors the write side. Without
   this, the store's `loadState` drops a `__proto__` entry on the read path
   (the `out[key] = value` assignment hits the same prototype setter), so the
   frozen STORE_PROTO_ROUNDTRIP acceptance criterion could not be met.

3. **`packages/core/test/ledger.test.ts` — new seam regression** in the
   `DECIMAL_JSON` block: a `BalanceMap` with id `__proto__` survives `toJson`
   (own key present, decimal value, `JSON.stringify` includes it) and
   `fromJson(toJson(m))` round-trips it exactly. Pins TO_JSON_PROTO_ROW.

4. **`packages/core/test/store-state.test.ts` — new deterministic store
   round-trip** (`STORE_PROTO_ROUNDTRIP` describe): a `__proto__` balance
   through a real `saveState` → `close` → `open` → `loadState` cycle; asserts
   the on-disk canonical doc retains `__proto__` → its decimal string (byte-
   exact) and `fromJson` returns the full map. Pins STORE_PROTO_ROUNDTRIP.
   The `SNAPSHOT_ROUNDTRIP` property's `idArb` `filter(id !== '__proto__')` is
   left UNCHANGED, as the plan directs.

### Deviation from the plan's Code Map (flagged for the orchestrator)

The plan's non-frozen Code Map marks `file-chain-store.ts` as "PATTERN ONLY
(read, don't change)" and the Design Notes claim "`assertStateDocument` already
accepts a `__proto__` entry ... the fix needs no store change." **That premise
is factually wrong.** `assertStateDocument` builds a plain `const out = {}` and
does `out[key] = value` — the exact same prototype-setter trap — so it **drops**
a `__proto__` entry on the read path. This was confirmed empirically (a throw-
away probe replicating `canonicalJson`/`assertStateDocument`/`fromJson`
verbatim, run with plain Node and then deleted): with only the `toJson` fix,
the full `toJson → saveState → loadState → fromJson` chain still lost the
`__proto__` balance, and the new `STORE_PROTO_ROUNDTRIP` test failed.

The frozen (highest-priority) acceptance criteria + I/O matrix require
STORE_PROTO_ROUNDTRIP to prove the balance *survives* the full
`saveState → loadState` cycle — that is unachievable without the read path
preserving `__proto__`. I resolved the conflict in favor of the frozen goal:
the read-side half of the *same* defect had to be closed. The store edit is the
minimal, same-pattern one line (null-prototype projection) and does not change
behavior for any protocol-valid (32-byte-hex) id — `__proto__` is unreachable in
that id space — so it is consistent with the "cleanup only" boundary. **The
orchestrator should confirm this is acceptable or route the store read-path
hardening to a separate ticket; as implemented, the epic's STORE_PROTO_ROUNDTRIP
Done-when cannot be proven otherwise.**

### Refactor sweep (leftovers)

Swept `packages/core/src/` (ledger, store, config, events, proto, ports, index).
**No dead code, unused exports, or duplicates found** — per-story reviews and
the two standing guards (`no-ui-imports`, `no-float-guard`) already keep it
clean. `big.js` is imported by exactly `ledger/fee.ts` + `ledger/display.ts`
(the two documented boundaries). No `TODO`/`FIXME`/`deprecated` markers. No
further changes made.

### Done-when → evidence mapping (all four green)

1. Conservation of supply, no-negative-balance, and fee invariants over long
   random sequences → `conservation.test.ts` (CONSERVATION_SUPPLY / FEE_EXACT /
   NO_NEGATIVE / PERSISTED_ROUNDTRIP).
2. Random BigInts up to 10³⁰ round-trip through the store losslessly; a
   float/int64 column is rejected → `store-state.test.ts` (SNAPSHOT_ROUNDTRIP
   property + FLOAT_INT64_REJECT `SC-STORE-3` shape guards; now also
   STORE_PROTO_ROUNDTRIP for the reserved-key path).
3. `JSON.stringify` of a balance never throws or drifts; `big.js` referenced
   only in the fee and display modules → `no-float-guard.test.ts`
   (JSON_STRINGIFY_BALANCE + BIG_JS_ONLY_BOUNDARY) + `ledger.test.ts`
   DECIMAL_JSON.
4. A direct balance mutation outside `apply` is impossible (no public mutator)
   → `ledger.test.ts` NO_MUTATOR (enumerates the public surface; only the
   `apply` seam mutates).

### Verification (all run green in this story)

- `corepack pnpm test` → **96 passed** (94 existing + 2 new regression cases),
  headless, temp dirs, no real sockets.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean; protons regen byte-identical (no `src/proto/`
  diff); tsc emitted `dist/`.
- Plan's manual check (revert `toJson` to `const out = {}`, confirm the new
  tests fail, restore, confirm green): **done.** With `toJson` reverted, both
  the seam test and the store round-trip test failed (the `__proto__` entry
  dropped on write); restored, the full suite is green — proving the tests pin
  the defect.

## Plan Change Log

- **Forced deviation (build, 2026-10-05) — root cause: this plan's non-frozen Code Map + Design Notes were factually wrong.** The Code Map marked `file-chain-store.ts` "PATTERN ONLY (read, don't change)" and both the Code Map and Design Notes claimed `assertStateDocument` "already accepts a `__proto__` entry … the fix needs no store change." That is false: `assertStateDocument` built a plain `const out = {}` and did `out[key] = value`, the identical `Object.prototype.__proto__` setter trap, so it dropped a `__proto__` entry on the read path. The frozen `STORE_PROTO_ROUNDTRIP` criterion (the balance must survive the full `saveState → close → open → loadState` cycle) was therefore unsatisfiable with only the `toJson` fix. **Amended:** the implementation added the same one-line `Object.create(null)` projection to `assertStateDocument` (the read-side half of the same defect); the Code Map and Design Notes were corrected to state the store edit and why. **Known-bad state avoided:** a `toJson`-only fix that passes the seam test but still loses a `__proto__` balance on `loadState` — a write-side-only "fix" that would have left the round-trip broken and the Done-when check unproven. **KEEP:** the two regression tests (seam + full store round-trip), the `Object.create(null)` pattern applied symmetrically to both projections, and the probe-verified reasoning that `canonicalJson` needs no change (it is `Object.keys`-driven). The code was NOT reverted and re-derived — it was already the only coherent outcome and verified green (96/96); the plan was amended to match, per the step-03 forced-deviation convention.

## Review Triage Log

Quick lens, pass 1 — 5 findings, all `low`/doc-bookkeeping, all `patch` (no code logic touched; the two source fixes + both tests were verified correct by the lens and re-run green at 96/96):

- **low — patch — store-state.test.ts module header missing the `STORE_PROTO_ROUNDTRIP` row.** Verified: the header (lines ~5-24) still lists only the original five rows; the Implementation Notes claimed a header edit that never happened. Action: added the `STORE_PROTO_ROUNDTRIP` row to the header matrix and removed the false "gained a line" claim from the Implementation Notes.
- **low — patch — store-state.test.ts stale pre-fix `__proto__` comment (above `idArb`).** Verified: the comment (lines ~44-57) still described the defect as active ("breaks the round-trip", "recorded in deferred-work.md"), but 2.6 fixed both the write and read path. Action: rewrote the comment to state the filter is now purely id-space hygiene, with a short history note that 2.6 fixed the defect and pins the reserved-key path in `STORE_PROTO_ROUNDTRIP`.
- **low — patch — Design Notes Done-when row 1 cited nonexistent `conservation.test.ts` rows `CONSERVE`/`FEE_NONNEG`.** Verified by grep: the file's rows are `CONSERVATION_SUPPLY`/`FEE_EXACT`/`NO_NEGATIVE`/`PERSISTED_ROUNDTRIP`; the Implementation Notes version already used the correct names, so only the Design Notes copy was wrong. Action: corrected the Design Notes row names to match the actual describes.
- **low — patch — all four Tasks checkboxes unchecked although all four tasks are done and verified.** Verified: status `in-review`, suite 96/96, mapping recorded, yet all boxes were `- [ ]` (inconsistent with sibling plans' convention). Action: checked all four.
- **low — patch — deferred-work.md entry 2 (the `toJson` `__proto__` drop) left open although this story closes it, and its "the read side accepts it" wording is now wrong.** Verified: `assertStateDocument` had the same trap (fixed in 2.6), so the "read accepts / silently lost" claim is obsolete. Action: converted the entry to a `RESOLVED 2026-10-05 (story 2.6)` note (kept as a note only, matching the existing resolved-entry convention), recording that both the write and read projections were fixed and the earlier read-side note was wrong.


## Design Notes

**The `toJson` fix (one line + a comment).** The root cause is the plain object literal: `out['__proto__'] = '…'` resolves the key on the `Object.prototype` setter and silently no-ops for a non-object value. `const out = Object.create(null)` gives a prototype-less object, so `__proto__` (and any other reserved own-property name) becomes an ordinary own data property. `JSON.stringify(out)` and the store's `canonicalJson` (which is `Object.keys`-driven, not a `JSON.stringify` of the live object) both handle it correctly, and `fromJson` already reads it via `Object.entries`. The public signature and the AD-5 contract are unchanged; only a reserved-key id — unreachable in the 32-byte-hex protocol id space — now survives. The store's `assertStateDocument` needed the identical fix (see the next bullet) — the asymmetry closed on both the write and read projections.

**The read-path half (forced at build).** The defect is symmetric: both `toJson` (write) and `assertStateDocument` (read, via `loadState`) built a plain `const out = {}` and assigned `out[key] = value`, so both hit the `Object.prototype.__proto__` setter and drop a `__proto__` entry. The frozen `STORE_PROTO_ROUNDTRIP` criterion requires the balance to survive the full `saveState → close → open → loadState` cycle, so closing the finding necessarily touches both sides with the same one-line `Object.create(null)` projection. `fromJson` needs no change (it reads via `Object.entries`, which already yields `__proto__` as a normal entry).

**Scope = the one in-epic deferred finding + a no-op sweep.** `deferred-work.md` carries two entries: (a) `createCore().start()` → `loadGenesis` — explicitly "Home: the consensus epic (3)", OUT of scope here; (b) the `toJson` `__proto__` hardening — "Home: a hardening ticket", which is this epic's own deferred finding, so it is in scope. The sweep of `packages/core/src/` (ledger/store/config/events/proto/ports/index) is expected to find no dead code, unused exports, or dupes — the per-story reviews and the two standing guards (`no-ui-imports`, `no-float-guard`) already police the structural invariants. If the sweep finds nothing, say so and change nothing (inventing churn is a boundary violation).

**Done-when → evidence mapping (recorded for an auditable epic close):**
1. Conservation of supply, no-negative-balance, and fee invariants over long random sequences → `conservation.test.ts` (CONSERVATION_SUPPLY / NO_NEGATIVE / FEE_EXACT / PERSISTED_ROUNDTRIP property rows).
2. Random BigInts up to 10³⁰ round-trip through the store with no precision loss; a float/int64 column is rejected → `store-state.test.ts` (SNAPSHOT_ROUNDTRIP property + the shape guards; `SC-STORE-3` rejects a JSON-number amount).
3. `JSON.stringify` of a balance never throws or drifts; `big.js` referenced only in the fee and display modules → `no-float-guard.test.ts` (JSON_STRINGIFY_BALANCE + BIG_JS_ONLY_BOUNDARY) + `ledger.test.ts` DECIMAL_JSON.
4. A direct balance mutation outside `applyBlock` is impossible (no public mutator); the suite proves it → `ledger.test.ts` NO_MUTATOR (enumerates the public surface; only the `apply` seam mutates).
(The initiative's broader Done-when — boot path, verifiable draw, packaged app — is owned by later epics; this epic's four checks are the ones above.)

## Verification

**Commands:**
- `corepack pnpm test` -- expected: green, all tests (94 + the 2 new regression cases), headless, no real sockets.
- `corepack pnpm typecheck` -- expected: clean.
- `corepack pnpm build` -- expected: clean, protons regen byte-identical, tsc emits dist/.

**Manual checks (if no CLI):**
- Temporarily revert `toJson` to `const out = {}` and confirm the new `__proto__` tests fail (proving they pin the defect); restore and confirm they pass.
