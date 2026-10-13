---
ticket: "9"
title: "Refactor sweep"
epic: epic-node-network
status: "built"
route: full
baseline_revision: "17deb3b9d419ec0131ce4bf0a001c89b83f741f4"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: []
context:
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/sim.ts
  - packages/core/src/index.ts
  - packages/core/src/ports.ts
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/index.ts
  - packages/core/src/net/sync.ts
  - packages/core/src/net/topics.ts
  - packages/core/proto/protocol.proto
  - packages/core/test/ticket-tx-propagation.test.ts
  - _bmad-output/initiative-succinctcoin-ai/deferred-work.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/story-refactor-sweep-plan.md
---

# Story Plan — 5.9 Refactor sweep

## Story of truth

Run the **closing refactor sweep** for epic 5 (node-network / CAP-3). Scope is
**cleanup only** — set from the epic's build records (5.1–5.8) and the
deferred-work list. The sweep must **confirm the net suite is green headless**:
`pnpm test` and `pnpm build` pass in plain Node over the memory transport (zero
real sockets, AD-10); the net invariants (one stable topic per class, proto
envelopes, memory transport, the relay) and the AD-8 / AD-10 / AD-12 guards
hold; and **no capability logic was added**. The change is **comment/JSDoc-only**
— the comment-only diff filter over `src` + `test` is empty of non-comment lines.

## What the survey found (orchestrator, read-only, at baseline `17deb3b`)

