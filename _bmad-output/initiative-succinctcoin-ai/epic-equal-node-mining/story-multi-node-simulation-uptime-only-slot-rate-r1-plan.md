---
ticket: "7"
title: "Multi-node simulation: uptime-only slot rate (R1)"
epic: epic-equal-node-mining
status: "built"
route: full
baseline_revision: "6ad19e1c1206947d7950cc6e0be9bb2c4d726b39"
review: "quick"
review_source: "pinned"
lenses_ran: ['quick']
review_loop_iteration: 0
covers: [R1]
context:
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/src/consensus/miner.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/economics.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/store/file-chain-store.ts
  - packages/core/src/index.ts
  - packages/core/test/consensus-draw.test.ts
  - packages/core/test/consensus-verify-draw.test.ts
  - packages/core/test/consensus-economics.test.ts
  - packages/core/test/no-float-guard.test.ts
---

# Story Plan — 3.7 Multi-node simulation: uptime-only slot rate (R1)

## Story of truth

Build the multi-node simulation on the memory transport proving the core promise (R1):
a single always-up node wins slots at the expected **uptime-proportional slot rate**
(its uptime weight over the sum of the window's ticket weights, from `drawWindow`)
**regardless of hardware**, and **no node wins a slot without a valid per-slot ticket**
whose `(ticket, nonce)` verifies the draw.

The sim is a standalone consensus module (`src/consensus/sim.ts`) + a test
(`test/simulation.test.ts`). It reuses the pinned seams — `drawWindow` (3.3, AD-7, the
ONE draw), `mineBlock` (3.2, R3), `applyBlock` (3.6, R5), `verifyDraw` (3.4, the launch
gate) — and **never re-implements the draw**. It is NOT wired into `createCore`; it is a
validation harness that proves R1.

## Settling the ticket's `unknown` (the two open design questions)

- **Statistical tolerance** → a **±5% band** around the expected rate, plus the **exact
  deterministic win count pinned** for regression (mirrors 3.3's `PROPORTIONAL_RATE`:
  integer band + pinned count + strict ordering). Because the sim is fully deterministic
  (pinned commitments, no RNG, no wall clock — AD-3), the pinned count is stable; the
  band is the statistical sanity guard.
- **Where synthetic tickets/uptimes come from (pre-epic-4)** → a **deterministic
  synthetic ticket** conforming to 3.3's `DrawTicket` / the proto `Ticket`: each
  up-node's per-window `nonceCommitment = sha256("SC-SIM-COMMIT/1" ‖ identityId ‖
  u64be(slot) ‖ parentHash)` (distinct per (node, window); no RNG/wall clock), and each
  node's **uptime weight is a fixed input** (the synthetic stand-in for "valid tickets
  over lookback L" — AD-7: weights are INPUTS to the draw; epic 4 derives real weights
  from the lookback window). These are **not** gate-verified tickets (epic 4); the empty
  `signature` is exactly the epic-3 convention (3.4).

## Design Notes (decisions)

- **D1 — Memory transport = shared in-process store + chain head (no sockets).** The
  "network" is modeled as ONE chain with ONE accepted ticket set per window, carried by
  the single-writer `FileChainStore` (AD-9) — all in one process, no sockets (epic 5 adds
  the real network). Each window = one slot = one block. This is the "memory transport".
- **D2 — The draw is `drawWindow` (imported, AD-7), weighted by uptime.** Per-window win
  probability for a node = its uptime weight / the window's total weight (from
  `drawWindow`). The always-up node has the HIGHEST uptime weight, so it wins the most.
- **D3 — Hardware independence is STRUCTURAL, not statistical.** The winner is chosen by
  `drawWindow` (a pure function of the committed nonces + challenge + uptime weights — NO
  hash-rate input) BEFORE `mineBlock` is invoked. `mineBlock` only produces the PoW nonce
  for the already-selected winner (fixed N=16 target for every node). A faster machine
  finds its counter faster but cannot change the draw outcome. The test pins this ordering.
- **D4 — The launch gate is `verifyDraw` (3.4).** A block's winner is legitimate only if
  `verifyDraw(block, tickets, weights, challenge) === true` (the winner's ticket is in the
  accepted set, bound to the window, and reproduces the draw). A forged/invalid ticket →
  `verifyDraw === false` (rejected). This is "no node wins without a valid per-slot ticket".
- **D5 — Determinism (AD-3).** No `Math.random`, no wall clock. Every commitment and
  challenge is a pinned `sha256` of public data. The whole schedule is reproducible.

## Sim parameters (PINNED — the subagent must use EXACTLY these)

- Nodes (64-hex identity ids, distinct from `MINT_ID` …001 / `TRACER_WINNER_ID` …002 /
  `BURN_ID` …003):
  - **A** (always-up, highest uptime) = 62 zeros + `"aa"`, weight **50n**
  - **B** (flaky) = 62 zeros + `"bb"`, weight **30n**
  - **C** (flaky) = 62 zeros + `"cc"`, weight **20n**
  - Total weight = 100n ⇒ A's expected per-window rate = 50/100 = **0.5**.
- **Rate schedule** (`SIM_RATE`): **W = 4000** windows, NO mining (pure `drawWindow`).
  `FIXED_PARENT` = 32 zero bytes; for window `w` ∈ [0, 4000): `challenge =
  deriveWindowChallenge(FIXED_PARENT, BigInt(w))`, `slot = BigInt(w)`, ticket =
  `syntheticTicket(node, slot, FIXED_PARENT, challenge)` for each node. Count A's wins.
- **Full path** (`SIM_FULL_PATH`): **K = 3** windows through a real `FileChainStore`
  (temp dir), `rewardDisplay = "12.5"`, `maxSupplyDisplay = "21000000"`.
- **Tolerance** (`SIM_RATE`): A's win rate ∈ **[0.45, 0.55]** (±5% around 0.5), AND the
  **exact A-win count pinned** (subagent computes + records it here: **2111 of 4000**
  — rate 0.52775; B = 1203, C = 686, total = 4000), AND `A_wins > B_wins` and `A_wins
  > C_wins` (strict).

## I/O Matrix (frozen — every row covered by a passing test)

| Row | Scenario | Input | Expected |
|-----|----------|-------|----------|
| SIM_RATE | 4000-window pure draw schedule (A=50/B=30/C=20) | `drawWindow` over `syntheticTicket`s + `deriveWindowChallenge(FIXED_PARENT, w)` | A's win rate ∈ [0.45, 0.55] (0.5 expected); exact A-win count pinned; `A_wins > B_wins` and `A_wins > C_wins` |
| SIM_FULL_PATH | 3 windows end-to-end on a real `FileChainStore` | `simulateNetwork` (draw→mine→apply→verify per window) | `headSlot() === 2`; EVERY block's `verifyDraw(block, tickets, weights, challenge) === true`; each winner ∈ {A, B, C}; reward `MINT_ID → winner` = `fromDisplay("12.5")`; `totalSupply` conserved (== `fromDisplay("21000000")`) |
| SIM_NO_WIN_WITHOUT_VALID_TICKET | valid vs forged winner ticket | `verifyDraw(block, tickets, weights, challenge)` | a block whose winner's ticket is the node's valid per-window ticket → `true`; a FORGED ticket (winner claims a valid identity but a fabricated `nonceCommitment` not in the accepted set) → `false` (the launch gate rejects) |
| SIM_HARDWARE_INDEPENDENT | draw precedes mine | `drawWindow` winner vs the mined `block.winnerIdentityId` | `block.winnerIdentityId === drawWindow(...).winnerIdentityId` (the draw — not the miner — decided it); the selection inputs `(tickets, challenge, weights)` contain no hash-rate term |
| SIM_TICKET_CONFORMS | synthetic ticket shape | `syntheticTicket(A, slot, parent, challenge)` | `identityId` is 64 hex chars; `nonceCommitment` is 32 bytes; `windowIndex === slot`; `challenge` byte-equals the input; `signature` empty; `Ticket.encode`/`Ticket.decode` round-trips |

## Tasks

- [x] Add `src/consensus/sim.ts` (standalone, NOT wired into `createCore`):
  - `interface SimNode { identityId: string; uptime: bigint }` — a simulated node: a
    64-hex identity + its fixed uptime weight (the draw input).
  - `syntheticTicket(node: SimNode, slot: bigint, parentHash: Uint8Array, challenge:
    Uint8Array): ProtoTicket` — the node's deterministic per-window proto `Ticket`:
    `identityId` = node id, `windowIndex` = slot, `challenge` = the (copied) 32-byte
    challenge, `nonceCommitment = sha256("SC-SIM-COMMIT/1" ‖ utf8(identityId) ‖ u64be(slot)
    ‖ parentHash)` (32 bytes, AD-3 — no RNG/wall clock; distinct per (node, window)),
    `signature = new Uint8Array(0)` (epic 4 verifies).
  - `windowAcceptedSet(nodes, slot, parentHash, challenge): { tickets: DrawTicket[];
    weights: bigint[]; protoTickets: ProtoTicket[] }` — the window's accepted set:
    each node's `DrawTicket` (`{identityId, nonceCommitment}`) + its uptime weight + its
    proto `Ticket` (for encoding the winner's).
  - `simulateWindow(params: { store, rewardDisplay, maxSupplyDisplay, nodes }):
    Promise<{ block: Block; winnerId: string; tickets: DrawTicket[]; weights: bigint[];
    challenge: Uint8Array; verify: boolean }>` — ONE window end-to-end: (1)
    `nextSlotAndParent(store)`; (2) `deriveWindowChallenge(parentHash, slot)`; (3)
    `windowAcceptedSet`; (4) `drawWindow(tickets, challenge, weights)` (imported — the
    ONE draw) picks the winner; (5) `mineBlock` for the WINNER with
    `Ticket.encode(winnerProtoTicket)` as `winnerTicket` (R3); (6) `applyBlock`
    (reward `MINT_ID → winner`, commit, save — R5); (7) `verify = verifyDraw(block,
    tickets, weights, challenge)` (3.4 launch gate). Returns the block + the re-verify
    inputs + the verify result.
  - `simulateNetwork(params: { store, rewardDisplay, maxSupplyDisplay, nodes, windows }):
    Promise<Array<{ block, winnerId, verify }>>` — run `windows` windows via
    `simulateWindow`, threading the store head forward (the memory transport).
  - `drawSchedule(nodes, windows): Array<{ winnerId: string; slot: bigint }>` — the PURE
    rate schedule (NO mining): for window `w`, `challenge =
    deriveWindowChallenge(FIXED_PARENT, w)`, `slot = BigInt(w)`, `drawWindow` over the
    nodes' `syntheticTicket`s → the winner id. `FIXED_PARENT` = 32 zero bytes (module
    const). This is what `SIM_RATE` consumes (fast, deterministic, like 3.3).
  - Import `fromDisplay` from `../ledger/index.js` (the AD-5 boundary, done ONCE per
    window OUTSIDE the mining loop — exactly as `slot-loop.ts` does; NOT `big.js`
    directly, so the 2.5 guard's specifier set is unchanged).
- [x] Re-export the sim additively: `src/consensus/index.ts` (barrel) + `src/index.ts`
  (root barrel) — `SimNode` (type) + `syntheticTicket` / `windowAcceptedSet` /
  `simulateWindow` / `simulateNetwork` / `drawSchedule` (values). Do NOT touch
  `createCore` or any existing export.
- [x] Add `test/simulation.test.ts` (imports from the ROOT barrel `../src/index.js` only —
  never re-implements the draw / challenge / fee): the 5 matrix rows
  (SIM_RATE / SIM_FULL_PATH / SIM_NO_WIN_WITHOUT_VALID_TICKET /
  SIM_HARDWARE_INDEPENDENT / SIM_TICKET_CONFORMS). `SIM_FULL_PATH` uses a real
  `FileChainStore` in a `mkdtemp` dir (rmSync in `afterEach`); `SIM_RATE` +
  `SIM_TICKET_CONFORMS` + the pure parts need no store.
- [x] Record the pinned `SIM_RATE` A-win count (the subagent runs the schedule, records
  the exact deterministic count in the test + here), and confirm it falls in [0.45, 0.55].

## Acceptance criteria

1. A new standalone `src/consensus/sim.ts` provides the multi-node memory-transport sim:
   deterministic `syntheticTicket` (conforming to the proto `Ticket` / 3.3 `DrawTicket`),
   `windowAcceptedSet`, `simulateWindow` (draw→mine→apply→verify), `simulateNetwork`, and
   the pure `drawSchedule`. It imports the pinned seams (`drawWindow`, `mineBlock`,
   `applyBlock`, `verifyDraw`, `nextSlotAndParent`, `deriveWindowChallenge`) — it does NOT
   re-implement the draw (AD-7) or the challenge (AD-12).
2. **R1 rate:** over the pinned 4000-window schedule (A=50/B=30/C=20), the always-up node
   A's win rate is within **[0.45, 0.55]** of its uptime-proportional expected rate 0.5
   (its weight 50 over the total 100), the exact A-win count is pinned, and A wins strictly
   more than both B and C.
3. **R1 no-win-without-valid-ticket:** over a real end-to-end run (3 windows), EVERY
   committed block's winner passes the 3.4 launch gate
   (`verifyDraw(block, tickets, weights, challenge) === true`); a FORGED winner ticket
   (valid identity, fabricated commitment not in the accepted set) is REJECTED
   (`verifyDraw === false`).
4. **R1 hardware independence:** the block's `winnerIdentityId` equals the `drawWindow`
   winner (the draw — not the miner — selected it); the selection inputs contain no
   hash-rate term (the draw is pure over committed nonces + challenge + uptime weights,
   and `mineBlock` runs only for the already-selected winner).
5. The synthetic ticket conforms to the interface: 64-hex `identityId`, 32-byte
   `nonceCommitment`, `windowIndex === slot`, byte-equal `challenge`, empty `signature`,
   and a `Ticket.encode`/`decode` round-trip.

## Never

- NEVER re-implement the draw (`drawWindow`) or the challenge derivation
  (`deriveWindowChallenge`) — import them (AD-7 / AD-12).
- NEVER introduce RNG (`Math.random`) or wall-clock time into the sim (AD-3) — every
  commitment/challenge is a pinned `sha256` of public data.
- NEVER import `big.js` in `src/consensus` (the 2.5 `BIG_JS_ONLY_BOUNDARY` guard pins
  big.js to `ledger/display.ts` + `ledger/fee.ts`); use `fromDisplay` from
  `../ledger/index.js`.
- NEVER wire the sim into `createCore` or change any existing export's behavior — it is a
  standalone harness.
- NEVER change the protocol (`protocol.proto` must regenerate byte-identical) or any
  3.1–3.6 seam (`pow` / `miner` / `draw` / `verify-draw` / `slot-loop` / `apply-block` /
  `economics` / ledger / store) — only ADD `sim.ts` + the additive re-exports + the test.
- NEVER let a node "win" outside the accepted ticket set — the winner is always
  `drawWindow`'s output over the window's tickets, and every committed block must pass
  `verifyDraw`.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **153 prior + 5 new = 158 tests, 20 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only -- packages/core/src/proto/`
  empty (proto byte-identical).
