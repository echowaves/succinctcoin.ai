---
ticket: "1"
title: "Core: the running node (slot loop) + the UI data source (events + real read-API)"
epic: epic-desktop-app
status: "built"
route: full
baseline_revision: "53a94938646c31b2eb62f9a9696a017d7fed5440"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: ["R1", "E1", "E3"]
context:
  - packages/core/src/index.ts
  - packages/core/src/events/types.ts
  - packages/core/src/ports.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/src/consensus/miner.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/uptime.ts
  - packages/core/src/consensus/acceptance-cap.ts
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/identity/identity.ts
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/topics.ts
  - packages/core/src/ledger/ledger.ts
  - packages/core/src/ledger/display.ts
  - packages/core/src/store/file-chain-store.ts
  - packages/core/test/identity-key-surface.test.ts
  - packages/core/test/core-surface.test.ts
  - packages/core/test/boot-path.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-desktop-app/epic-desktop-app.md
---

# Story 6.1 — Core: the running node (slot loop) + the UI data source

## Overview (the story-of-truth)

This is EPIC 6's **prerequisite**: the core gains an integrated, running node (the AD-9 "consensus loop, the single writer in the main process") **and** the AD-9 UI data source (the event stream + the read-API) so the desktop shell (6.2–6.4) has something to show. After epic 5 the core has every seam (3.x mine, 4.x identity, 5.x net) but **no integrated running node**: `startMining()`/`getPeers()`/`getBlock()` are `SC-CORE-1` stubs and `CoreEvents` has only `CoreStarted`/`CoreStopped`. This story lands, **in the core** (per AD-9's one-owner rule — `core/events/` owns the event payload types + the read-API signatures):

