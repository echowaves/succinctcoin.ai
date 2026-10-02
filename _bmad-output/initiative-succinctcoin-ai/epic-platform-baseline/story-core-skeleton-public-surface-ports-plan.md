---
title: 'Core skeleton + public surface + ports'
type: 'feature'
ticket: 2
created: '2026-10-02'
status: 'built'
baseline_revision: 'e2dd0ac213c2bd8a6a932c3e00c6372800a909a4'
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

**Problem:** `packages/core` is an empty placeholder (1.1 left only `src/index.ts` exporting a const). No seam exists for the capability epics: the five port interfaces (net/store/clock/gate/ui-sink) and the `core/events/` public surface (typed events + commands + read-API) are missing, so nothing can be built, type-checked, or tested against the spine's hexagonal contract (AD-1, AD-9).

**Approach:** Add the five port **interfaces** (type-only, no logic) in `src/ports.ts`, add `src/events/` owning the typed public surface (event payloads, commands, read-API `getPeers`/`getBlock`), and a `createCore(ports)` factory wiring the emitter + ui-sink. Prove AD-1 with a test that scans `src/**` for forbidden UI imports.

## Decisions

- **2026-10-02 — read-API return types (Option A).** `core/events/` owns typed UI **read-models**: `getPeers(): Promise<ReadPeer[]>`, `getBlock(slot): Promise<ReadBlock>`. `ReadPeer`/`ReadBlock` are lightweight presentation projections, explicitly NOT the wire types; 1.4's generated protocol types stay a separate module and the read-API projects to/from them later. Keeps 1.2 self-contained and AD-12-clean (no hand-written *protocol* types), fully typed now.

## Boundaries & Constraints

**Always:**
- TS 5.x, ESM NodeNext; relative imports carry `.js`; package imports extensionless.
- `packages/core` imports only `node:` builtins and its own devDeps; the public surface is owned by `core/events/` (AD-1/AD-9).
- Ports are **type-only interfaces** — no adapter logic, no libp2p/store/clock implementation here.
- Naming per spine: events PascalCase nouns, commands imperative; errors `{ code: 'SC-<DOMAIN>-<n>', message }`.

