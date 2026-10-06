---
title: 'Difficulty / target adjustment spike (E1)'
type: 'feature'
ticket: '1'
created: '2026-10-05'
status: 'built'
route: 'full'
route_source: 'auto'
baseline_revision: 'b1808795a7059920e1194f1d0c593f1f3b09e24c'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The tracer (3.2) needs a PoW target + adjustment rule (E1) but none exists; the draw (3.3) is the real winner selector, so the PoW must stay a *genuine but trivially-reachable* per-attempt hash check (≥1 hash per slot on commodity hardware).

**Approach:** Measure per-attempt sha256 throughput at the canonical `Block` size, settle a fixed leading-zero-bits target + a fixed-at-launch adjustment rule as the consensus constant, and ship the canonical-encoding + PoW-check seam (with a pinned vector) that the tracer's mining loop and the block-hash math build on.

## Boundaries & Constraints

**Always:**
- Per-attempt hashing uses ONLY `node:crypto` sha256 + a plain integer counter (AD-6); no `big.js`, no pure-JS keccak.
- The target + adjustment rule are recorded as a Decision in the epic Notes, and the constant is the one the PoW check uses.
- The canonical `Block` encoding uses big-endian fixed-width integers (AD-12) and is the exact byte set the block hash (3.2) and the PoW check both hash.

**Never:**
- No retargeting / difficulty-adaptation logic in this spike (fixed target at launch).
- No per-attempt work beyond a single sha256 (the draw, not the PoW, selects the winner).
- No `createCore` / slot-loop / applyBlock wiring (3.2+).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CANONICAL_HEX | the pinned fixed block (slot/parent/id/ticket/nonce/txCount) | `canonicalBlockBytes` = the exact pinned hex (BE fixed-width ints, proto field order) | No error |
| POW_PASS | a mined block whose sha256(canonical bytes) has ≥ 16 leading zero bits | `powCheck` true | No error |
| POW_REJECT | a block whose digest has < 16 leading zero bits | `powCheck` false (not an exception) | No error |
| COUNTER_ROUNDTRIP | the pinned block's nonce counter | round-trips through the u64be field in the canonical bytes | No error |

</frozen-after-approval>

## Code Map

