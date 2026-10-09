---
ticket: "9"
title: "Refactor sweep"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "0768fb49f63af2fec1eba164fbf709a9908644c9"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: []
context:
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/uptime.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/consensus/sim.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/consensus/economics.ts
  - packages/core/src/consensus/multi-sim.ts
  - packages/core/src/identity/reattestation.ts
  - packages/core/src/index.ts
  - packages/core/test/consensus-draw.test.ts
  - packages/core/test/consensus-verify-draw.test.ts
  - packages/core/test/simulation.test.ts
  - _bmad-output/initiative-succinctcoin-ai/deferred-work.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
---

# Story Plan — 4.9 Refactor sweep

## Story of truth

Run the **closing refactor sweep** for epic 4 (operator-identity / CAP-2). Scope is
**cleanup only** — set from the epic's build records and the deferred-work list. The
sweep must **confirm the identity suite is green headless**: `pnpm test` and `pnpm
build` pass in plain Node; the identity invariants (acceptance cap, uptime lookback,
re-attestation, GateVerifier offline, ticket signature) and the AD-4 / AD-7 / AD-11 /
AD-12 guards hold; and **no capability logic was added**.

## What the survey found (orchestrator, read-only, at baseline `0768fb4`)

Epic 4 is fully built (4.1–4.8). The modules were written **during** the epic, so
their comments narrate the epic in the FUTURE TENSE ("epic 4 derives it", "4.8 wires
these in", "epic 4 conforms real tickets to it"). Those are now **done** — the
forward-looking phrasing is stale. This is the same class of drift 3.8 cleaned for
epic 3 (11 frozen comment/JSDoc fixes, zero non-comment lines changed).

**Class A — 13 stale "epic 4" forward-references** (now past tense):

| # | File | Line | Stale text (fragment) | Fix (fragment) |
|---|------|------|-----------------------|----------------|
| 1 | `src/consensus/draw.ts` | 29 | "epic 4 conforms real tickets to it." | "epic 4 (4.3, `protoTicketToDrawTicket`) conforms real tickets to it." |
| 2 | `src/consensus/draw.ts` | 39 | "(3.4 / epic 4), not the draw." | "(3.4 / 4.3), not the draw." |
| 3 | `src/consensus/uptime.ts` | 16 | "the sim (4.8 wires these derived weights into the multi-identity accepted-set construction, replacing the fixed `SimNode.uptime` inputs)" | "the sim (4.8 has wired these derived weights into the multi-identity accepted-set construction, replacing the fixed `SimNode.uptime` inputs)" |
| 4 | `src/consensus/slot-loop.ts` | 42 | "epic 4 derives it from the lookback window" | "4.5/4.8 derive it from the lookback window" |
| 5 | `src/consensus/slot-loop.ts` | 60 | "(epic 4 verifies it; the tracer signs nothing)" | "(4.3/4.8 verify it; the tracer still signs nothing)" |
| 6 | `src/consensus/verify-draw.ts` | 103 | "closed when epic 4 verifies the identity-bound Ticket.signature." | "closed by 4.3's `acceptBlockWinner`, which composes `verifyDraw` with the identity-bound `verifyTicketSignature` (4.2/AD-12)." |
| 7 | `src/consensus/sim.ts` | 28 | "the pre-epic-4 stand-in for a real gate-verified ticket (epic 4)" | "the pre-epic-4 stand-in for a real gate-verified ticket (epic 4 now ships 4.2's signed tickets)" |
| 8 | `src/consensus/sim.ts` | 31 | "weights are inputs; epic 4 derives real weights from the lookback window" | "weights are inputs; 4.5/4.8 derive real weights from the lookback window" |
| 9 | `src/consensus/sim.ts` | 54 | "the pre-epic-4 stand-in for 'valid tickets over lookback L'" | "the pre-epic-4 stand-in for 'valid tickets over lookback L' (4.5 derives it)" |
| 10 | `src/consensus/sim.ts` | 126 | "`signature` = empty (epic 4 verifies it — the epic-3 convention, 3.4)" | "`signature` = empty (4.3/4.8 verify a real signature — this harness keeps the epic-3 empty-signature convention, 3.4)" |
| 11 | `test/consensus-draw.test.ts` | 289 | "the proto `Ticket` (1.4) maps to this shape in epic 4 without re-inventing the proto message (AD-12)" | "…maps to this shape via 4.3's `protoTicketToDrawTicket` without re-inventing the proto message (AD-12)" |
| 12 | `test/consensus-verify-draw.test.ts` | 139 | "`signature` empty (epic 4 verifies it)" | "`signature` empty (this epic-3 harness predates 4.2's signature; 4.3/4.8 verify a real one)" |
| 13 | `test/simulation.test.ts` | 318 | "empty signature (epic 4 verifies it — the epic-3 convention)" | "empty signature (4.3/4.8 verify a real signature — this harness keeps the epic-3 convention)" |

**Class B — 1 wrong-AD-number slip (a real doc bug):**

| # | File | Line | Stale text | Fix |
|---|------|------|-----------|-----|
| 14 | `src/consensus/draw.ts` | 180 | "deriving a weight from the lookback-L valid-ticket count (**AD-4**) happens where the accepted-ticket set is built (3.4 / epic 4), not here." | The weight is a **draw input** — the pinned pure-function contract is **AD-7** ("Verifiable draw is one pinned pure function"), NOT AD-4 ("Identity is protocol; gate is external and offline"). Fix to "(**AD-7**) … (4.5/4.8), not here." |

**Verified NOT stale (left unchanged):**
- `src/consensus/economics.ts:17` — "the inception deferred so it cannot collide with epic 4's genesis/proto edits; a future genesis fee field would REPLACE this constant in a **later epic**." Epic 4 added **no** genesis fee field (verified); the "later epic" forward-ref is still accurate. KEEP.
- `src/consensus/apply-block.ts:29/32/50` — "epic 5's ledger path" / "Carrying real, verified txs through the loop is epic 5." Epic 5 is **not built**. KEEP.
- `src/consensus/reattestation.ts:43/142` — "4.8 wires the cadence + lapse gate" / "max(oldDeadline, W+K) (4.8's sim wiring)". 4.8 **is built** and does exactly this (verified in `multi-sim.ts`); the references are accurate facts, not forward promises. KEEP (past-tense-adjacent, no drift).
- `src/consensus/slot-loop.ts:19` — "3.5 wires this into the `createCore` lifecycle" — past-tense historical narration (3.5 is done). KEEP.
- `src/consensus/sim.ts:7/28` — "epic 5 adds …" (the network) — epic 5 not built. KEEP.
- `src/ports.ts:91`, `src/index.ts:116/162`, `src/events/types.ts:11` — epic-5 / read-API forward-refs (epic 5/6 not built). KEEP.
- `src/consensus/index.ts:66/75` — "the sim (4.8 wires it into the multi-identity accepted-set construction)" — 4.8 is built; accurate fact. KEEP.
- The `AD-4` references in `test/identity-re-attestation.test.ts` and `test/identity-gate.test.ts` are **correct** (AD-4 genuinely is "gate is external and offline"). KEEP.

**Class C — deferred-work bookkeeping:**

Add ONE **OPEN** entry to `_bmad-output/.../deferred-work.md` carrying the u64be /
bytesToBig / concat byte-helper DRY extraction across `pow.ts` + `draw.ts`, deferred
since the 3.8 sweep. Rationale to record: `pow.ts` and `draw.ts` are **pinned**
AD-6/AD-7 modules with golden vectors + import-scan guards (the 2.5 no-float guard +
3.9 mining-path guard scan their import surfaces); the helpers are coupled to each
module's own error codes and constants, so a shared extraction would either duplicate
those or risk the guards. Defer to a dedicated byte-helper sweep (or epic 5, which
touches the wire path). This is a **note, not a change** — the code is untouched.

## Acceptance criteria

- **AC-1 — Class A:** all 13 stale "epic 4" forward-references reworded to past
  tense / precise story-number, per the frozen table above. Each fix is a
  **comment/JSDoc-only** line.
- **AC-2 — Class B:** `draw.ts:180`'s AD-number corrected AD-4 → AD-7 (and its
  "3.4 / epic 4" → "4.5/4.8"), comment-only.
