---
ticket: "5"
title: "Uptime = valid tickets over lookback-L (ramp from zero)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "c3688d3d695c1ed89ceaecd336aaeee7881fc63d"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [R2]
context:
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/acceptance-cap.ts
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/consensus/sim.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/config/genesis.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/index.ts
  - config/genesis.json
  - packages/core/test/simulation.test.ts
  - packages/core/test/consensus-acceptance-cap.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.5 Uptime = valid tickets over lookback-L (ramp from zero)

## Story of truth

Compute an identity's **uptime** as the number of its **valid tickets over a
moving lookback of `L` chain-time windows**, **ramping from zero** for a new
identity (no uptime inflation from a fresh identity claiming a long lookback),
and derive the identity's **per-window draw weight** from that ticket history —
replacing the pre-epic-4 **fixed** weight input with a weight that tracks the
identity's actual uptime. The slot reward **stays fixed emission** with **no
stake component** (R2) — the weight only affects an identity's **draw odds**,
never the reward amount.

`L` is the genesis parameter `uptimeLookbackL` (already in `GenesisConfig`, an
integer ≥ 1; the value `50` in `config/genesis.json`) — it is **not** a
protocol-logic choice, just a parameter the function receives. The computed
weight **feeds `drawWindow` as the uptime input** (AD-7) — the draw is
**imported, never re-implemented**, and **UNCHANGED**.

This is a **NEW-MODULE story**: one new `src/consensus/uptime.ts` + additive
barrel re-exports + one new test file. It does **NOT** change `draw.ts` (the
draw is imported, AD-7), `acceptance-cap.ts` (4.4), `accept-winner.ts` (4.3),
`sim.ts` (3.7), `apply-block.ts` / `economics.ts` (3.6), the genesis seam
(1.6), the proto, or `ports.ts`. It ships the **pure uptime-weight derivation**
that **4.8** (multi-identity sim) wires into the sim's per-window weight
construction (replacing the fixed `SimNode.uptime` inputs) and **4.10**
(closing suite) drives end-to-end.

## The epic requirement this delivers (R2)

- **Uptime** — an identity's uptime = its **valid tickets over a lookback of
  `L` chain-time windows** (chain-time, AD-3 — the last `L` windows, not wall
  clock).
- **Ramp from zero** — a **new** identity ramps its weight **from zero**: it
  cannot claim a long lookback it has not actually accumulated, so a fresh
  identity's weight starts at 0 and grows as it earns valid tickets.
- **Per-identity weight derived from history** — the draw weight for a window is
  derived from the identity's **ticket history** (how many of the last `L`
  windows it was valid in), not a fixed input.
- **Fixed emission, no stake** — the slot reward is a **fixed emission** (3.6's
  `applyBlock` credits a constant to the winner) with **no stake component**;
  the weight affects only **draw odds**, not the reward.

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — A standalone pure derivation, not a `drawWindow` / sim change.** The
  uptime weight is a **PURE** function in NEW `src/consensus/uptime.ts`:
  `computeUptimeWeight(validWindows: ReadonlyArray<bigint>, currentWindow: bigint,
  lookbackL: bigint): bigint`. It takes an identity's **ticket history** — the
  set of chain-time window indices at which the identity had a **valid** ticket —
  the **current** window (the one about to draw), and the lookback `L`; it
  returns the identity's **draw weight** for that window. It does **NOT** change
  `drawWindow` (epic 3 owns the draw — AD-7: the draw is imported, never
  re-implemented), the cap (4.4), the acceptance seam (4.3), or the sim (4.8 wires
  the derived weight into the sim's accepted-set weight construction, replacing
  the fixed `SimNode.uptime`).
- **D2 — The weight = the COUNT of valid tickets in the last `L` windows (an
  integer, no float).** "Uptime = valid tickets over a lookback of `L` windows"
  is realized as the **integer count** of the identity's valid tickets whose
  window lies in the lookback range `[currentWindow − L, currentWindow − 1]` (the
  `L` windows **strictly before** the current one). The draw consumes a
  **non-negative integer** weight (`W`, the exponent in `c^W`), so the
  requirement's "fraction" is realized as an integer count **bounded by `L`** —
  **never** a float (`validCount / L` would be a float, banned by AD-5). A
  fully-up identity (valid in all `L` prior windows) → weight `L` (the max); a
  half-up identity → weight `L/2`; a fresh identity → weight 0.