Epic 5 is fully built (5.1–5.8). The `src/net` modules + the net-facing additions
to the barrel/ports were written **during** the epic, and earlier modules
(consensus, the barrel's Read-API) carry forward-promises that epic 5 would
fulfill. Now that epic 5 is **built**, those forward-references are stale. This is
the same class of drift 3.8/4.9 cleaned (stale future-tense "epic N" refs →
precise past tense). **Verified truth** (read-only): `src/net` never calls
`applyBlock` (the tracer's 0-tx path is unchanged) and 5.6 explicitly runs no
mining/`applyBlock` — so epic 5 **propagates** txs over gossipsub but does **not**
carry real, verified txs through the `applyBlock` loop; the Read-API `getPeers` is
still a stub (not wired to the net adapter's `peers()`).

**Class A — 7 stale "epic 5" / "5.N" forward-references (now past / inaccurate):**

| # | File | Line(s) | Stale text (fragment) | Fix (fragment) |
|---|------|---------|-----------------------|----------------|
| 1 | `src/consensus/apply-block.ts` | 29 | `separate message, verified on epic 5's ledger path). `txs` is OPTIONAL —` | `separate message). `txs` is OPTIONAL —` |
| 2 | `src/consensus/apply-block.ts` | 32 | `conserved. Carrying real, verified txs through the loop is epic 5.` | `conserved. Carrying real, verified txs through the loop is beyond epic 5` / ` * (its networking propagates txs over gossipsub; the loop stays 0-tx).` |
| 3 | `src/consensus/apply-block.ts` | 49–51 | `carried here). The proto `Tx` message (a separate wire form, verified on` / ` * epic 5's ledger path) is NOT this view — this is the projection` / ` * `applyBlock` needs.` | `carried here). The proto `Tx` message (a separate wire form) is NOT this` / ` * view — this is the projection `applyBlock` needs.` |
| 4 | `src/consensus/sim.ts` | 7–8 | `carried by the single-writer store in a single process; epic 5 adds` / ` * the real network` | `carried by the single-writer store in a single process; epic 5 (src/net)` / ` * adds the real network` |
| 5 | `src/index.ts` | 116–117 | `// Read-API — owned by epic 5 (node-network). Stub: `async` so the throw` / `      // surfaces as a rejected promise, honoring the Promise<> return type.` | `// Read-API — stub (the net adapter, epic 5/src/net, exposes `peers()`;` / `      // this Read-API is not yet wired to it). `async` so the throw surfaces` / `      // as a rejected promise, honoring the Promise<> return type.` |
| 6 | `src/index.ts` | 393–394 | `envelope and publishes on its own topic; 5.3 wires discovery; 5.7 wires` / `// the relay transport.` | `envelope and publishes on its own topic; 5.3 wired discovery; 5.7 wired` / `// the relay transport.` |
| 7 | `test/ticket-tx-propagation.test.ts` | 29–30 | `A shared-driver extraction from 5.5 is 5.9's (the sweep) domain if` / ` * wanted — this file is self-contained.` | `A shared-driver extraction from 5.5 is a future test-refactor (not part` / ` * of the 5.9 comment-only sweep) — this file is self-contained.` |

**Class B — verified NOT stale (left byte-identical, KEEP):**
- `src/net/adapter.ts:2` — "the libp2p adapter (epic 5, AD-8/AD-10/AD-12)" — epic 5 built it; accurate past ref. KEEP.
- `src/ports.ts:91` — "The libp2p adapter (epic 5) implements it;" — accurate. KEEP.
- `src/net/index.ts:1–2` — "re-exports the libp2p adapter (5.1 scaffold + 5.2 topics / proto envelopes)" — accurate historical narration. KEEP.
- `proto/protocol.proto:87/102/138` — "Gossipsub message envelopes (epic 5, story 5.2)" / "the ONE proto change in epic 5" / "Chain sync (epic 5, story 5.4)" — accurate historical narration. KEEP (and the proto is frozen — see Class C).
- The `TS 5.9` comments in `miner.ts`/`multi-sim.ts`/`sim.ts`/`sync.ts`/`consensus-*.test.ts` — these are the **TypeScript 5.9** typed-array generic, not epic 5. KEEP (false positives).
- `src/net/sync.ts` / `src/net/topics.ts` — surveyed; no stale forward-refs, no dead exports. KEEP.

**Class C — deferred-work + frozen-proto bookkeeping (survey findings, NO change):**
- **u64be / BE-reader DRY stays OPEN/DEFERRED.** The shared surface (`u64be`,
  `beBytesToBig`/`bytesToBig`, `concat`) lives in `pow.ts` + `draw.ts` — pinned
  AD-6/AD-7 modules with golden vectors and import-scan guards (the 2.5 no-float
  guard + the 3.9 mining-path guard scan their import surfaces); `u64be`'s range
  guard throws each module's own `PowError`/`DrawError`. Epic 5's `src/net` is a
  separate concern and does **not** touch those modules, so a shared extraction
  would either duplicate the per-module error codes or risk the guards. **Stays
  deferred** (the 3.8/4.9 precedent holds); the `deferred-work.md` OPEN entry is
  left byte-identical.
- **Shared-driver extraction (5.5/5.6/5.7) stays DEFERRED.** It is a
  non-comment test refactor — out of scope for this comment-only sweep (AC-2).
  The ticket-tx-propagation header (fix #7) now records that.
- **5.4-F1 framing unit test stays DEFERRED.** It is a new test (non-comment) —
  out of scope for this comment-only sweep (AC-2).
- **`proto/protocol.proto:72`** — "Sender signature (verification owned by epic
  5's ledger path)." is inaccurate (signature verification is epic 4's
  `verifyTicketSignature`), but the proto is **frozen** (the build must
  regenerate `src/proto/` byte-identical — PROTO_OK). Editing the hand-written
  `.proto` risks the generated output; it is left unchanged and recorded here.

## Acceptance criteria

- **AC-1 — Class A:** all 7 stale forward-references reworded per the frozen
  table above. Each fix is a **comment/JSDoc-only** line (no code, signature,
  import, export, constant, or literal touched).
- **AC-2 — Comment-only diff:** `git diff <baseline>` over `packages/core/src`
  and `packages/core/test` contains **zero non-comment, non-whitespace lines** —
  the comment-only filter leaves an empty diff. No new source or test file.
  `packages/core/src/proto/` is untouched (PROTO_OK) and `package.json` /
  `pnpm-lock.yaml` are untouched.
- **AC-3 — Green headless:** `pnpm test` and `pnpm build` pass in plain Node;
  the net invariants (one stable topic per class, proto envelopes, memory
  transport, the relay) and the AD-8/AD-10/AD-12 guards hold; the test count is
  **unchanged** (247 tests / 36 files) — the sweep adds no tests.
- **AC-4 — No dead exports / no stale "epic 5" future-tense comments:** every
  `src/net` export is used; no stale "epic 5" future-tense comment remains in
  `src` or `test` (the KEEP list above is the only surviving "epic 5" text, all
  accurate past refs).

## Never (hard constraints)

- NEVER add or change capability logic: no new function, no changed expression,
  no changed literal, no changed import/export. Comment/JSDoc only.
- NEVER touch `proto/`, `protocol.proto`, `config/genesis.json`, `package.json`,
  or `pnpm-lock.yaml`. The build must regenerate `src/proto/` byte-identical.
- NEVER weaken or edit any guard test (the 2.5 no-float guard, the 3.9
  mining-path guard, the 4.x key-material scan, the 5.x net invariants). They
  must stay green and byte-identical.
- NEVER reword the KEEP items listed under Class B (the accurate past "epic 5"
  refs, the `TS 5.9` comments, the accurate proto narration).
- NEVER edit `packages/core/dist/**` (gitignored build output; regenerated by
  `pnpm build`).

## Verification (acceptance gate)

Run from `packages/core` (timeout ~500000), then the diff gates from the REPO ROOT:

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → **247 / 247 / 36 files** (unchanged).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1` → clean (PROTO_OK).
4. **Comment-only filter** (REPO ROOT): the diff over `packages/core/src` +
   `packages/core/test` has zero non-comment, non-whitespace lines:
   `git diff <baseline> -- packages/core/src packages/core/test | grep -E '^[+-]' | grep -vE '^[+-]{3}' | grep -vE '^[+-]\s*(//|\*|/\*)'` → **empty**.
5. **Proto untouched** (REPO ROOT): `git diff --name-only -- packages/core/src/proto/` → **empty**.
6. **No deps** (REPO ROOT): `git diff --name-only -- packages/core/package.json pnpm-lock.yaml` → **empty**.
7. `git status --short` → only the 4 edited files (`apply-block.ts`, `sim.ts`,
   `index.ts`, `ticket-tx-propagation.test.ts`) + this plan.

## Tasks

- [x] **T1 — Class A:** apply the 7 comment-only fixes per the frozen table; keep every line a `//` / ` * ` / `/*` comment; re-wrap JSDoc lines to ~72 cols.
- [x] **T2 — Verify green headless:** run the trio (test / typecheck / build); confirm 247/247 unchanged + clean.
- [x] **T3 — Verify comment-only:** run the diff gates (comment-only filter empty, proto empty, no deps, `git status` shows only the 4 files + plan).
- [x] **T4 — Report:** summarize the 7 fixes + the Class C survey findings (u64be DRY, shared-driver, 5.4-F1 framing test, proto:72 all stay deferred/frozen).

## Implementation Notes

- 2026-10-13 (5.9 build, step 03): all 7 Class A comment-only fixes applied
  verbatim from the frozen table — `apply-block.ts:29/32/49-51` (fixes #1–#3:
  dropped the stale "verified on epic 5's ledger path" refs; "Carrying real,
  verified txs through the loop is epic 5." → "…is beyond epic 5 (its
  networking propagates txs over gossipsub; the loop stays 0-tx)."),
  `sim.ts:7-8` (#4: "epic 5 adds the real network" → "epic 5 (src/net) adds
  the real network"), `index.ts:116-117` (#5: getPeers stub → "Read-API — stub
  (the net adapter, epic 5/src/net, exposes `peers()`; this Read-API is not yet
  wired to it)"), `index.ts:393-394` (#6: "5.3 wires / 5.7 wires" → "5.3 wired
  / 5.7 wired"), `ticket-tx-propagation.test.ts:29-30` (#7: "5.9's (the sweep)
  domain" → "a future test-refactor (not part of the 5.9 comment-only sweep)").
  Class B items left byte-identical; no code, literal, import, or export touched
  (comment-only filter over `src`+`test` vs `17deb3b` is empty).
- Gates (2026-10-13, from `packages/core` / repo root): `corepack pnpm test` =
  247/247 tests, 36 files (unchanged); `corepack pnpm typecheck` clean (exit 0);
  `corepack pnpm build` clean (exit 0, PROTO_OK — `git diff --name-only --
  packages/core/src/proto/` empty after the protons regen); `git diff
  --name-only -- packages/core/package.json pnpm-lock.yaml` empty; `git status`
  = the 4 edited files + this plan only.
- Class C findings stand as surveyed (no change): u64be / BE-reader DRY stays
  OPEN/DEFERRED (the `deferred-work.md` entry is left byte-identical); the
  5.5/5.6/5.7 shared-driver extraction stays DEFERRED (a non-comment test
  refactor — out of AC-2 scope, now recorded in fix #7); the 5.4-F1 framing
  unit test stays DEFERRED (a new test — out of AC-2 scope); `protocol.proto:72`
  ("Sender signature (verification owned by epic 5's ledger path)") is
  inaccurate (verification is epic 4's `verifyTicketSignature`) but the proto is
  frozen — left unchanged, recorded here only.

## Plan Change Log

- 2026-10-13 (5.9 build, plan created): authored from the read-only survey at baseline `17deb3b`. Scope = 7 comment-only stale-ref fixes (Class A) + the Class C survey findings (u64be DRY / shared-driver / 5.4-F1 framing test / proto:72 stay deferred or frozen). No capability logic, no proto change.
- 2026-10-13 (5.9 build, step 03): sweep executed — all 7 Class A fixes applied verbatim (comment-only; frontmatter `status:`, ACs, and Never constraints untouched). Gates green: 247/247 / 36 files, typecheck clean, build clean (PROTO_OK), comment-only filter empty, proto + deps diffs empty, `git status` = 4 files + this plan.

## Review Triage Log

- 2026-10-13 (5.9 review, quick lens, iteration 1): the quick-lens reviewer read
  this plan + every `context:` file + the architecture spine, then the staged
  diff (`$TMPDIR/plan059-diff.txt`, 85 lines). **Findings: NONE.** The reviewer
  independently re-ran the trio (`corepack pnpm test` = 247/247 / 36 files;
  `build` exit 0, PROTO_OK) and the diff gates (comment-only filter over
  `src`+`test` = 0 non-comment lines; `src/proto/`, `package.json`,
  `pnpm-lock.yaml` diffs empty; `git status` = the 4 files + this plan) and
  confirmed the reviewed diff is byte-identical to the fresh diff. The two
  flagged factual rewordings were verified against surrounding code: fix #2
  ("carrying real, verified txs through the loop is beyond epic 5 … the loop
  stays 0-tx") holds because `src/net` never calls `applyBlock` (grep = 0), the
  tracer mines `txCount: 0n` with no `txs`, and the 5.6 test states it runs no
  mining/`applyBlock`, while txs DO propagate over gossipsub on `TOPICS.tx`;
  fix #5 ("Read-API … not yet wired to" the net adapter's `peers()") holds
  because `getPeers` throws `notImplemented('getPeers')` (a stub) while the
  adapter concretely implements `peers()`. Fix #6's past-tense "5.3 wired
  discovery / 5.7 wired the relay transport" matches the 5.3/5.7 build records.
  No Class B KEEP item was reworded; all 7 new passages are coherent. No triage
  needed (no findings); no code patch, so the step-03 gate stands.
