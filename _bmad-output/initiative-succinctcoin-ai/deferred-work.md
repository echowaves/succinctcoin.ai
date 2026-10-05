# Deferred Work — initiative-succinctcoin-ai

<!-- RESOLVED 2026-10-03 (story 1.6): the `bench/bench.js` 120s-watchdog / exit-124 entry from
     `epic-platform-baseline/story-workspace-headless-test-harness-plan.md` is done — the sweep
     added `clearTimeout(watchdog)` + `process.exit(0)` after the results write (bench now exits 0
     in ~55s). Entry removed during the 1.6 review; kept here as a note only. -->

- source_plan: `_bmad-output/initiative-succinctcoin-ai/epic-platform-baseline/story-refactor-sweep-closing-headless-verification-plan.md`
  summary: `createCore().start()` does not call `loadGenesis` — genesis config is validated by its own functions (`genesis.test.ts`) but not wired into the boot path yet.
  evidence: epic Done-when #6 says "parsed and validated at boot"; 1.3 deliberately made genesis a "config seam only" (full boot path wired in later epics). Verified by 1.6's closing review: grep of `src/` shows no boot caller of `loadGenesis`/`validateGenesis`. Home: the consensus epic (3), which owns the real boot path and the genesis-derived constants (K, L, emission).

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
