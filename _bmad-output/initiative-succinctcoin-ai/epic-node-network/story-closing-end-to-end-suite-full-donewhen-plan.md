---
ticket: "10"
title: "Closing end-to-end suite (full Done-when)"
epic: epic-node-network
status: "built"
route: full
baseline_revision: "d38ad5f954b94b61592ae984da9ecad07b93de34"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [R1, R2, E1, E2]
context:
  - packages/core/test/block-propagation.test.ts
  - packages/core/test/ticket-tx-propagation.test.ts
  - packages/core/test/circuit-relay-v2.test.ts
  - packages/core/test/dht-threshold-spike.test.ts
  - packages/core/test/epic4-end-to-end.test.ts
  - packages/core/src/index.ts
  - packages/core/package.json
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/spike-dht-threshold-spike-e2-plan.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/story-closing-end-to-end-suite-full-donewhen-plan.md
---

# Story Plan — 5.10 Closing end-to-end suite (full Done-when)

## Story of truth

Run the **closing end-to-end suite** for epic 5 (node-network / CAP-3): the full
Done-when as **ONE integrated, headless, memory-transport scenario**. Like 3.9's
closing suite (epic 3) and 4.10's (epic 4), this is **TEST-ONLY** — one new file
(`packages/core/test/epic5-end-to-end.test.ts`) that **COMPOSES** the already-built
epic-5 seams (the 5.1 memory-transport `createNetAdapter`, the 5.2 gossipsub
topics + proto envelopes, the 5.3 discovery, the 5.4 `syncChain`, the 5.5 block
propagation driver, the 5.6 ticket/tx own-topic propagation, the 5.7
circuit-relay-v2 relay) together with the epic-3/4 seams (the 3.3 slot loop /
`drawWindow`, the 4.2 signed ticket, the 4.3/4.4 acceptance path, `applyBlock`) —
**all imported from the root barrel `../src/index.js`, NEVER re-implementing any of
them (AD-2 / AD-7)**. It proves **ALL FIVE** Done-when green together, in one
coherent headless `@libp2p/memory` topology with **zero real sockets (AD-10)**.

This story ADDS NO SOURCE. It is the integration proof the whole epic has been
building toward: the Done-when is not just true per-story (5.2–5.8), it holds in one
integrated run of a NATed node discovering, syncing, and gossiping through a relay.

## The integrated topology (ONE memory-transport scenario)

A **relay + a NATed node + two direct nodes** over `@libp2p/memory`, `k = 2`
(the two direct peers). Per-row lifecycle (`beforeEach` builds, `afterEach`
tears down — the 4.10 per-row isolation pattern; the relay topology build is ~3 s
of mesh settle, acceptable per row with a 90 s row `timeout`):

- **relay** — `relayRole: 'relay'`, listens on `/memory/relay`. **No store, no draw
  participation** (a pure relay — nothing requires it to hold a chain).
- **NATed** — `relayRole: 'client'`, `relayAddress: '/memory/relay'`, placeholder
  `listenAddress` the adapter IGNORES (client → `addresses.listen = []`, no direct
  inbound). **Has a `FileChainStore`** + participates in the draw/mining.
- **A** — `relayRole: 'none'`, listens on `/memory/a`. Has a `FileChainStore`.
- **B** — `relayRole: 'none'`, listens on `/memory/b`. Has a `FileChainStore`.

**Wiring** (the explicit-dial model — the adapter never auto-dials; compose the 5.5
`addNode` full-mesh + the 5.7 `RelayTopology` relay-wiring):
1. Start the relay.
2. **NATed dials the relay FIRST** (`dialWithRetry(nated, '/memory/relay')`) — the
   adapter registers the circuit reservation on that dial (5.7: fire-and-forget).
   NATed also dials **A and B directly** (outbound `/memory/a`, `/memory/b`) so it
   can sync + gossip (a node behind NAT can still dial out).
3. **A** dials the relay directly (the hop reuses it) **and dials NATed's proxied
   multiaddr** `relayProxiedMultiaddr(relayPeerId, natedPeerId) =
   /p2p/<relayId>/p2p-circuit/p2p/<natedId>` (the 5.7 peer-id-only form) with a
   wider `HOP_DIAL_POLLS` (the first attempts race the reservation) — this gives
   NATed an **inbound connection via the relay** (the NAT-traversal path, DW3).
