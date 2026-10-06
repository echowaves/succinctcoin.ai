---
title: 'drawWindow (AD-7) + fixed vectors + Ticket interface'
type: 'feature'
ticket: '3'
created: '2026-10-06'
status: 'built'
baseline_revision: 'e61ae4f2549169ed91c49b83286a274f9b957743'
route: 'full'
route_source: 'pinned'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-succinctcoin-ai/epic-equal-node-mining/epic-equal-node-mining.md'
  - '{project-root}/packages/core/src/consensus/pow.ts'
  - '{project-root}/packages/core/src/consensus/index.ts'
  - '{project-root}/packages/core/test/no-float-guard.test.ts'
  - '{project-root}/packages/core/proto/protocol.proto'
---

## Intent

**Problem:** The tracer (3.2) hard-codes a single winner (`TRACER_WINNER_ID`) and an empty ticket. To make node equality real (R1) and blocks verifiable (R2), the protocol needs the pinned public-coin draw: a winner selected reproducibly from public data, with a per-window challenge and a Ticket input contract that epic 4 conforms real tickets to.

**Approach:** Add a single exported `drawWindow(tickets, challenge, weights)` in `core/consensus` (winner = argmin `c^uptime`, `c = H(nonce ‖ challenge)` uniform in (0,1], AD-7) plus the per-window challenge derivation `H(lastBlockHash, windowIndex)`, a lightweight `DrawTicket` input interface, and ≥3 fixed test vectors. The argmin is computed **exactly with BigInt** (no float) so any node reproduces the identical winner.

## Boundaries & Constraints

**Always:**
- `drawWindow` is the **one** exported draw (AD-7): the block verifier (3.4) and **all tests import it — the `c^uptime` formula is never re-implemented** anywhere.
- The draw is a **pure function**: same `(tickets, challenge, weights)` ⇒ same winner, on every node, with no RNG source other than the committed nonces, no network-position term, no wall clock.
- **No `big.js`, no float** in `src/consensus`: the 2.5 `BIG_JS_ONLY_BOUNDARY` guard pins big.js to exactly `ledger/display.ts` + `ledger/fee.ts`. The argmin uses **BigInt only**.
- `protocol.proto` is **not** changed (AD-12); the `DrawTicket` interface is a *new* lightweight draw-input type that maps to the existing proto `Ticket` (1.4), it does not redefine the proto message.

**Never:**
- No `Math.log`/`Math.pow`/`Number(...)`/float literal in the argmin (non-deterministic across engines → fork risk). No `big.js` import.
- No re-implementation of the draw formula in any test (tests import `drawWindow`).
- No wall-clock or peer-id term in the winner. No re-invention of the proto `Ticket` shape (AD-12).
- Do not rewire the 3.2 tracer's fixed winner in this story — 3.4 wires verification; 3.3 ships the draw + challenge + interface + vectors only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DRAW_DETERMINISTIC | same `(tickets, challenge, weights)` called twice | identical `winnerIdentityId` (and `c`/`uptime`) both calls | No error |
| VECTORS | ≥3 pinned `(ticket set, challenge, weights) → winner` cases | each returns the pinned winner identityId | No error |
| PROPORTIONAL_RATE | 2 identities, uptime 1 vs 2, over many (seeded) draws | the uptime-2 identity wins at ≈ 2/3 (the exact AD-7 share) within a robust tolerance; strictly more than uptime-1 | No error |
| CHALLENGE_DERIVATION_PIN | `deriveWindowChallenge(fixedHash32, fixedWindow)` | a pinned 32-byte digest (committed constant) | No error |
| CHALLENGE_FORK_SENSITIVE | same window, two different `lastBlockHash` | two different 32-byte challenges | No error |
| DRAW_EMPTY_REJECTS | empty `tickets` (and empty `weights`) | throws | `DrawError` `SC-CONSENSUS-2` |
| DRAW_WEIGHT_MISMATCH_REJECTS | `tickets.length !== weights.length` | throws | `DrawError` `SC-CONSENSUS-2` |
| DRAW_BAD_WEIGHT_REJECTS | weight negative / non-integer / ≥ cap | throws | `DrawError` `SC-CONSENSUS-2` |
| INTERFACE | a `DrawTicket` constructed + passed to `drawWindow` via the barrel | accepted; `DrawTicket` + `drawWindow` + `deriveWindowChallenge` exported from `core/consensus` | No error |

## Code Map