- **D3 — Ramp from zero: the lookback is the `L` windows STRICTLY BEFORE the
  current one.** The range `[currentWindow − L, currentWindow − 1]` **excludes**
  the current window: an identity's weight at window `W` is its **track record
  over the prior `L` windows**. A **new** identity submitting its first ticket at
  window `W` has **no** prior valid windows → weight **0** (it cannot claim
  uptime it has not earned — **no inflation from a fresh identity claiming a long
  lookback**). The weight then **ramps up** (0 → 1 → 2 → … → `L`) over the
  identity's first `L` windows as it accumulates valid tickets, and stays at `L`
  once fully up. (A weight of 0 is the draw's **worst** priority — `c^0 = 1` — so
  a brand-new identity does not win until it has earned prior uptime; that is the
  intended ramp.)
- **D4 — Older history is forgotten (the lookback window is moving).** Only
  windows in `[currentWindow − L, currentWindow − 1]` count; a valid ticket from
  **before** the lookback (older than `L` windows) is **excluded**. So an
  identity's weight reflects its **recent** uptime (the last `L` windows), not its
  all-time history — a moving window, chain-time (AD-3).
- **D5 — One valid ticket per window bounds the weight by `L` (the 4.4 cap).**
  Given 4.4's acceptance cap (**at most one valid ticket per identity per
  window**), an identity has **at most one** valid window in any window-index,
  so the number of **distinct** valid windows in an `L`-window range is **≤ `L`**
  by construction — the weight is naturally in `[0, L]` (no explicit cap needed).
  The function counts **distinct** valid windows in range (robust to a caller
  passing duplicate window indices).
- **D6 — Feeds the draw as the uptime input (AD-7); the reward is fixed
  emission (R2).** The returned weight is a **non-negative integer (bigint)** in
  `[0, L]` — exactly the form `drawWindow`'s `weights` input takes (AD-7). 4.5
  ships the derivation; **4.8** feeds these derived weights into `drawWindow` in
  the sim (replacing the fixed inputs). The **reward is untouched**: 3.6's
  `applyBlock` credits the **fixed** `rewardBaseUnits` to the winner (no stake
  component) — the weight changes **draw odds only**, never the reward amount.
