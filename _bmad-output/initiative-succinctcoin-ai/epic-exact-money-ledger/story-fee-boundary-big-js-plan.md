---
title: 'Fee boundary (big.js)'
type: 'feature'
ticket: 2
created: '2026-10-04'
status: 'built'
baseline_revision: '2f7f2f7483dd4a9bc1963759e2f11ba8785b18a6'
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

**Problem:** The fee boundary does not exist: R2 requires fee = amount × rate computed exactly once per transaction, and AD-5's 1st big.js boundary is missing (2.1 shipped only the 2nd — display). Without it, fee math would fall to float (`0.1+0.2 → 0.30000000000000004`) and artifacts would reach persisted balances.

**Approach:** Author `computeFee(amount, rate)` in `core/ledger/fee.ts` — the 1st AD-5 big.js boundary: a pure function multiplying integer base units by a decimal rate string, returning integer base units (truncated). Wire it into the ledger surface and prove it with the matrix: seeded inputs yield exact decimal strings, truncation is deterministic, malformed rates are rejected, and post-fee balances stay clean decimal strings.

## Boundaries & Constraints

**Always:**
- `computeFee` is a pure, deterministic function; its result is integer base units (`bigint`). "Exactly once per transaction" is the caller's contract (epic 3's `applyBlock` computes once per tx, moves the result via `apply`); the boundary's purity makes any recomputation idempotent.
- The rate is a plain-decimal string in [0,1) (e.g. `"0.001"`); exponential notation and malformed input are rejected — the same plain-decimal discipline `fromDisplay` got in 2.1.
- `fee.ts` is the only new big.js importer (with `display.ts`, big.js then lives in exactly the two AD-5 boundaries); `apply` and the integer path stay bigint-only. Floating-point is banned.
- Errors carry the spine's `{ code, message }` shape; a new code `SC-LEDGER-3` marks the fee boundary, distinct from `SC-LEDGER-1` (invariant) and `SC-LEDGER-2` (display).

**Never:**
- No fee-rate provenance (genesis.json has no fee-rate field; adding one is a protocol change) — the test uses a fixed rate; provenance lands with the consensus epic.
- No fee destination (burn vs credit) — the boundary returns an amount; the destination is 2.4's / epic 3's decision.
- No `applyBlock` (epic 3), no store (2.3), no property tests (2.4), no import-scan guard (2.5), no new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FEE_EXACT | seeded: `computeFee(10000000n, "0.1")`; `computeFee(20000000n, "0.1")` | `1000000n`; `2000000n`; the sum's display is exactly `"0.3"` — never `0.30000000000000004`; same input called twice gives the same result (pure) | — |
| FEE_TRUNCATE | `computeFee(1n, "0.1")` (exact product = 0.1 base units) | truncates toward zero → `0n` (never round up; dust is dropped, not credited) | — |
| FEE_REJECT | rate `"1"`, `"-0.1"`, `"1e-3"`, `"abc"`; amount `-5n` | throws: rate outside [0,1), non-decimal rate, negative amount | `SC-LEDGER-3` |
| NO_FLOAT | seeded fee moved via `apply` as a base-unit transfer → `toJson` | balance is an exact bigint; clean decimal strings, no artifact, no throw; `toDisplay` clean | a throw/artifact fails the test |

</frozen-after-approval>

## Code Map

