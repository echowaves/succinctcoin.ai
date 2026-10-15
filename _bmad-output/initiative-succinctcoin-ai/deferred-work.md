# Deferred Work — initiative-succinctcoin-ai

<!-- RESOLVED 2026-10-03 (story 1.6): the `bench/bench.js` 120s-watchdog / exit-124 entry from
     `epic-platform-baseline/story-workspace-headless-test-harness-plan.md` is done — the sweep
     added `clearTimeout(watchdog)` + `process.exit(0)` after the results write (bench now exits 0
     in ~55s). Entry removed during the 1.6 review; kept here as a note only. -->

<!-- RESOLVED 2026-10-06 (story 3.5): the `createCore().start()` / `loadGenesis`
     boot-path gap (source: the 1.6 closing sweep, epic-platform-baseline) is
     resolved in code — `createCore().start()` now runs the real boot path
     (`store.open()` -> `loadGenesis` -> one `mineAndApply` loop block ->
     `CoreStarted`), with `loadGenesis` failing fast `SC-CONFIG-1` on a
     malformed/missing genesis BEFORE any block, emission flowing from the
     validated genesis, and `CorePorts.genesisPath` (default repo-root
     `config/genesis.json`) carrying the path. Pinned by
     `packages/core/test/boot-path.test.ts` (incl. the fail-fast order + resume).
     Kept here as a note only. -->

<!-- RESOLVED 2026-10-05 (story 2.6): the `toJson` `__proto__` drop is fixed — the
     write side (`toJson`, ledger.ts) AND the read side (`assertStateDocument`,
     file-chain-store.ts) now build their projections on `Object.create(null)`, so a
     reserved own-property id becomes a normal own property instead of hitting the
     `Object.prototype.__proto__` setter. Both are pinned by new tests
     (ledger.test.ts DECIMAL_JSON seam row + store-state.test.ts STORE_PROTO_ROUNDTRIP
     real close/open cycle). The earlier note that "the read side accepts it" was
     wrong — `assertStateDocument` had the same plain-object trap and dropped it too;
     that is why 2.6's forced deviation touched the store, not just the ledger. Kept
     here as a note only. -->

<!-- OPEN 2026-10-08 (story 4.9, deferred from 3.8): DRY-extract the shared
     big-endian byte helpers out of `src/consensus/pow.ts` and `src/consensus/draw.ts`
     into one shared module. The genuinely shared surface is `u64be` (identical in
     both); the big-endian byte→bigint reader is duplicated under DIFFERENT names
     (`beBytesToBig` in pow.ts, `bytesToBig` in draw.ts); `concat` is draw-only.
     DEFERRED — not done here: both are pinned AD-6/AD-7 modules with golden vectors
     and import-scan guards (2.5 no-float guard, 3.9 mining-path guard); `u64be`'s
     range guard throws each module's own `PowError`/`DrawError`, so a shared
     extraction would either duplicate those or risk the guards. Defer to a
     dedicated byte-helper sweep or epic 5 (which touches the wire path). Recorded
     at the 4.9 sweep; no code change. -->

<!-- OPEN 2026-10-14 (story 6.4 — carried items, disposition per the plan §3.4;
     none of the four is in the 6.4 ticket `verify`, so all stay DEFERRED):
     (1) F2 snapshot race in the 6.3 live hook (`useSuccinctcoin.ts`): a
     `CoreStarted`/`BlockApplied` firing while a snapshot is in flight yields
     two concurrent `buildInitialSnapshot` calls; the later-RESOLVING wins.
     Benign — each snapshot reads the current read-API state and the next
     event self-corrects. The 6.4 e2e drives the reducer with a synchronous
     event feed (no concurrent snapshot calls) and was NOT flaky (5
     consecutive green runs), so the optional sequence guard is NOT added.
     (2) The 6.2 F2 genesis-path fix (thread the app's `genesisPath()` into
     `host.start()`): a latent-defect fix for a packaged/relocated layout —
     the app + core independently resolve the same repo-root
     `config/genesis.json` today. The 6.4 e2e drives `createCoreHost`
     directly (it does not exercise the thin electron glue `index.ts` where
     the fix would land), so an untested glue change is out of scope.
     (3) Per-install random identity seed (`node:crypto` `randomBytes(32)`
     persisted to `userData`): a real feature (randomness + persistence)
     not in the 6.4 verify — the pinned 32-byte seed (AD-3, key in main)
     stays. (4) Real net transport config choice (tcp+noise+yamux): a
     production deployment concern; `@libp2p/memory` stays the testnet
     default (AD-10). No code change. -->
