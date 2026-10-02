---
title: 'Genesis config + boot validation'
type: 'feature'
ticket: 3
created: '2026-10-02'
status: 'built'
baseline_revision: '32da399396121c49c60220a37b45d1b3891d412d'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No genesis config exists and the core has no way to load/validate one. The spine requires `config/genesis.json` (bootstrap list, emission, K, L, accepted-gate registry, protocol version) to be authored and **validated at boot, failing fast** on a malformed config — but nothing parses or checks it yet, so a bad config would silently boot a broken node.

**Approach:** Author `config/genesis.json` with the spine's six fields, and add a pure-Node `core/config` module (`validateGenesis` + `loadGenesis`) that type-checks the config and throws a clear `SC-CONFIG-1` error naming the bad/missing field. The validator is hand-rolled TS (no new dep — spine Stack lists no validation lib; the "no second toolchain" constraint holds).

## Boundaries & Constraints

**Always:**
- TS 5.x ESM NodeNext; the validator is pure (no I/O) so it's testable without a filesystem; `loadGenesis` is the only I/O path (`node:fs/promises`).
- Errors follow the spine convention: `{ code: 'SC-CONFIG-1', message }` naming the offending field.
- Amounts in the config are **decimal strings** (AD-5); the config file is JSON (no `BigInt` literals).
- The validator is the single owner of the genesis shape; later epics read the typed `GenesisConfig`, never re-parse raw JSON.

**Never:**
- No capability logic — no consensus/emission-schedule/gate-verification behavior (epics fill the numbers); 1.3 owns the schema + validation only.
- No new runtime dependency (no zod/class-validator) — hand-rolled checks only.
- No UI imports (AD-1); no real sockets; no `.proto`/protons (1.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| VALID_LOAD | real `config/genesis.json` present | `loadGenesis(path)` resolves to a typed `GenesisConfig` | no error |
| VALID_PARSE | a well-formed genesis object | `validateGenesis(obj)` returns it typed | no error |
| MALFORMED_TYPE | a field of the wrong type (e.g. `reattestationK: "x"`) | throws `{ code:'SC-CONFIG-1' }` naming the field | clear error, no boot |
| MALFORMED_MISSING | a required field absent (e.g. no `protocolVersion`) | throws `{ code:'SC-CONFIG-1' }` naming the missing field | clear error, no boot |
| MALFORMED_JSON_FILE | a path whose content is not valid JSON | `loadGenesis` rejects `{ code:'SC-CONFIG-1' }` | clear error |

</frozen-after-approval>

## Code Map

- `config/genesis.json` — new (repo root, per Structural Seed). The six-field genesis: `protocolVersion`, `bootstrap[]`, `emission{blockReward,maxSupply}`, `reattestationK`, `uptimeLookbackL`, `gates[]`. Values are **initial placeholders** (K/L/emission/gate-ids deferred per spine).
- `packages/core/src/config/genesis.ts` — new. `GenesisConfig` type, `validateGenesis(raw): GenesisConfig` (pure, throws `SC-CONFIG-1`), `loadGenesis(path): Promise<GenesisConfig>` (readFile + JSON.parse + validate).
- `packages/core/src/config/index.ts` — new. Re-exports `genesis.ts`.
- `packages/core/src/index.ts` — re-export the config surface (additive; does not change `createCore`).
- `packages/core/test/genesis.test.ts` — new. Covers all five matrix rows (valid load + parse, type/missing/JSON failures).
- `packages/core/src/ports.ts`, `events/`, `test/ports.test.ts`, `test/core-surface.test.ts` — unchanged (1.2).

## Tasks & Acceptance

**Execution:**
- [ ] `config/genesis.json` — author the six-field genesis with initial placeholder values — the boot config every capability epic reads.
- [ ] `packages/core/src/config/genesis.ts` — `GenesisConfig` type + pure `validateGenesis` (per-field type/range checks, `SC-CONFIG-1` with field name) + `loadGenesis` (readFile/parse/validate) — the single owner of the genesis shape.
- [ ] `packages/core/src/config/index.ts` + `src/index.ts` — re-export the config surface — discoverable from the package entry.
- [ ] `packages/core/test/genesis.test.ts` — assert all five matrix rows — proves boot validation fails fast.

**Acceptance Criteria:**
- Given a well-formed `config/genesis.json`, when `loadGenesis` reads it, then it resolves to a typed `GenesisConfig` and no error is thrown.
- Given a config object with a field of the wrong type or a missing required field, when `validateGenesis` runs, then it throws `{ code:'SC-CONFIG-1' }` whose message names the offending field.
- Given a file path whose content is not valid JSON, when `loadGenesis` runs, then it rejects with `{ code:'SC-CONFIG-1' }`.

## Implementation Notes

(empty at planning time)

## Plan Change Log

(empty)

## Review Triage Log

Quick lens (subagent, session model; 2026-10-02) — **No findings.** All three ACs traced against the code (valid load of the real `config/genesis.json`; wrong-type and missing-field both throw `SC-CONFIG-1` naming the field; invalid-JSON file rejects), all Always/Never boundaries hold (pure validator, no new runtime dep, no UI imports, no sockets, no proto, `createCore` untouched), and all gates verified green (typecheck exit 0; 12/12 tests; build exit 0 with `dist/config/**` emitted, `genesis.json` not bundled). No loopback, no patches, no deferrals. `lenses_ran: ['quick']`.

## Design Notes

- **Hand-rolled validator (no dep).** The spine Stack lists no validation library and the spec forbids a second toolchain, so `validateGenesis` is a small typed checker: non-null object root, `protocolVersion`/`reattestationK`/`uptimeLookbackL` are integers ≥1, `bootstrap`/`gates` are string arrays (bootstrap entries must start with `/`), `emission.blockReward`/`maxSupply` are non-empty non-negative decimal strings. Each failure throws one `SC-CONFIG-1` naming the field.
- **Values are initial placeholders, by design.** The spine explicitly defers the *numbers* — K (re-attestation cadence), L (uptime lookback), the emission schedule, and *which two gates* — to the owning epics / open questions. The baseline genesis carries sensible starting values (e.g. `reattestationK:100`, `uptimeLookbackL:50`, `blockReward`/`maxSupply` decimal strings, the dual-gate recommendation as `gates`) so the schema + validation are real and tested; the values are a protocol decision later, not this story's.
- **`createCore` is untouched.** 1.3 delivers the config seam (load+validate); the full boot path (host calls `loadGenesis` then `createCore(...).start()`) is wired as later epics add the consensus loop. Keeping `createCore(ports)`'s 1.2 signature avoids churning its contract.

```ts
// config/genesis.ts (shape)
export interface GenesisConfig { protocolVersion: number; bootstrap: string[]; emission: { blockReward: string; maxSupply: string }; reattestationK: number; uptimeLookbackL: number; gates: string[] }
export function validateGenesis(raw: unknown): GenesisConfig  // throws SC-CONFIG-1
export async function loadGenesis(path: string): Promise<GenesisConfig>
```

## Verification

**Commands:**
- `corepack pnpm test` — expected: exit 0, all tests pass (7 from 1.1/1.2 + the new genesis rows); the malformed-config tests fail fast with `SC-CONFIG-1`.
- `corepack pnpm typecheck` — expected: exit 0, strict tsc clean across the new config module.
- `corepack pnpm build` — expected: exit 0, `src/config/**` emits into `dist/`; `config/genesis.json` stays a runtime data file (not bundled).