- `packages/core/src/ledger/fee.ts` — **new.** The 1st AD-5 boundary: `computeFee(amount: bigint, rate: string): bigint`. Pure: validate (amount ≥ 0; rate against `/^\d+(\.\d+)?$/` BEFORE big.js — big.js silently parses `1e-3`; then 0 ≤ rate < 1), then exact `new Big(amount.toString()).times(rate).toFixed()` with truncation toward zero as a string cut at the `.` (big.js 7.0.1 has NO `trunc()` — Design Notes) → `BigInt`. The only new big.js importer — after this story 2.5's guard finds big.js in exactly `fee.ts` + `display.ts` (import statements, not prose).
- `packages/core/src/ledger/ledger.ts` — `LedgerError.code` → 3-code union `'SC-LEDGER-1' | 'SC-LEDGER-2' | 'SC-LEDGER-3'` (fee boundary). `apply`/`Transfer` unchanged — the fee moves as an ordinary base-unit transfer made by the caller.
- `packages/core/src/ledger/index.ts` — re-export `computeFee`.
- `packages/core/src/index.ts` — additive re-export of `computeFee`.
- `packages/core/src/ledger/big-js.d.ts` — extend the ambient shim with the one `Big` method `fee.ts` uses that it lacked: `gte(n): boolean` (the `[0,1)` range check). No `trunc()` was ever added to the shim — it does not exist in big.js 7.0.1 (see Design Notes).
- `packages/core/test/fee.test.ts` — **new.** Matrix rows FEE_EXACT (incl. the 0.1+0.2 drift case + purity), FEE_TRUNCATE, FEE_REJECT, NO_FLOAT (fee → apply → `toJson`/`toDisplay`).
- Unchanged: `display.ts`, `ports.ts`, `events/`, `config/`, `proto/`, `store/`; one pre-existing assertion in `test/ledger.test.ts` (the NO_MUTATOR export enumeration gains `computeFee`, forced by the re-export above).

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/ledger/fee.ts` — `computeFee`: the 1st AD-5 big.js boundary (validation + exact multiply + truncation).
- [ ] `packages/core/src/ledger/ledger.ts` — widen `LedgerError.code` to the 3-code union (`SC-LEDGER-3`).
- [ ] `packages/core/src/ledger/index.ts` + `packages/core/src/index.ts` — re-export `computeFee`.
- [ ] `packages/core/test/fee.test.ts` — the four matrix rows.

**Acceptance Criteria:**
- Given a seeded amount and rate, when `computeFee` runs, then it returns amount × rate in exact integer base units — a clean decimal (per testing.md "assert exact strings"), with no float drift in sums.
- Given a fee result moved through `apply`, when balances encode via `toJson`, then the persisted form is clean decimal strings with no float artifact.

## Design Notes

- **Why a standalone boundary function.** AD-5 names the fee boundary as big.js's 1st of two; `apply` (2.1) is pure bigint and must stay that way. So the boundary is `computeFee(amount, rate) → bigint` in `fee.ts`, called once per transaction by whoever owns the mutation path (epic 3's `applyBlock`), which then moves the result as an ordinary base-unit transfer. The spine's structural seed already places "fee (big.js boundary)" inside `ledger/`.
- **Rate is a decimal string, amount a bigint.** The rate is a fractional per-unit proportion (e.g. `"0.001"`); AD-5: exact-decimal money is recorded via big.js at every boundary where a decimal exists — the rate IS that decimal. The amount is the integer path (bigint). The product converts back to integer base units inside the boundary; big.js never leaves it.
- **Rounding = truncation toward zero.** Integer amount × fractional rate can land on a fractional base unit (`1n × "0.1"` = 0.1 base units). Truncate: never overcharge the sender, identical on every node (consensus-critical), dust dropped and credited nowhere (destination semantics are 2.4's decision). big.js mechanics (probe-verified against installed 7.0.1): **`trunc()`/`floor()` do not exist** — the method surface ends at `round(dp)` (which returns a primitive `number`, not a `Big`). Truncation is therefore an exact string cut of `toFixed()` (no arg = full plain decimal) at the `.` → `BigInt(string)`. Exactness is probe-verified: big.js **multiplication is exact** (25+ fractional digits round-trip; `DECIMAL_PLACES` bounds only div/mod/pow), both operands are validated non-negative (toward-zero = floor), so everything after the `.` is sub-base-unit dust. `amount.toString()` on a bigint is always plain decimal (bigint has no float representation), so the exponential guard is needed only on the rate.
- **Validation order.** amount ≥ 0; rate against the plain-decimal regex before big.js (big.js silently accepts `1e-3` — the same drift vector 2.1 closed in `fromDisplay`; the regex literal is local to `fee.ts` so no third module references big.js); then 0 ≤ rate < 1 — a fee ≥ the whole amount is economic nonsense and would overdraw at `apply` anyway, so reject it early with a clearer error.
- **New code `SC-LEDGER-3`.** The fee boundary is semantically distinct from the no-negative invariant (`1`) and the display boundary (`2`) — a caller handling "balance went negative" must not see "bad rate". Same N-code pattern as 1.5's `SC-STORE-1`/`SC-STORE-2`.

## Verification

**Commands:**
- `corepack pnpm test` — expected: exit 0; the new fee matrix tests pass; existing suite (49) green.
- `corepack pnpm typecheck` — expected: exit 0 (strict; 3-code union types clean).
- `corepack pnpm build` — expected: exit 0 (protons regen byte-identical; `dist/ledger/fee.js` emitted).

## Implementation Notes

**2026-10-04 — story 2.2 implemented (route: full).**

### Verification results

| Command | Result |
| --- | --- |
| `corepack pnpm test` | exit 0 — 10 files / 66 tests passed (49 pre-existing green, 17 new fee-matrix tests across the four rows FEE_EXACT / FEE_TRUNCATE / FEE_REJECT / NO_FLOAT). |
| `corepack pnpm typecheck` | exit 0 (strict; 3-code `LedgerError.code` union clean). |
| `corepack pnpm build` | exit 0 — protons regen byte-identical (no `src/proto/` diff), `dist/ledger/fee.js` + `fee.d.ts` emitted. |

### Implementation decisions

1. **`trunc()` does not exist in big.js 7.0.1 (probe-verified, contradicts the Code Map).** The installed package's actual instance method surface is `abs, cmp, div, eq, gt, gte, lt, lte, sub, minus, mod, neg, add, plus, pow, prec, round, sqrt, mul, times, toExponential, toFixed, toString, toJSON, toNumber, toPrecision, valueOf` — no `trunc`, no `floor`. The Code Map's `new Big(amount.toString()).times(rate).trunc().toFixed()` throws `TypeError: trunc is not a function`. **Resolution:** truncation toward zero is done as an exact string cut on the `toFixed()` plain decimal at the decimal point (`plain.slice(0, dot)`). This is exact, not approximate: big.js multiplication is exact (DECIMAL_PLACES applies only to div/mod/pow), both operands are validated non-negative (so truncation toward zero = floor), and everything after the `.` is sub-base-unit dust — dropped, never credited. `gte` (used for the `[0,1)` range check) was confirmed present.
2. **Shim extended minimally — `gte` only.** `big-js.d.ts` gains `gte(n): boolean` (the only fee.ts method the shim lacked). The `trunc(): Big` declaration was never committed (first attempt added it; removed after the probe found the method missing at runtime).
3. **Validation order as planned:** `amount ≥ 0` → rate against local regex `/^\d+(\.\d+)?$/` (unsigned — stricter than display.ts's signed pattern; deliberately NOT shared so no third module references the decimal grammar) → `0 ≤ rate < 1` via `gte(1)`. All rejections throw `LedgerError` with `SC-LEDGER-3`; message prefixes follow the 2.1 convention (`SC-LEDGER-3: computeFee: …`).
4. **FEE_EXACT drift row — the frozen "0.3" display, at the fixed scale.** At the 2.1 scale (1 whole = 10⁸ base units), the seeded fees display as `"0.01"` and `"0.02"`; their sum `3_000_000n` displays exactly `"0.03"`. The canonical `0.1 + 0.2 → 0.30000000000000004` float pair is asserted in-test as the *witness* (proving the drift is real and the boundary's output never carries it). Note: at this scale `0.01 + 0.02 === 0.03` in float (no artifact) — the canonical drift pair is `0.1 + 0.2`; the test documents this so a future scale change doesn't silently vacate the row.
5. **Existing test touched (one assertion, not the frozen matrix):** `ledger.test.ts` NO_MUTATOR "exports exactly the agreed surface" hardcodes the ledger export list; it now includes `computeFee` (the plan's Code Map requires `ledger/index.ts` to re-export it, so the enumeration must follow). All other assertions in all 9 pre-existing test files are unchanged and green.
6. **`apply`/`Transfer` untouched** — the fee moves as an ordinary base-unit transfer in the NO_FLOAT row (fee → `apply` → `toJson` exact decimal strings, `toDisplay` clean, supply conserved).

### Left incomplete / risky

- Nothing incomplete: all four Tasks & Acceptance checkboxes are satisfied (fee.ts, 3-code union, both re-exports, four matrix rows).
- Risk (low, carried forward to 2.5): 2.5's import scan must scan **import statements** — `fee.ts`'s module doc comment mentions big.js in prose (same as `display.ts`/`big-js.d.ts` already do; the shim's header explicitly warns about this).
- Risk (low): the frozen FEE_EXACT row's literal `"0.3"` display string is not reproducible at the fixed 10⁸ scale (the seeded inputs yield `"0.01"`/`"0.02"`/`"0.03"`); the row's invariant — exact decimal, never `0.30000000000000004`, pure — is fully asserted. If a human reads the frozen row as pinning the literal `"0.3"` display, the scale (a 2.1 code-level decision, 8 decimals) would need renegotiation.
- **Frozen FEE_EXACT row interpretation (settled 2026-10-04, autonomous — user unavailable; human review requested)** — the row's `"0.3"` is read as testing.md's canonical `0.1+0.2` float-drift example (the row's own invariant wording: "exact decimal, never `0.30000000000000004`"), NOT a scale pin: at the fixed 10⁸ scale (2.1 code-level decision) the seeded sum `3_000_000n` displays `"0.03"`. The frozen text was not modified (human-owned). The test file's header now states this interpretation explicitly; the assertions are unchanged. If the human reads the row as pinning the literal `"0.3"`, the scale must be renegotiated (see 2.1's DISPLAY flag — same pattern, different row).

## Plan Change Log

- 2026-10-04 (review 2.2, Quick lens finding 2 — stale Code Map/Design Notes) — the Code Map prescribed `times(rate).trunc().toFixed()` and listed `big-js.d.ts` as unchanged, but big.js 7.0.1 has no `trunc()` (probe-verified) and the shim **was** changed (gained `gte`). The implementation was already correct (string-cut truncation, `gte` added); only the plan prose was wrong. Amended: Code Map fee.ts entry (exact multiply + string cut, `gte` shim note), new `big-js.d.ts` entry, "Unchanged" list corrected (big-js.d.ts removed; the forced `ledger.test.ts` NO_MUTATOR enumeration noted), Design Notes truncation paragraph rewritten with the probe-verified mechanics. Known-bad state avoided: 2.5 or a later story re-reading this plan would be told `trunc()` exists and that `big-js.d.ts` is untouched — both false. **KEEP:** the string-cut truncation implementation, the `gte`-only shim extension, the plain-decimal rate regex, `SC-LEDGER-3`, and the exactness probe result (multiplication is exact past `DECIMAL_PLACES`) — all must survive any re-derivation. No code changed by this amendment.

## Review Triage Log

- **low — flagged to human (no loopback, no revert)** — Quick lens: frozen FEE_EXACT row's literal `"0.3"` display is not reproducible at the fixed 10⁸ scale (seeded sum `3_000_000n` displays `"0.03"`); the row's substantive invariant (clean decimal, never `0.30000000000000004`, pure) IS met, and the code is correct per the approved 10⁸ scale (2.1 code-level decision). The row's `"0.3"` is testing.md's canonical `0.1+0.2` drift example inherited into the row text. HALTed at step-03 per the ambiguous-row rule; the human delegated the decision ("work autonomously, make good decisions"), so the scale-preserving reading was taken: frozen text untouched (human-owned), the interpretation recorded in Implementation Notes, and the test header now states it explicitly. Same pattern as 2.1's DISPLAY-row flag — if the human reads the row as pinning the literal `"0.3"`, the scale must be renegotiated (2.1/2.3/2.4 ripple), which is the human's call.
- **low — patch (doc-only, applied)** — Quick lens: the plan Code Map prescribed `trunc()` (absent from big.js 7.0.1) and listed `big-js.d.ts` as unchanged (it gained `gte`). Verified: `typeof b.trunc === 'undefined'` on the installed package; the diff does change the shim. The code is correct; only the plan prose was stale and would mislead 2.5. Fixed by amending the Code Map + Design Notes (see Plan Change Log); no code changed, verification results (66/66, typecheck, build) stand.
- **low — deferred to 2.5 (forward constraint, not a defect here)** — Quick lens: `fee.ts`'s module doc comment mentions "big.js" in prose (as `display.ts`/`big-js.d.ts` already do), so a 2.5 guard that greps the string `big.js` rather than parsing import statements would false-positive. Verified: the import *statements* are exactly two modules (AD-5 holds); only prose mentions it. The plan already carries this note in Implementation Notes; 2.5's import-scan guard must parse import statements. No action in this change.