- **D7 — No big.js; no proto change; guards on the inputs.** `src/consensus`
  still imports no `big.js` (the no-float guard stays green) — the function is an
  integer count over `bigint` window indices (no float, no float literal). The
  proto is unchanged (no field added). `lookbackL < 0n` or `currentWindow < 0n`
  is a **programming error** (a bad weight would silently fork the draw) → throw
  `DrawError` `SC-CONSENSUS-2` (the consensus-domain error, consistent with
  `draw.ts`'s `u64be` range guard).

## Frozen I/O matrix (each row a passing test)

Shared deterministic fixture (AD-3: no RNG, no wall clock): a lookback `L = 5n`
(the crisp test value; the genesis value is `50`), fixed per-identity 32-byte
`nonceCommitment`s (pinned `sha256` of public data), a fixed window challenge.
`computeUptimeWeight` is pure over `(validWindows, currentWindow, L)`.

| Row | Input | Expected |
|-----|-------|----------|
| UPTIME_VALID_IN_LOOKBACK | an identity valid in **all** `L` prior windows (`validWindows = [0,1,2,3,4]`), `currentWindow = 5`, `L = 5` | the weight = the count of valid tickets in the last `L` windows = **`5n`** (= `L`, full uptime) — a fully-up identity gets the maximum weight |
| UPTIME_RAMP_FROM_ZERO | a **new** identity: `currentWindow = 0` (no prior windows); then `currentWindow = 1` with `validWindows = [0]`; then `currentWindow = 2` with `validWindows = [0,1]` | the weight **ramps from zero**: `0n` → `1n` → `2n` (a fresh identity starts at 0 — **no inflation** from claiming a long lookback — and grows as it earns valid tickets) |
| UPTIME_DOWNTIME_REDUCES | an identity valid in windows `[0,1,2]` with a **gap** (no ticket at 3 or 4), `currentWindow = 5`, `L = 5` | the weight = the distinct valid windows in `[0,4]` = **`3n`** (< `L`) — downtime within the lookback **reduces** the weight below the full-uptime max |
| UPTIME_LOOKBACK_FORGETS_OLD | an identity valid at windows `[0,1, 50,51]` (old + recent), `currentWindow = 53`, `L = 5` | only the last `L` windows (`[48,52]`) count: weight = `{50,51}` = **`2n`**; the **old** tickets at `[0,1]` are **excluded** (the lookback is a **moving** window that forgets older history) |
| UPTIME_WEIGHT_IS_DRAW_INPUT | two identities at `currentWindow = 5`, `L = 5`: A valid in `[0,1,2,3,4]` (→ weight `5n`), B valid in `[2,4]` (→ weight `2n`); feed the **computed** weights + conformed tickets to the **IMPORTED** `drawWindow` (AD-7, never re-implemented) | each computed weight is a **non-negative integer (bigint) in `[0, L]`**; the higher-uptime identity has the **strictly higher** weight (`5n > 2n` — win odds track uptime); the weights passed to `drawWindow` are **exactly** the derived uptime weights (the per-identity draw weight is derived from the ticket history, AD-7); **no float** (AD-5) — the weight is the integer count, not `validCount / L` |

## Tasks

- [x] Add `src/consensus/uptime.ts` — `computeUptimeWeight(validWindows:
  ReadonlyArray<bigint>, currentWindow: bigint, lookbackL: bigint): bigint` — the
  PURE uptime-weight derivation: count the **distinct** valid windows in
  `[currentWindow − lookbackL, currentWindow − 1]` (the last `L` windows strictly
  before the current one), returned as a `bigint` in `[0, L]`; ramp from zero (a
  fresh identity → 0); older history forgotten; `lookbackL < 0n` or
  `currentWindow < 0n` → throw `DrawError` `SC-CONSENSUS-2`. Additive re-exports
  in `src/consensus/index.ts` + `src/index.ts`. Do NOT change `draw.ts`,
  `acceptance-cap.ts`, `accept-winner.ts`, `sim.ts`, `apply-block.ts`,
  `economics.ts`, the genesis seam, `protocol.proto`, or `ports.ts`.
- [x] Add `test/consensus-uptime.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the draw): the 5 matrix rows
  (UPTIME_VALID_IN_LOOKBACK / UPTIME_RAMP_FROM_ZERO / UPTIME_DOWNTIME_REDUCES /
  UPTIME_LOOKBACK_FORGETS_OLD / UPTIME_WEIGHT_IS_DRAW_INPUT), with a deterministic
  fixture (a fixed `L = 5n`, pinned per-identity commitments, a fixed challenge;
  `drawWindow` imported for the draw-input row).
- [x] Run the verification gate; confirm the epic-3 `verify-draw` (12), `sim`
  (5), and `e2e` (5) suites — and the 4.3 `accept-winner` (5) + 4.4 `acceptance-cap`
  (5) suites — stay green (the ADDITIVE constraint) and the new suite is
  deterministic.

## Acceptance criteria

1. Uptime for an identity = its **valid tickets over a lookback of `L` windows**:
   the weight = the count of distinct valid windows in `[currentWindow − L,
   currentWindow − 1]`, a `bigint` in `[0, L]`.
2. A **new** identity's weight **ramps from zero** (starts at 0 with no prior
   valid windows and grows as it earns valid tickets) — **no uptime inflation**
   from a fresh identity claiming a long lookback.
3. **Downtime** within the lookback **reduces** the weight below the full-uptime
   max; **older** history (before the lookback) is **excluded** (a moving
   window).
4. The weight **feeds `drawWindow` as the uptime input** (AD-7, imported, never
   re-implemented, **unchanged**): it is a non-negative integer (bigint) in
   `[0, L]`, a higher-uptime identity has the strictly higher weight, and **no
   float** is used (AD-5).
5. The change is **ADDITIVE**: the epic-3 `verify-draw` (12), `sim` (5), and `e2e`
   (5) suites — and the 4.3 `accept-winner` (5) + 4.4 `acceptance-cap` (5) suites —
   stay green; `draw.ts` / `acceptance-cap.ts` / `accept-winner.ts` / `sim.ts` /
   `apply-block.ts` / `economics.ts` / the genesis seam / `protocol.proto` /
   `ports.ts` are **UNCHANGED**; no `big.js` in `src/consensus`; the reward stays
   fixed emission (3.6's `applyBlock` is untouched — no stake component).

## Never

- NEVER change `drawWindow`'s behavior or signature (epic 3 owns the draw; the
  uptime weight is a **derived input** to it, AD-7 — the draw is imported, never
  re-implemented).
- NEVER re-implement the draw — where the test composes the weight with the draw,
  `drawWindow` is imported (AD-7); `computeUptimeWeight` only **counts** valid
  windows, it does not select a winner.
- NEVER use a **float** for the weight (AD-5) — the weight is the **integer
  count** of valid windows (a `bigint`), never `validCount / L`.
- NEVER let a fresh identity claim uptime it has not earned — the lookback is the
  `L` windows **strictly before** the current one (ramp from zero), so a new
  identity starts at weight 0.
- NEVER include the **current** window in the lookback (the weight at window `W`
  is the track record over the **prior** `L` windows) and NEVER count windows
  **older** than the lookback (the window is moving).
- NEVER change `acceptance-cap.ts` (4.4), `accept-winner.ts` (4.3), `sim.ts` (3.7),
  `apply-block.ts` / `economics.ts` (3.6), the genesis seam (1.6),
  `protocol.proto`, or `ports.ts` — the uptime weight is a NEW standalone
  derivation (wiring it into the sim's weight construction is 4.8).
- NEVER make the weight depend on RNG or the wall clock (AD-3) — it is a pure
  count over chain-time window indices.
- NEVER import `big.js` in `src/consensus` (AD-5 / the 2.5 no-float guard) — the
  weight is an integer count over `bigint`s.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **183 prior + 5 new = 188 tests,
  26 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.5 adds no proto.
- **ADDITIVE constraint (the HARD one):** `corepack pnpm test
  consensus-verify-draw` → **12 passed**; `corepack pnpm test simulation` →
  **5 passed**; `corepack pnpm test epic-end-to-end` → **5 passed**;
  `corepack pnpm test consensus-accept-winner` → **5 passed**; `corepack pnpm
  test consensus-acceptance-cap` → **5 passed** — all UNCHANGED (the uptime
  weight is a NEW standalone derivation; it changes no existing seam).
- Determinism: run `corepack pnpm test consensus-uptime` TWICE — both pass with
  the identical weight outcomes.
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]`).

