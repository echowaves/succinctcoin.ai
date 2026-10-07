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