- Prior suites unchanged: `corepack pnpm test consensus-draw consensus-verify-draw
  consensus-economics no-float-guard` (draw 11 + verify-draw 12 + economics 7 + no-float 6
  = 36) all pass — the sim adds a module but changes none of them.
- Record the pinned `SIM_RATE` A-win count in the test + this plan.

## Review Triage Log
- Quick lens (pass 1, 2026-10-07): **0 findings** — all 10 scrutiny points (a)–(j) PASS with
  evidence. Independently re-verified by the orchestrator (not trusting the lens's own gate
  run): `pnpm test` 158/158 (20 files), `typecheck` clean, `pnpm build` clean +
  `git diff --name-only -- packages/core/src/proto/` empty (PROTO_OK), prior suites
  (consensus-draw 11 + consensus-verify-draw 12 + consensus-economics 7 + no-float-guard 6
  = 36) unchanged. No patches, no loopback (review_loop_iteration 0). Key lens-confirmed
  properties: draw + challenge IMPORTED not re-implemented (the only sha256 in sim.ts is the
  synthetic COMMITMENT, a distinct domain tag); zero RNG/wall-clock (AD-3); no `big.js`
  specifier (AD-5 — `fromDisplay`/`fromJson` via the ledger barrel); surface purely additive
  (`createCore` + every existing seam untouched); `protoTickets[draw.index]` aligned with
  `tickets[draw.index]`/`weights[draw.index]` (all built in `nodes` order); the forged-ticket
  row isolates the commitment-binding (windowIndex + challenge left correct, sanity check
  proves the commitment is absent from the accepted set); the test's single `createHash` is a
  negative-case fixture (the FORGED commitment), not a re-implementation of the draw.

