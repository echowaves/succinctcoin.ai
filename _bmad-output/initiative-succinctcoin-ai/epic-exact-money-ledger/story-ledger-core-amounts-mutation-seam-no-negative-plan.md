---
title: 'Ledger core: amounts, mutation seam, no-negative'
type: 'feature'
ticket: 1
created: '2026-10-03'
status: 'built'
baseline_revision: 'a4779e0b77f91c85000505508c4f216d58570396'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-exact-money-ledger/epic-exact-money-ledger.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `core/ledger` does not exist — there is no exact money anywhere in the core. Balances would be floats or ad-hoc, `JSON.stringify` of a BigInt throws, and there is no single mutation path with the no-negative invariant (AD-2/AD-5). This is the epic-2 tracer: stand up the ledger's amount representation, the mutation seam epic 3's `applyBlock` will invoke, and the no-negative invariant.

**Approach:** Author `packages/core/src/ledger/` — balances as integer base units (`bigint`), a pure `apply` seam (the ledger's only mutation path) that moves base units and enforces no-negative, decimal-string encoding for wire/JSON/disk (raw `BigInt` banned from JSON), the display-conversion boundary (big.js, the 2nd of the two AD-5 boundaries), and add `big.js@7.0.1` to `packages/core` devDependencies. Verify with the story's matrix: exact movement, negative rejection, no public mutator, clean decimal JSON.

## Boundaries & Constraints

**Always:**
- Amounts are integer base units (`bigint`) in memory; decimal strings on wire/JSON (AD-5). `JSON.stringify` of a balance never throws (BigInt throws natively) and never drifts.
- All mutation flows through the single `apply` seam; the ledger performs arithmetic + invariant checks only — it never re-validates protocol rules (AD-2). No other public mutator exists.
- The no-negative-balance invariant is enforced inside the seam: a debit exceeding the balance fails the whole apply with `SC-LEDGER-1`, leaving balances unchanged (atomic).
- `big.js` appears only in the display-conversion module in this story (its fee-boundary use is 2.2). Floating-point is banned from the ledger.
- Errors carry the spine's `{ code: 'SC-LEDGER-1', message }` shape.

**Never:**
- No fee computation (2.2 owns the fee boundary), no store persistence (2.3), no property tests over sequences (2.4), no import-scan guard (2.5).
- No `applyBlock` — that is `core/consensus` (epic 3); this story ships the seam it will call.
- No mining/reward-credit semantics (epic 3); the seam accepts credits as data, not as protocol.
- No new dependencies except `big.js@7.0.1` (spine Stack; already a root devDep for bench/).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EXACT_MOVE | `apply` with a transfer A→B of exact base units | A debited, B credited, amounts exact (no rounding, no drift) | — |
| NO_NEGATIVE | a debit larger than the balance | the whole apply fails `SC-LEDGER-1`; no balance changed (atomic) | the reject IS the expected behavior |
| NO_MUTATOR | inspect the ledger's public surface | only the seam mutates; balances are read via getters/projections | — |
| DECIMAL_JSON | `JSON.stringify` of a balance / balance map | clean decimal strings (base units), no throw, no drift | a throw fails the test |
| DISPLAY | base-unit `BigInt` → human decimal string via the big.js boundary | `12345678n` → `"1.2345678"` (8 base units per whole); `0n` → `"0"` | — |

</frozen-after-approval>

## Code Map

- `packages/core/src/ledger/ledger.ts` — **new.** `BASE_UNIT_DECIMALS = 8` (code-level decision: 8 base units per whole, Bitcoin-style; documented). `LedgerError` (`code 'SC-LEDGER-1'`). `BalanceMap = ReadonlyMap<string, bigint>` (identity 32-byte hex → base units). The seam: `apply(balances, transfers: Transfer[]): BalanceMap` — pure (new Map, no in-place mutation), moves exact base units, enforces no-negative atomically (any failing debit → `LedgerError`, original map untouched). `Transfer = { from: string, to: string, amount: bigint }`. Read helpers: `balanceOf(balances, id): bigint` (absent → 0n), `totalSupply(balances): bigint`.
- `packages/core/src/ledger/display.ts` — **new.** The big.js boundary (AD-5 2nd boundary): `toDisplay(baseUnits: bigint): string` and `fromDisplay(s: string): bigint` — pure, big.js-only decimal math (no float: divide by 10^8 via big.js, never `/` on numbers). This is the only file in `src/ledger/` that imports `big.js` in this story.
- `packages/core/src/ledger/index.ts` — **new.** Re-export the ledger surface (`apply`, `Transfer`, `BalanceMap`, `balanceOf`, `totalSupply`, `LedgerError`, `BASE_UNIT_DECIMALS`, `toDisplay`, `fromDisplay`).
- `packages/core/src/index.ts` — additive re-export of the ledger surface (`createCore` untouched; the read-API projection of balances is a later epic's concern).
- `packages/core/package.json` — add `big.js@7.0.1` to devDependencies (matches root; core imports it in src → under pnpm strict layout it must be a direct devDep; 2.2's fee module will use the same).
- `packages/core/test/ledger.test.ts` — **new.** Matrix rows EXACT_MOVE, NO_NEGATIVE, NO_MUTATOR (surface inspection), DECIMAL_JSON, DISPLAY (incl. `fromDisplay` round-trip and `0n`).
- Unchanged: `ports.ts`, `events/`, `config/`, `proto/`, `store/`, all existing tests, root `package.json`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ledger/ledger.ts` — base-unit balances, pure `apply` seam, no-negative invariant (atomic), read helpers, `LedgerError`.
- [x] `packages/core/src/ledger/display.ts` — big.js display boundary (`toDisplay`/`fromDisplay`), 8 base units per whole.
- [x] `packages/core/src/ledger/index.ts` — re-export the ledger surface.
- [x] `packages/core/src/index.ts` — additive re-export of the ledger surface.
- [x] `packages/core/package.json` — add `big.js@7.0.1` devDependency (+ lockfile).
- [x] `packages/core/test/ledger.test.ts` — the five matrix rows.

**Acceptance Criteria:**
- Given balances and a transfer, when `apply` runs, then the sender is debited and the receiver credited by the exact base units, with no rounding or drift, and the result is a new map (the input map is untouched).
- Given a debit larger than a balance, when `apply` runs, then it throws `SC-LEDGER-1` and no balance changes (atomic failure).
- Given the ledger's exported surface, when it is inspected, then only the `apply` seam mutates and balances are read via getters/projections.
- Given a balance or balance map, when `JSON.stringify` runs, then it yields clean decimal strings (base units) without throwing or drifting.

## Design Notes

- **Base unit = 8 decimals (code-level decision).** 1 whole = 10^8 base units (Bitcoin-style). `BASE_UNIT_DECIMALS` is a named constant so 2.2/2.3/2.4 inherit it. Not in the frozen block: it is a ledger-internal representation choice (AD-5 says "integer base units" without fixing the scale), and the display boundary documents it.
- **Seam shape = pure `apply(balances, transfers) → BalanceMap` (the `unknown` settled).** Pure function: no hidden state, no I/O, deterministic — epic 3's `applyBlock` owns the state (the Map it threads), the store, and the ordering; the ledger does arithmetic + invariants only (AD-2). Credits (rewards) are just transfers from a reserved mint id, so no protocol semantics leak in. `Transfer.amount` is `bigint` base units — the wire/JSON decimal-string form is the encoding boundary (DECIMAL_JSON row), not the in-memory type.
- **Atomic no-negative.** `apply` validates all debits against the running totals and throws `SC-LEDGER-1` naming the identity before returning; because it builds a new Map, a throw leaves the input untouched (atomicity is structural).
- **JSON encoding.** `BalanceMap` is a `Map`; the DECIMAL_JSON contract is that a balance (bigint) serializes as its decimal base-unit string — provided by a `toJson(balances): Record<string, string>` projection (and the test proves `JSON.stringify` of that never throws/drifts). Raw `BigInt` is never placed where `JSON.stringify` would throw.
- **Why devDependency, not dependency.** `big.js` is imported from `src/` (the display module), but the package is `private` and consumed in-repo; the existing convention puts everything in `devDependencies` (libp2p, protons-runtime all live there). pnpm strict layout requires a direct devDep entry for core's import to resolve.
- **NO_MUTATOR proof.** The test imports the `ledger` module namespace and asserts the only function that returns a changed map is `apply` (surface enumeration + type-level: `BalanceMap` is `ReadonlyMap`, so in-place mutation is a type error — the compile is part of the proof).

## Verification

**Commands:**
- `corepack pnpm test` — expected: exit 0; the 5 new ledger matrix tests pass; existing suite (27) green.
- `corepack pnpm typecheck` — expected: exit 0, strict tsc clean across the new ledger module (bigint/ReadonlyMap typing).
- `corepack pnpm build` — expected: exit 0 (protons regen byte-identical; tsc emits the ledger module into dist/).

## Implementation Notes

- **Verification (2026-10-03, baseline `a4779e0`)**: `corepack pnpm test` → 9 files / **49 tests** pass (27 pre-existing + **22** new ledger); `corepack pnpm typecheck` → clean (strict, incl. `ReadonlyMap`/bigint typing); `corepack pnpm build` → clean, protons regen byte-identical (no diff in `src/proto/`), `dist/ledger/{ledger,display,index}.js` emitted. (Re-run after the review patches below: still 49/49.)
- **Review patch — `fromDisplay` plain-decimal guard + `SC-LEDGER-2`** (findings: big.js silently accepts exponential notation — `new Big('1e8')` → `100000000`, no throw — and throws a plain `Error`, not `RangeError`, for malformed input). `fromDisplay` now rejects anything not matching `/^-?\d+(\.\d+)?$/` BEFORE big.js sees it, and both the malformed-input and sub-base-precision rejections throw `LedgerError` with a **new code `SC-LEDGER-2`** (the display boundary), keeping `SC-LEDGER-1` semantically pure for the no-negative invariant. `LedgerError.code` is now `'SC-LEDGER-1' | 'SC-LEDGER-2'` (same pattern as 1.5's `SC-STORE-1`/`SC-STORE-2`). The docstring's wrong `RangeError` claim and the test's `RangeError` expectation were both corrected; the test now pins `fromDisplay('1e8')` / `'1.2345678e1'` as `SC-LEDGER-2` rejections.
- **Frozen-matrix typo (DISPLAY row)** — the frozen row says `12345678n → "1.2345678" (8 base units per whole)`, which is internally inconsistent: 12345678 base units at 10⁸/whole is `0.12345678`; the output `"1.2345678"` requires `123456780n` (10⁷/whole). The Design Notes fix the scale (1 whole = 10⁸ base units, `BASE_UNIT_DECIMALS = 8`), so the scale won and the input was corrected to `123456780n`. The test asserts BOTH mappings (`123456780n → "1.2345678"` and `12345678n → "0.12345678"`) so the derivation is visible. Human renegotiation needed to change the frozen row itself.
- **`toJson` added to the surface** — the Design Notes name it as the DECIMAL_JSON mechanism but the Code Map's surface list omits it; it is additive and required to make "JSON.stringify never throws" testable, so it is exported from `ledger/index.ts` and `src/index.ts`.
- **`src/ledger/big-js.d.ts` — ambient type shim (deviation: file not in Code Map)** — `big.js@7.0.1` ships no TypeScript declarations (no `types` field, no `.d.ts`) and no `@types/big.js` is in the lockfile; under `strict` tsc the `import Big from 'big.js'` is untyped. The frozen boundary allows no dependency except `big.js` itself (so `@types/big.js` was out), and a package-local `typings/` dir would also be an unlisted artifact — the minimal fix is a `declare module 'big.js'` shim declaring only the surface `display.ts` uses. It does not import big.js; `display.ts` remains the sole big.js importer (2.5's import scan should scan import statements, not prose comments — the module docstring of `display.ts` and this shim reference "big.js" as text).
- **big.js API gotchas (probe-verified against installed 7.0.1, both CJS and ESM builds)**: (1) `Big#round(dp)` returns a primitive `number`, not a `Big` — a `round(0).neq(...)` chain TypeErrors; (2) `neq` does not exist at all — comparators are `eq`/`gt`/`gte`/`lt`/`lte`/`cmp`; (3) `Big#toString()` switches to exponential notation (`1e+22`) at large magnitudes, while `toFixed()` (no arg) always yields the full plain decimal — `toFixed()` is used for display strings so the 10³⁰ round-trip stays a plain decimal; (4) invalid input (`''`, `'abc'`, `'1.2.3'`, `'NaN'`, `'Infinity'`) throws `[big.js] Invalid number` from the constructor.
- **`fromDisplay` is the inverse of `toDisplay` only for values quantized to base units** — `toDisplay` truncates sub-base-unit tails (`toFixed` at ≤ 8 fractional display digits), so `fromDisplay(toDisplay(x)) === x` holds iff `x` is a multiple of 1 base unit's display quantum (the test round-trips quantized values only and documents the contract). The integer seam path is never lossy; only the display boundary quantizes.
- **No reserved-mint special case in `apply`** — the Design Notes say "credits (rewards) are just transfers from a reserved mint id", implemented as: the seam has no protocol semantics and the no-negative invariant applies to every `from`, including a mint id (an unfunded mint debit fails `SC-LEDGER-1`). Epic 3's `applyBlock` owns any mint id it defines; the seam treats it as data.
- **Atomicity implementation** — two passes: pass 1 validates every debit against running totals (credits in the same apply count toward covering later debits) and throws `SC-LEDGER-1` naming the identity before any map is built; pass 2 materializes the new map. The input map is only ever read, so a throw leaves it structurally untouched.

## Plan Change Log

- 2026-10-03 (build 2.1) — additions beyond the Code Map, all forced by the frozen boundaries, none changing intent: (a) `toJson` exported on the surface (named in the plan's Design Notes as the DECIMAL_JSON mechanism); (b) new file `packages/core/src/ledger/big-js.d.ts` (ambient type shim — `big.js` ships no types; no new dependency). The frozen block is untouched.
- 2026-10-03 (review 2.1) — `fromDisplay` hardened: plain-decimal guard (`/^-?\d+(\.\d+)?$/`) rejects exponential/malformed input before big.js parses it (big.js silently accepts `1e8`); malformed + sub-base-precision rejections now throw `LedgerError` with a new `SC-LEDGER-2` code (display boundary), leaving `SC-LEDGER-1` for the no-negative invariant. `LedgerError.code` widened to the two-code union. No new dependency; the frozen block is untouched (its DISPLAY row typo is flagged for human renegotiation, see Triage Log).

## Review Triage Log

- **medium — `patch`** — `fromDisplay` silently accepted exponential notation: big.js parses `1e8` as `100000000` (verified: `new Big('1e8')` → `100000000`, no throw), so a display/wire string like `"1e8"` would be read as 10¹⁶ base units — a drift vector the plain-decimal contract exists to prevent. The docstring claimed it "accepts plain decimal strings" and "throws on non-decimal," but big.js's `NUMERIC` grammar accepts `e` notation. Fix: `fromDisplay` now rejects anything not matching `/^-?\d+(\.\d+)?$/` before big.js sees it; the test pins `fromDisplay('1e8')` / `'1.2345678e1'` as rejections.
- **low — `patch`** — `fromDisplay`'s docstring claimed non-decimal input "throws `RangeError`," but big.js's constructor throws a plain `Error` (`[big.js] Invalid number`); the only `RangeError` was the sub-base-precision one. Verified against installed 7.0.1. Fix (folded into the above): both the malformed-input and sub-base-precision rejections now throw a typed `LedgerError`, and a **new code `SC-LEDGER-2`** (display boundary) is introduced so `SC-LEDGER-1` stays semantically pure for the no-negative invariant — the same two-code pattern as 1.5's `SC-STORE-1`/`SC-STORE-2`. `LedgerError.code` is now `'SC-LEDGER-1' | 'SC-LEDGER-2'`; the test asserts `SC-LEDGER-2` on every display rejection.
- **low — `patch`** — The test file's header repeated the frozen row's incorrect DISPLAY mapping (`12345678n → "1.2345678"`) while its own assertions used the corrected `123456780n → "1.2345678"`, an in-file contradiction with no explanation. Fix: header corrected to the 10⁸ scale with a pointer to the plan's Implementation Notes.
- **low — `patch`** — The Implementation Notes verification line recorded "48 tests (21 new ledger)" but `ledger.test.ts` has 22 `it` blocks and the suite reports 49 total; the note was stale. Fix: corrected to "49 tests (22 new)."
- **low — rejected (frozen-text typo; fix is a human's call)** — The frozen I/O matrix DISPLAY row reads `12345678n → "1.2345678" (8 base units per whole)`, which is internally self-contradictory: 12 345 678 base units at 10⁸/whole is `0.12345678`, and `"1.2345678"` requires `123456780n`. No scale satisfies the row as written. The approved (non-frozen) Design Notes unambiguously fix the scale at 10⁸ (`BASE_UNIT_DECIMALS = 8`, Bitcoin-style), and the code + tests correctly implement that scale, asserting both `123456780n → "1.2345678"` and `12345678n → "0.12345678"` so the derivation is visible. So the code is correct per the approved intent; the row's worked-example input is a one-digit typo. Its fix is editing the `<frozen-after-approval>` block, which only the human can renegotiate — flagged to the user, not self-authorized. Reverting the (correct) code over a typo would be wrong, so no intent_gap loopback.
