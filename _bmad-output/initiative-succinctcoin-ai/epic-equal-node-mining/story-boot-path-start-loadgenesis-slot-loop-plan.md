---
title: 'Boot path: start() -> loadGenesis -> slot loop'
type: 'feature'
ticket: '5'
created: '2026-10-06'
status: 'built'
route: 'full'
route_source: 'pinned'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
baseline_revision: '8047af56f260990c35ca355a9847c426685d178b'
context:
  - packages/core/src/index.ts
  - packages/core/src/ports.ts
  - packages/core/src/events/types.ts
  - packages/core/src/config/genesis.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/test/core-surface.test.ts
  - packages/core/test/store.test.ts
  - config/genesis.json
  - _bmad-output/initiative-succinctcoin-ai/deferred-work.md
---

## Intent

**Problem:** `createCore().start()` only opens the store and emits `CoreStarted`; it never calls `loadGenesis`, so the genesis config is validated by its own tests but NOT at boot (the 1.x/2.x deferred "genesis validated at boot" gap). The consensus slot loop (`mineAndApply`, 3.4) is standalone and not wired into the core lifecycle, and the genesis-derived constants (emission, K, L) don't flow into the loop.

**Approach:** Rewire `createCore`'s `start()` to the real boot path: `store.open()` (fail-fast order preserved — the lock is taken first) → `loadGenesis` (fail-fast `SC-CONFIG-1` on a malformed/missing genesis, BEFORE any block is produced) → the slot loop, which produces ONE block from the store's persisted chain state via `mineAndApply` (resume-from-persisted is automatic through `nextSlotAndParent`; emission `blockReward`/`maxSupply` flow from the validated genesis; `K`/`L` ride in the validated config for the epics that consume them). The genesis file path rides on the `CorePorts` bundle as an optional `genesisPath` (default = the repo-root `config/genesis.json`). Closes the deferred-work open item.

## Boundaries & Constraints

**Always:**
- Fail-fast ORDER is pinned: `store.open()` FIRST (a contended data dir rejects `SC-STORE-1` before genesis is even read), THEN `loadGenesis` (rejects `SC-CONFIG-1` before any block is produced), THEN the loop. A malformed genesis MUST reject before any block is produced.
- The loop produces exactly ONE block per `start()` (see Design Notes). It resumes from the STORE's persisted head (`nextSlotAndParent`) — never slot 0 on a non-empty chain, never the wall clock (AD-3).
- The emission constants (`emission.blockReward`, `emission.maxSupply`) are the ONLY reward/maxSupply values the loop consumes — they flow from the validated genesis, never inline literals in the core.
- `CoreStarted` is emitted EXACTLY ONCE per successful `start()`, AFTER the block is mined, with its existing payload shape `{ slot }` UNCHANGED (the 1.2 decision; the slot is `clock.slotIndex()`, chain-time AD-3).
- The single-writer/lock contract (AD-9) and the `SC-STORE-1` contended-dir behavior are unchanged (the `store.test.ts` BOOT_FAIL pin must survive).
- big.js stays ONLY at the ledger boundaries (`fromDisplay` in `mineAndApply`/`apply-block`); `src/consensus` and `src/index.ts` MUST NOT import `big.js` (the 2.5 no-float-guard `BIG_JS_ONLY_BOUNDARY` pin must survive — `loadGenesis` lives in `src/config`, which is not the guarded import set, and it never imports big.js).

