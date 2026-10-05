---
title: 'big.js boundary + no-float guard'
type: 'feature'
ticket: 5
created: '2026-10-04'
baseline_revision: 'e199cc83d39ef7b350974ee29f837579994c845a'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/packages/core/test/no-ui-imports.test.ts'
  - '{project-root}/packages/core/src/ledger/ledger.ts'
  - '{project-root}/packages/core/src/ledger/fee.ts'
  - '{project-root}/packages/core/src/ledger/display.ts'
---

## Intent

**Problem:** AD-5 says `big.js` appears at exactly two boundaries (fee, display) and floating-point is banned from the ledger, but nothing *enforces* that standing — a future edit could import big.js elsewhere or let a `number`/float slip into money math and the suite would not notice.

**Approach:** Add one test-only guard file that (a) scans every import statement in `packages/core/src` and asserts `big.js` is imported only by `ledger/fee.ts` + `ledger/display.ts`, (b) scans ledger source (minus comments and the type-shim) and asserts no floating-point type/literal appears, and (c) proves `JSON.stringify` of a balance map never throws and never drifts (decimal-string encoding). The guard passes today and fails on future drift. No source changes.

## Boundaries & Constraints

**Always:**
- The big.js import scan matches **import statements only** — strip comments first, then match an import-specifier form. A comment that *mentions* "big.js" must never be flagged (the fee.ts/display.ts/ledger.ts/shim doc comments all say so in prose).
- The float scan excludes `*.d.ts` (the `big-js.d.ts` shim declares big.js's `number | string | Big` surface — that is the engine's type, not ledger arithmetic) and runs on comment-stripped ledger source.
- `toJson` output values must be strings matching `/^\d+$/` (decimal base units, no float, no e-notation) — that is what makes `JSON.stringify` both safe and drift-free.

**Never:**
- No source-file edits. The guard is additive test code only; if a scan fails, the fix is in the offending source (a future story), not by weakening the guard.
- Do not scope the float scan to the whole package — the ticket bans float from the **ledger**; the store's `Number(b.slot)` (a slot index, not a balance) stays legal.
- Do not treat `declare module 'big.js'` (the shim) as an import.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| BIG_JS_ONLY_BOUNDARY | scan all `src/**/*.ts` import statements | offenders set == `{ledger/fee.ts, ledger/display.ts}`; a comment mentioning "big.js" is NOT an offender; a real `import Big from 'big.js'` IS | test fails listing offenders if the set differs |
| NO_FLOAT_IN_LEDGER | comment-stripped `src/ledger/*.ts` (excl `*.d.ts`) | zero matches for `number` type / `Number(` / `Math.` / float literal / exponential | test fails listing offenders |
| JSON_STRINGIFY_BALANCE | balance map incl. 0, 1, mid, 10³⁰-scale | `JSON.stringify(toJson(map))` does not throw; `JSON.parse` round-trips exactly; every value matches `/^\d+$/` | a raw BigInt would make `JSON.stringify` throw `TypeError` — that failure is the point |

## Code Map