**Never:**
- No capability logic — no consensus/ledger/identity/net/store behavior (epics 2–5 fill the seams).
- No hand-written **protocol** types, no `.proto`, no protons (1.4, AD-12). The read-API's `getPeers`/`getBlock` exist and are typed in 1.2 per the decision above (read-models, distinct from 1.4's generated wire types).
- No real-socket transport (tcp/mdns); no big.js; no `electron`/renderer/UI import anywhere in `packages/core` (AD-1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FRESH_CORE | all 5 ports provided | `createCore` returns an instance; `on(event,fn)` subscribes; `start()` emits an event | no error |
| NO_UI_IMPORTS | scan `packages/core/src/**` | zero imports of `electron`/`react`/UI libs | a match fails the test |
| FIVE_PORTS | import `@succinctcoin/core` | all 5 port interfaces + `CoreInstance` exported | a missing export fails typecheck/test |
| EVENT_SINK | core wired with a ui-sink | emitting an event reaches both the emitter and the sink | no error |
| UNIMPL_STUB | `getPeers`/`getBlock`/`startMining` (capability command) | throws `{ code: 'SC-CORE-1', message }` | clear not-implemented error |

</frozen-after-approval>

## Code Map

- `packages/core/src/index.ts` — 1.1 placeholder (`CORE_PACKAGE` const). **Replace** with the `createCore(ports)` factory + re-exports; remove the placeholder.
- `packages/core/src/ports.ts` — new. `NetPort`, `StorePort`, `ClockPort`, `GateVerifier`, `UiSink` + the `CorePorts` bundle.
- `packages/core/src/events/types.ts` — new. `CoreEvents` map, `CoreCommands`, `CoreReadApi` (`getPeers`/`getBlock`), read-models `ReadPeer`/`ReadBlock` (per the decision), `CoreInstance`.
- `packages/core/src/events/index.ts` — new. Re-exports `events/types.ts`.
- `packages/core/test/no-ui-imports.test.ts` — new. Walks `src/**` and asserts no forbidden UI import.
- `packages/core/test/ports.test.ts` — new. Asserts the 5 port interfaces + `CoreInstance` are exported.
- `packages/core/test/core-surface.test.ts` — new. Fake ports; assert `createCore` wiring (on/emit→sink, start→emits) and that read/command stubs throw `SC-CORE-1`.
- `packages/core/package.json`, `tsconfig*`, root config — unchanged (1.1).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports.ts` — define the 5 type-only port interfaces + `CorePorts` — the hexagonal injection seam (AD-1/AD-4/AD-9).
- [x] `packages/core/src/events/types.ts` — define `CoreEvents`, `CoreCommands`, `CoreReadApi` (`getPeers`/`getBlock`), `ReadBlock`, `ReadPeer`, `CoreInstance` — the single owner of the public surface (AD-1/AD-9).
- [x] `packages/core/src/events/index.ts` — re-export the surface types.
- [x] `packages/core/src/index.ts` — implement `createCore(ports)`: `NodeJS.EventEmitter` + sink forwarding, read/command stubs throwing `SC-CORE-1`; re-export ports + surface — the runnable seam epics extend.
- [x] `packages/core/test/no-ui-imports.test.ts` — walk `src/**`, fail on any forbidden UI import — proves AD-1 by test.
- [x] `packages/core/test/ports.test.ts` + `core-surface.test.ts` — assert exports, wiring, and `SC-CORE-1` stub behavior — matrix coverage.

**Acceptance Criteria:**
- Given `packages/core` with zero UI imports, when the no-ui-imports test runs, then it passes and would fail if any `src/**` file imported `electron`/`react`/a UI library.
- Given the five ports + `createCore`, when `createCore` is called with all ports and `start()` is invoked, then an event is emitted and forwarded to the registered ui-sink.
- Given the read-API and command stubs, when `getPeers`/`getBlock`/any command is called, then it throws `{ code: 'SC-CORE-1' }` until a capability epic implements it.

## Implementation Notes

- **Added `@types/node@24.9.2`** to `packages/core` devDependencies (pnpm-lock.yaml updated). The Approach + task list require `NodeJS.EventEmitter`, which does not typecheck without node type declarations (verified: TS2307 `Cannot find module 'node:events'` + TS2503 `Cannot find namespace 'NodeJS'` without it). Pinned to 24.9.2 to match the Node 24 runtime. This overrides the Code Map's "package.json … unchanged (1.1)" note — the frozen intent + the exit-0 typecheck gate take precedence.
- **`PeerInfo` → `ReadPeer`.** The task list said `PeerInfo`, but the Code Map, the dated Decision (Option A), and AD-12 all specify `ReadPeer` (a UI read-model projection); `PeerInfo` is the AD-12-owned *generated* wire type (1.4) and must not be hand-written. So the read-model is `ReadPeer`.
- **`NodeJS.EventEmitter` is a type namespace, not a runtime value.** `new NodeJS.EventEmitter()` is `TS2708`; the emitter is constructed from `node:events` and the field is *typed* as `NodeJS.EventEmitter` (honoring the plan's naming). Documented in a code comment.
- **Node's core `EventEmitter` has no `'*'` wildcard listener** (that's `eventemitter2`-only), so ui-sink forwarding lives inside the `emit` method rather than a wildcard `on('*')`. Behavior matches the matrix `EVENT_SINK`.
- **Removed `test/trivial.test.ts`** (1.1 harness test that asserted the now-deleted `CORE_PACKAGE` const). 7 tests pass: memory-transport (1) + no-ui-imports (1) + ports (1) + core-surface (4).

## Plan Change Log

(empty)

## Review Triage Log

Quick lens (subagent, session model; 2026-10-02) — 2 findings, both verified real and **patched**:

1. `packages/core/test/no-ui-imports.test.ts` — the `FORBIDDEN` regex missed dynamic `import("electron")` (and `@electron-forge`), so the AD-1 "zero UI imports" proof had a real hole: an ESM `src/**` file doing `await import("electron")` would still pass. **Verdict: medium — patched.** Replaced with `/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](electron|@electron[\w/-]+|react-dom|react)(["'])/`. Verified by a regex probe: all 5 bad forms (static, dynamic, `import( x)`, `require`, `@electron-forge`) caught, and no false positives on `node:events`/`node:fs`/`libp2p`/`vitest`. The NO_UI_IMPORTS test re-ran green.
2. `packages/core/src/index.ts` — `getPeers`/`getBlock` are typed `Promise<…>` but threw synchronously, violating the return-type contract: a consumer using `core.getPeers().catch(…)` (AD-9: every command resolves its promise) hit an uncaught sync throw. **Verdict: medium — patched.** Verified empirically against the built dist: `core.getPeers()` → `SYNC THROW, code=SC-CORE-1`. Made both stubs `async` so the throw surfaces as a rejected promise; `startMining()` (typed `void`) still throws sync as the matrix intends. Updated the `UNIMPL_STUB` test to verify `getPeers`/`getBlock` **reject** with `SC-CORE-1` and `startMining` throws sync. All gates re-run green (7/7, typecheck, build).

No `intent_gap`/`bad_plan` findings — no loopback. `lenses_ran: ['quick']`, `review_loop_iteration` stayed 0.

## Design Notes

- Ports are injected into `createCore(ports)` and stored on the instance; capability epics attach logic to the returned instance without forking it. Type-only here — the adapters (libp2p, file store, slot clock, gate verifier, IPC bridge) land with the epics that use them.
- `UiSink` is how the core pushes events to the host without importing `electron`: the shell registers a sink; `createCore` forwards every emitted event to it. This is the AD-1 seam made concrete.
- `CoreCommands`/`CoreEvents` are the **baseline** command/event set; epics extend them (one owner = `events/`, per AD-9 tightening). The read-API return types are a design choice (Open Question): the recommended read-models are UI projections, distinct from 1.4's generated wire types — do not treat them as the protocol schema.

```ts
// ports.ts (shape)
export interface ClockPort { slotIndex(): number; lastBlockHash(): string }
export interface GateVerifier {
  verify(cred: GateCredential, windowIndex: number): Promise<GateVerification>
}
export interface CorePorts { net: NetPort; store: StorePort; clock: ClockPort; gate: GateVerifier; uiSink: UiSink }
```

## Verification

**Commands:**
- `corepack pnpm test` — expected: exit 0, 7 tests pass (1.1's 2 + 3 new files); the no-ui-imports test proves zero UI imports.
- `corepack pnpm typecheck` — expected: exit 0, strict tsc clean across the new surface.
- `corepack pnpm build` — expected: exit 0, new `src/**` emits into `dist/` with a resolvable entry.