4. **B** does the same as A (dials the relay + NATed's proxied multiaddr).
5. `settleMesh()` (bounded yield, ~3 gossipsub heartbeats) before any publish.

Result: NATed has outbound links to A, B, and the relay; A and B each reach NATed
**through the relay** (the proxied dial) — the realistic NAT topology. gossipsub
floods across the mesh (A—NATed—B, plus the relay links for DW3). The proxied dial
multiaddr is built **only** from the two peers' `peerId()` strings (AD-8 / 5.7).

## The five Done-when → rows (one integrated scenario)

Each row runs over the SAME per-row topology. All waits are **bounded polls**
(loop counters + bounded `setTimeout`, AD-3 — never a timestamp read); "bounded
time" is an event bound (a count of received messages / a bounded poll budget), not
wall-clock.

| Row | Done-when | What it proves (composition, root-barrel only) |
|-----|-----------|------------------------------------------------|
| `E2E5_R1_NATED_DISCOVER_SYNC_GOSSIP_K` | **#1** (R2) | (a) **discovers**: after wiring, a bounded poll over `natAdapter.peers()` sees BOTH `aPeerId` and `bPeerId` (k=2 peers, through the relay). (b) **syncs**: A mines one window (its store advances past genesis); NATed — still at genesis — calls `syncChain({ client: natAdapter, peer: aPeerId, store: natStore, rewardDisplay, maxSupplyDisplay })` and its store head slot reaches A's (the sync runs over NATed's live link to A). (c) **gossips a test block to k peers**: NATed authors a test block (compose the 5.5 `mineBlock` on top of its synced head) and `sendBlock`s it; a bounded poll over `A.received` **and** `B.received` (blocks topic) shows the block landed at both (k=2). The whole row is event-bounded (AD-3) over the memory transport (zero real sockets). |
| `E2E5_R2_BLOCK_TICKET_TX_OWN_TOPICS` | **#2** (R1, AD-8) | ONE topic per message class, end-to-end: A (the window winner) authors a block and `sendBlock`s it — a bounded poll shows it at NATed **and** B (k=2) on the `blocks` topic; A then `sendTicket`s a signed ticket and `sendTx`s a tx — bounded polls show the ticket on the `tickets` topic and the tx on the `tx` topic at NATed **and** B (each class on ITS OWN topic — the 5.2/5.6 invariant, asserted over the live relay mesh, not just a direct pair). |
| `E2E5_R3_RELAY_CONNECTS_NATED` | **#3** (E1) | the circuit-relay-v2 adapter connects the NATed node **through the relay**: the NATed node (`relayRole: 'client'`, `addresses.listen = []` — no direct inbound) is nonetheless reachable by A and B **only via the relay** — a bounded poll confirms `natAdapter.peers()` includes `aPeerId` and `bPeerId` and the relay's `peers()` includes the NATed node; A's proxied-dial (`/p2p/<relayId>/p2p-circuit/p2p/<natedId>`) succeeded (the 5.7 NAT-traversal path, exercised on the memory relay). |
| `E2E5_R4_DHT_DECISION_NO_DHT` | **#4** (E2) | the DHT-threshold spike's recommendation is **recorded in the epic Notes** and Kad-DHT is **NOT wired**: (a) a read of `epic-node-network.md` contains the dated 2026-10-13 DHT Decision (the known-list model suffices — "do NOT wire Kad-DHT at launch"); (b) `packages/core/package.json` has **no** `@libp2p/kad-dht` in `dependencies` or `devDependencies`; (c) a comment-stripped scan of `src/**` finds **no** `@libp2p/kad-dht` import. The no-DHT non-goal holds. |
| `E2E5_R5_MEMORY_HEADLESS_ZERO_SOCKETS` | **#5** (AD-10) | `@libp2p/memory` runs the net suite headless with zero real sockets: the module pins `const TRANSPORT = 'memory' as const` (the single selector passed to every `createNetAdapter`) and the row asserts `expect(TRANSPORT).toBe('memory')`; a **self-source scan** of this test file asserts NO `Date.now(`, NO `Math.random(`, imports ONLY from `../src/index.js` (+ `node:*` builtins), and NO `@libp2p/` or `@multiformats/` import — the run passing headless IS the empirical zero-sockets proof (the 5.x ADDITIVE/NO_DHT_WIRED guard pattern). |

## The composition (root-barrel `../src/index.js` ONLY — value vs type)

- **Values:** `createNetAdapter`, `TOPICS`, `SYNC_PROTOCOL`, `loadGenesis`,
  `FileChainStore`, `fromDisplay`, `deriveIdentityKeypair`, `signTicket`,
  `verifyTicketSignature`, `deriveWindowChallenge`, `computeUptimeWeight`,
  `applyAcceptanceCap`, `isEligibleAtWindow`, `reattestationWindow`, `drawWindow`,
  `verifyDraw`, `nextSlotAndParent`, `mineBlock`, `applyBlock`, `acceptBlockWinner`,
  `syncChain`, `buildSyncSource`, `MINT_ID`, proto codecs `Block`/`Ticket`/`Tx`
  (and `BlockEnvelope`/`TicketEnvelope`/`TxEnvelope` if the driver needs them).
- **Types:** `NetAdapter`, `NetAdapterConfig`, `ReceivedEnvelope`, `TopicClass`,
  `SyncSource`, `SyncWindowRecord`, `IdentityKeypair`, `MultiSimIdentity`,
  `BalanceMap`.
- **Node builtins:** `node:fs`, `node:os`, `node:path`, `node:url`. Plus `vitest`.
  NEVER `big.js`, NEVER a sub-module path (`../src/net/...`), NEVER
  `@libp2p/peer-id` (transitive-only).

Re-use the 5.x driver helpers by **re-implementing them in-test** (the 5.5/5.6/5.7
drivers are self-contained per the 5.6 deferral — there is no shared driver to
import): `sleep`, `bytesEqual`, `seedFor`, `dialWithRetry`, `pollReceived` (the
per-topic read-cursor over `adapter.received`), `settleMesh`, `makeNode` (with the
`relayRole`/`relayAddress` config), `relayProxiedMultiaddr`. These are test-local
glue (bounded-poll loops + the proxied multiaddr string) — NOT a re-implementation
of any protocol seam (the draw / sync / gossip / relay are all the imported
seams). The 5.5 `NetNode`/`NetNetwork` shape (a store + an adapter + a per-topic
read cursor per node) is the model to adapt.

## Acceptance criteria

- **AC-1 — TEST-ONLY:** the ONLY new file is
  `packages/core/test/epic5-end-to-end.test.ts` (+ the plan). `git diff <baseline>`
  over `packages/core/src` is EMPTY (no source changed) AND
  `git diff --name-only -- packages/core/src/proto/` is EMPTY (**PROTO_OK** — the
  3.8/4.9/5.8 precedent: a builder who touches proto but not src still passes). The
  test imports ONLY from `../src/index.js` (+ `node:*` builtins) — never a
  sub-module path, never `big.js`, never `@libp2p/peer-id`.
- **AC-2 — ALL FIVE Done-when:** the file has exactly 5 rows, one per Done-when
  (`E2E5_R1_NATED_DISCOVER_SYNC_GOSSIP_K`, `E2E5_R2_BLOCK_TICKET_TX_OWN_TOPICS`,
  `E2E5_R3_RELAY_CONNECTS_NATED`, `E2E5_R4_DHT_DECISION_NO_DHT`,
  `E2E5_R5_MEMORY_HEADLESS_ZERO_SOCKETS`), each asserting its Done-when over the
  integrated relay topology.
- **AC-3 — ONE integrated headless memory-transport scenario:** the rows share ONE
  `@libp2p/memory` topology (relay + NATed + A + B, k=2) — a NATed node discovering,
  syncing, and gossiping through a relay (the 3.9/4.10 pattern). No real sockets, no
  new runtime deps (AD-10).
- **AC-4 — NEVER re-implement:** the draw (`drawWindow`/`deriveWindowChallenge`),
  the sync (`syncChain`/`buildSyncSource`), the gossip (the adapter's `sendBlock` /
  `sendTicket` / `sendTx` + `TOPICS`), the relay (`createNetAdapter` with
  `relayRole`/`relayAddress`), the slot loop (`nextSlotAndParent`), the signed
  ticket (`signTicket`), the acceptance (`acceptBlockWinner`/`applyAcceptanceCap`),
  and the ledger (`applyBlock`) are all IMPORTED from the barrel. No `Math.random`,
  no wall clock (AD-3); bounded polls only; no float / no `big.js` in the test
  (AD-5).
- **AC-5 — Green headless:** `pnpm test` passes — the suite goes **247 → 252 tests
  (36 → 37 files)** (+5, the new rows only; every prior suite unchanged);
  `pnpm typecheck` clean; `pnpm build` passes (proto byte-identical, PROTO_OK); the
  suite is **deterministic** (structural invariants — same block bytes at all k
  peers, head-slot equality, topic-class separation — are stable across 2 runs; no
  wall-clock or RNG anywhere).

## Never (hard constraints)

- NEVER touch `packages/core/src/**` (no source change — this is the test-only
  closing suite, the 3.9/4.10/5.8 precedent). No new source file, no barrel change.
- NEVER change the proto (`packages/core/src/proto/` byte-identical, PROTO_OK) or
  add any dependency (`package.json` unchanged — in particular **no
  `@libp2p/kad-dht`**).
- NEVER re-implement a protocol seam (draw / challenge / sync / gossip / relay /
  slot loop / signed ticket / acceptance / ledger) — compose the imported seams
  only (AD-2 / AD-7). Test-local bounded-poll helpers + the proxied-multiaddr
  string are allowed glue; the seams are not.
- NEVER import from a non-root path (`../src/net/...`, `../src/consensus/...`) or
  from `big.js` or `@libp2p/peer-id` — root barrel `../src/index.js` + `node:*`
  only.
- NEVER use `Math.random`, a wall clock (`Date.now` / `performance.now` / a
  timestamp read), or a float for a protocol quantity (AD-3/AD-5) — bounded polls
  (loop iterations) and exact `bigint` / byte-equality comparisons only.
- NEVER weaken or edit any existing guard test (the 2.5 no-float, the 5.x
  ADDITIVE/NO_DHT_WIRED scans, or any 5.x net suite) — they stay green and
  byte-identical.
- NEVER open a real socket — the transport is `memory` everywhere (AD-10).

## Verification (acceptance gate)

From the repo root (`corepack pnpm`; `pnpm` not on PATH). ALL green:

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → **252 tests / 37 files**
   (247 prior + 5 new).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1 && git diff --name-only -- packages/core/src/ && git diff --name-only -- packages/core/src/proto/ && echo PROTO_OK`
   → **EMPTY src diff AND EMPTY proto diff** (no source/proto changed) + `PROTO_OK`.
4. `git diff --name-only <baseline> -- packages/core/package.json` → EMPTY (no dep
   change, no `@libp2p/kad-dht`).
5. **ADDITIVE (hard):** every prior suite UNCHANGED — the 247 prior tests still
   pass; the key net ones run explicitly: gossipsub-topics, discovery, chain-sync,
   block-propagation, ticket-tx-propagation, circuit-relay-v2, dht-threshold-spike,
   plus the epic-3/4 suites (epic-end-to-end, epic4-end-to-end).
6. **Determinism:** run the new `epic5-end-to-end` suite twice (or the full suite
   twice); the structural invariants (block bytes at all k peers, head-slot
   equality, topic separation, relay topology) are identical both runs (no flake).
7. **90 s timeouts:** the relay-topology rows (R1, R2, R3) build the relay mesh
   (reservation race up to ~3 s + ~3 s mesh settle) + sync + mine — set a **90 s**
   `timeout` on each (the 5.5/5.6/5.7 precedent). R4 (doc + scan) and R5 (guard)
   are fast (default timeout).
8. **git status:** only the new test file + this plan are added; nothing under
   `packages/core/src` changed; `dist/` stays gitignored (never committed).

## Task

- [x] Write `packages/core/test/epic5-end-to-end.test.ts` — 5 rows (one per
      Done-when) over the integrated relay topology (relay + NATed + A + B, k=2),
      composing the root-barrel seams only + the 5.x test-local bounded-poll /
      proxied-multiaddr glue; per-row lifecycle; 90 s timeouts on the relay rows.
- [x] Confirm `packages/core/src` diff is EMPTY AND `packages/core/src/proto/`
      diff is EMPTY (PROTO_OK) + `package.json` unchanged; run the full
      verification gate (steps 1–8); confirm 252/37, all prior suites unchanged,
      deterministic ×2.
- [x] Fill the Implementation Notes (the exact invariants observed, the node
      topology + dial sequence used, any deviation) + the row → Done-when mapping.

## Implementation Notes

Single new file: `packages/core/test/epic5-end-to-end.test.ts` (5 rows, one per Done-when). `packages/core/src` and `packages/core/src/proto/` byte-identical (`git diff` empty; PROTO_OK — `corepack pnpm build` regenerates the proto unchanged). `packages/core/package.json` untouched. Full suite: **252 tests / 37 files** (247 prior + 5 new), deterministic across 2 full-suite runs + 1 targeted epic5 run (~11 s).

**Topology** (per-row lifecycle: built in `beforeEach`, closed + `rmSync` of the tmp store dirs in `afterEach`):

| node | relayRole | listen | store |
|---|---|---|---|
| relay | `relay` | `/memory/e5relay` | none (pure transport: circuit-relay-v2 + gossipsub) |
| NATed | `client` | `/memory/e5nated` (placeholder — ignored in client mode) | FileChainStore + seeded balances |
| A | `none` | `/memory/e5a` | FileChainStore + seeded balances |
| B | `none` | `/memory/e5b` | FileChainStore + seeded balances |

**Dial sequence** (bounded retries only — `dialWithRetry`, 40×25 ms; hop dials 120×25 ms):
1. NATed → relay (the circuit reservation — fire-and-forget inside the adapter)
2. NATed → `/memory/e5a`, NATed → `/memory/e5b` (direct links — the memory transport has no real NAT; models the known-list bootstrap)
3. A → relay, then A → `/p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>` (the proxied multiaddr, built as a string from the two peers' `peerId()` — test-local glue; the wider hop budget covers the first hop racing the reservation)
4. B → relay, then the same proxied multiaddr
5. mesh settle: 120×25 ms bounded wait (gossipsub heartbeat/mesh convergence)

**Row → Done-when mapping:**
- R1 `E2E5_R1_NATED_DISCOVER_SYNC_GOSSIP_K` → Done-when #1 (discover k=2 + syncChain + NATed's re-gossiped block)
- R2 `E2E5_R2_BLOCK_TICKET_TX_OWN_TOPICS` → Done-when #2 (one class per topic, exact 1/1/1 counts)
- R3 `E2E5_R3_RELAY_CONNECTS_NATED` → Done-when #3 (relay connects NATed; direct dial fails)
- R4 `E2E5_R4_DHT_DECISION_NO_DHT` → Done-when #4 (documented no-DHT decision + no kad-dht anywhere)
- R5 `E2E5_R5_MEMORY_HEADLESS_ZERO_SOCKETS` → Done-when #5 (TRANSPORT pin + self-scan of this file)

**Invariants observed** (identical across all runs — no flake):
- k=2: NATed's `peers()` includes BOTH A's and B's transport peer ids; the relay's `peers()` include NATed (the reservation link); A and B each include NATed (the proxied hop)
- window 0 (single-participant draw over the imported `drawWindow`): A wins; NATed's slot-1 test block: NATed wins
- sync: NATed `applied: 1`, `headSlot: 0`; `getBlock(0)` byte-identical to A's store; NATed's balances reloaded via `loadState()` + `fromJson` before it mines on top (the 5.5 D5 pattern)
- gossip: NATed's slot-1 block lands at A and B with `sourcePeerId` = NATed's 4.2 PROTOCOL identity id and `Block.encode` byte-identity; R2's ticket passes `verifyTicketSignature` from public data; the tx's decimal-string amount is intact over the wire (`Tx.encode` byte-identity)
- NAT traversal (R3): direct `dial(/memory/e5nated)` rejects (no listener there); the proxied multiaddr is the only path
- no wall-clock, no RNG, no floats anywhere; every wait is a bounded for-loop + `sleep(25)`

**Deviations from the plan** (test-only, zero source impact):
1. R4/R5 live in a separate top-level `describe` WITHOUT the relay topology — the 5 s default vitest timeout cannot absorb the ~3.5 s mesh build + node starts, and the doc-scan/guard rows do not exercise the network. The AD-10 empirical proof (zero real sockets) is carried by the R1–R3 memory transport plus R5's TRANSPORT pin.
2. `syncChain({ peer })` takes a multiaddr STRING (the 5.4 seam signature), so R1 passes A's listen address `/memory/e5a` rather than A's peer id (the plan's shorthand).
3. Window winners are guaranteed by single-participant draws (`participants = [A]` for window 0, `[NATed]` for the slot-1 test block) — the imported `drawWindow` still runs over the real (single) ticket set; no tie-break prediction needed.
4. `signWindowTicket` copies `challenge`/`signature` into fresh ArrayBuffers (`new Uint8Array(x)`) — the proto `Ticket` types its byte fields `Uint8Array<ArrayBuffer>` while the seams declare the wider `Uint8Array`; the copies are deterministic and byte-identical.

## Plan Change Log

No plan changes — the plan was followed as written. The build-time decisions are recorded in the Implementation Notes above (the R4/R5 no-topology scoping, the `syncChain` multiaddr parameter, the single-participant draws, the `Uint8Array<ArrayBuffer>` copies). None of them required a plan edit; `status:` and the Task checkboxes are left untouched by this note.

## Review Triage Log

Quick lens (1 iteration): **ZERO findings.** The reviewer independently re-ran the
full gate (252/37 green, typecheck clean, build PROTO_OK, epic5 run twice → 5/5
both runs) and confirmed, against the plan + spine:
- **AC-1 TEST-ONLY** — the diff is exactly one new file (`epic5-end-to-end.test.ts`
  + the plan); `git diff --name-only` over `src`, `src/proto/`, and `package.json`
  is EMPTY (PROTO_OK re-confirmed after the build regenerated the proto). Imports
  are only `node:fs/os/path/url`, `vitest`, and `../src/index.js` — no sub-module
  path, no `big.js`, no `@libp2p/*`, no `@multiformats/*`, no `@libp2p/peer-id`.
- **AC-2 FIVE rows** — exactly 5 `it`, one per Done-when, each honestly asserted:
  R1 (k=2 discover + `syncChain` head-equality + `getBlock(0)` byte-identity +
  NATed's slot-1 block at A AND B with `sourcePeerId` = NATed's protocol id +
  `Block.encode` byte-identity); R2 (block/ticket/tx each on its OWN topic at
  NATed AND B, the gossiped ticket passes the imported `verifyTicketSignature`
  from public data, the 30-digit decimal amount byte-intact, EXACT 1/1/1 per-topic
  counts — a leaked class would bump a count to 2 and fail, so not vacuous); R3
  (nated/relay/A/B `peers()` membership + the proxied-dial `dialWithRetry` that
  throws if the relay hop never lands + the direct-dial-of-placeholder REJECTS —
  the 5.7 `NOT_DIRECTLY_REACHABLE` shape); R4 (the three epic-Notes regexes match
  the real 2026-10-13 DHT Decision; no `@libp2p/kad-dht` in deps/devDeps or
  comment-stripped `src/**`); R5 (`TRANSPORT` pin + self-scan: no `Date.now`, no
  `Math.random`, root-barrel-only imports, no transitive-dep imports + the four
  topics + `SYNC_PROTOCOL` pins match `src/net/topics.ts` / `src/net/sync.ts`).
- **AC-4 never re-implement** — every protocol seam is imported from the barrel
  (`drawWindow`, `deriveWindowChallenge`, `syncChain`, `buildSyncSource`,
  `createNetAdapter`, `mineBlock`, `applyBlock`, `acceptBlockWinner`,
  `applyAcceptanceCap`, `computeUptimeWeight`, `signTicket`, `nextSlotAndParent`,
  `verifyTicketSignature`, …); `mineWindow`/`applyOwnBlock` are plan-sanctioned
  orchestration glue (the D6 contiguity check is the 5.5 driver invariant; all
  draws/challenges/caps/weights/signatures/acceptance go through the imported
  seams); `relayProxiedMultiaddr` is plan-allowed glue, byte-identical to 5.7's.
  AD-2 (balances mutate only via `applyBlock`'s return) + AD-11 (no `.secret`
  read) hold.
- **AD-3/AD-5/AD-10** — no wall-clock / RNG anywhere (grep-verified); every wait
  is a bounded for-loop + `setTimeout(25)`; no float on a protocol quantity
  (bigint / decimal-string / byte-equality; `'12.5'`/`'21000000'` cross the
  AD-5 display boundary only via the imported `fromDisplay`, matching genesis);
  memory transport only (zero real sockets).
- **The 4 documented deviations** are each test-only and non-weakening: (1) R4/R5
  outside the relay topology — doc/guard scans need no network; the AD-10
  empirical proof is carried by R1–R3 + the unchanged 5.x net suites. (2)
  `syncChain({ peer: A_LISTEN })` matches the seam's real signature (`peer:
  string`, the 5.1 multiaddr form) — the plan table's `aPeerId` was shorthand; the
  sync still runs over NATed's live link to A. (3) Single-participant draws still
  run the imported pinned `drawWindow` over the real ticket set — winner
  guaranteed by construction, no RNG / tie-break prediction; epic-5's Done-when is
  about propagation, not draw competition. (4) The `new Uint8Array(x)` copies are
  deterministic byte-identical conversions into fresh ArrayBuffers; the signature
  remains the imported `signTicket` output.

No findings to triage → no code patch → no post-patch gate re-run needed.
Orchestrator independently re-ran the full gate before and after the lens:
252/37, typecheck clean, build PROTO_OK, `src`/`src/proto/`/`package.json` diffs
all EMPTY, git status = the one new test file + the plan.