- `packages/core/test/no-float-guard.test.ts` -- NEW. The guard. Reuses `no-ui-imports.test.ts`'s `tsFiles` walker shape + import-specifier regex idea.
- `packages/core/test/no-ui-imports.test.ts` -- PATTERN ONLY (read, don't change): the `tsFiles` recursive walker and the `from|import(|import|require(` specifier regex to adapt.
- `packages/core/src/ledger/ledger.ts` -- source of `toJson` (→ `Record<string,string>` decimal base units) used by the JSON row; also the file whose prose comments mention big.js (must not be flagged).
- `packages/core/src/ledger/fee.ts` + `display.ts` -- the only two big.js importers (fee.ts:23, display.ts:24). Read to confirm the import form.
- `packages/core/src/ledger/big-js.d.ts` -- the ambient `declare module 'big.js'` shim; excluded from the float scan; its `declare module 'big.js'` must not match the import scan.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/test/no-float-guard.test.ts` -- add the guard: a `stripComments` helper + `tsFiles` walker; the big.js import-specifier scan (BIG_JS_ONLY_BOUNDARY, incl. two self-test cases proving comments aren't flagged and real imports are); the float scan (NO_FLOAT_IN_LEDGER); the `JSON.stringify(toJson)` never-throws/never-drifts check (JSON_STRINGIFY_BALANCE, deterministic + a fast-check property over random BigInts ≤ 10³⁰) -- RATIONALE: single standing guard for all three AD-5 invariants, test-only.

**Acceptance Criteria:**
- Given the current tree, when the guard runs, then all three matrix rows pass and the suite is green (existing 88 + new cases).
- Given a comment that mentions `big.js` in a ledger file, when the import scan runs, then that file is not reported as an offender.
- Given a balance map whose values were raw `BigInt`s (hypothetical), when `JSON.stringify` is attempted on the map directly, then it throws — and the guard's use of `toJson` is what avoids that (documented in a test comment).

## Implementation Notes

**Built (2026-10-05, baseline `e199cc8`).** Added `packages/core/test/no-float-guard.test.ts` (6 tests, 3 matrix rows). Test-only — no source file under `src/` touched; `git status` shows only the new test file as untracked, and `pnpm build`'s protons regen is byte-identical (no `src/` drift).

**Guard structure** (matches the plan's Code Map + Design Notes):
- `tsFiles` walker (recursive, same shape as `no-ui-imports.test.ts`) + `stripComments` (removes block and line comments, preserving line structure). The plan's "no comment markers inside string literals" safety assumption was **verified across all of `src/`** before relying on it: greps for `://`, a quote immediately followed by a slash, and `//` inside template literals all came back clean, so a comment-marker sweep cannot corrupt any real string.
- **BIG_JS_ONLY_BOUNDARY**: import-specifier regex `(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']big\.js["']` (adapted from `no-ui-imports.test.ts`'s form-agnostic regex, specialized to the `big.js` module literal) run on **comment-stripped** `src/**/*.ts`; asserts the offender set (src-relative, sorted) equals exactly `[ledger/display.ts, ledger/fee.ts]`. Self-test proves a prose comment (`/* … big.js … */` + `// import Big from "big.js"`) and the shim's `declare module 'big.js'` are NOT flagged, while four real import forms ARE.
- **NO_FLOAT_IN_LEDGER**: `/\bnumber\b|\bNumber\(|\bMath\.|\d+\.\d+|\d+[eE][+-]?\d+/` on comment-stripped `src/ledger/*.ts` **excl `*.d.ts`**; asserts zero offenders and asserts `big-js.d.ts` exists (the excluded shim). Self-test proves the patterns fire on code but not on the same constructs inside comments, and that `\bnumber\b` does not match camelCase (`someNumber`).
- **JSON_STRINGIFY_BALANCE**: deterministic map (0, 1, `10n**8n`, `123456789012345678901234567890n` ~10³⁰-scale) + a `fc.bigInt({min:0n, max:10n**30n})` property (ids via `fc.string().filter(≠'__proto__')`, same convention as 2.3/2.4). Each asserts: `JSON.stringify(toJson(m))` does not throw, `JSON.parse` deep-equals `toJson(m)` (never drifts), every value matches `/^\d+$/`. The deterministic case first proves `JSON.stringify(Object.fromEntries(rawBigIntMap))` **throws** `TypeError` — the `toJson` projection is what avoids it (documented in the test comment, per the acceptance criteria).

**Verification (all green):** `corepack pnpm test` → **94/94 pass** (88 pre-existing + 6 new; 13 files). `corepack pnpm typecheck` → clean. `corepack pnpm build` → clean, proto regen byte-identical. `get_errors` on the new file → none.

**Deviations:** none from the plan. (One self-inflicted parse error during authoring: the `stripComments` JSDoc originally contained a literal `*/` in the phrase "Remove `/* … */`", which terminated the comment early and broke the oxc transform; reworded the docstring to avoid the `*/` sequence. Not a plan deviation — the guard's logic is unchanged.)

**Risk note (for a future review):** `stripComments`'s regex sweep is safe *because* no current `src/` string/template literal contains a `//` or `/*` marker. If a future story adds a URL (`://`) or a comment-marker inside a string literal, the sweep could over-strip (a false-negative in the import scan) or corrupt the scanned text (false-positives in the float scan). The guard's self-test cases pin the *current* behavior; a URL-in-a-string would not be caught until it actually breaks a scan. Acceptable for a test-only standing guard — the fix on drift is in the offending source, not by weakening this file.

## Plan Change Log

(empty)

## Review Triage Log

(empty)

## Design Notes

**Scanner design (the load-bearing decision).** Both scans run on **comment-stripped** source, so prose never false-positives. `stripComments` removes block `/*…*/` and line `//` comments; the ledger has no `//` or `/* */` inside string literals, so a regex sweep is safe here. The big.js scan then matches the import-specifier form `(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']big\.js["']` across all of `src/` and asserts the offender set equals exactly `{ledger/fee.ts, ledger/display.ts}` (relative paths). `declare module 'big.js'` in the shim contains none of those prefixes, so it never matches.

**Float scan patterns** (comment-stripped, `src/ledger/*.ts`, excl `*.d.ts`): `\bnumber\b` (the primitive type; `\b` stops it matching camelCase ids like `someNumber`), `\bNumber\(`, `\bMath\.`, `[0-9]+\.[0-9]+` (float literal), `[0-9]+[eE][+-]?[0-9]+` (exponential). Current ledger code matches none — verified. Scope is the ledger only: the store's `Number(b.slot)` is a slot index, not money.

**JSON row.** `toJson` maps each balance to a decimal-string of base units, so `JSON.stringify(toJson(m))` cannot hit the BigInt serialization `TypeError`. The test pins: (1) no throw, (2) `JSON.parse` deep-equals `toJson(m)`, (3) every value matches `/^\d+$/`. Deterministic set (0, 1, a mid value, `10n**30n`-scale) plus a `fc.bigInt` property for breadth.

## Verification

**Commands:**
- `corepack pnpm test` -- expected: green, existing 88 + new guard cases pass.
- `corepack pnpm typecheck` -- expected: clean.
- `corepack pnpm build` -- expected: clean, proto regen byte-identical (no source touched, but confirm no accidental drift).

**Manual checks (if no CLI):**
- Temporarily add a comment `// import Big from 'big.js'` to `ledger.ts` and confirm BIG_JS_ONLY_BOUNDARY still passes (comment not flagged); then add a real import and confirm it fails. Revert.