**Never:**
- Do NOT change `mineBlock`, `BlockTemplate`, `MINT_ID`, `TRACER_WINNER_ID`, `powCheck`, `drawWindow`, `verifyDraw`, or the 3.2/3.3/3.4 consensus modules — the loop reuses `mineAndApply` (3.4) as-is; the draw/verification seam is IMPORTED, never re-implemented (AD-7).
- Do NOT change the `CoreStarted`/`CoreStopped` event payload shapes or the `UiSink` forwarding.
- Do NOT modify `config/genesis.json` (the repo-root config is the single source; the default path points at it).
- Do NOT add a new dependency or a second toolchain (spine Stack).
- Do NOT make the loop run repeatedly / on a timer / on a wall clock — one block per `start()` (epic 3's multi-node sim, 3.7, drives cadence later).
- Do NOT close the store on a `loadGenesis` or mining failure — the store stays open; the boot rejection propagates to the host (the host owns teardown). Do NOT add auto-retry.
- Do NOT touch the `stop()` path (still `CoreStopped` + `store.close()`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| START_SUCCESS_FRESH | real `FileChainStore` (fresh temp dir) + valid genesis (default repo-root `config/genesis.json`); empty chain | `start()` resolves; chain = exactly one block at slot 0; block decodes (`Block.decode`) with `winnerIdentityId === TRACER_WINNER_ID`; `CoreStarted` emitted exactly once (payload `{ slot: clock.slotIndex() }`); no `CoreStopped` | No error expected |
| START_SUCCESS_FLOW | same as above | the block's reward = genesis `emission.blockReward` (`"12.5"` → `1.25e9` base units) credited `MINT_ID → winner`; `totalSupply` stays `emission.maxSupply` (`"21000000"` → `2.1e16`); the seeded mint balance (absent snapshot) = maxSupply | No error expected |
| START_MALFORMED | real `FileChainStore` (fresh temp dir) + a malformed genesis file (e.g. missing `emission`) OR a nonexistent path passed | `start()` rejects `SC-CONFIG-1` (a malformed file names the field; a missing file names the path — both via `loadGenesis`'s `readFile`/validate failure); chain stays EMPTY (`headSlot() === -1` AND no `blocks/0.block` file, proven by a fresh inspector after releasing the lock); no `state/balances.json` saved; `CoreStarted` NEVER emitted; the store stays OPEN (not auto-closed — a second store's `open()` is contended `SC-STORE-1` while the failed core holds the lock). TWO tests: the malformed-file variant + the missing-file variant (AC2 "malformed or missing"). | `SC-CONFIG-1` (`GenesisConfigError`) |
| START_FAILFAST_ORDER | a contended dir (another core holds the lock) + a malformed genesis path passed | `start()` rejects `SC-STORE-1` (lock contention) — proving `store.open()` runs BEFORE `loadGenesis`; the `SC-CONFIG-1` path is NOT reached | `SC-STORE-1` |
| START_RESUME | real `FileChainStore` on a dir ALREADY holding N blocks + a valid snapshot (from a prior `start()` on the same dir); new core instance on the same dir | `start()` resumes from the persisted head: it mines slot `N` (head+1), NOT slot 0; `headSlot()` becomes `N`; `CoreStarted` emitted once | No error expected |

## Code Map

- `packages/core/src/ports.ts` -- ADD optional `genesisPath?: string` to `CorePorts` (the boot-time genesis config file path; default resolved in `createCore` to the repo-root `config/genesis.json`).
- `packages/core/src/events/types.ts` -- WIDEN `CoreCommands.start()` to `start(genesisPath?: string): Promise<void>`; update the doc comment (boot now loads+validates genesis and runs one loop block).
- `packages/core/src/index.ts` -- REWIRE `createCore`'s `start()`: `store.open()` → `loadGenesis(path)` → `mineAndApply({ store, rewardDisplay: cfg.emission.blockReward, maxSupplyDisplay: cfg.emission.maxSupply })` → `emit('CoreStarted', ...)`. Add `loadGenesis` to the existing `config` re-export set (it already re-exports the config barrel's types; `loadGenesis` is added to the value re-export). `stop()` and the stubs unchanged.
- `packages/core/test/core-surface.test.ts` -- ADD `genesisPath: GENESIS_PATH` to the `makePorts` fake (the default; the fake store stays a no-op so the existing 4 tests keep passing — `mineAndApply` on the no-op fake store is harmless).
- `packages/core/test/ports.test.ts` -- ADD `genesisPath` to the `fake` `CorePorts` (optional field; add it for completeness).
- `packages/core/test/boot-path.test.ts` -- NEW: the 5 matrix rows (real `FileChainStore` + real/repo-root genesis; a malformed genesis written to a temp file; a contended dir via a second core; a resume dir from a prior `start()`).
- `_bmad-output/initiative-succinctcoin-ai/deferred-work.md` -- MARK the open `createCore().start()` / `loadGenesis` item RESOLVED (story 3.5).
- `config/genesis.json` -- READ ONLY (the default path target). Do NOT modify.
- `packages/core/src/consensus/*`, `src/store/file-chain-store.ts`, `src/config/genesis.ts` -- UNTOUCHED (the loop reuses `mineAndApply`; genesis I/O is unchanged).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports.ts` -- add optional `genesisPath?: string` to `CorePorts` with a doc comment (default = repo-root `config/genesis.json`) -- carries the boot genesis path through the injected port bundle (the host can point a node at an alternate config) -- the additive port field the fail-fast order test needs.
- [x] `packages/core/src/events/types.ts` -- widen `CoreCommands.start()` to `start(genesisPath?: string): Promise<void>` and update its doc comment (boot now = open store, load+validate genesis, run one loop block, emit `CoreStarted`) -- the command signature now takes the optional genesis path override.
- [x] `packages/core/src/index.ts` -- rewire `createCore`'s `start()`: `await ports.store.open()`; `const cfg = await loadGenesis(path ?? defaultGenesisPath())` (the default resolves to the repo-root `config/genesis.json` via `join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'genesis.json')` — same convention as `genesis.test.ts`); `await mineAndApply({ store: ports.store, rewardDisplay: cfg.emission.blockReward, maxSupplyDisplay: cfg.emission.maxSupply })`; then `this.emit('CoreStarted', { slot: ports.clock.slotIndex() })`. Add `loadGenesis` to the config value re-export. Do NOT change `stop()`, the stubs, or the event payload -- this is the boot path the ticket names; the fail-fast order (open → genesis → loop) is the invariant.
- [x] `packages/core/test/core-surface.test.ts` + `packages/core/test/ports.test.ts` -- add `genesisPath` to the fake `CorePorts` (point at the real repo-root `config/genesis.json` so the default-path test path is exercised) -- keep the 4 surface + 1 ports tests green after the port field is added.
- [x] `packages/core/test/boot-path.test.ts` -- NEW test file covering the 5 matrix rows (START_SUCCESS_FRESH, START_SUCCESS_FLOW, START_MALFORMED, START_FAILFAST_ORDER, START_RESUME) with a real `FileChainStore` in a temp dir, the real repo-root genesis for the success/resume rows, a malformed genesis file for the malformed row, and a second core for the contended row -- proves the boot path end-to-end (loadGenesis + one loop block + fail-fast order + resume).
- [x] `_bmad-output/initiative-succinctcoin-ai/deferred-work.md` -- mark the open `createCore().start()` / `loadGenesis` item RESOLVED with a dated note (story 3.5 wired the boot path) -- closes the 1.x/2.x deferred gap the ticket names.

**Acceptance Criteria:**
- Given `createCore(ports)` with a real `FileChainStore` (fresh dir) and the default genesis, when `start()` is called, then it calls `loadGenesis` (the repo-root `config/genesis.json`), mines exactly ONE block from the persisted (empty) chain head, and emits `CoreStarted` once with the unchanged `{ slot }` payload.
- Given a malformed or missing genesis path, when `start()` is called, then it rejects with `SC-CONFIG-1` BEFORE any block is produced (`headSlot() === -1`, no `state/balances.json`, `CoreStarted` never emitted).
- Given a contended data directory (another core holds the lock), when `start()` is called (even with a malformed genesis path), then it rejects with `SC-STORE-1` — proving `store.open()` runs before `loadGenesis`.
- Given a store already holding N blocks + a snapshot (from a prior `start()`), when a new `createCore` on the same dir calls `start()`, then it mines slot `N` (head+1), not slot 0 (resume-from-persisted).
- The loop's reward + maxSupply come from the validated genesis emission (no inline literals in the core); the no-float-guard (`BIG_JS_ONLY_BOUNDARY`) and all 3.2/3.3/3.4 consensus pins stay green.

## Implementation Notes

(append-only)

**2026-10-06 — story 3.5 implemented (boot path wired).**

Files touched:
- `packages/core/src/ports.ts` — added optional `genesisPath?: string` to `CorePorts` with a doc comment (default = repo-root `config/genesis.json`; read only AFTER `store.open()`).
- `packages/core/src/events/types.ts` — widened `CoreCommands.start()` to `start(genesisPath?: string): Promise<void>` and rewrote its doc comment (boot = open store → load+validate genesis → one loop block → `CoreStarted`).
- `packages/core/src/index.ts` — re-imported `loadGenesis` (`./config/index.js`) + `mineAndApply` (`./consensus/index.js`) as direct values for the boot path, added a `defaultGenesisPath()` helper (`join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'genesis.json')`), and rewired `start()`: `store.open()` → `loadGenesis(genesisPath ?? ports.genesisPath ?? defaultGenesisPath())` → `mineAndApply({ store, rewardDisplay: cfg.emission.blockReward, maxSupplyDisplay: cfg.emission.maxSupply })` → `emit('CoreStarted', { slot: ports.clock.slotIndex() })`. `stop()`/stubs/UiSink forwarding unchanged. The `config` value re-export already listed `loadGenesis` (no re-export change needed); `loadGenesis`/`mineAndApply` are now also direct imports used by `start()`. No `big.js` import added (constraint 6 holds).
- `packages/core/test/core-surface.test.ts` — added a `GENESIS_PATH` constant + `genesisPath: GENESIS_PATH` to `makePorts` (the no-op fake store makes the new `mineAndApply` call harmless).
- `packages/core/test/ports.test.ts` — added the same `GENESIS_PATH` + `genesisPath` to the `fake` `CorePorts`.
- `packages/core/test/boot-path.test.ts` — NEW: 6 tests on a real `FileChainStore` in a per-test `mkdtemp` dir — the 5 matrix rows (START_SUCCESS_FRESH, START_SUCCESS_FLOW, START_MALFORMED, START_FAILFAST_ORDER, START_RESUME) plus START_DEFAULT_PATH (pins the `defaultGenesisPath()` branch: `start()` with no command arg and no `ports.genesisPath` must load the repo-root `config/genesis.json`). Real repo-root genesis for the success/resume/default rows, a malformed (missing `emission`) temp file for the malformed row, a second core for the contended row; temp dirs removed in `afterEach`.
- `_bmad-output/.../deferred-work.md` — marked the `createCore().start()`/`loadGenesis` open item RESOLVED with a dated HTML comment (style-matched).

Key decisions / notes:
- The `start(genesisPath)` command override takes precedence over `ports.genesisPath`, which takes precedence over `defaultGenesisPath()` — so the existing `store.test.ts` BOOT_FAIL test (which passes no path) exercises the default-path branch and still mines one block, staying green.
- In START_MALFORMED, the "store stays open" proof is that a second `FileChainStore.open()` on the same dir is contended (`SC-STORE-1`); the failed `start()` does NOT auto-close (constraint 10), so the lock is held until `stop()`.
- START_RESUME seeds N=2 blocks (two `start()` calls), then a NEW core on the same dir mines slot 2 (head+1), asserted via `Block.decode` on `store.getBlock(2)`.
- START_SUCCESS_FLOW verifies reward `fromDisplay("12.5")` credited MINT_ID → winner, seeded mint balance = `maxSupply - reward`, and `totalSupply(fromJson(doc))` = `fromDisplay("21000000")` (closed system), using the exported ledger seams.
- Surprises: (1) The plan's Verification says "5 matrix rows + the flow row" = 6 new tests, but the 5 named matrix rows already INCLUDE START_SUCCESS_FLOW (an off-by-one). I honored the gate's explicit "145 = 139 + 6" by adding a 6th genuinely-meaningful test, START_DEFAULT_PATH, that pins the `defaultGenesisPath()` fallback branch (no command arg + no `ports.genesisPath`). (2) `start()` leaves the store OPEN (lock held, by design — constraint 10: no auto-close on success/failure), so the success/resume rows must `core.stop()` BEFORE opening a second `FileChainStore(dir)` to inspect persisted state; otherwise the inspector's `open()` rejects `SC-STORE-1`. Baseline was 139 tests / 17 files; this adds the boot-path file (18 files / +6 tests = 145). The `defaultGenesisPath()` import.meta convention mirrors `genesis.test.ts` and works from both `src/index.ts` and the built `dist/index.js`.

## Plan Change Log

(append-only; empty until a loopback)

## Review Triage Log

**Quick lens (pass 1, 2026-10-06):** 1 finding — 0 high / 0 medium / 1 low. Scrutiny points (a)–(j) all PASS (fail-fast order, empty-chain-on-malformed, resume, emission-from-genesis, CoreStarted shape/timing, big.js boundary, consensus invariance, default-path from src+dist, test isolation, re-export — each verified with evidence against the surrounding code).

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | AC2 says "a malformed **or missing** genesis path" but only the malformed-FILE variant was tested; the nonexistent-path branch had no dedicated pin (the code handles both identically — `loadGenesis` catches the `readFile` failure and routes to the same `SC-CONFIG-1` before any block). | low | patch | Added a 7th boot-path test (START_MALFORMED missing-file variant): a nonexistent path → `SC-CONFIG-1`, `CoreStarted` never emitted, chain stays empty (`headSlot() === -1`) proven by a fresh inspector. Plan matrix row + verification counts updated (6 → 7 new tests, 145 → 146). Gate re-run green (146/146, typecheck clean, PROTO_OK). |

## Design Notes

**One block per `start()` — the "slot loop" is a lifecycle, not a timer.** AD-3 is chain-time (no wall clock), epic 3 has no real network yet (epic 5), and the 3.4 loop (`mineAndApply`) is already a one-block function. So `start()` runs the loop exactly ONCE: it mines the next block from the persisted head and returns. "Resuming from persisted state" is therefore automatic — `mineAndApply` calls `nextSlotAndParent(store)`, which reads the store's persisted head, so a store that already holds N blocks resumes at slot `N+1` on the next `start()`. A long-running node = the host calling `start()` per window (or, in the 3.7 multi-node sim, the sim drives cadence). This keeps the boot path synchronous-with-respect-to-the-loop and testable (one block, deterministic). NO setInterval/setTimeout/wall-clock anywhere (AD-3).

**Fail-fast order is load-bearing and pinned.** `store.open()` first: a contended dir must reject `SC-STORE-1` before genesis is read (the existing `store.test.ts` BOOT_FAIL pin). Then `loadGenesis`: a broken node must never mine a block on a config it can't validate (`SC-CONFIG-1` before any block). The `START_FAILFAST_ORDER` matrix row pins that a contended dir + malformed genesis still surfaces `SC-STORE-1` (the lock check wins). This ordering is why the genesis path is a port field, not a `loadGenesis`-internal constant: the test needs to hand a malformed path in to prove the order.

**K/L flow into the config, not the loop.** `reattestationK` (100) and `uptimeLookbackL` (50) are validated by `loadGenesis` and carried in the returned `GenesisConfig`. Epic 3's one-block loop does not consume them (a single node has no re-attestation cadence or multi-node lookback yet); epic 4 (identity/attestation) and 3.7 (multi-node sim) will read them from the validated config. The loop consumes ONLY `emission.blockReward` + `emission.maxSupply`. The ticket's "flow into difficulty/lookback/emission" is satisfied: emission flows into the loop now; K/L are validated and available for the consumers that need them (difficulty is fixed-at-launch from 3.1, so no difficulty flow).

**The default genesis path.** `createCore` resolves the default to the repo-root `config/genesis.json` via `import.meta.url` + `join` (the same convention `genesis.test.ts` uses: `test/` → `core/` → `packages/` → repo root → `config/genesis.json`). From `src/index.ts` (in `core/src/`), that's `../../../config/genesis.json`. The `CorePorts.genesisPath` optional field overrides it (a host pointing a node at an alternate config). Tests pass the real path explicitly for the success/resume rows and a malformed temp file for the malformed row.

## Verification

**Commands:**
- `corepack pnpm test` -- expected: all suites green (prior 139 + 7 new boot-path tests = 146); the 3.2 tracer, 3.3 draw, 3.4 verify-draw, and no-float-guard suites unchanged.
- `corepack pnpm typecheck` -- expected: clean (the `start(genesisPath?)` widen + `CorePorts.genesisPath` are compatible; the fake ports in the tests type-check).
- `corepack pnpm build 2>&1 | tail -2 && git diff --name-only -- packages/core/src/proto/ && echo PROTO_OK` -- expected: build clean; the generated proto is byte-identical (no `protocol.proto` change) → `PROTO_OK`.
- `corepack pnpm test boot-path` -- expected: the 7 new tests pass (the 5 matrix rows + START_MALFORMED missing-file variant [AC2 "malformed or missing"] + START_DEFAULT_PATH, which pins the `defaultGenesisPath()` fallback branch — no command arg, no `ports.genesisPath`); a malformed genesis rejects `SC-CONFIG-1` with an empty chain (`headSlot() === -1`, no block file); a contended dir rejects `SC-STORE-1`; resume mines head+1.

**Manual checks (if no CLI):**
- None — the CLI trio + the focused boot-path run are the gate.