- **AC-3 — Class C:** exactly ONE new **OPEN** deferred-work entry (u64be DRY), with
  the rationale; the three existing RESOLVED notes are left byte-identical.
- **AC-4 — No code changed:** `git diff <baseline>` over `packages/core/src` and
  `packages/core/test` contains **zero non-comment, non-whitespace lines** — i.e. the
  comment-only filter leaves an empty diff. No function body, signature, import,
  export, constant, or literal changed. No new source file.
- **AC-5 — Green headless:** `pnpm test` and `pnpm build` pass in plain Node; the
  identity invariants (acceptance cap, uptime lookback, re-attestation, GateVerifier
  offline, ticket signature) and the AD-4/AD-7/AD-11/AD-12 guards hold; the test
  count is **unchanged** (203 tests / 29 files) — the sweep adds no tests.

## Never (hard constraints)

- NEVER add or change capability logic: no new function, no changed expression, no
  changed literal, no changed import/export. Comment/JSDoc + the one deferred-work.md
  entry only.
- NEVER touch `pow.ts`, `draw.ts` **code** (only `draw.ts`'s comments), `economics.ts`,
  `proto/`, `protocol.proto`, `ports.ts`, the genesis seam, or `config/genesis.json`.
- NEVER weaken or edit any guard test (the 2.5 no-float guard, the 3.9 mining-path
  guard, the 4.1 blob-reading scan, the 4.7 key-material scan, the 4.x identity
  invariants). They must stay green and byte-identical.
- NEVER reword the KEEP items listed under "Verified NOT stale" (economics, apply-block
  epic-5 refs, reattestation 4.8 facts, ports/index/events forward-refs, the correct
  AD-4 test refs).
- NEVER change the proto (the build must regenerate it byte-identical).

## Verification (acceptance gate)

Run from the repo root (use `corepack pnpm`; `pnpm` is not on PATH). After the edit,
ALL of these must be green:

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → **203 tests / 29 files**
   (unchanged).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1 && git diff --name-only -- packages/core/src/proto/ && echo PROTO_OK`
   → empty proto diff + `PROTO_OK` (byte-identical regeneration).
4. **Comment-only proof:** the diff over `packages/core/src` and `packages/core/test`
   has zero non-comment lines. Verify by confirming every changed hunk is within a
   `* …` / `//` / `/* */` region and the build is byte-identical (step 3) with the
   test count unchanged (step 1).
5. **Determinism:** run the full suite twice; both runs 203/203 (no flake introduced).

## Frozen replacements (exact `oldString` → `newString`, all comment/JSDoc-only)

Apply EXACTLY these 14 edits (each `oldString` occurs once; whitespace/indentation must match the file). No other line changes.

1. `src/consensus/draw.ts`
   - old: ` * redefined here); epic 4 conforms real\n * tickets to it.`
   - new: ` * redefined here); epic 4 (4.3,\n * \`protoTicketToDrawTicket\`) conforms real tickets to it.`
   - old: ` * \`challenge\`, and \`signature\` fields are owned by verification (3.4 /\n * epic 4), not the draw.`
   - new: ` * \`challenge\`, and \`signature\` fields are owned by verification (3.4 /\n * 4.3), not the draw.`
2. `src/consensus/draw.ts` (Class B — AD-number slip)
   - old: ` * deriving a weight from the lookback-L valid-ticket count (AD-4) happens\n * where the accepted-ticket set is built (3.4 / epic 4), not here.`
   - new: ` * deriving a weight from the lookback-L valid-ticket count (AD-7) happens\n * where the accepted-ticket set is built (4.5/4.8), not here.`
3. `src/consensus/uptime.ts`
   - old: ` * acceptance cap (4.4), the acceptance seam (4.3), the sim (4.8 wires these\n * derived weights into the multi-identity accepted-set construction, replacing`\n   - new: ` * acceptance cap (4.4), the acceptance seam (4.3), the sim (4.8 has wired these\n * derived weights into the multi-identity accepted-set construction, replacing`
4. `src/consensus/slot-loop.ts`
   - old: ` * non-negative integer uptime weight (draw input; epic 4 derives it from\n * the lookback window).`
   - new: ` * non-negative integer uptime weight (draw input; 4.5/4.8 derive it from\n * the lookback window).`
   - old: ` * (epic 4 verifies it; the tracer signs nothing).`
   - new: ` * (4.3/4.8 verify a real signature; the tracer — the single-node\n * 3.5 loop — signs nothing).`
5. `src/consensus/verify-draw.ts`
   - old: ` //    residual case closed when epic 4 verifies the identity-bound\n //    Ticket.signature.)`
   - new: ` //    residual case closed by 4.3's \`acceptBlockWinner\`, which composes\n //    \`verifyDraw\` with the identity-bound \`verifyTicketSignature\` (4.2, AD-12).)`
6. `src/consensus/sim.ts`
   - old: ` * and challenge is a pinned \`sha256\` of public data. \`syntheticTicket\` is the\n * pre-epic-4 stand-in for a real gate-verified ticket (epic 4): its`
   - new: ` * and challenge is a pinned \`sha256\` of public data. \`syntheticTicket\` is the\n * pre-epic-4 stand-in for a real gate-verified ticket (epic 4 now ships 4.2's\n * signed tickets): its`
   - old: ` * weights are fixed inputs** to the draw (AD-7: weights are inputs; epic 4\n * derives real weights from the lookback window).`
   - new: ` * weights are fixed inputs** to the draw (AD-7: weights are inputs; 4.5/4.8\n * derive real weights from the lookback window).`
   - old: ` * the draw — the pre-epic-4 stand-in for\n * "valid tickets over lookback L\`)."
   - new: ` * the draw — the pre-epic-4 stand-in for\n * "valid tickets over lookback L" (4.5 derives it)."
   - old: ` *   - \`signature\` = empty (epic 4 verifies it — the epic-3 convention, 3.4).`
   - new: ` *   - \`signature\` = empty (4.3/4.8 verify a real signature — this harness\n *     keeps the epic-3 empty-signature convention, 3.4).`
7. `test/consensus-draw.test.ts`
   - old: `    // proto \`Ticket\` (1.4) maps to this shape in epic 4 without\n    // re-inventing the proto message (AD-12).`
   - new: `    // proto \`Ticket\` (1.4) maps to this shape in epic 4 (4.3,\n    // \`protoTicketToDrawTicket\`) without re-inventing the proto message (AD-12).`
8. `test/consensus-verify-draw.test.ts`
   - old: ` * form, AD-12) — \`signature\` empty (epic 4 verifies it). The \`challenge\``
   - new: ` * form, AD-12) — \`signature\` empty (this epic-3 harness predates 4.2's\n * signature; 4.3/4.8 verify a real one). The \`challenge\``
9. `test/simulation.test.ts`
   - old: `    // empty signature (epic 4 verifies it — the epic-3 convention).`
   - new: `    // empty signature (4.3/4.8 verify a real signature — this harness keeps the\n    // epic-3 convention).`
10. `_bmad-output/.../deferred-work.md` (Class C — append ONE new OPEN entry; leave the 3 RESOLVED notes byte-identical).
    Append after the existing RESOLVED notes (final form, corrected at review to
    name the actual helpers — see Plan Change Log):
    `\n<!-- OPEN 2026-10-08 (story 4.9, deferred from 3.8): DRY-extract the shared\n     big-endian byte helpers out of \`src/consensus/pow.ts\` and \`src/consensus/draw.ts\`\n     into one shared module. The genuinely shared surface is \`u64be\` (identical in\n     both); the big-endian byte→bigint reader is duplicated under DIFFERENT names\n     (\`beBytesToBig\` in pow.ts, \`bytesToBig\` in draw.ts); \`concat\` is draw-only.\n     DEFERRED — not done here: both are pinned AD-6/AD-7 modules with golden vectors\n     and import-scan guards (2.5 no-float guard, 3.9 mining-path guard); \`u64be\`'s\n     range guard throws each module's own \`PowError\`/\`DrawError\`, so a shared\n     extraction would either duplicate those or risk the guards. Defer to a\n     dedicated byte-helper sweep or epic 5 (which touches the wire path). Recorded\n     at the 4.9 sweep; no code change. -->\n`

## Task

- [x] Apply the 13 Class-A comment rewrites (draw.ts ×2, uptime.ts ×1, slot-loop.ts ×2,
      verify-draw.ts ×1, sim.ts ×4, consensus-draw.test.ts ×1,
      consensus-verify-draw.test.ts ×1, simulation.test.ts ×1) per the frozen table.
- [x] Apply the Class-B AD-number fix (draw.ts:180, AD-4 → AD-7 + 3.4/epic-4 → 4.5/4.8).
- [x] Add the ONE Class-C OPEN deferred-work entry (u64be DRY); leave the 3 RESOLVED
      notes byte-identical.
- [x] Confirm KEEP items untouched; run the full verification gate (steps 1–5); confirm
      203/203 twice and the comment-only diff is clean.

## Implementation Notes

**Orchestrator-implemented** (a comment-only sweep of 14 frozen line-edits + 1
bookkeeping append — applied directly with the exact `oldString`/`newString` from the
frozen table; no code touched). The orchestrator re-ran the full gate after the review
patch (203/203, typecheck clean, PROTO_OK, comment-only filter empty).

**Survey result:** epic 4 (4.1–4.8) is fully built; its modules narrate the epic in the
future tense ("epic 4 derives it", "4.8 wires these in", "epic 4 conforms real tickets
to it") — now stale. 13 Class-A forward-references reworded to past-tense / precise
story numbers; 1 Class-B wrong-AD-number slip fixed (`draw.ts:180` cited AD-4 for the
weight-derivation, but the weight is a draw input = AD-7 "Verifiable draw is one pinned
pure function"; AD-4 is "gate is external and offline"). The deferred `u64be` DRY item
(3.8) re-recorded as ONE new OPEN deferred-work entry.

**Gate (orchestrator, re-ran post-review-patch):** 203/203 (29 files, UNCHANGED),
typecheck clean, build clean + protons regen byte-identical (PROTO_OK), comment-only
filter (`git diff … | grep '^[+-]' | grep -v '^[+-]{3}' | grep -v '^[+-]\s*(\*|//)'`)
EMPTY (every changed line is a ` * ` / `//` comment), KEEP items byte-identical, suite
deterministic (203/203 on two runs). No new source file, no code line, no test added.

## Plan Change Log

- **Frozen table corrected (pre-impl, orchestrator):** item 6c (`sim.ts:54`) was split
  across two lines in the table but is a SINGLE line in the file; the actual edit was
  applied with the correct single-line match (`the draw — the pre-epic-4 stand-in for
  "valid tickets over lookback L")` → `…" (4.5 derives the real weight)`). The table's
  line-split was a transcription artifact only; the applied text is the source of truth.
- **Class-C entry corrected (review patch, orchestrator):** the new deferred-work entry
  originally named the DRY target as `u64be / bytesToBig / concat` "shared" across
  `pow.ts` + `draw.ts`. The Quick lens (and an empirical grep) showed only `u64be` is
  truly shared (same name in both); the BE byte→bigint reader is duplicated under
  DIFFERENT names (`beBytesToBig` in pow.ts vs `bytesToBig` in draw.ts); `concat` is
  draw-only. The entry was reworded to name the actual helpers (frozen Class-C text in
  this plan updated to match). No code change.

## Review Triage Log

| # | Finding | Triage | Disposition |
|---|---------|--------|-------------|
| 1 | deferred-work OPEN entry misnames the shared byte helpers (claimed `u64be/bytesToBig/concat` shared; actually only `u64be` is same-named, BE reader duplicated under different names, `concat` draw-only) | LOW — real doc-accuracy defect in content authored by this sweep | FIXED (deferred-work.md entry + plan frozen Class-C text reworded to the actual helper names); re-gated (203/203, comment-only filter empty). |

All other Quick-lens checks PASS: comment-only filter empty; all 14 rewordings factually
verified against the built code (`protoTicketToDrawTicket` conforms Ticket→DrawTicket;
`acceptBlockWinner` composes verifyDraw + verifyTicketSignature closing the residual
replay; AD-4→AD-7 correct per spine); all KEEP items byte-identical (economics
"later epic", apply-block epic-5 refs, reattestation 4.8 facts, ports/index/events
forward-refs, correct AD-4 test refs); the 3 RESOLVED deferred notes byte-identical;
no residual stale forward-reference; 203/203 green headless, PROTO_OK.
