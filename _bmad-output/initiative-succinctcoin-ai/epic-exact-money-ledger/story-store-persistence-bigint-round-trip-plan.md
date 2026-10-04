---
title: 'Store persistence + BigInt round-trip'
type: 'feature'
ticket: 3
created: '2026-10-04'
status: 'built'
baseline_revision: '89caef2ad4bdf9c2c63efbfeac986a8cbeebdbef'
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

**Problem:** Ledger amounts are not persisted anywhere: E1 (AD-5) requires persisted amounts as decimal strings with a property-proven round-trip of random BigInts up to 10³⁰, and the store today holds only canonical block bytes — a restart would lose every balance, and nothing rejects float/int64 amount encodings.

**Approach:** Add a balance-state **snapshot** to the store — `saveState`/`loadState` persisting a canonical JSON document of identity→decimal-base-unit-string, atomically under the existing exclusive lock — plus the ledger's inverse decoder `fromJson`, and prove it: a fast-check property test round-trips random BigInt balances (≤ 10³⁰) through save → close → reopen → load with no precision loss, and float/int64 amount encodings are rejected on the decode side.

## Boundaries & Constraints

**Always:**
- Persisted amounts are decimal strings: the on-disk document is a JSON object of identity → plain decimal base-unit string. Raw `BigInt` never reaches JSON (AD-5), and a JSON *number* (float/int64 "column") can never represent an amount.
- The snapshot is written canonically (sorted keys) and atomically (tmp + fsync + rename, same as block files) under the existing exclusive lock — one writer, no torn file (AD-9).
- The decode side validates, the persist side stays faithful (storage-agnostic): the store rejects a malformed document *shape* (`SC-STORE-3`); the ledger rejects a malformed base-unit *value* (`SC-LEDGER-4`).
- The snapshot mechanism is the store's; WHEN it is called belongs to the caller (epic 3's `applyBlock`). No boot wiring in this story.

**Never:**
- No `applyBlock`/consensus (epic 3), no boot wiring (`start()` does not load state), no reward credit, no fee logic.
- No replay mechanism (decision: snapshot — Design Notes); no new dependencies; no second on-disk engine (same directory, same lock, same atomic-write path).
- No change to the block path: `commit`/`getBlock`/`headSlot` unchanged.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SNAPSHOT_ROUNDTRIP | random `BalanceMap` (fast-check BigInts 0 … 10³⁰) → `toJson` → `saveState` → `close` → `open` → `loadState` → `fromJson` | deep-equal to the original; the on-disk file is plain decimal (no `e+`/`e-`, no JSON numbers) | — |
| FLOAT_INT64_REJECT | a raw state file containing JSON-number amounts (`{"a":1.5}`, `{"a":123}`) | `loadState` rejects the document | the reject IS the expected behavior — `SC-STORE-3` |
| BASE_UNIT_REJECT | `fromJson` on values `"1.5"`, `"1e8"`, `"12a"`, `""`, `"-5"` | throws (non-plain-decimal, or negative, base-unit string) | the reject IS the expected behavior — `SC-LEDGER-4` |
| CANONICAL_BYTES | the same record saved with two different key orders | byte-identical documents (deterministic) | — |
| ABSENT_VS_EMPTY | fresh store; then `saveState(toJson(empty map))` | `loadState` → `null` (no snapshot yet); then → `{}` (empty chain state) | — |

</frozen-after-approval>

## Code Map

