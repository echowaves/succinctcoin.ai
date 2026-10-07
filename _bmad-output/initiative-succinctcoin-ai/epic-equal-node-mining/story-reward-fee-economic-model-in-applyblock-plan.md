---
title: 'Reward + fee economic model in applyBlock'
type: 'feature'
ticket: '6'
created: '2026-10-06'
status: 'built'
route: 'full'
route_source: 'pinned'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
baseline_revision: '67bd3ca23dfcfa9b32d86cc2b33e7a564da23201'
context:
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/ledger/fee.ts
  - packages/core/src/ledger/ledger.ts
  - packages/core/src/ledger/index.ts
  - packages/core/src/consensus/miner.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/test/conservation.test.ts
  - packages/core/test/consensus-tracer.test.ts
  - config/genesis.json
  - _bmad-output/initiative-succinctcoin-ai/epic-equal-node-mining/epic-equal-node-mining.md
---

## Intent

**Problem:** `applyBlock` (3.2) credits a fixed-emission reward but has NO economic model — no fee computation, no fee destination, and the initial-allocation / burn-vs-credit / fee-rate-provenance decisions are all unsettled. The 2.4 conservation property test assumed a closed system with fees burned to a receive-only identity, but that was never made concrete in `applyBlock` (the tracer mines 0-tx blocks, and the fee rate was a test-local constant).

**Approach:** Settle the three economic/protocol decisions (recorded in the epic Notes) and implement them in `applyBlock`: (1) **fee destination = BURN** — each tx's fee is computed at the 2.2 fee boundary (`computeFee(amount, FEE_RATE)`) and transferred to a reserved receive-only `BURN_ID` (the ledger `apply` seam has NO destroy path — 2.1 — so "burn" = a neutral receive-only account, exactly the 2.4 conservation model; `totalSupply` is conserved under a running miner); (2) **fee-rate provenance = a named protocol constant** `FEE_RATE` (one named origin — NOT a genesis field, which inception deferred as a protocol change that would collide with epic 4's genesis edits); (3) **initial allocation = the closed-system treasury** (the `MINT_ID` pre-funded with `maxSupply`; the reward is a within-supply transfer `MINT_ID → winner`). `applyBlock` gains an optional fee-bearing `txs` view (the proto `Block` carries only `txCount`, not a tx payload, so the txs are an in-memory view the ledger math consumes); the single `apply` call is atomic (AD-2). The tracer's `mineAndApply` stays txCount-0 (carrying real txs through the loop is epic 5's ledger path), so 3.2/3.5 pins are untouched.

## Boundaries & Constraints

**Always:**
- The fee is computed at the **2.2 fee boundary** — `computeFee(amount, FEE_RATE)` (in `src/ledger/fee.ts`, the one big.js file) — exactly once per tx, then moved through the `apply` seam as an ordinary base-unit transfer. `apply-block.ts` calls `computeFee` (imported from `../ledger/index.js`); it does NOT import `big.js` (the 2.5 `BIG_JS_ONLY_BOUNDARY` guard pins the `big.js` import SPECIFIER to `ledger/display.ts` + `ledger/fee.ts` — importing `computeFee` from the ledger barrel does not add a `big.js` specifier).
- `totalSupply` (sum over ALL identities, **including** `BURN_ID`) is **CONSERVED** under a sequence of mined blocks: the reward (`MINT_ID → winner`) and each fee (`sender → BURN_ID`) are both within-supply transfers, so `totalSupply` is invariant at every step (the 2.4 `CONSERVATION_SUPPLY` invariant, made concrete with a real reward credit). Circulating supply (excl. mint + burn) changes by exactly `+Σ rewards − Σ fees` (the reward flows FROM the excluded treasury TO the circulating winner; only fees leave circulation).
- The fee destination is **BURN** (to `BURN_ID`), NOT credited to the winner: the winner receives ONLY the block reward (never reward + fees). `BURN_ID` is a reserved 32-byte-hex id that only receives (distinct from `MINT_ID` = …001 and `TRACER_WINNER_ID` = …002).
- `FEE_RATE` is a **named protocol constant** (one named origin) in a new `src/consensus/economics.ts` — a plain-decimal string in [0,1) (the 2.2 fee-boundary form), NOT a genesis field and NOT an inline test constant. A change to it is a protocol version bump.
- The whole block (reward + all tx value transfers + all tx fees) goes through ONE `apply` call (AD-2 single mutation path, atomic): an over-draw throws `SC-LEDGER-1` BEFORE `store.commit`/`saveState` (the existing ordering: ledger first, then commit, then snapshot).
- `applyBlock`'s change is BACKWARD-COMPATIBLE: `txs` is OPTIONAL (default `[]`). A 0-tx block (the tracer path) behaves exactly as 3.2/3.5 (reward credit only, no fee, `totalSupply` conserved) — the `consensus-tracer` + `boot-path` suites must stay green UNCHANGED.