## Plan Change Log
_(none — no AC / matrix / Never / Design Notes change during the build; the
ticket's `unknown` was settled by the frozen D1–D7 design notes before
implementation. The D7 guard assertions are covered by the
UPTIME_RAMP_FROM_ZERO row (folded to keep exactly 5 `it()` blocks).)_

## Review Triage Log
| Lens | Finding (short) | Verdict | Action |
|------|-----------------|---------|--------|
| quick | (none) | n/a | The quick lens returned 0 findings; it independently verified every scrutiny question (a)–(k) with evidence: strictly additive (only the two barrels + new uptime.ts + new test touched; `draw.ts`/`acceptance-cap.ts`/`accept-winner.ts`/`sim.ts`/`apply-block.ts`/`economics.ts`/genesis seam/`protocol.proto`/`ports.ts` byte-identical); range bounds exactly `lo = currentWindow − L` / `hi = currentWindow − 1` (current window + older-than-L excluded; boundaries 48-in/47-out proven) with `Set<bigint>` distinct count; ramp from zero (fresh → 0, anti-inflation `([],0n,50n) → 0n`); feeds the IMPORTED `drawWindow` (AD-7, `draw.uptime === weights[draw.index]`, 5n > 2n); no float (integer bigint count, no `validCount / L`); guards throw `DrawError` (imported, not re-implemented); no big.js (no-float 6/6); determinism (5/5 twice, fully pinned fixture); pure/no-mutation; fixed emission untouched; all 5 frozen matrix rows present (guards folded into the RAMP row per the plan's own note). No action required. |

## Implementation Notes
Built from baseline `c3688d3` (clean tree; 183 tests / 25 files pre-change).

**What was added (ADDITIVE — nothing existing modified except two barrel re-exports):**

- `packages/core/src/consensus/uptime.ts` (NEW) — `computeUptimeWeight(validWindows: ReadonlyArray<bigint>, currentWindow: bigint, lookbackL: bigint): bigint`. The pure derivation: count DISTINCT valid windows in `[currentWindow − lookbackL, currentWindow − 1]` (the `L` windows strictly before the current one) using a `Set<bigint>` for de-dup, returned as a `bigint` in `[0, L]`. Guards (D7): `lookbackL < 0n` or `currentWindow < 0n` → `throw new DrawError('SC-CONSENSUS-2: …')` (the class is IMPORTED from `./draw.js`, not re-implemented). No float, no `number` division (NEVER `validCount / L`), no `Math.random`, no `Date.now`/wall clock (AD-3), no `big.js` (AD-5).
- `packages/core/test/consensus-uptime.test.ts` (NEW) — the 5 matrix rows (UPTIME_VALID_IN_LOOKBACK / UPTIME_RAMP_FROM_ZERO / UPTIME_DOWNTIME_REDUCES / UPTIME_LOOKBACK_FORGETS_OLD / UPTIME_WEIGHT_IS_DRAW_INPUT) importing from the ROOT barrel `../src/index.js` only. Deterministic fixture: fixed `L = 5n`, per-identity 32-byte `nonceCommitment`s as pinned `sha256("SC-UPTIME-COMMIT/1" ‖ utf8(id) ‖ u64be(5) ‖ PARENT_HASH)`, a fixed window challenge via the IMPORTED `deriveWindowChallenge(PARENT_HASH, 5n)`. The D7 guard assertions (negative L / negative window → `DrawError` `SC-CONSENSUS-2`) are folded into the UPTIME_RAMP_FROM_ZERO row so the file has EXACTLY 5 `it()` blocks (matching the gate's "5 new tests"). The draw-input row feeds the EXACTLY-computed weights + conformed `DrawTicket`s to the IMPORTED `drawWindow` and asserts `draw.uptime === weights[draw.index]` (the draw consumes the derived weights verbatim).
- `packages/core/src/consensus/index.ts` — additive re-export of `computeUptimeWeight` from `./uptime.js` (+9 lines).
- `packages/core/src/index.ts` — additive re-export of `computeUptimeWeight` from `./consensus/index.js` (+8 lines).

**Deliberately UNCHANGED (per the Never list):** `draw.ts`, `acceptance-cap.ts`, `accept-winner.ts`, `sim.ts`, `apply-block.ts`, `economics.ts`, the genesis seam (`config/genesis.ts`), `protocol.proto` / `src/proto/`, `ports.ts`. `git status` confirms only the 2 new files + the 2 barrel edits (17 insertions total, 0 deletions).

**Verification (acceptance gate) — exact outputs:**
- `corepack pnpm test` → **Test Files 26 passed (26); Tests 188 passed (188)** (183 prior + 5 new).
- `corepack pnpm typecheck` → clean (tsc exits 0, no output).
- `corepack pnpm build` → clean (protons + tsc exit 0); `git diff --name-only -- packages/core/src/proto/` → **empty (PROTO_OK)** — no proto field added.
- ADDITIVE constraint: `consensus-verify-draw` → **12 passed**; `simulation` → **5 passed**; `epic-end-to-end` → **5 passed**; `consensus-accept-winner` → **5 passed**; `consensus-acceptance-cap` → **5 passed** — all UNCHANGED.
- Determinism: `corepack pnpm test consensus-uptime` run TWICE → both **1 file / 5 tests passed** with identical outcomes (pure count + pinned draw; no RNG / wall clock).
- AD-5 guard: `corepack pnpm test no-float-guard` → **6 passed** (the `big.js` import-specifier set over `src/` is still exactly `[ledger/display.ts, ledger/fee.ts]` — the new module imports no `big.js`).

**Left incomplete / risky:** nothing within this story's scope. The weight is NOT yet wired into any weight-construction call site — that is 4.8 (multi-identity sim, which replaces the fixed `SimNode.uptime` inputs) and 4.10 (closing e2e suite), both explicitly out of scope for 4.5. No residual risk: the derivation is standalone, pure, and the draw / cap / acceptance / sim / economics seams are byte-unchanged.
