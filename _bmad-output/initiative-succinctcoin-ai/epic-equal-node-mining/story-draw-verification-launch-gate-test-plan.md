---
title: 'Draw verification + launch gate test'
type: 'feature'
ticket: '4'
created: '2026-10-06'
status: 'built'
baseline_revision: 'be4fb04eddab1acdc7d039c454dcaebedd51f29b'
route: 'full'
route_source: 'pinned'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/initiative-succinctcoin-ai/epic-equal-node-mining/epic-equal-node-mining.md'
  - '{project-root}/packages/core/src/consensus/draw.ts'
  - '{project-root}/packages/core/src/consensus/slot-loop.ts'
  - '{project-root}/packages/core/src/consensus/miner.ts'
  - '{project-root}/packages/core/proto/protocol.proto'
  - '{project-root}/packages/core/test/consensus-tracer.test.ts'
---

## Intent

**Problem:** The 3.2 tracer hard-codes a winner and ships an empty ticket, so nothing proves a block's winner actually won the draw. To close R2 (verifiable election), block acceptance must verify the draw: a block is accepted only if its `(winnerTicket, nonce)` verify the draw for that slot's challenge + window, and the core suite must prove a node NOT selected by the draw cannot produce a valid block (the launch gate).

**Approach:** Add a `verifyDraw` seam in `core/consensus` that decodes a block's `winnerTicket` (proto `Ticket`, 1.4) and re-derives the AD-7 winner with the pinned `drawWindow` (3.3 — imported, never re-implemented) over the accepted ticket set, requiring the block's `winnerIdentityId` to equal the draw winner. Rewire `mineAndApply` so the node builds its per-window ticket, runs the draw, and mines for the draw winner with the winner's proto `Ticket` as `winnerTicket`. Ship the launch gate test (a forged, unselected block is rejected; a selected node's block is accepted) plus the accepted-set boundary rule (late tickets never invalidate an already-accepted block).

## Boundaries & Constraints