**Never:**
- Do NOT add a destroy/mint path to the ledger `apply` seam (2.1) — "burn" is a transfer to a receive-only account, never a supply destruction.
- Do NOT touch `mineBlock`, `BlockTemplate`, `MINT_ID`, `TRACER_WINNER_ID`, `powCheck`, `drawWindow`, `verifyDraw`, `mineAndApply`'s single-node flow, or the 3.1/3.2/3.3/3.4/3.5 pins — `mineAndApply` keeps mining 0-tx blocks (real-tx carrying is epic 5's ledger path).
- Do NOT modify `config/genesis.json` (a genesis fee field is a protocol change — inception deferred it; `FEE_RATE` is a named constant instead).
- Do NOT import `big.js` into `src/consensus/**` (the 2.5 `BIG_JS_ONLY_BOUNDARY` guard) — call `computeFee` from the ledger boundary instead.
- Do NOT add a new dependency or a second toolchain (spine Stack).
- Do NOT change the `apply`/`computeFee`/`toJson`/`fromJson` ledger signatures (the seam is 2.1–2.4's contract).
- Do NOT credit fees to the winner (that couples the mining reward to network traffic and distorts uptime-only R1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| REWARD_CREDIT | a block + `rewardBaseUnits` R + NO txs; balances pre-funded (treasury `MINT_ID` funded) | the winner's balance += R; `MINT_ID` −= R; `totalSupply` conserved (unchanged) | No error expected |
| FEE_COMPUTED_AT_BOUNDARY | a block + one tx `{from: S, to: R2, amount: A}` (S funded); `FEE_RATE` named constant | `BURN_ID` += `computeFee(A, FEE_RATE)` EXACTLY (the 2.2 boundary output — assert equality with an independent `computeFee(A, FEE_RATE)` call); the recipient += A (NOT A−fee); the sender −= (A + fee); `totalSupply` conserved | No error expected |
| FEE_BURNED_DESTINATION | a block + a tx with a non-zero fee | the fee lands in `BURN_ID` (burn), NOT in the winner: `BURN_ID` = Σ fees; the winner's balance = the block reward ONLY (not reward + fees) | No error expected |
| TOTAL_SUPPLY_CONSERVED_SEQUENCE | a SEQUENCE of N mined blocks, each with ≥1 tx (senders funded) | at EVERY step `totalSupply` === the initial total supply (conserved); `BURN_ID` === Σ fees over the whole sequence; the winner === Σ rewards; circulating (excl. mint + burn) === initial + Σ rewards − Σ fees (the reward flows from the excluded treasury into circulation; only fees leave it) | No error expected (asserted at each step) |
| FEE_RATE_NAMED_ORIGIN | the fee computation path | the rate used is the imported `FEE_RATE` named constant (one named origin) — NOT an inline test constant; `computeFee(amount, FEE_RATE)` is the fee | No error expected |
| NO_TXS_NO_FEE (backward compat) | a 0-tx block (the tracer path) + a reward | behaves exactly as 3.2/3.5: reward credit only, no fee, `BURN_ID` untouched, `totalSupply` conserved | No error expected |
| OVERDRAW_REJECTS | a tx whose `amount + fee` exceeds the sender's balance | `apply` throws `SC-LEDGER-1` BEFORE `store.commit`/`saveState`; the chain + snapshot are untouched (atomic) | `SC-LEDGER-1` |

## Code Map

- `packages/core/src/consensus/economics.ts` -- NEW: the economic-model constants — `FEE_RATE` (named protocol constant, plain-decimal string in [0,1), one named origin) + `BURN_ID` (reserved 32-byte-hex receive-only burn identity, distinct from `MINT_ID` …001 / `TRACER_WINNER_ID` …002). Mirrors `pow.ts` (which holds `POW_TARGET_LEADING_ZERO_BITS`).
- `packages/core/src/consensus/apply-block.ts` -- ADD an optional `txs?: ReadonlyArray<BlockTx>` to `ApplyBlockParams` + a new `BlockTx {from: string; to: string; amount: bigint}` type; build the FULL atomic transfer set (reward + each tx's value transfer + each tx's fee `computeFee(amount, FEE_RATE)` burned to `BURN_ID`) and run ONE `apply`. Import `computeFee` (ledger boundary) + `FEE_RATE`/`BURN_ID` (economics). Backward-compatible (`txs` default `[]`).
- `packages/core/src/consensus/index.ts` -- ADD `FEE_RATE`, `BURN_ID` to the value re-export + `BlockTx` to the type re-export (additive).
- `packages/core/src/index.ts` -- ADD `FEE_RATE`, `BURN_ID` to the consensus value re-export + `BlockTx` to the type re-export (additive; the root barrel is where every test imports from).
- `packages/core/test/consensus-economics.test.ts` -- NEW: the 7 matrix rows (a fake no-op `StorePort` for the simple rows; a real `FileChainStore` for the `TOTAL_SUPPLY_CONSERVED_SEQUENCE` row to prove the full `commit`+`saveState` path; blocks constructed directly with valid field types — `applyBlock` does not re-check PoW). Imports from the root barrel only.
- `_bmad-output/initiative-succinctcoin-ai/epic-equal-node-mining/epic-equal-node-mining.md` -- Notes: record the three Decisions (burn-vs-credit = BURN; fee-rate = named constant `FEE_RATE`, genesis field deferred; initial allocation = closed-system treasury) as dated Decision entries (matching the existing `- Decision:` style).
- `packages/core/src/ledger/*`, `src/consensus/miner.ts`, `slot-loop.ts`, `pow.ts`, `draw.ts`, `verify-draw.ts`, `config/genesis.json` -- UNTOUCHED.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/consensus/economics.ts` -- NEW module: `export const FEE_RATE = '0.001'` (named protocol constant, plain-decimal string in [0,1), documented as ONE named origin — a genesis field is a protocol change inception deferred) + `export const BURN_ID` (reserved 32-byte-hex receive-only burn identity, 63 zeros + "3", distinct from `MINT_ID`/`TRACER_WINNER_ID`) -- the single home for the economic constants (mirrors `pow.ts`).
- [x] `packages/core/src/consensus/apply-block.ts` -- add `BlockTx {from, to, amount}` + optional `txs` to `ApplyBlockParams`; build the atomic transfer set (reward `mintId→winner` + per-tx `from→to amount` + per-tx `from→BURN_ID computeFee(amount, FEE_RATE)`) and run ONE `apply`; import `computeFee` (ledger) + `FEE_RATE`/`BURN_ID` (economics) -- the economic model the ticket names; atomic + backward-compatible.
- [x] `packages/core/src/consensus/index.ts` + `packages/core/src/index.ts` -- re-export `FEE_RATE`, `BURN_ID` (values) + `BlockTx` (type) -- the additive surface every test imports from the root barrel.
- [x] `packages/core/test/consensus-economics.test.ts` -- NEW: the 7 matrix rows (REWARD_CREDIT, FEE_COMPUTED_AT_BOUNDARY, FEE_BURNED_DESTINATION, TOTAL_SUPPLY_CONSERVED_SEQUENCE [real `FileChainStore`], FEE_RATE_NAMED_ORIGIN, NO_TXS_NO_FEE, OVERDRAW_REJECTS) -- proves the reward credit, the fee-at-boundary, the burn destination, totalSupply conservation over a sequence, the named fee rate, backward compat, and the atomic over-draw reject.
- [x] `_bmad-output/.../epic-equal-node-mining/epic-equal-node-mining.md` -- Notes: record the three Decisions as dated entries -- closes the ticket's "recorded as Decisions" requirement.

**Acceptance Criteria:**
- Given `applyBlock` with a reward and NO txs, then the winner is credited the reward, `MINT_ID` debited, and `totalSupply` is conserved (the 3.2/3.5 behavior — backward compatible).
- Given `applyBlock` with a fee-bearing tx, then the fee = `computeFee(amount, FEE_RATE)` (the 2.2 boundary) is transferred to `BURN_ID` (burn — NOT the winner), the recipient gets the full amount, the sender loses amount + fee, and `totalSupply` is conserved.
- Given a SEQUENCE of mined blocks each with txs, then `totalSupply` is invariant (conserved) at every step, `BURN_ID` = Σ fees, the winner = Σ rewards, and circulating supply (excl. mint + burn) = initial circulating + Σ rewards − Σ fees (the reward flows from the excluded treasury into circulation; only fees leave it — the 2.4 `CONSERVATION_SUPPLY` invariant with a real reward credit).
- The fee rate is the single named constant `FEE_RATE` (one named origin), not a genesis field or an inline test constant.
- An over-drawing tx throws `SC-LEDGER-1` BEFORE `store.commit`/`saveState` (atomic); the `consensus-tracer` (3.2), `boot-path` (3.5), `no-float-guard` (2.5), and `conservation` (2.4) suites stay green unchanged.

## Implementation Notes

(append-only)

- **2026-10-07 (build, ticket 6) — implemented.** All three Decisions settled in Design Notes, implemented as-is (no re-decision). Files touched:
  - NEW `packages/core/src/consensus/economics.ts` — `FEE_RATE = '0.001'` (named protocol constant, plain-decimal string in [0,1), documented as ONE named origin — genesis field deferred per inception) + `BURN_ID = '0'×63 + '3'` (reserved receive-only burn identity, distinct from `MINT_ID` …001 / `TRACER_WINNER_ID` …002). Mirrors `pow.ts`.
  - `packages/core/src/consensus/apply-block.ts` — added `BlockTx {from,to,amount}` + optional `txs?: ReadonlyArray<BlockTx>` (default `[]`) to `ApplyBlockParams`; `applyBlock` now builds the FULL atomic transfer list (reward `mintId→winner` + per-tx value `tx.from→tx.to amount` + per-tx fee `tx.from→BURN_ID computeFee(amount, FEE_RATE)`) and runs ONE `apply` (AD-2, atomic — over-draw throws `SC-LEDGER-1` before commit/saveState). Imports `computeFee` from `../ledger/index.js` (NOT a big.js specifier) + `FEE_RATE`/`BURN_ID` from `./economics.js`. Module doc rewritten to describe the economic model (burn-not-credit + conservation), keeping the AD-2 ordering prose accurate.
  - `packages/core/src/consensus/index.ts` + `packages/core/src/index.ts` — additive re-exports of `FEE_RATE`/`BURN_ID` (values) + `BlockTx` (type). `createCore`/`start()` untouched.
  - NEW `packages/core/test/consensus-economics.test.ts` — the 7 matrix rows. Fake no-op `StorePort` (records commit/saveState) for the simple rows + the atomic OVERDRAW_REJECTS proof; a REAL `FileChainStore` (temp dir, `close()` in `finally`) for TOTAL_SUPPLY_CONSERVED_SEQUENCE. Blocks built directly (valid field types, `txCount: 0n` — `applyBlock` reads the `txs` VIEW, not `txCount`; no PoW re-check). Imports ONLY from `../src/index.js`.
  - `_bmad-output/.../epic-equal-node-mining/epic-equal-node-mining.md` — appended three dated `Decision: 2026-10-06 (build, ticket 6)` entries (burn-not-credit + why; FEE_RATE named constant + genesis field deferred; initial allocation = closed-system treasury kept).
- **Exact values used:** `FEE_RATE = '0.001'` (0.1%); `BURN_ID = '0000000000000000000000000000000000000000000000000000000000000003'` (63 zeros + "3"). Sequence test: N=25 blocks, senders `SENDER_1 = '0'×60 + '0a0b'`, `SENDER_2 = '0'×60 + '0a0c'` (each funded 10^10 base units), recipient `'0'×60 + '0a0d'`, per-tx `amount = 10_000_000n + 100_000n·i` (i=0..24), reward `fromDisplay('12.5')`, treasury `MINT_ID = fromDisplay('21000000')`. Other rows: FEE_COMPUTED_AT_BOUNDARY amount `1_234_567_890n`; FEE_BURNED_DESTINATION amount `500_000_000n`; FEE_RATE_NAMED_ORIGIN amount `987_654_321n`; OVERDRAW_REJECTS amount `4_000_000n` with sender funded `amount + fee − 2_000n`.
- **Surprises / notes:** none. `applyBlock` consuming the `txs` VIEW (not `block.txCount`) is why the sequence test's blocks keep `txCount: 0n` while still carrying a tx. Backward-compat confirmed: `consensus-tracer`, `boot-path`, `conservation`, `no-float-guard` all green UNCHANGED (30 tests across the 4 suites); the 2.5 `BIG_JS_ONLY_BOUNDARY` guard stays green because `apply-block.ts` imports `computeFee` from the ledger barrel, never a `big.js` specifier.

## Plan Change Log

(append-only; empty until a loopback)

## Review Triage Log

**Quick lens (pass 1, 2026-10-06):** 2 notes — 0 high / 0 medium / 2 low (non-blocking; no bugs, no broken rules, no unmet ACs). All ten scrutinized points (a)–(j) PASS with evidence: fee-at-boundary (once per tx, imported `computeFee`, not inlined), burn-not-credit (fee → `BURN_ID` only; winner = reward exactly), conservation (per-step `totalSupply` invariant + distribution assertions), atomicity (ONE `apply`, ledger first; over-draw leaves the store untouched), backward-compat (`txs` optional; 0-tx = 3.2/3.5; consensus modules untouched), no-big.js (import statements verified; `economics.ts` has no imports), named-origin (`FEE_RATE` single constant, no genesis field), id-collision (64-hex, distinct …001/…002/…003), decisions-recorded (3 dated Notes entries), test-correctness (7 rows map 1:1 to the matrix, no vacuous fee).

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The per-step `totalSupply === initialTotal` line in the sequence test is structurally guaranteed by the pure-transfer `apply` seam (it conserves supply by construction); the discriminating conservation evidence is the distribution assertions (`BURN_ID = Σfees`, `winner = N·reward`, circulating equation), which are present. | low (non-blocking) | defer | No code change — the distribution assertions already carry the conservation proof (they would catch a wrong-destination bug the tautological totalSupply line would not). Consistent with the 2.4 `CONSERVATION_SUPPLY` row's structure. Noted for epic 5's ledger path (real txs) where the seam is less tautological. |
| 2 | The AC/matrix/Always prose "circulating supply (excl. mint + burn) drops by exactly Σ fees" is loose — the reward is a within-supply transfer FROM the excluded treasury TO the circulating winner, so circulating changes by `+Σrewards − Σfees` (exactly the formula the test asserts). The test is correct; the one-line prose under-states the reward inflow. | low (doc accuracy) | patch | Corrected all 3 occurrences (Always #2, the `TOTAL_SUPPLY_CONSERVED_SEQUENCE` matrix row, and the AC) to "circulating (excl. mint + burn) = initial + Σ rewards − Σ fees (the reward flows from the excluded treasury into circulation; only fees leave it)". No code/test change. |

## Design Notes

**"Burn" = a transfer to a receive-only identity, NOT a supply destruction.** The ledger `apply` seam (2.1) has NO destroy path — it only moves base units between identities. So "burning" a fee means transferring it to a reserved `BURN_ID` that only receives (never sends) — EXACTLY the model the 2.4 conservation property test already uses (its `BURN` identity, and its `CONSERVATION_SUPPLY` row asserting `totalSupply` IDENTICAL before/after with `FEE_EXACT` asserting the burn account = Σ fees and circulating-excl-burn dropping by Σ fees). This is why `totalSupply` is CONSERVED (not decreasing) under a running miner: the reward (`MINT_ID → winner`) and the fee (`sender → BURN_ID`) are both within-supply transfers. The 3.2/3.5 closed-system treasury (`totalSupply` = `maxSupply`) is the same invariant with 0 txs. The ticket's "totalSupply behaving correctly under a sequence of mined blocks" = conserved/invariant, asserted at every step.

**Why BURN, not CREDIT-to-winner.** Crediting the fee to the winning identity would couple the mining reward to network traffic (a busy network → the winner earns more), which distorts uptime-only mining (R1: a node's win rate depends ONLY on its uptime, not on fee volume). Burning to a neutral account keeps the winner's income = the fixed block reward, independent of traffic. This is also the economically standard choice for a fixed-emission supply (deflationary pressure on circulating supply) and matches 2.4's existing model.

**`FEE_RATE` = a named protocol constant, NOT a genesis field.** The spine's inception Decision (line 64 of the epic Notes) explicitly defers a genesis fee field: "Entry 6's fee-rate genesis field (a protocol change) therefore cannot collide with epic 4's genesis/proto edits; the fee-rate provenance is entry 6's `unknown`, settled + recorded as a Decision at build." A genesis field is a protocol change requiring a genesis version bump; a named constant in `economics.ts` satisfies the ticket's "one named origin" at lower ceremony (no genesis schema change, no collision with epic 4). The value `"0.001"` (0.1%) continues the 2.2 fixed-rate decision + the 2.4 conservation test's `RATE` (the established interim rate) — a plain decimal in [0,1), makes the fee boundary's truncation observable, and is economically sane. A future genesis fee field would REPLACE this constant in a later epic with a version bump.

**The txs are an in-memory view, not a block payload.** The proto `Block` carries only `txCount` (no tx payload — `Tx` is a separate message verified on epic 5's ledger path). So `applyBlock` takes an optional `txs: ReadonlyArray<BlockTx>` (the in-memory sender/recipient/amount view) and computes each fee via `computeFee`. The tracer's `mineAndApply` stays txCount-0 (no txs) — carrying real, verified txs through the loop is epic 5's ledger path, so the single-node 3.2/3.5 flow is untouched. The `BlockTx` view is the seam the multi-node sim (3.7) will feed real (or synthetic) txs through.

**`apply-block.ts` calls `computeFee` without importing `big.js`.** `computeFee` lives in `src/ledger/fee.ts` (one of the two sanctioned big.js files) and is exported from the ledger barrel. `apply-block.ts` imports it from `../ledger/index.js` — the 2.5 `BIG_JS_ONLY_BOUNDARY` guard scans `big.js` import SPECIFIERS in `src/**` and pins them to exactly `['ledger/display.ts','ledger/fee.ts']`; `../ledger/index.js` is NOT a `big.js` specifier, so the guard stays green. This is the AD-5 boundary pattern: the boundary is the FUNCTION (`computeFee`), not the import.

## Verification

**Commands:**
- `corepack pnpm test` -- expected: all suites green (prior 146 + 7 new economics tests = 153); the 3.2 tracer, 3.3 draw, 3.4 verify-draw, 3.5 boot-path, 2.4 conservation, and no-float-guard suites UNCHANGED.
- `corepack pnpm typecheck` -- expected: clean (the `BlockTx` type + `txs?` optional param + `FEE_RATE`/`BURN_ID` exports are compatible; the existing `applyBlock` call sites — `mineAndApply` + the 3.2 `APPLY_REWARD` test — still type-check with `txs` omitted).
- `corepack pnpm build 2>&1 | tail -2 && git diff --name-only -- packages/core/src/proto/ && echo PROTO_OK` -- expected: `PROTO_OK` with an EMPTY proto diff (no `protocol.proto` change).
- `corepack pnpm test consensus-economics` -- expected: the 7 new tests pass (reward credit, fee-at-boundary, burn destination, totalSupply conservation over a sequence, named fee rate, backward-compat 0-tx, atomic over-draw reject).
- `corepack pnpm test consensus-tracer boot-path conservation no-float-guard` -- expected: all green UNCHANGED (the backward-compat + guard pins survive).

**Manual checks (if no CLI):**
- None — the CLI trio + the focused economics run + the backward-compat suite run are the gate.