- `packages/core/src/consensus/draw.ts` -- NEW: `DrawTicket` interface, `DrawError`, `drawWindow`, `deriveWindowChallenge`, and the exact-BigInt argmin + digest→c mapping.
- `packages/core/src/consensus/index.ts` -- barrel: additively re-export the draw surface (do not touch the E1/tracer exports).
- `packages/core/test/consensus-draw.test.ts` -- NEW: the I/O matrix tests (deterministic, vectors, proportional, challenge pin, error rows). Imports `drawWindow`/`deriveWindowChallenge` from the barrel only.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/consensus/draw.ts` -- implement `DrawTicket`, `DrawError` (`SC-CONSENSUS-2`), `deriveWindowChallenge(lastBlockHash, windowIndex)`, and `drawWindow(tickets, challenge, weights)` with the exact-BigInt argmin (minimize `c_num^W / 2^{256W}`, tie-break by smallest `identityId`) -- the single pinned draw (AD-7).
- [x] `packages/core/src/consensus/index.ts` -- additively export `DrawTicket`, `DrawError`, `drawWindow`, `deriveWindowChallenge` from `./draw.js` -- exposes the draw for the 3.4 verifier and tests.
- [x] `packages/core/test/consensus-draw.test.ts` -- unit-test every I/O matrix row (deterministic, ≥3 pinned vectors, proportional rate, challenge pin + fork-sensitivity, all three error rows, interface) -- proves the draw is reproducible, fair, and the interface is usable.

**Acceptance Criteria:**
- Given a well-formed `(tickets, challenge, weights)`, when `drawWindow` runs, then it returns the argmin `c^uptime` winner reproducibly (twice ⇒ identical) and the result is recomputable by any node from public data.
- Given the ≥3 pinned fixed vectors, when `drawWindow` runs on each, then each returns its pinned winner.
- Given two identities with uptime 1 vs 2 over many seeded draws, when `drawWindow` runs per draw, then the higher-uptime identity wins at the expected (≈ 2/3) proportional rate, strictly more than the lower-uptime identity.
- Given the block verifier / tests, when they need a winner, then they import `drawWindow` from the `core/consensus` draw surface — exposed via the package barrel (the suite's import convention) — never re-implementing the formula.
- Given a real proto `Ticket` (1.4), when epic 4 maps it, then it conforms to the `DrawTicket` interface without re-inventing the proto shape.

## Implementation Notes

- Decision (2026-10-06, build 3.3): the draw surface is exported from BOTH barrels — `consensus/index.ts` (the plan's named barrel) AND the root `src/index.ts` (additive, same pattern as the E1/tracer surfaces). The test file imports from the root package entry, matching every existing test in the suite (they all import from `../src/index.js`), so "import from the barrel only" holds for both barrels.
- Decision (2026-10-06, build 3.3): the Design Notes' "exact share = 3/4 (Gamma(1,2)→Beta(1,2))" is an arithmetic slip — `X_i = W_i·(−ln c_i)` with `c_i ~ U(0,1]` gives `X_i ~ Exp(1/W_i) = Gamma(1, W_i)` (shape 1, scale W), so the exact uptime-1-vs-2 win share is `∫₀¹ (1−u)·(1/2·√u) du = 2/3`, not 3/4. The plan's wide robust band `[0.60, 0.90]` covers either reading, so no plan change was needed; the pinned schedule below lands at 0.674 (near 2/3, as the exact math predicts). Flagged for the spec-correction note already pending on the epic.
- Decision (2026-10-06, build 3.3): PROPORTIONAL_RATE uses a fully deterministic schedule — per draw k: `lastBlockHash = sha256("window-k:lastBlockHash")`, `challenge = deriveWindowChallenge(lastBlockHash, k)` (so the challenge-derivation path is itself exercised), commitments = `sha256("ticket-A-k")` / `sha256("ticket-B-k")`. N = 4000; the pinned outcome (uptime-2 wins 2696, uptime-1 wins 1304) is committed as a constant so the test is bit-stable across runs/engines, plus the band + strict-inequality assertions. Band check is written in integer math (`BigInt(winsU2) * 100n` vs `60n/90n * N`) — no float anywhere in the test file.
- Decision (2026-10-06, build 3.3): vectors ship as 4 (≥3 required): V1 equal weights (1,1) plain argmin; V2 uptimes (1,2,1) higher-uptime win; V3 uptimes (0,1) zero-uptime-never-wins; V4 equal weights (3,3,3) over three tickets. `cNum` (the 256-bit numerator of `c`) is also pinned per vector — it is the exact public data any node recomputes.
- Decision (2026-10-06, build 3.3): `drawWindow` returns a `DrawResult` (`{ winnerIdentityId, cNum, uptime, index }`) rather than a bare id string — the plan's deterministic row requires identical "winner (and c/uptime)" and the 3.4 verifier will want the recomputable public data; the winner id is the `winnerIdentityId` field. `DrawResult` is exported alongside the plan-named surface (additive).
- One matrix row beyond the plan's table was added as a test (CHALLENGE_WINDOW_SENSITIVE: same hash, two window indices → distinct challenges) — the window-term half of the derivation, same spirit as CHALLENGE_FORK_SENSITIVE.

## Plan Change Log

## Review Triage Log

**Quick lens (1 pass, 2026-10-06): verdicts — 0 high, 0 medium, 3 low, 0 false, 0 maybe-false.** Code verified correct by two independent recomputations (all 4 vectors + the full 4000-draw schedule reproducing 2696/1304); every finding was plan-prose/path, no code change needed.

- F1 (low, patch): the proportional target was labelled "≈ ¾" in the I/O matrix `PROPORTIONAL_RATE` row and AC #3, but the exact AD-7 share is 2/3 (the subagent's Implementation Notes already flagged the slip; I had corrected only the Design Notes). Evidence: `∫₀¹(1−b²)db = 2/3`; the draw yields 0.674. Action: reworded both to "≈ 2/3".
- F2 (low, patch): AC #4 said tests import "from `core/consensus`" but the test imports from the root barrel (the suite-wide convention; the draw IS re-exported from `core/consensus`). Action: reworded the AC to "from the `core/consensus` draw surface — exposed via the package barrel". No rule break (no re-implementation).
- F3 (low, patch): `context:` listed `packages/core/src/proto/protocol.proto` (does not exist — `src/proto/` holds the generated `protocol.ts`). Action: corrected the path to `packages/core/proto/protocol.proto`.

## Design Notes

**Digest → c (the pinned mapping).** `c = H(nonceCommitment ‖ challenge)` where `H = sha256` over the concatenated bytes (commitment first, then challenge). Read the 256-bit digest as an integer `C ∈ [0, 2^256)` and set the numerator `c_num = C + 1n` so `c = c_num / 2^256 ∈ (0, 1]` (the `+1` excludes 0, which would otherwise make `c^W = 0` dominate every draw). `c_num` is the 256-bit numerator; `2^256` is the implicit denominator.

**Exact argmin (why no float).** Minimize `c^W = c_num^W / 2^{256·W}`. Two tickets `a` and `b` are compared exactly as BigInts:
`c_a^W_a < c_b^W_b  ⟺  c_num_a^{W_a} · 2^{256·W_b}  <  c_num_b^{W_b} · 2^{256·W_a}`.
This is a pure integer comparison — **no transcendental, no rounding** — so the winner is bit-identical on every engine/node (a public-coin draw that any full node must reproduce; `Math.pow`/`Math.log` are not correctly-rounded per IEEE-754 and would risk a fork). The scan is linear over the (small, per-window) ticket set; each comparison touches BigInts of ≈ `256·(W_a + W_b)` bits, trivial for realistic uptime weights (bounded by lookback L = 50 in practice).

**Tie-break.** If `c_a^{W_a}` equals `c_b^{W_b}` exactly (measure zero but must be defined), the smaller `identityId` (32-byte hex string, spine convention) wins, so every node picks the same identity.

**Challenge layout.** `deriveWindowChallenge(lastBlockHash: Uint8Array, windowIndex: bigint): Uint8Array` = `sha256(utf8("SC-CHALLENGE/1") ‖ lastBlockHash ‖ u64be(windowIndex))` — a 32-byte digest, AD-12 u64be, domain-separated. The `lastBlockHash` term makes a fork change the challenge (fork-replay dead by construction, R2); the `windowIndex` term gives chain-time window locality. `u64be`/range-guard mirrors `pow.ts` (out-of-range → `DrawError` `SC-CONSENSUS-2`).

**Weight semantics.** `weights[i]` is a non-negative integer uptime weight for `tickets[i]` (`W ≥ 0`; `W = 0` ⇒ `c^0 = 1`, the worst priority, so a zero-uptime identity never wins over any `W > 0`). Weights are **inputs** to the draw — deriving the weight from the lookback-L valid-ticket count (AD-4) happens where the accepted-ticket set is built (3.4 / epic 4), not here. Cap: weight must be `< 2^20` (programming guard; realistic values ≤ L = 50).

**Proportional test target (exact).** Under AD-7, winner = argmax of `X_i = W_i·(−ln c_i)` with `c_i ~ U(0,1]`; since `−ln c_i ~ Exp(1)`, `X_i ~ Gamma(1, W_i)` (shape 1, **scale** `W_i`, i.e. rate `1/W_i`). For the pinned 2-identity case (uptime `W=1` vs `W=2`) the exact higher-uptime win share is `P(X_2 > X_1) = λ_1/(λ_1+λ_2) = 1/(1+½) = **2/3**` (equivalently `∫₀¹(1−b²)db`). The test uses a **deterministic (seeded) nonce/challenge schedule** (no `Math.random`) over many draws and asserts the uptime-2 identity's empirical win rate falls in a wide, robust band around 2/3 (`[0.60, 0.90]`) — directionally exact and stable across runs.

## Verification

**Commands:**
- `corepack pnpm test` -- expected: all files pass; the new `consensus-draw.test.ts` suite green (deterministic + ≥3 vectors + proportional + challenge pin + 3 error rows).
- `corepack pnpm test no-float-guard` -- expected: `BIG_JS_ONLY_BOUNDARY` still reports big.js in exactly `['ledger/display.ts','ledger/fee.ts']` (the new `draw.ts` imports no big.js).
- `corepack pnpm typecheck` -- expected: clean.
- `corepack pnpm build && git diff --name-only -- packages/core/src/proto/` -- expected: build succeeds and the proto diff is EMPTY (byte-identical generated proto).