**Always:**
- **Draw verification imports `drawWindow`** (the one pinned draw, AD-7) — the winner is re-derived, never re-implemented. `verifyDraw` is a thin seam over `drawWindow` + `deriveWindowChallenge`.
- A block is accepted only if its `(winnerTicket, nonce)` verify the draw **for that slot's challenge + window**; the block's `winnerIdentityId` must equal both the decoded ticket's `identityId` and the re-derived draw winner.
- The **accepted-set boundary rule (AD-7)**: a block verifies against the ticket set present when it is accepted; a ticket arriving late (after the previous window's last block) never invalidates an already-accepted block — verification is a pure function of the set passed to it.
- The 3.2 tracer's public pins must keep holding: `mineBlock` is **untouched** (MINING_PATH_GUARD scans it); the single-node `mineAndApply` flow stays behavior-invariant (a lone ticket wins its own draw → `winnerIdentityId` is still `TRACER_WINNER_ID`).
- `protocol.proto` is NOT changed (AD-12); the block's `winnerTicket` carries the winner's proto `Ticket` in WIRE (protons) form.

**Never:**
- No re-implementation of the `c^uptime` formula anywhere (the verifier and all tests import `drawWindow`).
- No `big.js`/float in the new verification path (the 2.5 `BIG_JS_ONLY_BOUNDARY` guard pins big.js to `ledger/display.ts` + `ledger/fee.ts`).
- No wall clock, RNG (other than committed nonces), or network-position term in verification.
- Do not change `mineBlock`'s per-attempt loop or `BlockTemplate`'s public fields beyond what the tracer needs (MINING_PATH_GUARD + MINE_BLOCK pins).
- Do not loosen the launch gate: a node not selected by the draw MUST be unable to produce a block that passes `verifyDraw`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| VERIFY_ACCEPT_SELECTED | a block mined via the rewired `mineAndApply` (sole ticket) + its ticket set | `verifyDraw` returns true (winner verified) | No error |
| VERIFY_REJECT_UNSELECTED (launch gate) | a PoW-valid block whose `winnerIdentityId` is an identity NOT selected by the draw (forged) | `verifyDraw` returns false | No error (reject is the normal outcome) |
| VERIFY_REJECT_FORGED_COMMITMENT (launch gate) | a PoW-valid block claiming the draw **winner's** identity but with a `nonceCommitment` NOT in the accepted set (fabricated / empty / truncated) | `verifyDraw` returns false (the ticket is not one the window accepted) | No error |
| VERIFY_REJECT_BAD_TICKET | a block whose `winnerTicket` does not decode to a proto `Ticket`, or whose ticket `identityId` ≠ `winnerIdentityId` | `verifyDraw` returns false (or `DrawError` `SC-CONSENSUS-2` if the wire is structurally invalid) | No error (throw only for malformed wire) |
| CHALLENGE_MATCHES_SLOT | the verification challenge for slot `s` = `deriveWindowChallenge(parentHash, s)` | the challenge `mineAndApply` uses is the same one the verifier recomputes | No error |
| LATE_TICKET_NO_INVALIDATE | an already-verified block; then a new ticket is added to the set | the block still verifies against the set it was accepted with (verification is pure over the passed set); the late ticket only affects FUTURE windows | No error |
| REJECT_NONWINNER_IN_MULTISET | a 2+ ticket set where the block's `winnerIdentityId` is the NON-draw-winner (though PoW-valid) | `verifyDraw` returns false | No error |
| MINE_AND_APPLY_DRAW | `mineAndApply` on an empty store, then the block is verified against the node's ticket set | the mined block's `winnerIdentityId` = the draw winner and `verifyDraw` returns true | No error |

## Code Map

- `packages/core/src/consensus/verify-draw.ts` -- NEW: `verifyDraw(block, tickets, weights, challenge)` — decodes `winnerTicket`, checks `winnerIdentityId` agreement, and re-derives the AD-7 winner via `drawWindow` (imported).
- `packages/core/src/consensus/slot-loop.ts` -- rewire `mineAndApply`: derive the per-window challenge, build the node's proto `Ticket`, run `drawWindow` over the ticket set, and mine for the draw winner with the winner's `Ticket` encoded as `winnerTicket`.
- `packages/core/src/consensus/index.ts` -- additively export `verifyDraw` (and any new helper) from `./verify-draw.js`.
- `packages/core/src/index.ts` -- additively re-export `verifyDraw` at the package entry.
- `packages/core/test/consensus-verify-draw.test.ts` -- NEW: every I/O matrix row + the launch gate (forged unselected block rejected, selected block accepted).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/consensus/verify-draw.ts` -- implement `verifyDraw(block, tickets, weights, challenge)`: decode `block.winnerTicket` as a proto `Ticket`, then (1) require `ticket.identityId === block.winnerIdentityId` (ownership), (2) require the decoded winner ticket to be present in the accepted set by `(identityId, nonceCommitment)` (the block must present a ticket the window actually accepted — an unselected node cannot fabricate one), (3) require `ticket.windowIndex === block.slot` and `ticket.challenge === challenge` (the ticket is bound to the block's window), (4) map the accepted set to `DrawTicket`s, call `drawWindow(..., challenge, weights)`, and return true iff `draw.winnerIdentityId === block.winnerIdentityId` -- the single verification seam (imports `drawWindow`, AD-7).
- [x] `packages/core/src/consensus/slot-loop.ts` -- rewire `mineAndApply` to derive `challenge = deriveWindowChallenge(parentHash, slot)`, build the node's proto `Ticket` (identityId, windowIndex, challenge, nonceCommitment), run `drawWindow` over the ticket set (the node's ticket + any `otherTickets`), and `mineBlock` for the **draw winner** with the winner's `Ticket` encoded as `winnerTicket` -- so a mined block carries a verifiable ticket.
- [x] `packages/core/src/consensus/index.ts` + `packages/core/src/index.ts` -- additively export `verifyDraw` -- exposes verification for 3.7/3.9 and the launch gate test.
- [x] `packages/core/test/consensus-verify-draw.test.ts` -- unit-test every I/O matrix row: selected accepted, unselected (forged) rejected, bad/non-decoding ticket rejected, non-winner-in-multiset rejected, challenge-matches-slot, late-ticket-no-invalidate, and the end-to-end `mineAndApply`→`verifyDraw` -- proves block acceptance verifies the draw and the launch gate holds.

**Acceptance Criteria:**
- Given a block whose `(ticket, nonce)` verify the draw for its slot's challenge + window, when `verifyDraw` runs, then it is accepted (returns true).
- Given a PoW-valid block whose `(ticket, nonce)` do NOT verify the draw (an unselected/forged winner), when `verifyDraw` runs, then it is rejected (returns false).
- Given the launch gate test, when a node not selected by the draw attempts to produce a valid block, then that block fails `verifyDraw` (the test passes in the core suite).
- Given an already-accepted block and a ticket arriving late, when the block is re-verified against the set it was accepted with, then it still verifies (late tickets never invalidate an accepted block).
- Given the 3.2 tracer's pins, when the single-node `mineAndApply` runs, then its block still mines for `TRACER_WINNER_ID` and passes the unchanged `mineBlock`/MINING_PATH_GUARD.

## Implementation Notes

- **Decision (build, ticket 4): the tracer's `nonceCommitment` is DETERMINISTIC** — `sha256(utf8("SC-TRACER-COMMIT/1") ‖ parentHash ‖ u64be(slot))` (AD-12 digest form). The plan left it as "`<some committed bytes>`"; this is the value chosen so a rerun on the same chain reproduces the same ticket (no RNG, no wall clock, AD-3) while still being a genuine draw input. The PoW counter is the block's separate `nonce` field (AD-6); this commitment is a distinct draw input (Design Notes).
- **Decision (build, ticket 4): protons `Ticket.decode` is LENIENT (proto3) — the "malformed ticket" matrix row splits two ways.** `Ticket.decode` does NOT throw on an empty buffer (or some truncated-but-readable buffers); it returns all-default fields. It throws ONLY on structurally invalid wire (an invalid wire-type tag, or a length prefix that overruns the buffer). So `VERIFY_REJECT_BAD_TICKET` is pinned two ways: (a) a `winnerTicket` with structurally invalid wire → `Ticket.decode` throws → the seam re-throws `DrawError` `SC-CONSENSUS-2` (the only throw path); (b) an EMPTY `winnerTicket` → decodes to the proto3 default ticket (`identityId ""`) → `"" ≠ winnerIdentityId` → `verifyDraw` returns `false` (a normal reject, no error). Both are in the test; the plan's single "does not decode → false" row is satisfied by (b), and the throw path (a) is the seam's only error path.

## Plan Change Log

- **Loopback 1 (Quick lens, 2026-10-06) — bad_plan: the task text was WEAKER than the plan's own Never clause + AC #2/#3.** The verify-draw.ts task said "require `ticket.identityId === block.winnerIdentityId` … return true iff `draw.winnerIdentityId === block.winnerIdentityId`" — an identity-claim check only. But the plan's **Never** clause ("a node not selected by the draw MUST be unable to produce a block that passes `verifyDraw`") and **AC #2** ("a block whose `(ticket, nonce)` do NOT verify the draw … is rejected") require the **winner's ticket to be bound to the accepted set** — which the task omitted. The implementer followed the task literally, so an unselected node could claim the (public) draw winner's identity with a fabricated/empty `nonceCommitment` and pass (the lens confirmed empirically: forged commitment, empty commitment, and a truncated ticket all passed). Fix: `verifyDraw` now ALSO (a) requires the decoded winner ticket to be present in the accepted set by `(identityId, nonceCommitment)` and (b) binds `ticket.windowIndex === block.slot` and `ticket.challenge === challenge`. This is the strong (AC) reading; the task text + matrix + Design Notes are amended to match. **KEEP** (survives re-derivation): the single-node tracer invariance (the traced block satisfies the binding — its ticket is the sole set member and its window/challenge match), the single challenge source, the import-`drawWindow` discipline, and every 3.2 pin. Note: the *complete* launch gate (an unselected node replaying the winner's EXACT public ticket) is closed only when epic 4 verifies the `Ticket.signature` (empty for every ticket that exists today); the set- + window-binding closes all forgeries that do NOT reuse the winner's exact public ticket.

## Review Triage Log

**Quick lens (1 pass + 1 loopback, 2026-10-06): verdicts — 2 high, 2 medium, 3 low, 0 false, 0 maybe-false.** The lens found a REAL launch-gate hole (F1): the plan's task text was weaker than the plan's own Never clause + AC #2/#3, so the implementer's identity-claim-only `verifyDraw` let an unselected node claim the (public) winner's identity with a fabricated commitment and pass. Routed as a **bad_plan loopback**: the plan was corrected to the strong (ticket-binding) semantics, the code + tests were fixed, and the orchestrator independently re-verified the exact flagged scenario (forged/empty/truncated commitment → `false`) is now closed. All gates green after the loopback: 17 files / 139 tests, typecheck clean, build proto byte-identical, 3.2 tracer 12/12 intact, no-float-guard 6/6.

- F1 (high, patch): `verifyDraw` never bound the winner's ticket to the accepted set (or the block's window) — an unselected node could claim the draw winner's identity with a fabricated/empty/truncated `nonceCommitment` and pass. Evidence: lens reproduced empirically (set {X},{Y}, winner Y; a block claiming Y with a forged/empty/truncated commitment → `true`). Action: `verifyDraw` now ALSO requires the decoded winner ticket be present in the accepted set by `(identityId, nonceCommitment)` AND `windowIndex === block.slot` AND `challenge === challenge`. Closes F1 + F4.
- F2 (high, patch): the launch-gate test pinned only the "claims the loser" forgery, not the "claims the winner with a forged commitment" one. Action: added a `the STRONGEST forgery` case (fabricated + empty + truncated commitment for the winner's identity → `false`); now passes.
- F3 (medium, patch): `LATE_TICKET_NO_INVALIDATE` was vacuous (built `setWithLate` but never passed it to `verifyDraw`). Action: rewritten to prove purity deterministically via the set-binding — the same block verified against a set that lacks its own ticket (the late ticket) → `false`, while against its acceptance set S → `true`. (The initial "the late ticket flips the draw" assertion was commitment-specific and not guaranteed, so it was dropped in favor of the binding proof.)
- F4 (low, patch): the lenient-decode analysis missed a third path — a truncated ticket retaining `identityId` but dropping `nonceCommitment` decodes without throwing and (pre-binding) passed. Action: closed by the F1 binding; added a truncated-ticket → `false` case to the strongest-forgery test.
- F5 (low, patch): the test's `idOf` yielded 36-char (later 68-char) ids under a "32-byte-hex" comment. Action: `idOf` now yields exactly 64 hex chars; the truncated-ticket length prefix is derived from the id length. (The first fix over-padded to 68 and tripped a protons `RangeError` — corrected.)
- F6 (medium, patch): the multi-ticket `MINE_AND_APPLY_DRAW` fixture used a fixed `challenge` for the other node's ticket, so it passed only because the ticket's window/challenge were unchecked. Action: the fixture now precomputes the deterministic fresh-store window (slot 0, 32-zero parent) and builds the other node's ticket with the REAL window challenge BEFORE mining; the test asserts the window-bound acceptance (`true`) and a wrong-window-challenge reject (`false`).
- F7 (low, patch): the `@param challenge` JSDoc overstated the seam as "recomputing" the challenge. Action: corrected to "the CALLER recomputes and passes it; the seam receives it."

## Design Notes

**Verification = a thin seam over `drawWindow`, with the winner's ticket bound to the set + window.** `verifyDraw(block, tickets, weights, challenge)` (1) decodes `block.winnerTicket` with the protons `Ticket` codec into the winner's proto `Ticket` (the ONLY throw path = a wire that fails to decode → `DrawError`/`SC-CONSENSUS-2`); (2) requires `ticket.identityId === block.winnerIdentityId` (ownership — a block cannot claim a ticket it doesn't own); (3) **binds the winner ticket to the accepted set**: `ticket` must be present in `tickets` by `(identityId, nonceCommitment)` AND `ticket.windowIndex === block.slot` AND `ticket.challenge === challenge` (the block must present the window's actual winning ticket — this is what stops an unselected node from fabricating a ticket); (4) maps the accepted set to `DrawTicket`s (`{identityId, nonceCommitment}`); (5) calls `drawWindow(drawTickets, challenge, weights)`; (6) returns true iff `result.winnerIdentityId === block.winnerIdentityId`. A reject is a normal `false`, not an error — the 65535/65536 PoW outcome and a draw reject are both expected.

**Challenge = the slot's challenge.** The block's parent hash + slot fix its challenge: `challenge = deriveWindowChallenge(block.parentHash, block.slot)`. `mineAndApply` uses exactly this (parentHash + slot from `nextSlotAndParent`), so the challenge a block is mined under is the one the **caller** hands `verifyDraw` (recomputed as `deriveWindowChallenge(block.parentHash, block.slot)`) — a single source, no separate channel. `verifyDraw` **receives** the challenge as a parameter; it does NOT recompute it (a caller passing a wrong/stale challenge gets a silent `false`, not an error — the CHALLENGE_MATCHES_SLOT test pins the byte-equality + slot-sensitivity).

**The block carries the winner's proto `Ticket` (wire form, AD-12).** `mineAndApply` builds the node's `Ticket` (`{identityId, windowIndex, challenge, nonceCommitment, signature}`) and encodes the **draw winner's** `Ticket` into `block.winnerTicket` via the protons codec. `nonceCommitment` is the draw input; for the tracer the signature is empty (epic 4 verifies it). The PoW counter is the block's separate `nonce` field (AD-6) — the `Ticket.nonceCommitment` is a distinct commitment the draw hashes, not the PoW counter.

**The tracer stays behavior-invariant (single ticket).** With one ticket (the node's own) and weight ≥ 1, `drawWindow` returns that ticket's identity — so the rewired `mineAndApply` still mines for `TRACER_WINNER_ID` and every 3.2 pin (`winnerIdentityId`, `totalSupply`, chain extension, MINING_PATH_GUARD) holds unchanged. `mineAndApply` gains an optional `otherTickets` (with weights) so a multi-ticket draw can be exercised; the default (empty) keeps the existing one-node flow identical.

**Launch gate = forge + reject (two forgery shapes).** The test mines PoW-valid blocks (so PoW is never the thing failing): (1) a block whose `winnerIdentityId` is an identity NOT the draw winner → `verifyDraw` false; (2) a block claiming the draw **winner's** identity but with a `nonceCommitment` that is NOT in the accepted set (fabricated / empty) → `verifyDraw` false (this is the shape the binding closes). Both prove an unselected node cannot produce a block that passes verification — the R2 launch gate. **Scope note (documented, not a defect):** an unselected node replaying the winner's **exact** public ticket (same identityId + nonceCommitment, which any node can read off the chain) still passes the set- + window-binding; that residual replay is closed only when **epic 4 verifies the `Ticket.signature`** (identity-bound, over `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)`, AD-12). Every ticket that exists in epic 3 has an EMPTY signature, so the full gate is the 3.4 + epic-4 combination; 3.4 closes every forgery that does not reuse the winner's exact public ticket.

**Accepted-set boundary rule (AD-7, the ticket's `unknown`).** The draw's input set is "tickets accepted at or before the previous window's last block" (a fixed chain point). `verifyDraw` is a pure function of the set passed to it: a block already verified against set S stays valid for S, and a late ticket arriving after the window boundary is simply not in S — it cannot retroactively flip the winner. This is structural (the verifier uses only the set handed to it), so the rule holds by construction; the LATE_TICKET_NO_INVALIDATE test pins it.

## Verification

**Commands:**
- `corepack pnpm test` -- expected: all files pass; the new `consensus-verify-draw.test.ts` suite green AND the existing `consensus-tracer.test.ts` (3.2 pins) still green.
- `corepack pnpm test no-float-guard` -- expected: `BIG_JS_ONLY_BOUNDARY` still reports big.js in exactly `['ledger/display.ts','ledger/fee.ts']` (no new big.js import).
- `corepack pnpm typecheck` -- expected: clean.
- `corepack pnpm build && git diff --name-only -- packages/core/src/proto/` -- expected: build succeeds and the proto diff is EMPTY (byte-identical generated proto).