1. **The slot loop** — a bounded-poll, `setTimeout`-driven loop (AD-3: chain-time only, NO wall clock, NO RNG) that each window composes the built seams: `nextSlotAndParent` → `deriveWindowChallenge` → build the local ticket (a real `signTicket` when an identity is injected, else the tracer ticket) → collect the gossiped tickets for the window (a bounded poll of the adapter's `received['tickets']`, when the net is a NetAdapter) → `applyAcceptanceCap` + `computeUptimeWeight` → `drawWindow` (AD-7) → `mineBlock` → `applyBlock` (AD-2) → `sendBlock` (gossip) → **emit `BlockApplied`**.
2. **The missing `CoreEvents`** — a `BlockApplied` event (PascalCase noun, spine convention) + the read-models, all in `events/types.ts` (the single owner).
3. **The REAL read-API** — `getChainHead`, `getBalances`, `getPeers`, `getBlock` — replacing the `SC-CORE-1` stubs.
4. **A working `startMining()`** (starts the loop) + `stop()` (halts it).

It COMPOSES the built seams (never re-implements any of them — AD-7/AD-2). The node now runs end to end: a single node mines a block each tick and the event stream + read-API reflect it. **This is a core `src` change (NOT test-only).**

## Acceptance criteria

- **AC-1 (the loop mines + emits a real signed block).** A plain-Node test (memory transport, zero real sockets, AD-10) drives `createCore` with the real ports — a `createNetAdapter` over `@libp2p/memory`, a real `FileChainStore` (mkdtemp), a store-backed `ClockPort`, `createOfflineGateVerifier`, and a REAL identity (`deriveIdentityKeypair(seed)`), with a `uiSink` that records events — calls `start()` then `startMining()`, and (bounded, event-driven wait — AD-3, NO wall-clock assertion) a `BlockApplied` event fires with `slot ≥ 1` carrying the winner identity id + the block hash + ticket/tx counts; the winner is the local identity (single participant always wins its own draw — same as 5.10 deviation 3); the mined block (via `getBlock(slot)`) has a `winnerTicket` that passes `verifyTicketSignature` from public data (a REAL signed ticket, AD-12); after `stop()` NO further `BlockApplied` fires (the loop halted).
- **AC-2 (the read-API is real; the stubs are gone).** `getChainHead()` resolves to `{ slot, hash, winnerIdentityId, ticketCount, txCount, totalSupplyDisplay }` matching the mined head; `getBalances()` resolves to `{ balances: Record<string, string> }` with the local identity's balance as a non-zero **decimal-string** (AD-5) and the MINT balance; `getPeers()` resolves to a `ReadPeer[]` (the net adapter's `peers()`; `multiaddrs: []` — the adapter exposes peer ids only); `getBlock(slot)` resolves to the block read-model for a present slot and **rejects normally** (a `{ code }`, never a sync throw) for an absent slot. The `SC-CORE-1` stub behavior is GONE — `core-surface.test.ts`'s `UNIMPL_STUB` row is replaced.
- **AC-3 (AD-9 one-owner; the complete UI data source).** The new `BlockApplied` event + the `ReadChainHead`/`ReadBalances` read-models live in `core/events/types.ts` (the single owner); `CoreReadApi` gains `getChainHead` + `getBalances` (additive — `getPeers`/`getBlock` kept); the read-models are UI projections (NOT the wire types — 1.4's generated `Block` stays separate, AD-12); the event stream + read-API is the complete UI data source.
- **AC-4 (AD-11 — no keys cross the surface).** The `BlockApplied` payload + the `ReadChainHead`/`ReadBalances` read-models carry **NO key material** (no field named `secret`/`privateKey`/`privateKeyHex`/`keypair`, and no field value byte-equal to the keypair's `secret`); the loop calls `signTicket(keypair, fields)` and **never reads `keypair.secret`** (the 4.7 single-reader source scan stays exactly `['identity/identity.ts']`); the 4.7 AD-11 guard (`test/identity-key-surface.test.ts`) is updated at exactly its two compile-break points (+ `surfacePayloads`) for the new event and stays green.
- **AC-5 (AD-2/AD-7 compose, never re-implement).** The loop COMPOSES the imported seams (`nextSlotAndParent`, `deriveWindowChallenge`, `signTicket`, `applyAcceptanceCap`, `protoTicketToDrawTicket`, `computeUptimeWeight`, `drawWindow`, `mineBlock`, `applyBlock`, the adapter's `sendBlock`/`peers`/`received`) — it does NOT re-implement the draw (AD-7), the ledger apply (AD-2), or the net. **No proto change** (the build regens `src/proto/` byte-identical — PROTO_OK).
- **AC-6 (AD-3/AD-10/AD-1).** The loop is bounded-poll + `setTimeout` (chain-time — a self-source scan finds NO `Date.now`/`Math.random` in `src/`); the test is plain-Node + `@libp2p/memory` (zero real sockets); the core still imports **zero** `electron`/renderer/UI (AD-1); `start()` keeps its one-block-per-start semantics (`boot-path.test.ts` stays green).

## Design notes

- **D1 (the loop is a new module).** `src/consensus/node-loop.ts` exports `createNodeLoop(opts: NodeLoopOptions): { stop(): void }`. `NodeLoopOptions` = `{ store: StorePort; net: NetPort & { readonly received?: ReadonlyMap<TopicClass, ReceivedEnvelope[]> }; identity?: IdentityKeypair; rewardBaseUnits: bigint; maxSupplyDisplay: string; mintId: string; lookbackL: bigint; emitBlockApplied: (p: BlockAppliedPayload) => void; tickMs: number }`. The loop is a `setTimeout`-driven tick (AD-3: the slot advances by loop iteration via `nextSlotAndParent`, never a wall clock; `tickMs` is a host/test constant, e.g. 15 ms). `stop()` clears the pending timer + sets a stopped flag (idempotent). It holds the local identity's mined-slot history (`Set<bigint>`) for the uptime weight (4.5).
- **D2 (the identity is an injected, OPTIONAL port).** `CorePorts` gains `identity?: IdentityKeypair` (the node's 4.2 PROTOCOL identity — the host creates it via `deriveIdentityKeypair(seed)` in the Electron main process, AD-11). When present, the loop signs its ticket with `signTicket(identity, fields)` (a real signed ticket, AD-12); when **absent**, the loop uses the existing tracer ticket (empty signature, `TRACER_WINNER_ID`) — preserving the single-node default and backward-compat (every existing `createCore(makePorts())` caller that passes no identity still mines). `start()` is UNCHANGED (it keeps the tracer one-block path — boot-path stays green); only the loop's `startMining()` uses the injected identity.
- **D3 (the accepted set, single-node by default).** Each window: the local ticket (D2) + the gossiped tickets for the window (a **bounded poll** of `net.received?.get('tickets')` filtered to the window's slot — present only when `net` is a NetAdapter; a bare `NetPort` → no gossiped tickets → single-node). Deduped by `identityId` (keep-first), identity-sorted, `applyAcceptanceCap` (4.4), weights via `computeUptimeWeight(validWindows, slot, lookbackL)` (4.5) — the local identity's `validWindows` = its mined slots in `[slot−L, slot−1]` (tracked in D1); a single participant always wins its own draw (the Done-when is about mining/propagation, not draw competition — 5.10 deviation 3).
- **D4 (the real read-API).** `getChainHead`: `store.headSlot()` (−1 → a zero/empty head read-model) → `store.getBlock(head)` → `Block.decode` → project `{ slot, hash: hex, winnerIdentityId, ticketCount, txCount, totalSupplyDisplay: toDisplay(totalSupply(fromJson(loadState))) }`. `getBalances`: `store.loadState()` (null → `{ balances: {} }`) → `fromJson` → `toJson` (identity id → **decimal-string** base units, AD-5) → `{ balances }`. `getPeers`: `net.peers()` (transport peer-id strings) → `.map(peerId => ({ peerId, multiaddrs: [] }))` (the adapter exposes ids only — a documented projection limitation, not a defect). `getBlock(slot)`: `store.getBlock(slot)` (null → **normal reject** with a `{ code: 'SC-CORE-1' }`-class, never a sync throw) → `Block.decode` → project.
- **D5 (lifecycle).** `startMining()` is idempotent (a second call is a no-op) and starts the loop using the genesis config captured in `start()` (`rewardBaseUnits = fromDisplay(cfg.emission.blockReward)`, `maxSupplyDisplay = cfg.emission.maxSupply`, `lookbackL = cfg.uptimeLookbackL`, `mintId = MINT_ID`); it rejects (a normal `{ code }`) if `start()` has not run. `stop()` stops the loop (if running), then emits `CoreStopped`, then `store.close()` (AD-9 order preserved).
- **D6 (the event + read-model shapes).** `BlockApplied` payload = `{ slot: number; hash: string; winnerIdentityId: string; ticketCount: number; txCount: number }` (mirrors `ReadBlock`; `slot` = `Number(bigint slot)`; `hash` = the hex of `block.hash`; **key-free**). `ReadChainHead = { slot: number; hash: string; winnerIdentityId: string; ticketCount: number; txCount: number; totalSupplyDisplay: string }`; `ReadBalances = { balances: Record<string, string> }` (identity ids are public 32-byte-hex, NOT key material). `ticketCount` = the accepted set's size for that window (the loop knows it); the decoded `Block` proto carries no ticket count, so the read-API projects it from the loop's tracked window (or `1` for the head when only the winner ticket is known — a documented projection, D6 note).
- **D7 (the 4.7 AD-11 guard).** Adding `BlockApplied` to `CoreEvents` breaks compilation of `test/identity-key-surface.test.ts` in exactly two places: the `allEventPayloadsClean` literal (needs `BlockApplied: clean`) and the `EXPECTED_KEY_SETS` literal (needs `BlockApplied: ['hash','slot','ticketCount','txCount','winnerIdentityId']`); `surfacePayloads()` gains a `BlockApplied` payload with exactly those keys. The type-level `SurfaceClean` then proves the payload carries none of the four key-material names. `ReadChainHead`/`ReadBalances` are NOT in the guard's hardcoded set (only `ReadPeer`/`ReadBlock` + every `CoreEvents[K]` payload are scanned) — they are still kept key-free by AD-11.
- **D8 (the replaced stub test).** `core-surface.test.ts`'s `UNIMPL_STUB` row (which pins `startMining` sync-throw + `getPeers`/`getBlock` reject `SC-CORE-1`) is **replaced** — its premise (the stubs) is gone. The new behavior is covered by the node-loop test (AC-1/AC-2) + `core-surface` keeps its `FRESH_CORE`/`EVENT_SINK`/`CoreStarted`-payload rows intact.

## Code map

- `src/events/types.ts` — += `BlockApplied` to `CoreEvents`; += `ReadChainHead` + `ReadBalances` read-models; += `getChainHead(): Promise<ReadChainHead>` + `getBalances(): Promise<ReadBalances>` to `CoreReadApi`; reword the `startMining`/read-API doc comments (no longer stubs).
- `src/consensus/node-loop.ts` (NEW) — `createNodeLoop(opts): { stop(): void }` + the `NodeLoopOptions` type; the tick + `runWindow()` composing the seams (D1/D3).
- `src/consensus/index.ts` — re-export `createNodeLoop` + `type { NodeLoopOptions }` (additive).
- `src/ports.ts` — `CorePorts` += `identity?: IdentityKeypair` (D2; import the `IdentityKeypair` type from identity — a type-only import, no cycle).
- `src/index.ts` (`createCore`) — capture the genesis config in the closure on `start()`; `startMining()` → `createNodeLoop` (D5, idempotent); `stop()` → stop the loop first; `getPeers`/`getBlock` real (D4) + `getChainHead`/`getBalances` real (D4); remove `notImplemented` calls for the now-real ops (drop the `notImplemented` helper if it becomes unused — no dead code). Barrel: += `ReadChainHead`/`ReadBalances` types (additive).
- `test/identity-key-surface.test.ts` — += the `BlockApplied` entries (D7: the 2 compile-break literals + `surfacePayloads`).
- `test/core-surface.test.ts` — replace the `UNIMPL_STUB` row (D8).
- `test/core-node-loop.test.ts` (NEW) — the rows below (root-barrel-only + `vitest` + node builtins; memory transport; bounded polls; NO wall-clock/RNG).

## Test matrix (`test/core-node-loop.test.ts`)

- **NODE_LOOP_MINES_REAL_TICKET** (AC-1): real ports (memory `createNetAdapter`, real `FileChainStore` mkdtemp, a store-backed clock, `createOfflineGateVerifier`, a real `deriveIdentityKeypair(seed)`, a recording `uiSink`); `start()` (slot 0, tracer) → `startMining()` → **bounded** event-driven wait for a `BlockApplied` with `slot ≥ 1` → assert `winnerIdentityId === keypair.identityId` (single participant) + the payload's key set is exactly `{slot,hash,ticketCount,txCount,winnerIdentityId}` (no key material) + `getBlock(slot).hash === payload.hash` + the mined block's `winnerTicket` passes `verifyTicketSignature` from public data (real signed ticket, AD-12); `stop()` → a short bounded wait → **no** further `BlockApplied` (loop halted).
- **NODE_LOOP_READ_API** (AC-2): after mining, `getChainHead()` (slot/hash/winnerIdentityId/`totalSupplyDisplay` is a decimal string) + `getBalances()` (the identity's balance is a non-zero decimal string; MINT present) + `getPeers()` (resolves to an array; empty for a lone memory node — the adapter's `peers()`) + `getBlock(0)` (the slot-0 read-model) + `getBlock(<absent>)` **rejects normally** (a `{ code }`, not a sync throw). The `SC-CORE-1` stub reject is gone.
- **NODE_LOOP_TRACER_FALLBACK** (D2 backward-compat): `createCore` with **no** `identity` (the existing `makePorts`-shape fake) → `startMining()` still mines (the tracer ticket, empty signature, `TRACER_WINNER_ID`) — the single-node default is preserved.
- **NODE_LOOP_AD11_AND_HYGIENE** (AC-4/AC-5/AC-6, self-scan): the `BlockApplied` payload + the read-models carry no key material (name + value); the loop file reads `.secret` NOWHERE (the 4.7 scan is the authority — re-assert `['identity/identity.ts']`); a comment-stripped `src/**` scan finds NO `Date.now(`/`Math.random(` and NO `electron`/renderer/UI import (AD-1) and NO direct `big.js` import outside `ledger/display.ts`/`ledger/fee.ts` (the 2.5 no-float set is unchanged); every `../src/` import in the test == the root barrel only (no `@libp2p/`, no `@multiformats/`).

## Never

- Never re-implement the draw (AD-7), the ledger apply (AD-2), or the net — compose the imported seams.
- Never read `keypair.secret` / `.secret` outside `identity/identity.ts` (AD-11 single-reader).
- Never add a key-material field to the `BlockApplied` payload or the new read-models (AD-11).
- Never use a wall clock or RNG in `src/` (AD-3) — the loop is bounded-poll + `setTimeout`.
- Never change `start()`'s one-block-per-start semantics or the `CoreStarted`/`CoreStopped` payloads (boot-path stays green).
- Never change the proto (PROTO_OK — the build regens `src/proto/` byte-identical).
- Never import `electron`/renderer/UI in the core (AD-1); never add `@libp2p/kad-dht`; never import `big.js` directly outside `ledger/display.ts`/`ledger/fee.ts`.
- Never break the 4.7 AD-11 guard (update it with the `BlockApplied` entries, keep it green).
- Never turn a read-API miss into a sync throw — a missing `getBlock` slot is a normal reject with a `{ code }`.

## Verification (the gate — orchestrator re-runs all, from the correct dirs)

- The full core suite is green (prior 252 + the new node-loop rows − the replaced `UNIMPL_STUB` + the updated 4.7 guard); typecheck clean; build clean (protons regen byte-identical — PROTO_OK).
- The 4.7 AD-11 guard is green (the `BlockApplied` entries prove the payload is key-free).
- Diff gates (from the repo root, absolute-path cds): `git diff` over `src/` = the expected files only (`events/types.ts`, `consensus/node-loop.ts` (new), `consensus/index.ts`, `ports.ts`, `index.ts`); `git diff --name-only -- packages/core/src/proto/` EMPTY; `git diff --name-only -- packages/core/package.json pnpm-lock.yaml` EMPTY (no new deps); the 2.5 no-float `big.js` import set is unchanged.
- Deterministic ×2 (the node-loop rows run twice, identical).

## Implementation Notes

- **T1 (`events/types.ts`)** — `BlockApplied` added to `CoreEvents` (key-free: `slot`, `hash`, `winnerIdentityId`, `ticketCount`, `txCount`); `ReadChainHead` + `ReadBalances` read-models added; `CoreReadApi` += `getChainHead()`/`getBalances()`; `startMining()` re-typed `void` → `Promise<void>` (rejects with a `{ code }` when `start()` has not run); module + per-member doc comments reworded (no longer stubs).
- **T2 (`consensus/node-loop.ts`, NEW)** — `createNodeLoop(opts): { stop(): void }`, `setTimeout`-driven bounded-poll tick (AD-3; `tickMs` a host constant — `createCore` passes `NODE_LOOP_TICK_MS = 15`). Each `runWindow()` composes, in order: `nextSlotAndParent` → `deriveWindowChallenge` → local ticket → gossiped tickets → dedup/sort/cap → weights → `drawWindow` → `mineBlock` → `applyBlock` → `net.sendBlock` → `emitBlockApplied`. Local ticket: the 4.8 `signedTicket` seam (imported from `multi-sim.ts`; `signTicket` over the exact AD-12 digest) when `opts.identity` is injected, else a local tracer stub (see Change Log, deviation 1). Gossiped set: ONE bounded read of `net.received?.get('tickets')` filtered to `windowIndex === slot` (bare `NetPort` → none → single-node). Dedup by `identityId` keep-first (local added FIRST so it wins its own identity slot), identity-sorted, `applyAcceptanceCap`. Uptime weight: local = its `minedSlots` `Set<bigint>` (slots it WON) intersected to the lookback window; gossiped identities = `0n` (no tracked history — the 4.5 ramp-from-zero). `runWindow` is wrapped in try/catch so a failed window does not halt the loop (the next tick re-derives from the persisted head); `sendBlock` is best-effort (5.2 D6); `stop()` sets the flag + clears the timer (idempotent). `BlockAppliedPayload = CoreEvents['BlockApplied']` (AD-9 single owner).
- **T3 (`ports.ts`, `index.ts`)** — `CorePorts.identity?: IdentityKeypair` (type-only import, no cycle). `createCore`: `start()` unchanged boot + captures the genesis config once (`rewardBaseUnits = fromDisplay(blockReward)`, `maxSupplyDisplay`, `lookbackL` — the AD-5 display→base-unit conversion happens once at the caller, never per window); `startMining()` async + idempotent, rejects `SC-CORE-1` before `start()`; `stop()` stops the loop first, then `CoreStopped`, then `store.close()` (AD-9 order); `getPeers`/`getBlock`/`getChainHead`/`getBalances` all real (misses are normal `{ code }` rejects, never sync throws). `ticketCount` in the read-API is projected from `lastWindow` (the loop's tracked accepted-set size) when the head slot matches, else `1` (the D6 documented projection — the decoded `Block` proto carries no ticket count). `notImplemented` helper removed (unused). Barrel += `ReadChainHead`/`ReadBalances`.
- **T4 (tests)** — `core-node-loop.test.ts` (NEW, 4 rows, root-barrel-only imports, memory transport, bounded waits, no wall clock/RNG) + `identity-key-surface.test.ts` updated at exactly the D7 points (`surfacePayloads` + the two compile-break literals) + `core-surface.test.ts` `UNIMPL_STUB` row replaced by `LIVE_START_MINING`.
- **Verification (from `packages/core`)** — full suite **256/256 green** (prior 252 + 4 new rows; the replaced stub row is in-place); `typecheck` clean; `build` clean with protons regen byte-identical (PROTO_OK); diff gates from the repo root: `src/proto/` diff EMPTY, `package.json`/`pnpm-lock.yaml` diff EMPTY, `src/` diff = exactly the five expected files; 2.5 `big.js` set unchanged (`ledger/display.ts` + `ledger/fee.ts` only); 4.7 AD-11 single-reader scan = exactly `['identity/identity.ts']`.

## Plan Change Log

- **Deviation 1 (minor, disclosed): the tracer ticket is a local copy, not an import.** D2 says the no-identity path uses "the existing tracer ticket" — but `slot-loop.ts`'s `tracerTicket` is module-PRIVATE (no exported seam exists to compose). `node-loop.ts` therefore carries its own local copy of the identical deterministic 10-line stub (same `SC-TRACER-COMMIT/1` domain, empty signature, `TRACER_WINNER_ID`). This is NOT a re-implementation of the draw (AD-7), the ledger apply (AD-2), or the net — only of the inert single-node placeholder ticket. Alternative (export the private helper from `slot-loop.ts`) was rejected: it would widen `slot-loop.ts`'s surface for a tracer-only concern. Byte-identity of the stub is pinned by the `NODE_LOOP_TRACER_FALLBACK` row — which, after the Quick-lens review, recomputes the pinned `sha256("SC-TRACER-COMMIT/1" ‖ parentHash ‖ u64be(slot))` from the parent block's hash and asserts `nonceCommitment` equality (not just identity + empty signature).
- **Review patches (Quick lens, iteration 1 — see the Review Triage Log):** (a) `stop()` now also resets `genesis = null`, so a `startMining()` after `stop()` (without a fresh `start()`) rejects `SC-CORE-1` instead of silently re-creating a loop that would tick forever against the closed store (finding 3); pinned in `core-surface.test.ts` `LIVE_START_MINING`. (b) `NODE_LOOP_TRACER_FALLBACK` now pins the tracer ticket's `nonceCommitment` bytes (finding 4), upholding Deviation 1's byte-identity claim. No other deviations: T1–T4 as specified; no proto change; no deps added; `status:` left for the orchestrator.

## Review Triage Log

Quick lens (iteration 1) — 4 findings, verified individually against the code.

1. **The loop never gossips its own ticket (`sendTicket`), so the D3 gossiped-ticket branch has no producer; a multi-node deployment would fork (every node wins every draw).** — *Deferred (out of 6.1 scope).* Verified: no code in `src/` calls `net.sendTicket` (only the `NetPort` declaration in `ports.ts` + the adapter impl in `net/adapter.ts`). The plan defers draw competition explicitly (D3 / 5.10 deviation 3: "the Done-when is about mining/propagation, not draw competition"). 6.1's scope is the single-node running node + the UI data source; the D3 gossiped-collection branch is wired and correct for when a `sendTicket` producer lands (a later multi-node story). The local ticket is always valid (signed locally via `signTicket`), so no invalid ticket enters the draw in 6.1's single-node scope. No 6.1 code change.
2. **Gossiped tickets are admitted to the draw with no protocol validation (AD-2/AD-7 tension).** — *Deferred (out of 6.1 scope).* Same root as finding 1: the gossiped branch has no producer, so no gossiped ticket ever arrives in 6.1. When a `sendTicket` producer lands, the accepted-set validation (4.3 `verifyTicketSignature` / challenge match / AD-4 gate check) is a precondition of that multi-node story. The implementation matches plan D3 verbatim (a plan-vs-spine tension, not an implementation deviation). No 6.1 code change.
3. **`startMining()` after `stop()` starts an infinite silent tick loop against the closed store.** — *Fixed + pinned.* Verified real: `stop()` reset `loop = null` but not `genesis`, so a post-stop `startMining()` passed both the idempotency check and the `genesis === null` check and re-created a loop whose every tick threw at `store.loadState()` (store closed), swallowed by the window's try/catch, with `schedule()` re-arming the 15 ms timer forever. Fix: `stop()` now also resets `genesis = null`, so a post-stop `startMining()` (without a fresh `start()`) rejects `SC-CORE-1` (a normal reject — never a sync throw). Pinned in `core-surface.test.ts` `LIVE_START_MINING` (post-stop `startMining()` rejects `{ code }`).
4. **The `NODE_LOOP_TRACER_FALLBACK` row did not pin the tracer ticket's commitment bytes (the Change Log's "byte-identity is pinned" claim was over-stated).** — *Fixed + pinned.* Verified: the row asserted the identity + empty signature but not the `nonceCommitment`/`challenge` bytes. Fix: the row now recomputes the pinned `sha256("SC-TRACER-COMMIT/1" ‖ parentHash ‖ u64be(slot))` from the parent block's hash (public data only, no `.secret` read) and asserts `ticket.nonceCommitment` equals it — upholding the module doc's byte-identity claim (byte-identical to `slot-loop.ts`'s tracer ticket).

Full gate re-run after the patches: **256/256 green, typecheck clean, build PROTO_OK**.

## Task

- [x] T1 — `events/types.ts`: `BlockApplied` event + `ReadChainHead`/`ReadBalances` read-models + `CoreReadApi` += `getChainHead`/`getBalances` (AC-3, D6).
- [x] T2 — `node-loop.ts` (NEW): `createNodeLoop` + the tick + `runWindow` composing the seams (AC-1/AC-5, D1/D3); `consensus/index.ts` re-export.
- [x] T3 — `ports.ts` += `CorePorts.identity?` (D2); `index.ts` `createCore`: `startMining` (D5) + `stop` (loop halt + genesis reset) + real read-API (D4) + genesis capture; drop dead `notImplemented`; barrel += read-model types (AC-1/AC-2).
- [x] T4 — tests: `core-node-loop.test.ts` (4 rows) + update `identity-key-surface.test.ts` (D7) + replace `core-surface.test.ts` `UNIMPL_STUB` (D8) + pin the two review-patch fixes (AC-1..AC-6).