- `packages/core/proto/protocol.proto` — `Block` message (read): field order slot(1) parentHash(2) winnerIdentityId(3) winnerTicket(4) nonce(5) hash(6) txCount(7). AD-12: ints BE fixed-width inside digests.
- `packages/core/src/proto/protocol.ts` — generated `Block` type (read); the spike works from raw fields (no protons encode in the per-attempt path — canonical form is hand-built per AD-12, distinct from the varint wire form pinned by the golden vector).
- `packages/core/src/consensus/pow.ts` — NEW: `POW_TARGET_LEADING_ZERO_BITS`, `canonicalBlockBytes(block)`, `powCheck(block)`, `leadingZeroBits(buf)`.
- `packages/core/src/consensus/index.ts` — NEW: re-export the pow seam.
- `packages/core/src/index.ts` — additive re-export of the pow seam (createCore untouched).
- `packages/core/test/consensus-pow.test.ts` — NEW: matrix + a "target is trivially reachable" mine loop.
- `bench/pow-bench.js` — NEW: standalone per-attempt throughput + time-to-find at the canonical size (AD-6 throughput evidence).
- `_bmad-output/.../epic-equal-node-mining/epic-equal-node-mining.md` — Notes: add the target + adjustment-rule Decision.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/consensus/pow.ts` — define `canonicalBlockBytes` (BE fixed-width, proto field order, hash field EXCLUDED from the digest input), `POW_TARGET_LEADING_ZERO_BITS`, `leadingZeroBits`, `powCheck` (sha256 of canonical bytes) — the canonical-encoding + PoW seam 3.2 builds on.
- [x] `packages/core/src/consensus/index.ts` + `packages/core/src/index.ts` — re-export the pow seam (createCore untouched).
- [x] `packages/core/test/consensus-pow.test.ts` — pin the CANONICAL_HEX vector; assert POW_PASS/POW_REJECT; assert a mine loop reaches a passing nonce with a bounded attempt budget (target trivially reachable).
- [x] `bench/pow-bench.js` — measure per-attempt sha256 throughput at the canonical size + time-to-find at the target (watchdog + exit 0, mirror `bench/bench.js`).
- [x] `epic-equal-node-mining.md` Notes — record the chosen target + fixed-at-launch adjustment rule as a Decision.

**Acceptance Criteria:**
- Given a fixed block, when `canonicalBlockBytes` is called, then it equals the pinned BE-fixed-width hex exactly.
- Given a block whose canonical digest has ≥16 leading zero bits, when `powCheck` is called, then it returns true; a block with fewer returns false.
- Given the target, when a mining loop increments the integer counter, then it finds a passing nonce within a bounded budget (target trivially reachable on this hardware).

## Implementation Notes

- **Delivered (E1, AD-6/AD-12):** `src/consensus/pow.ts` — `POW_TARGET_LEADING_ZERO_BITS = 16` (the fixed-at-launch consensus constant), `canonicalBlockBytes(block)` (BE fixed-width, proto field order, `hash` EXCLUDED; the counter is the `u64be(nonce)` field — the AD-12 DIGEST canonical the golden-vector comment deferred to this epic), `blockDigest(block)` (sha256 of canonical bytes = the 3.2 block-hash input), `powCheck(block)` (≥N leading zero bits; boolean for a well-formed block), `leadingZeroBits`, `PowError` (`SC-POW-1` on a malformed canonical field). Barrel `src/consensus/index.ts` + additive `src/index.ts` re-export (`createCore` untouched). Per-attempt path = `node:crypto` sha256 + integer counter only (no big.js/keccak/protons-encode).
- **Pinned vector:** CANONICAL_HEX = 322 bytes (u64be(42) ‖ parent(32) ‖ utf8(id,64) ‖ ticket(202) ‖ u64be(7) ‖ u64be(3)); the ticket is built from its proto PARTS (the golden vector's values) so the digest pin and wire pin share the same block. FIXED_DIGEST (nonce 7, lzb 0 → natural POW_REJECT); PASS_NONCE 76735 → digest `0000f2…` (exactly 16 leading zeros → POW_PASS).
- **Nonce shape decision (forced by AD-6/AD-12):** the PoW counter is an 8-byte BE u64be field, DISTINCT from the golden vector's 32-byte `bytes` nonce (a commitment, wire form). `canonicalBlockBytes` re-encodes the nonce field to u64be (accepts ≤8 bytes with leading zeros; empty/>8 → `SC-POW-1`). The tracer (3.2) must store the counter in this same BE form. This is a deliberate, documented divergence — NOT a bug (see Review Triage Log, finding 1).
- **Bench:** `bench/pow-bench.js` (standalone, mirrors `bench/bench.js`) — per-attempt throughput at the exact 322-byte canonical size (1.33M hashes/s here) + time-to-find at N=16 (best 58 ms over 76736 attempts ≈ 2^16) → `targetTriviallyReachable: true`. Its `pow-bench-results.json` is gitignored (added to `.gitignore`, mirroring the 1.6 precedent for `bench-results.json`).
- **Decision recorded** in epic Notes: target = N=16 leading zero bits, fixed at launch, NO retargeting (the AD-7 draw — not the PoW — selects the winner, so difficulty carries no economic pressure; a fixed target keeps ≥1 hash/slot trivially reachable).
- **Verification:** `corepack pnpm test` 104/104 (14 files, +8 consensus-pow), `typecheck` clean, `build` clean + protons byte-identical (no proto change), `node bench/pow-bench.js` exit 0. **Matrix audit:** all 4 frozen rows (CANONICAL_HEX / POW_PASS / POW_REJECT / COUNTER_ROUNDTRIP) covered by passing tests (plus TARGET / TRIVIALLY_REACHABLE / SEAM / GUARD).

## Plan Change Log

- (2026-10-05, step-04 quick lens) — finding 1 (test header claimed the digest pin and the golden-vector wire pin "derive from the same fixed block"; the golden block's nonce is 32 bytes while the seam's counter is an 8-byte u64be, so the two pins differ on the nonce field, and `powCheck` throws `SC-POW-1` on a >8-byte nonce rather than returning false). Root cause outside the frozen block (a doc/contract-precision gap, not an intent gap) → amended the NON-FROZEN test header to state the two pins share every field EXCEPT the nonce shape (32-byte wire commitment vs 8-byte digest counter), and amended the NON-FROZEN `powCheck` doc to say it is not total over every `Block` (a malformed canonical field throws `SC-POW-1`; the tracer always builds well-formed blocks). Known-bad state avoided: a reader trusting "same fixed block" or "never throws" would mis-model the seam's contract for the 3.2 tracer. KEEP: the 322-byte BE-fixed-width canonical layout, the pinned hex/digests, the `hash`-excluded digest input, and the `POW_REJECT` "returns false on a well-formed block" behavior (unchanged). No code-behavior change (docs only); re-verified 104/104.

## Review Triage Log

- **Quick lens, pass 1 — 3 findings (2 patched [low], 1 rejected [low]):**
  1. `test/consensus-pow.test.ts` header + `pow.ts` `canonicalBlockBytes` — the two shipped canonical pins disagree on the `nonce` field shape and the test header overstates they are "the same fixed block" (golden nonce = 32-byte commitment, seam counter = 8-byte u64be; `powCheck(goldenBlock)` throws `SC-POW-1` on >8-byte nonce). **Verdict: low** (verified: `golden-vector.test.ts` pins `block.nonce.byteLength === 32`; the seam requires ≤8; the well-formed-block `POW_REJECT` "returns false" contract is unaffected). **Route: patch** — corrected the test header (shares every field EXCEPT nonce shape) + the `powCheck` doc (not total over every `Block`).
  2. `bench/pow-bench.js` — the AD-6 throughput evidence hardcodes the 322-byte layout + N=16 rather than importing `POW_TARGET_LEADING_ZERO_BITS` / `canonicalBlockBytes`, so it can silently drift from `pow.ts` (currently matches by manual sync). **Verdict: low** (verified: the bench is standalone JS, not exercised by `pnpm test`; it matches today). **Route: reject** — a low maintainability note; the fix adds complexity (a standalone bench cannot import the TS core, and the target is fixed-at-launch so it is unlikely to change), and it is unlikely users/developers will meet the drift in everyday use. No patch.
  3. `pow.ts` `powCheck` doc — "never throws on a failing check" is imprecise: `powCheck` → `blockDigest` → `canonicalBlockBytes` throws `SC-POW-1` on a malformed canonical field (empty / >8-byte nonce, out-of-range slot / txCount). **Verdict: low** (verified: no try/catch in `powCheck`; the well-formed-block reject path correctly returns `false`). **Route: patch** — doc now states the boolean contract holds for a well-formed block and the malformed-field throw is a programming error the tracer never hits. (Same root cause as finding 1's nonce-contract overstatement; patched with it.)

## Review Triage Log

## Design Notes

- **Why leading-zero-bits, not a target-number comparison:** the check is `sha256(canonical bytes)` and the target is "≥ N leading zero bits" — a single integer constant, no float, no per-protocol big-integer compare. N=16 ⇒ 1/65536 expected attempts.
- **Why the hash field is excluded from the digest input:** the block hash is `sha256(canonical bytes)` where canonical bytes = all `Block` fields EXCEPT `hash` (a hash cannot include itself). The full canonical encoding = canonical bytes ‖ hash. So the PoW check and the 3.2 block-hash math hash the SAME bytes; the PoW check is just "that digest has ≥ N leading zeros." The counter is a field of those bytes (AD-6: counter included as a field).
- **Canonical layout (BE fixed-width, AD-12, proto field order):** `u64be(slot) ‖ parentHash(32) ‖ utf8(winnerIdentityId) ‖ winnerTicket ‖ u64be(nonce) ‖ u64be(txCount)`. `nonce`/`slot`/`txCount` are the BE fixed-width digest form (the AD-12 "digest canonical" serialization the golden-vector comment defers to epic 3 — this is where it lands).
- **Input type:** `canonicalBlockBytes(block: Block)` and `powCheck(block: Block)` take the generated `Block` (imported from `../proto/protocol.js`) and read its fields directly — they do NOT call protons `encode` (the varint wire form is a distinct serialization; the canonical digest form is hand-built here per AD-12).
- **Fixed-at-launch rule (no retarget):** the draw (AD-7), not the PoW, selects the winner, so difficulty has no economic pressure; a fixed target keeps "≥1 hash/slot on commodity hardware" trivially true. Any change is a protocol version bump (AD-7/AD-12).
- **Target value:** N=16 leading zero bits. Measured on the build machine ~1.9M hashes/s at ~308B; 1/65536 expected ≈ 5 ms here, tens of ms on commodity hardware — far under any 1-slot budget, yet a genuine 2^16 search space (not a no-op).

## Verification

**Commands:**
- `corepack pnpm test` -- expected: all prior + the new consensus-pow matrix green.
- `corepack pnpm typecheck` -- expected: clean.
- `corepack pnpm build` -- expected: clean, protons regen byte-identical (no proto change).
- `node bench/pow-bench.js` -- expected: prints per-attempt hashes/s + time-to-find at the target, exits 0 (target trivially reachable).