- `packages/core/src/ports.ts` — `StorePort` gains `saveState(doc: Record<string, string>): Promise<void>` and `loadState(): Promise<Record<string, string> | null>` (typed as the canonical balance-state snapshot; `SC-STORE-3` on malformed document). The port stays storage-agnostic — it knows "identity → decimal string", not `BalanceMap`.
- `packages/core/src/store/file-chain-store.ts` — implement both: new `state/` subdir (mkdir'd at `open()`), `state/balances.json`, canonical serialization (keys sorted), reuse `atomicWrite`; load: `ENOENT` → `null`, parse + shape check (plain object, every value a string) → otherwise `SC-STORE-3` (this is where float/int64 JSON-number "columns" die). `StoreError.code` union gains `'SC-STORE-3'`. Block path untouched.
- `packages/core/src/ledger/ledger.ts` — `fromJson(doc: Record<string, string>): BalanceMap` — the `toJson` inverse: each value against a plain non-negative decimal-integer grammar → `BigInt`; violations throw the new `SC-LEDGER-4` (state-decode boundary; a persisted balance is by invariant ≥ 0, so a negative string is corruption, not data). `LedgerError.code` union gains `'SC-LEDGER-4'`.
- `packages/core/src/ledger/index.ts` + `packages/core/src/index.ts` — re-export `fromJson`.
- `packages/core/test/store-state.test.ts` — **new.** The five matrix rows. SNAPSHOT_ROUNDTRIP is a fast-check property (BigInt arbitrary 0 … 10³⁰ — `fc.bigInt`, or a documented equivalent if the installed 4.10.2 lacks it) against `FileChainStore` in a temp dir, with a real `close()`/`open()` between save and load.
- `packages/core/test/ledger.test.ts` — the NO_MUTATOR export enumeration gains `fromJson` (forced by the re-export; same pattern as 2.2's `computeFee`).
- Unchanged: `display.ts`, `fee.ts`, `big-js.d.ts`, `config/`, `proto/`, `events/`, all other tests (66).

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/ports.ts` — `StorePort` + `saveState`/`loadState`.
- [ ] `packages/core/src/store/file-chain-store.ts` — snapshot file, canonical bytes, `SC-STORE-3` shape guard.
- [ ] `packages/core/src/ledger/ledger.ts` (+ both index re-exports) — `fromJson` + `SC-LEDGER-4`.
- [ ] `packages/core/test/store-state.test.ts` — the five matrix rows (round-trip property ≤ 10³⁰).
- [ ] `packages/core/test/ledger.test.ts` — NO_MUTATOR enumeration + `fromJson`.

**Acceptance Criteria:**
- Given a random `BalanceMap` with amounts up to 10³⁰ base units, when it is snapshotted (`toJson` → `saveState`) and reloaded after a store close/reopen (`loadState` → `fromJson`), then it equals the original with no precision loss.
- Given a persisted state document with a float or int64 (JSON-number) amount encoding, when `loadState` runs, then it is rejected — a float/int64 amount column can never be read back.

## Design Notes

- **Snapshot, not replay (the ticket's `unknown`, settled).** (1) Replay needs the block→transfers projection = `applyBlock` — epic 3, does not exist yet; (2) AD-9 makes the store the *owner* of on-disk state — replay-derived balances would demote it to a cache of block bytes; (3) the ticket description says "persists ledger amounts as decimal strings through the store". A checkpoint-then-replay hybrid is a later optimization (epic 3/4) that this mechanism leaves open: blocks are already persisted per slot.
- **Canonical document = sorted keys + `JSON.stringify`.** Byte-identity is the store's ethos (1.5); sorted keys make the snapshot byte-stable regardless of `Map` iteration order. `JSON.stringify` cannot fail or drift here — the values are plain decimal *strings* (BigInts never reach JSON, AD-5).
- **Decode side validates, persist side is faithful.** `saveState` persists whatever string record it is given (storage-agnostic — it does not know base-unit semantics; the ledger's `toJson` is the only producer and never emits a bad value). `loadState` guards the document *shape* (object of string→string; a JSON number — the float/int64 "column" — is a shape violation → `SC-STORE-3`). `fromJson` guards the value *semantics* (plain non-negative decimal integers → `SC-LEDGER-4`).
- **New codes, one per boundary.** `SC-STORE-3` (malformed state document) and `SC-LEDGER-4` (state-decode boundary) follow the established N-code pattern (1.5's `SC-STORE-1/2`, 2.1/2.2's `SC-LEDGER-1..3`) — a boot path or caller handling "corrupt on-disk state" must not be conflated with "invariant failed" or "bad display string".
- **Absent vs empty.** `loadState` → `null` means "no snapshot yet" (fresh chain); `{}` means "state exists, all balances zero". Epic 3's boot path distinguishes them.
- **No boot wiring.** `start()` still just opens the store; loading state into the ledger is epic 3's boot path (consistent with the 1.6 deferral of `loadGenesis`-at-boot).

## Verification

**Commands:**
- `corepack pnpm test` — expected: exit 0; the new store-state rows (incl. the round-trip property) pass; existing suite (66) green.
- `corepack pnpm typecheck` — expected: exit 0 (strict).
- `corepack pnpm build` — expected: exit 0 (protons regen byte-identical; `dist/store/` + `dist/ledger/` re-emitted).

## Implementation Notes

**2026-10-04 — built against baseline `89caef2`.**

Verification results (all run with `corepack pnpm` from the repo root):
- `corepack pnpm test` — exit 0: **83/83 tests, 11 files** (existing 66 green; 17 new — `store-state.test.ts` adds 14 `it`s (round-trip property, 10³⁰ boundary, 3× float/int64 `it.each`, non-object doc, 5× `BASE_UNIT_REJECT` `it.each`, accept-case, canonical bytes, absent-vs-empty), `ledger.test.ts` adds a FROM_JSON block with 3 `it`s; the NO_MUTATOR enumeration is an existing `it` that now lists `fromJson`).
- `corepack pnpm typecheck` — exit 0 (strict).
- `corepack pnpm build` — exit 0: protons regen byte-identical (`git status` clean for `src/proto/`); `dist/store/` + `dist/ledger/` re-emitted with the new surface.

Implementation decisions:
- **`fc.hexaString` does not exist in fast-check 4.10.2** (removed in v4; probe-verified via `typeof fc.hexaString === 'undefined'`). The round-trip property uses `fc.string()` for identity ids — the plan's "documented equivalent" allowance. Identity-id format is not validated by the seam (protocol rules are consensus' job, AD-2), so arbitrary strings are faithful to the ledger's contract. `fc.bigInt({min: 0n, max: 10n**30n})` used as the plan specified (probe-verified to exist and sample).
- **`fc.asyncProperty`** is the correct wrapper for the async round-trip body (the store does real I/O); `fc.property` + `fc.assert` would type-error on the `Promise<void>` body.
- **Canonical serialization** is a small hand-rolled `canonicalJson` (sorted `Object.keys`, `JSON.stringify` per key/value, `{...}` join) rather than `JSON.stringify(doc)` with a replacer — `JSON.stringify` preserves *insertion* order for string keys, so a replacer cannot sort; explicit sort is what makes CANONICAL_BYTES byte-stable. Output is identical to `JSON.stringify` on an already-sorted object (verified by the byte-identity test).
- **`loadState` shape guard** (`assertStateDocument`): rejects `null`, arrays, and any non-string value with `SC-STORE-3` — this is where JSON-number (float/int64) amounts die, per the design note "decode side validates, persist side stays faithful." Invalid JSON text (unparseable file) is also `SC-STORE-3` ("state document … is not valid JSON") — a corrupt file is a malformed document, the same boundary.
- **`fromJson` grammar** is `/^\d+$/` (plain non-negative decimal integer, no leading-sign ambiguity): rejects `"1.5"`, `"1e8"`, `"12a"`, `""`, `"-5"` → `SC-LEDGER-4`, exactly the BASE_UNIT_REJECT row. A negative persisted balance is corruption by invariant (a persisted balance is ≥ 0), matching the plan's rationale.
- **Not-open guard**: `saveState`/`loadState` on a closed store throw `SC-STORE-2` (same pattern as `commit`/`getBlock`) — not a new code; "not open" is a programming error, not a document-shape error.
- **Test-fake updates (forced, not in the plan's Code Map)**: adding two required methods to `StorePort` breaks every `CorePorts` fake at the type level — `test/ports.test.ts` and `test/core-surface.test.ts` fakes gained `saveState`/`loadState` stubs. No other file implements `StorePort` (only `FileChainStore`; `src/events/types.ts` references the store only in prose).
- **No boot wiring** (frozen): `start()` still just opens the store; `loadState`/`saveState` are exercised directly by tests, exactly as the plan's ABSENT_VS_EMPTY and SNAPSHOT_ROUNDTRIP rows require.

## Plan Change Log

## Review Triage Log

- **false — rejected (lens miscounted; the Implementation Notes are correct)** — Quick lens returned no code findings and one "cosmetic" note claiming the Implementation Notes' test-count arithmetic is off: it asserted `store-state.test.ts` "adds 14 `it`s" should be "11 `it`/`it.each` blocks (expanding to 11 test cases)" and that "66 + 11 + 3 = 80, not the 83 actually run, since the pre-existing suite is 69, not 66". Refuted by direct count: `store-state.test.ts` defines 8 `it`/`it.each` blocks (6 plain `it` + 2 `it.each`) expanding to **14** test cases (6 + a 3-entry `it.each` + a 5-entry `it.each`); the pre-existing suite was **66** (confirmed at the 2.2 build), not 69; and **66 + 14 (store-state) + 3 (FROM_JSON) = 83**, exactly the observed run. The lens conflated "blocks" with "cases" and used the wrong baseline. The notes are accurate; no change made.
- **Code: no findings** — the Quick lens independently re-ran the verification (83/83, typecheck, build) and found no unmet acceptance criteria, no broken AD-2/AD-5/AD-9/AD-10 rules, and no bugs (it also confirmed the `__proto__`/inherited-property edge is handled and the block path is byte-for-byte untouched). The forced test-fake stubs (`ports.test.ts`/`core-surface.test.ts`) are disclosed in the Implementation Notes and are unavoidable (two required `StorePort` methods break every `CorePorts` fake at the type level).
