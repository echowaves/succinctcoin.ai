---
title: 'Tracer: slot loop + PoW hot path + applyBlock (one block)'
type: 'feature'
ticket: '2'
created: '2026-10-05'
status: 'built'
route: 'full'
route_source: 'auto'
baseline_revision: 'c46895073ee6883b8acfd19d7f0222f8c81da97f'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md'
  - 'packages/core/src/consensus/pow.ts'
  - 'packages/core/src/ledger/ledger.ts'
  - 'packages/core/src/store/file-chain-store.ts'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No consensus loop exists — a single node cannot produce, persist, and reload one valid block. The PoW seam (3.1) and ledger seam (2.x) exist but are not wired into a chain-time slot loop + `applyBlock`.

**Approach:** Stand up `core/consensus` on the thinnest path: a chain-time slot loop that derives the next slot from the store head (R4), a per-attempt PoW hot path (`node:crypto` sha256 + integer counter, the 3.1 target; R3), and `applyBlock` (R5) that commits the block through the store and credits the fixed-emission reward through the ledger — so a single node produces and persists one block that survives a close/open reload.

## Boundaries & Constraints

**Always:**
- Per-attempt mining uses ONLY `node:crypto` sha256 + an integer counter (via 3.1's `powCheck`/`blockDigest`); no `big.js`, no pure-JS keccak in the mining path (AD-6).
- Every protocol decision (next slot, parent hash) uses chain time — the store's persisted head — never the wall clock (AD-3).
- `applyBlock` is the single mutation path (AD-2): it credits the reward through the ledger `apply` seam AND persists the block + balance snapshot through the store.

**Never:**
- No draw / ticket verification (3.3/3.4) — the tracer uses a trivial fixed single-node winner + an empty placeholder ticket, replaced by the draw later.
- No real economic model (3.6) — the reward credit is a fixed-emission credit (a pre-funded mint/treasury), refined later.
- No `createCore().start()` wiring (3.5) — the tracer is standalone functions, not wired into the core lifecycle yet.
- No retargeting — the 3.1 fixed target is consumed, not re-derived.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| MINE_BLOCK (R3) | a block template (slot, parent, winner, empty ticket, txCount 0) | `mineBlock` returns a block whose counter (u64be nonce) makes `powCheck` true, and `hash = blockDigest(block)` | No error expected |
| APPLY_REWARD (R5) | a mined block + initial balances (mint pre-funded) | `applyBlock` credits the reward to the winner via `apply` (winner += reward, mint -= reward), commits the block, saves the balance snapshot | No error expected |
| PERSIST_RELOAD (R5) | a committed block + saved balances, then close/open | `getBlock` decodes; the recomputed hash matches the stored hash and `powCheck` is true; `loadState` balances match | No error expected |
| CHAIN_TIME_SLOT (R4) | an empty chain (head -1), then a non-empty chain | empty → slot 0 + parent = 32 zero bytes; non-empty → slot = head+1 + parent = head block's hash — derived from the store, never wall clock | No error expected |

</frozen-after-approval>

## Code Map

- `packages/core/src/consensus/pow.ts` (3.1, READ) — `powCheck(block)`, `blockDigest(block)`, `canonicalBlockBytes`, `POW_TARGET_LEADING_ZERO_BITS`; the counter is the `u64be(nonce)` field. The mining path reuses these (no re-implementation).
- `packages/core/src/ledger/ledger.ts` (2.1, READ) — `apply(balances, transfers): BalanceMap` (two-pass atomic no-negative; NO mint path — an unfunded debit fails `SC-LEDGER-1`), `balanceOf`, `totalSupply`, `toJson`, `fromJson`. `fromDisplay` (2.1) converts the decimal reward to base units.
- `packages/core/src/store/file-chain-store.ts` (1.5/2.3, READ) — `FileChainStore`: `commit(block)` = `Block.encode`→atomic write+advance head; `getBlock(slot)` = stored WIRE bytes verbatim (or null); `headSlot()` = highest committed slot or -1; `saveState(doc)`/`loadState()`. The store persists the WIRE form; the digest (block hash) is a distinct serialization recomputed from the decoded block.
- `packages/core/src/proto/index.ts` (1.4, READ) — the `Block` codec namespace (`Block.decode`/`encode`) + `Block` type.
- `packages/core/src/consensus/miner.ts` — NEW: `mineBlock(template)` (R3 hot path) + `MINT_ID`/`TRACER_WINNER_ID` constants.
- `packages/core/src/consensus/apply-block.ts` — NEW: `applyBlock({store, block, balances, rewardBaseUnits, mintId})` (R5 single mutation path).
- `packages/core/src/consensus/slot-loop.ts` — NEW: `nextSlotAndParent(store)` (R4 chain-time) + `mineAndApply(...)` (the end-to-end tracer, one block).
- `packages/core/src/consensus/index.ts` — additive re-export of the new surface.
- `packages/core/src/index.ts` — additive re-export (createCore untouched).
- `packages/core/test/consensus-tracer.test.ts` — NEW: matrix rows + the per-attempt-path guard.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/consensus/miner.ts` — `mineBlock`: iterate the integer counter, set the u64be nonce field, stop when `powCheck` is true, set `hash = blockDigest`; export `MINT_ID` (reserved mint) + `TRACER_WINNER_ID` (the trivial fixed winner).
- [x] `packages/core/src/consensus/apply-block.ts` — `applyBlock`: credit the reward via `apply` (mint → winner), `store.commit(block)`, `store.saveState(toJson(newBalances))`, return new balances.
- [x] `packages/core/src/consensus/slot-loop.ts` — `nextSlotAndParent` (head -1 → slot 0 + 32 zero bytes; else head+1 + decoded head hash) + `mineAndApply` (load balances [absent → mint pre-funded with maxSupply], derive slot, `mineBlock`, `applyBlock`, return the block).
- [x] `packages/core/src/consensus/index.ts` + `src/index.ts` — additive re-exports (createCore untouched).
- [x] `packages/core/test/consensus-tracer.test.ts` — MINE_BLOCK, APPLY_REWARD, PERSIST_RELOAD (real `FileChainStore` close/open in a temp dir), CHAIN_TIME_SLOT; + a guard that the mining path (miner.ts) imports no big.js/keccak.

**Acceptance Criteria:**
- Given a mined block, when its canonical encoding is re-hashed, then the digest equals the stored `hash` and `powCheck` is true (Done-when #5).
- Given the tracer's fixed-emission credit, when a block is applied, then the winner's balance increases by the reward through the ledger `apply` seam (no new mint path) and `totalSupply` is unchanged (closed system).
- Given the mining loop, when it increments the counter, then the per-attempt path references only `node:crypto` sha256 + the counter (no `big.js`, no keccak).

## Implementation Notes

- **Delivered (R3/R4/R5, one block):** `src/consensus/miner.ts` — `mineBlock(template)` (the R3 per-attempt hot path: iterate a plain integer counter, set the u64be `nonce` field, `powCheck` per attempt via the 3.1 seam, set `hash = blockDigest` ONLY on success — a `Uint8Array.from` bridge there is a one-per-successful-block copy, never per-attempt, so AD-6's hot path is intact; `MAX_COUNTER` = 2^32 liveness guard; `MINT_ID` (reserved treasury) + `TRACER_WINNER_ID` (trivial fixed winner) exported). `src/consensus/apply-block.ts` — `applyBlock({store, block, balances, rewardBaseUnits, mintId})`: order = ledger `apply` (mint → winner, closed system, no mint path; an unfunded reward throws `SC-LEDGER-1` BEFORE commit) → `store.commit(block)` → `store.saveState(toJson(newBalances))`. `src/consensus/slot-loop.ts` — `nextSlotAndParent(store)` (empty → slot 0 + 32 zero bytes; else head+1 + decoded head `hash`; chain-time, never wall clock) + `mineAndApply({store, rewardDisplay, maxSupplyDisplay})` (load snapshot [absent → pre-fund `MINT_ID` with `maxSupply`], derive slot, `mineBlock` with empty placeholder ticket + txCount 0, `applyBlock`, return `{block, balances}`; the one-time `fromDisplay` conversions are OUTSIDE the per-attempt loop).
- **Standalone:** the tracer is standalone functions (store + params in, block + balances out); `createCore` untouched (3.5 wires it in).
- **Test:** `test/consensus-tracer.test.ts` — MINE_BLOCK (counter → u64be nonce, powCheck true, hash = blockDigest; mining twice), APPLY_REWARD (winner += reward, mint -= reward, totalSupply unchanged; block committed byte-identical; snapshot saved; + the unfunded-reward SC-LEDGER-1 ordering case — nothing committed), PERSIST_RELOAD (real `FileChainStore` close/open in a temp dir: block re-decodes, recomputed hash matches, powCheck true, balances match; + a second-block chain-extension case), CHAIN_TIME_SLOT (empty/non-empty), + MINING_PATH_GUARD (comment-stripped import scan of miner.ts for big.js/keccak, prose-vs-import self-test). 12 tests.
- **Verification:** `corepack pnpm test` 116/116 (15 files, +12 consensus-tracer), `typecheck` clean, `build` clean + protons byte-identical (no proto change). **Matrix audit:** all 4 frozen rows (MINE_BLOCK / APPLY_REWARD / PERSIST_RELOAD / CHAIN_TIME_SLOT) covered by passing tests.

## Plan Change Log

- (2026-10-05, step-04 quick lens) — finding 2: `miner.ts` + `slot-loop.ts` threw plain `new Error(...)` for two failure classes (a no-counter-below-cap liveness failure; a corrupt-store head), breaking the spine's error-code convention (`{ code: 'SC-<DOMAIN>-<n>', message }`) that every sibling module follows (`PowError`/`LedgerError`/`StoreError`/`GenesisConfigError`). Root cause outside the frozen block → amended the NON-FROZEN production code to attach `code = 'SC-CONSENSUS-1'` to those two `Error`s (mirroring the package's existing `notImplemented` pattern — no new public error class, no new surface). Known-bad state avoided: 3.5's boot-path caller special-casing `SC-` codes (the `SC-STORE-1` "directory in use" precedent) cannot distinguish these from generic throws. KEEP: the exact throw messages + the ledger-first ordering in `applyBlock`. No behavior change beyond the code; re-verified 116/116.

## Review Triage Log

- **Quick lens, pass 1 — 4 findings (2 patched [medium/low], 2 rejected [false/low]):**
  1. Plan file `status`/checkboxes not updated + diff from a stale snapshot. **Verdict: false** — orchestrator-owned bookkeeping (status/checkboxes are set by the orchestrator at step-05, not the implementer per the handoff guardrail); the "stale snapshot" is a step-03/04 workflow artifact (the diff was cut before the plan's status advanced). Not a code defect. No patch.
  2. Bare `new Error(...)` at `miner.ts:112` + `slot-loop.ts:48` break the spine's `SC-<DOMAIN>-<n>` error-code convention (every sibling module uses coded errors; 3.5 will special-case SC- codes). **Verdict: medium** (verified: grep shows the only bare `new Error` in the new files; siblings are `PowError`/`LedgerError`/`StoreError`/`GenesisConfigError`). **Route: patch** — attached `code = 'SC-CONSENSUS-1'` to both (mirrors `notImplemented` in `src/index.ts`; no new public class/surface).
  3. Unused `Block as BlockType` import in `test/consensus-tracer.test.ts:51` (appears only on the import line). **Verdict: low** (verified: grep shows the single occurrence). **Route: patch** — removed from the type import (now `import type { BalanceMap }`).
  4. `mineAndApply` hard-fails (`SC-LEDGER-1`) on any non-null snapshot lacking `MINT_ID`. **Verdict: low / reject** — verified: the tracer's flow always carries `MINT_ID` (the first run pre-funds it; every subsequent snapshot includes it, proven by the second-block + existing-snapshot tests), so the `MINT_ID`-less state is unreachable in this tracer; the fix would add a guard for a state the tracer never produces, outside the plan's scope. No patch.

## Design Notes

- **Trivial winner (replaced by 3.3):** `TRACER_WINNER_ID` is a fixed constant; the loop mines for it with an EMPTY placeholder ticket. No draw/ticket verification — 3.3's `drawWindow` + 3.4's verification replace this.
- **Chain-time slot (R4):** next slot = store `headSlot()` + 1 (empty → 0); parent = the head block's stored `hash` (empty → 32 zero bytes). Derived from the persisted chain state, never the wall clock.
- **Fixed-emission reward credit (R5, refined by 3.6):** the ledger `apply` has NO mint path (2.1: an unfunded debit fails `SC-LEDGER-1`), so the tracer pre-funds a reserved mint (`MINT_ID`) with `maxSupply` and credits each block's reward as an ordinary `apply` transfer `MINT_ID → winner`. This is a closed-system treasury (totalSupply stays `maxSupply`); 3.6 refines the economic model (initial allocation, burn-vs-credit for fees, real fee rate).
- **Per-attempt path (R3):** `mineBlock` increments the counter and calls `powCheck` (→ `blockDigest` → `canonicalBlockBytes` → `node:crypto` sha256) per value; the counter is the u64be nonce field (3.1). `big.js` is used ONLY for the one-time reward display (`fromDisplay`), outside the per-attempt loop.
- **Standalone (not wired into createCore):** the tracer is standalone functions (store + params in, block + balances out). 3.5 wires it into the real boot path.

## Verification

**Commands:**
- `corepack pnpm test` -- expected: all prior + the new consensus-tracer matrix green.
- `corepack pnpm typecheck` -- expected: clean.
- `corepack pnpm build` -- expected: clean, protons regen byte-identical (no proto change).