## Plan Change Log
_(none yet — no plan changes were forced during 3.7; the only edits were the two allowed
ones: the pinned SIM_RATE A-win count + the Implementation Notes append)_

## Implementation Notes
Built 2026-10-07 (ticket 3.7, R1). Added `src/consensus/sim.ts` (standalone, NOT wired
into `createCore`): `SimNode { identityId: string; uptime: bigint }`, `syntheticTicket`
(pinned `sha256("SC-SIM-COMMIT/1" ‖ utf8(identityId) ‖ u64be(slot) ‖ parentHash)`; empty
`signature` — the epic-3 convention), `windowAcceptedSet`, `simulateWindow`
(draw→mine→apply→verify), `simulateNetwork`, and the pure `drawSchedule`
(`FIXED_PARENT` = 32 zero bytes + the window index as the slot). It imports the pinned
seams (`drawWindow` / `deriveWindowChallenge` / `mineBlock` / `applyBlock` / `verifyDraw`
/ `nextSlotAndParent` / `fromDisplay`) and never re-implements the draw (AD-7) or the
challenge (AD-12). `fromDisplay` comes from `../ledger/index.js` (NOT `big.js` directly
— the 2.5 `BIG_JS_ONLY_BOUNDARY` guard's specifier set is unchanged). Additive
re-exports in `src/consensus/index.ts` + `src/index.ts` (`SimNode` type + the five
values); `createCore` and every existing export untouched. `test/simulation.test.ts`
covers the 5 matrix rows (root-barrel imports only — the draw/challenge/fee are never
re-implemented).

- **Pinned SIM_RATE A-win count = 2111 of 4000** (rate 0.52775, inside [0.45, 0.55];
  B = 1203, C = 686; total = 4000). Deterministic (AD-3 — no `Math.random`, no wall
  clock; every commitment + challenge is a pinned `sha256` of public data), verified
  stable across runs; A > B and A > C (strict). This is the committed regression pin;
  regenerate ONLY by changing the pinned sim parameters (a protocol change, AD-7).
- **SIM_FULL_PATH**: 3 windows on a real `FileChainStore` (`mkdtemp`, `rmSync` in
  `afterEach`); `headSlot() === 2`; every block re-verified BOTH by the sim AND
  independently from the block's own `parentHash` + `slot` (the 3.4 verifier
  contract); reward `MINT_ID → winner` = `fromDisplay("12.5")`; `totalSupply`
  conserved == `fromDisplay("21000000")`.
- **SIM_NO_WIN_WITHOUT_VALID_TICKET**: the winner's valid per-window ticket →
  `verifyDraw` true; a FORGED ticket (valid identity, fabricated `nonceCommitment` not
  in the accepted set, `windowIndex` + `challenge` left CORRECT) → `verifyDraw` false
  (the launch gate rejects the commitment-binding).
- **SIM_HARDWARE_INDEPENDENT**: `block.winnerIdentityId ===
  drawWindow(...).winnerIdentityId` (the draw — not the miner — selected it); the
  selection inputs are the nodes' fixed uptime weights `[50n, 30n, 20n]` (no
  hash-rate term).
- **SIM_TICKET_CONFORMS**: 64-hex `identityId`, 32-byte `nonceCommitment`,
  `windowIndex === slot`, byte-equal `challenge`, empty `signature`, and a
  `Ticket.encode`/`decode` round-trip.

Verification (acceptance gate): `pnpm test` → 158 tests, 20 files, all passing; `pnpm
typecheck` clean; `pnpm build` clean AND `git diff --name-only --
packages/core/src/proto/` empty (PROTO_OK); prior suites unchanged (consensus-draw 11
+ consensus-verify-draw 12 + consensus-economics 7 + no-float-guard 6 = 36).
