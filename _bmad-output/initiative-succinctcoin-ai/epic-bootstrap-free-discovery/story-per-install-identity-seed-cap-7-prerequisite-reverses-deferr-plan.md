---
title: 'Per-install identity seed (CAP-7 prerequisite)'
type: 'feature'
ticket: '1'
created: '2026-10-17'
baseline_revision: 9c29943402ff72735124cfa19ec9aeefe6765425
status: 'built'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** App main mines with a pinned constant seed (`IDENTITY_SEED`, `(0x5c + i) % 256`), so every install derives the SAME identity; the node-loop's per-slot dedupe (keyed by `identityId`) makes all but one instance's tickets win — cross-instance mining is structurally impossible. CAP-7 (signed announcements, ticket 8.3+) cryptographically requires per-install keypairs. The deferred-work entry RATIFIED this reversal on 2026-10-17; the old deferral argument ("persistence is a packaging concern") no longer holds because discovery depends on it.

**Approach:** Replace the constant with a persisted per-install seed: a pure, electron-free module `identity-seed.ts` (the proven `net-config.ts` seam pattern) that loads `<userData>/identity.seed` or creates it — 32 random bytes from `crypto.getRandomValues` (startup key generation only; AD-3's no-RNG rule governs consensus, not identity creation), written atomically (temp + rename) as lowercase hex with mode `0600`. `boot()` calls it with `app.getPath('userData')`; the seed file sits beside (not inside) the chain store dir. Tests are headless (AD-10): injected tmp dirs, no electron spawn.

Decisions (build-time, ratified by this plan):
- File format: single line of lowercase hex (64 chars), trimmed on read; a file whose content is not exactly 32 bytes of hex THROWS (a corrupt identity file must not silently mint a new identity).
- `0600` is set at creation via the `open` mode and re-asserted with `chmod` after rename (umask-proof).
- The seed NEVER crosses IPC and never leaves main (AD-11 unchanged); renderer key-material scans keep passing.

</frozen-after-approval>

## Implementation Notes

Oneshot (~95 LOC): one new pure module + a ~10-line swap in `index.ts` boot + one headless test file; no core touches, no build-order concerns (app-only). The deferred-work entry flips RESOLVED and the spec's CAP-7-prerequisite open question is marked resolved (memlog event) in the same commit.

Built 2026-10-17: `identity-seed.ts` (module takes `dir` — AD-10 headless), `index.ts` boot swap, `test/identity-seed.test.ts` (all green first run). Deviation from the plan text: used `randomFillSync` from `node:crypto` (the sync face of `crypto.getRandomValues`) — same CSPRNG, avoids a needless await. Corrupt-file behavior pinned by test (throws, file untouched). Spec: open-question bullet removed, resolution recorded as memlog event (memlog is canonical).

Review round amended (quick lens): create path switched from temp+`rename` to unique-temp + `link` with EEXIST→adopt-winner (concurrent first boots now converge on ONE seed — pinned by the CONCURRENT_FIRST_BOOT row); corrupt-file error reports shape only, never a content slice; chmod re-asserted AFTER the link lands (matching the frozen decision's literal order); scan widened to every `src/main/*.ts` (`0x5c +` expression / `IDENTITY_SEED =` declaration) and AC1 rows extended to identity-id level. Suite now 6 rows, root 285/44 green + typecheck OK.

## Plan Change Log

## Review Triage Log

Pass 1 (quick lens, 6 findings):

- `high` → PATCHED — create path not concurrency-safe (fixed `.tmp` name + overwriting rename: two first-booting processes could diverge, loser keeps a seed absent from disk). Fix: unique temp + `link`; EEXIST → adopt the winner's file; pinned by CONCURRENT_FIRST_BOOT. Evidence: read of the create branch confirmed non-exclusive write + unconditional rename.
- `medium` → PATCHED — corrupt-file error echoed `hex.slice(0,16)` (near-secret into boot logs). Fix: message reports char count only.
- `medium` → PATCHED — AC1 rows asserted seed-level only; verify criterion says identity ids. Fix: `deriveIdentityKeypair(...).identityId` asserted distinct/same.
- `low` → PATCHED — scan covered only `index.ts`; criterion says "app main". Fix: scans every `src/main/*.ts` for `0x5c +` / `IDENTITY_SEED =` (regex won't false-hit the module's own `IDENTITY_SEED_BYTES`/`_FILE_NAME`).
- `low` → PATCHED — chmod ran before rename while the frozen decision said after. Fix: re-asserted after the link lands; deviation note removed (see Implementation Notes).
- `low` → REJECTED — stale `.tmp` orphan after a crash mid-create: residue is inert, and the proposed boot-time sweep would race a sibling creator's in-flight temp (worse than the disease); unique UUID temp names keep it collision-free.
