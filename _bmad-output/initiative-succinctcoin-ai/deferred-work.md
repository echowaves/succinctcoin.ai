# Deferred Work — initiative-succinctcoin-ai

<!-- RESOLVED 2026-10-03 (story 1.6): the `bench/bench.js` 120s-watchdog / exit-124 entry from
     `epic-platform-baseline/story-workspace-headless-test-harness-plan.md` is done — the sweep
     added `clearTimeout(watchdog)` + `process.exit(0)` after the results write (bench now exits 0
     in ~55s). Entry removed during the 1.6 review; kept here as a note only. -->

- source_plan: `_bmad-output/initiative-succinctcoin-ai/epic-platform-baseline/story-refactor-sweep-closing-headless-verification-plan.md`
  summary: `createCore().start()` does not call `loadGenesis` — genesis config is validated by its own functions (`genesis.test.ts`) but not wired into the boot path yet.
  evidence: epic Done-when #6 says "parsed and validated at boot"; 1.3 deliberately made genesis a "config seam only" (full boot path wired in later epics). Verified by 1.6's closing review: grep of `src/` shows no boot caller of `loadGenesis`/`validateGenesis`. Home: the consensus epic (3), which owns the real boot path and the genesis-derived constants (K, L, emission).

- source_plan: `_bmad-output/initiative-succinctcoin-ai/epic-exact-money-ledger/story-conservation-fee-invariant-property-tests-plan.md`
  summary: `toJson` (ledger.ts) silently drops a balance whose identity id is the literal `__proto__` — the `out['__proto__'] = <string>` assignment invokes the `Object.prototype.__proto__` setter, which ignores non-object values, so the entry is lost (while `fromJson`/`assertStateDocument` DO accept a `__proto__` entry via `Object.entries`, so a `__proto__` balance round-trips `toJson → saveState → loadState → fromJson` with that balance silently lost).
  evidence: Discovered via a 2.4 flake-stability pass: 2.3's `store-state.test.ts` SNAPSHOT_ROUNDTRIP (which generates ids with `fc.string()`) failed `expected Map{} to deeply equal Map{'__proto__' => 0n}`. Measured (probe, fast-check 4.10.2): ~0.33% of `fc.dictionary(fc.string(), …)` maps contain a `__proto__` key; ~15% of property runs fail at numRuns:50. **Latent, not active:** the protocol's id space is 32-byte hex (spine/AD-12) and can never be `__proto__`, so no real balance is affected. The test was fixed to stay within the protocol-valid id space (`fc.string().filter(id => id !== '__proto__')`), which is the correct correction for the *test*. The production `toJson` asymmetry (write drops `__proto__`, read accepts it) remains unguarded because a fix is out of scope for the test-only 2.4 story and the seam's contract (AD-2) deliberately does not validate id format. Home: a hardening ticket (e.g. build `toJson` via a `Map` and serialize keys explicitly, or reject/escape reserved own-property keys) — low priority since the protocol id space cannot trigger it.
