---
ticket: "5.5"
epic: epic-node-network
status: "built"
review: quick
review_source: pinned
covers:
  - R1
baseline_revision: "33ffea0d4be1f46ea3795698846f1c42cfc66671"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/topics.ts
  - packages/core/src/consensus/multi-sim.ts
  - packages/core/src/consensus/slot-loop.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/acceptance-cap.ts
  - packages/core/src/consensus/uptime.ts
  - packages/core/src/consensus/sync.ts
  - packages/core/src/consensus/miner.ts
  - packages/core/src/identity/identity.ts
  - packages/core/src/identity/reattestation.ts
  - packages/core/src/ports.ts
  - packages/core/src/store/file-chain-store.ts
  - packages/core/src/index.ts
  - packages/core/test/net-adapter.test.ts
  - packages/core/test/chain-sync.test.ts
  - packages/core/test/multi-sim.test.ts
  - config/genesis.json
---

# Story 5.5 (TRACER) — Block propagation over gossipsub + a fresh node receives the next block

Wires the live loop **end to end over the memory transport**: a node that mines a block (3.2's slot loop + 4.2's signed ticket) publishes it to the blocks topic; every peer validates it (4.3's acceptance path, over the per-window accepted set built from the tickets **gossiped** for that window — 4.4 cap + 4.5 weights) and applies it (AD-2). A node that joins mid-run discovers the others and receives the NEXT block via gossip. The full **propagate / validate / apply** loop, with real signed tickets.

This is the **TRACER** story of the epic: the first networked end-to-end composition of the seams epics 3 and 4 built in isolation. It is the story-of-truth for the **NEW multi-node memory-transport driver** the ticket's `unknown` calls for.

## Story of Truth

The ticket's `unknown` names the one genuinely new piece: *"the mining cadence in the multi-node test (who mines which slot) is driven by a NEW multi-node memory-transport driver added in this epic — 3.7's sim is an in-process multi-identity sim (one shared store, synthetic identities) and 4.8's multi-sim is likewise in-process, so neither is a networked-node driver. The decision is new driver vs adapting 3.7's harness."*

**Decision (D1): a NEW, test-only, multi-node networked driver — one new test file.** 3.7's `simulateWindows` and 4.8's `simulateMultiWindow` share ONE store and ONE set of in-process identities; they cannot express "N separate processes, each with its own adapter + store, connected over a transport." Adapting them would mean tearing out the single-store assumption they are built on. A new driver composes the existing seams (the adapters from 5.1/5.2, the store from 3.5, the consensus/identity seams from epics 3/4) without touching them — which also keeps the story **TEST-ONLY**: `src/`, `proto/`, `package.json`, and `pnpm-lock.yaml` are untouched, so the existing 229-test suite stands byte-for-byte and the AD-1 core/shell seam is preserved (the driver is not wired into `createCore`). This is the 3.9 / 4.10 end-to-end precedent: a test-side harness that composes imported seams.

**Decision (D2): draw-selected mining cadence (uptime-only, AD-3) — no pre-designated miner.** Every window, **all** nodes build the *same* deterministic accepted set (from the tickets gossiped for that window) and the *same* challenge (`deriveWindowChallenge(parentHash, slot)`), and therefore the *same* `drawWindow` result → the *same* winner. The node whose identity **won** the draw performs the PoW (`mineBlock`), applies the block to its own store (`applyBlock`), and publishes it (`sendBlock`). Every other node receives the gossiped block, validates it (`acceptBlockWinner` over the same accepted set), and applies it. This is the faithful multi-node analog of 3.7/4.8's "draw → winner mines" loop, and it exercises AD-3 (chain-time only: the cadence is driven by slots/loop iterations, never a wall clock or RNG) and uptime-only mining (the winner is selected by the draw, not by who is "supposed" to mine).

**Decision (D3): the accepted set is built from GOSPIED tickets (own + received), with 4.4's cap + 4.5's weights.** Each node signs its window ticket (4.2, via `signedTicket` — the 4.8 commitment convention) and publishes it to the tickets topic. Each node collects its own ticket **plus** every ticket it receives over the tickets topic (deduped by `identityId`, robust whether or not gossipsub self-delivers), derives each ticket's weight via `computeUptimeWeight(identity.validWindows, slot, L)` (the driver knows every identity's `validWindows`), and applies `applyAcceptanceCap` (4.4 — keep-first, at most one ticket per identity). The challenge is derived LOCALLY from the node's own head (`deriveWindowChallenge(headHash, slot)`), never wire-trusted. This is the exact local accepted-set path from 4.8, but sourced from the wire. 5.5 establishes the flow; 5.6 refines the cap on gossiped tickets.

**Decision (D4): receive = a bounded poll of `adapter.received` (event-driven, AD-3).** The adapter exposes **no** per-topic callback (verified: its internal gossip `message` listener only appends to the cumulative `received: ReadonlyMap<TopicClass, ReceivedEnvelope[]>`). The driver tracks a per-topic read cursor and uses **bounded poll loops** (the `SLEEP_MS` / `MAX_POLLS` pattern from 5.2/5.3 — a bounded wait/yield between iterations, never a wall-clock read or a `Date.now` assertion). This keeps the bounded-time assertion style **event-based, never wall-clock** (the ticket's hard rule) and AD-3-compliant.

**Decision (D5): the late joiner uses 5.4's `syncChain`, then gossip.** Node D starts with a fresh empty store, dials A/B/C, and catches up to the current head N via `syncChain` (a source node registers `setSyncSource(buildSyncSource(records))`; the driver maintains the per-window `SyncWindowRecord[]` from the loop). Because `applyBlock` persists the balance snapshot (`store.saveState(toJson(newBalances))`), the driver reloads D's balances from `D.store.loadState()` after the sync. D then **participates in window N+1** — it signs + publishes its ticket, collects the gossiped set, and (as a peer) receives block N+1 over the blocks topic, validates it, and applies it. This is the ticket's *"a node that joins after block N receives block N+1 via gossip and applies it."*

**Decision (D6): client-side contiguity is enforced (the 5.4 F3 forward note, now load-bearing).** Before applying a **gossiped** block, each node verifies `block.slot === head + 1 && block.parentHash === head's hash` (via `nextSlotAndParent(store)`). A block that does not extend the current head is a **normal stop** — never applied, never thrown. This is the first time gossip **peers** (not a trusted sync source) are the block source, so the client must check contiguity itself. This lands 5.4's F3 note with its gossip-side scope.

**Decision (D7): no new dependencies** (the 5.1–5.4 precedent). The memory transport, gossipsub, and all consensus/identity seams are already in place.

## Acceptance Criteria

- **AC-1 (block propagation).** In a 3-node memory-transport network (A, B, C), over at least two windows, the draw-selected node mines a block and the **other two** nodes receive it over the blocks topic, pass `acceptBlockWinner` (4.3) over the gossiped-ticket accepted set, and `applyBlock` (AD-2) it. Each peer's store advances by exactly one slot per window, and every applied block's committed wire bytes are **byte-identical** across all three stores (same canonical encoding, AD-12).
- **AC-2 (late joiner).** A fourth node D, started with an empty store mid-run, syncs to the current head N via 5.4's `syncChain`, then receives + validates + applies block N+1 **via gossip** (not sync). D's store reaches N+1 with the same committed bytes as A/B/C.
- **AC-3 (the signed ticket is load-bearing — AD-12).** For a real block, `acceptBlockWinner` = `true`. For a block whose `winnerTicket` carries a **corrupted signature** (identical public fields — `identityId`, `windowIndex`, `challenge`, `nonceCommitment` — but a tampered/empty 64-byte signature), `acceptBlockWinner` = `false` **while** `verifyDraw(block, capped.tickets, capped.weights, challenge)` = `true` — isolating the signature gate as exactly what makes the block peer-verifiable. (The 4.8 / 4.10 R2 precedent, now over the wire.)
- **AC-4 (contiguity, AD-2 + D6).** Every gossiped block a node applies extends its current head (`slot === head + 1 && parentHash === head's hash`). The chain is contiguous from slot 0 on every node, and a non-extending gossiped block is **never applied** (normal stop, no throw).
- **AC-5 (additive, TEST-ONLY, AD-10 + AD-3).** `git diff` for `packages/core/src`, `packages/core/proto`, `packages/core/package.json`, and `pnpm-lock.yaml` is **EMPTY**. The driver composes only imported seams (no re-implementation). The network is memory-transport-only (zero real sockets in CI). The cadence uses bounded polls / loop iterations — **no** wall-clock reads or RNG in the chain logic. All 229 prior tests + 5 new = 234 pass. The no-float guard (6) and the identity-key-surface guard (5) stay green.

## Matrix Test Audit (5 rows)

| Row | Verifies |
|-----|----------|
| `TRACER_BLOCK_PROPAGATED` | AC-1: 3-node memory net; the draw-selected node mines a slot via the full gossiped-ticket accepted-set path; the other two receive via `adapter.received`, pass `acceptBlockWinner` over the same set, and `applyBlock`; each store S−1 → S, committed bytes byte-identical. |
| `TRACER_LATE_JOINER` | AC-2 + AC-4: D joins at head N, `syncChain` to N, receives + applies block N+1 via gossip (contiguity-checked), byte-identical to A/B/C. |
| `TRACER_SIGNED_TICKET_VERIFY` | AC-3: real AD-12 signature → `acceptBlockWinner` true; corrupted/empty winner-ticket signature (same public fields) → `acceptBlockWinner` false WHILE `verifyDraw` true. |
| `TRACER_CONTIGUOUS` | AC-4: every applied gossiped block extends the head via the `nextSlotAndParent` check; chain contiguous from slot 0; a non-extending block is never applied (normal stop). |
| `TRACER_ADDITIVE` | AC-5: src/proto/deps diffs EMPTY; driver composes only imported seams; memory transport only (zero real sockets); bounded polls (no wall-clock/RNG); 229 prior + 5 new green; no-float + identity-key-surface guards green. |

## Design Notes (forward notes carried into this story — record all FIVE)

1. **Send retry / `allowPublishToZeroTopicPeers`** (5.2 D6 note): the driver forms the gossip mesh (dials all peers) **before** publishing a block, using a bounded dial retry (40 × 25 ms, the 5.2 pattern) so the send is not to a zero-peer mesh. The explicit decision — whether to set `allowPublishToZeroTopicPeers` — is **deferred** (not load-bearing in 5.5 because the mesh is formed first); recorded here so 5.6/5.7 make the call when the send path becomes load-bearing under NAT/relay.
2. **Decode containment** (5.2 note): a corrupt envelope on a known topic must be a **normal REJECT, never a throw**. protons `decode` THROWS `RangeError` on genuinely malformed bytes (but returns defaults on empty). In 5.5, peers receive **real** gossiped bytes, so the containment boundary is the adapter's internal topic handler (5.2 code). 5.5 does **not** change that handler (the driver only ever publishes well-formed blocks); the note is recorded here, and the decision to harden the adapter's handler (if at all) is deferred to 5.6 where ticket/tx decode containment is in scope.
3. **5.4 F1 — framing unit test**: the sync framing helpers (`encodeFrame` / `FrameAccumulator`) are partial-frame-safe but not unit-pinned (the barrel didn't export them at 5.4). When a real/relayed transport lands (5.7), add a framing unit test via exported helpers. Deferred to 5.7.
4. **5.4 F2 — catch the seam `DrawError` on a malformed sync block**: `syncChain` does not catch the seam's `DrawError SC-CONSENSUS-2` (a malformed `winnerTicket`). Under the untrusted-peer threat model that should be a **normal stop**, not a throw. Deferred (the 5.5 driver's own gossip path already treats a decode failure as a normal reject per D6/D2).
5. **5.4 F3 — client-side contiguity**: **LANDED in 5.5 via D6.** The gossip-side scope (a node checks contiguity against its own head before applying a gossiped block) is implemented in the driver and pinned by `TRACER_CONTIGUOUS`.

## Code Map (TEST-ONLY — do NOT touch anything else)

- **NEW** `packages/core/test/block-propagation.test.ts` — the multi-node memory-transport driver + the 5 matrix rows. Imports **only** from the root barrel `../src/index.js` (+ vitest, `node:fs`/`node:os`/`node:path` for per-test temp dirs).
- **Do NOT touch (Do-NOT-touch list):** ALL of `packages/core/src/**`, `packages/core/proto/**`, `packages/core/package.json`, `pnpm-lock.yaml`, `config/genesis.json`, and every existing test file. The only file created is the new test file. (This is what makes the src/proto/deps diffs EMPTY.)

## Tasks

- [x] **T1 — the multi-node memory-transport driver (the NEW networked-node harness).**
Build, inside `test/block-propagation.test.ts`:
- **Node factory.** Per node: a fresh `FileChainStore` in its own `mkdtempSync` dir, a `createNetAdapter({ transport: 'memory', listenAddress: '/memory/<node>', protocolIdentityId: <identityId>, mdns: false })`, `start()`, and `nextSlotAndParent`-derived state. Pinned-seed identities: `seedFor(i) = new Uint8Array(32).fill(0x40 + i)` → `deriveIdentityKeypair(seedFor(i))`; each `MultiSimIdentity` has `attestedUntilWindow = 100000n` and `validWindows` = a deterministic range (4.8 convention). Constants: `REWARD_DISPLAY = '12.5'`, `MAX_SUPPLY_DISPLAY = '21000000'`, `L = BigInt(GENESIS.uptimeLookbackL)` (= 50n, from `loadGenesis()` on the repo-root `config/genesis.json`). `rewardBaseUnits = fromDisplay(REWARD_DISPLAY)` computed **once**.
- **Mesh formation.** `dial` every peer's `/memory/<peer>` listen address (bounded retry: 40 × 25 ms — the 5.2 pattern) so the gossip mesh is formed **before** any block is published (forward note 1).
- **Per-window loop (D2 + D3).** For each slot S (0..N−1): (a) each node derives `{ slot, parentHash } = await nextSlotAndParent(node.store)` and `challenge = deriveWindowChallenge(parentHash, slot)` (LOCAL, D3); (b) each node signs its ticket `signedTicket(keypair, slot, parentHash, challenge)` and `sendTicket`s it; (c) each node collects **own + received** tickets (poll the tickets topic, dedupe by `identityId`), derives weights via `computeUptimeWeight(validWindows, slot, L)`, and `applyAcceptanceCap({ tickets, weights })` → `CappedSet`; (d) `drawWindow(capped.tickets.map(protoTicketToDrawTicket), challenge, capped.weights)` → the deterministic winner; (e) the **winning node** `mineBlock({ slot, parentHash, winnerIdentityId, winnerTicket: Ticket.encode(capped.tickets[draw.index]), txCount: 0n })`, `applyBlock({ store, block, balances, rewardBaseUnits, mintId: MINT_ID })` on its own store, and `sendBlock(block)`; (f) **every node** receives the block (poll the blocks topic), checks contiguity (D6: `block.slot === head+1 && block.parentHash === headHash` via `nextSlotAndParent`), `acceptBlockWinner(block, capped.tickets, capped.weights, challenge)` = true, and `applyBlock` (non-winner nodes with their own `balances`); (g) the driver records the window's `SyncWindowRecord { block, acceptedTickets: capped.tickets, weights: capped.weights }` (for D5's sync source). Per-node `balances` are seeded from `store.loadState()` (null → `new Map([[ MINT_ID, fromDisplay(MAX_SUPPLY_DISPLAY) ]])`) and threaded forward (the `applyBlock` return).
- **Bounded poll helper (D4, AD-3).** `pollReceived(adapter, topic, predicate, { maxPolls, pollMs })` — tracks a per-topic cursor over `adapter.received.get(topic)`, yielding a bounded `pollMs` between iterations, resolving the first entry matching `predicate`, or failing after `maxPolls` (a **bounded** timeout — event-based, never a wall-clock read; no `Date.now`/`Math.random` in the chain logic).
- **Cleanup.** `afterEach`: `stop()` all adapters, `close()` all stores, `rmSync` the temp dirs.

- [x] **T2 — the late-joiner driver (D5).**
Extend the harness: a **source** node registers `setSyncSource(buildSyncSource(records))` (records accumulated from the loop). A fourth node D (fresh empty store) dials A/B/C, then `syncChain({ client: D, peer: <source listen address>, store: D.store, rewardDisplay, maxSupplyDisplay })` → D reaches head N. Reload D's balances via `fromJson(await D.store.loadState())` (applyBlock persisted them). D then participates in window N+1 (signs + publishes its ticket; collects; and as a peer receives block N+1 via gossip, contiguity-checks, `acceptBlockWinner`, `applyBlock`).

- [x] **T3 — `TRACER_BLOCK_PROPAGATED` + `TRACER_CONTIGUOUS` rows.**
- `TRACER_BLOCK_PROPAGATED`: run ≥ 2 windows over A/B/C. Assert: for each window, exactly one node (the draw winner) mined; the other two received the block via `adapter.received`, `acceptBlockWinner` = true, and `applyBlock`'d; each store's `headSlot()` advanced by one; and `store.getBlock(slot)` wire bytes are **byte-identical** across all three stores for every applied slot.
- `TRACER_CONTIGUOUS`: assert every applied gossiped block satisfied the D6 contiguity check; the chain is contiguous from slot 0 on each node (`block[slot].parentHash === hash(block[slot−1])`, `block[0].parentHash === 32 zeros`); and a deliberately **non-extending** block (e.g. a block for `slot+2`, or with a wrong `parentHash`) published to the topic is **never applied** — the node's `headSlot()` is unchanged and no throw escapes (normal stop).

- [x] **T4 — `TRACER_LATE_JOINER` + `TRACER_SIGNED_TICKET_VERIFY` rows.**
- `TRACER_LATE_JOINER`: run A/B/C to head N (≥ 1 window), then bring up D (T2), sync to N, and let the loop run window N+1. Assert D's `headSlot()` = N+1 and D's committed block bytes for slots 0..N+1 are byte-identical to A/B/C's.
- `TRACER_SIGNED_TICKET_VERIFY`: take a real window's block + its `CappedSet` + challenge. Assert `acceptBlockWinner(block, capped.tickets, capped.weights, challenge)` = true. Then build `corrupted = { ...block, winnerTicket: Ticket.encode({ ...decodedWinnerTicket, signature: EMPTY_64 }) }` (same public fields, tampered signature). Assert `acceptBlockWinner(corrupted, capped.tickets, capped.weights, challenge)` = false **AND** `verifyDraw(corrupted, capped.tickets.map(protoTicketToDrawTicket), capped.weights, challenge)` = true — isolating the signature gate.

- [x] **T5 — `TRACER_ADDITIVE` row + the full gate.**
- `TRACER_ADDITIVE`: assert the driver composes only imported seams (self-documenting: no local re-implementation of `mineBlock`/`drawWindow`/`applyBlock`/`acceptBlockWinner`/`applyAcceptanceCap`/`computeUptimeWeight`/`signedTicket`/`deriveWindowChallenge` — all called from the barrel), the network is memory-transport-only, and the poll loops are bounded (no `Date.now`/`Math.random`).
- Run the full verification suite (below).

## Verification (gate — 7 commands)

Run from `packages/core` unless noted; long-running gates get a 600 000 ms timeout.

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → **234 / 234 (33 files)** (229 prior + 5 new; 32 prior + 1 new).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1` → clean (protons regen byte-identical — proto untouched).
4. `git diff --name-only -- packages/core/src` → **EMPTY** (TEST-ONLY).
5. `git diff --name-only -- packages/core/proto` → **EMPTY**.
6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml` → **EMPTY**.
7. Guard suites (covered by #1): the no-float guard (6) and the identity-key-surface guard (5) green; big.js still imported only by `ledger/display.ts` + `ledger/fee.ts`.

## Never list

- No real sockets in CI — memory transport only (AD-10).
- No wall-clock reads or RNG in the chain logic — bounded polls / loop iterations only (AD-3). `setTimeout`-based bounded yields in the test harness are allowed (5.2/5.3 precedent), never a `Date.now()` assertion or `Math.random()` in the cadence.
- No re-implementation of any seam — compose only imported functions from the root barrel.
- Reject = a normal stop / `false` — **never** a throw (a non-extending gossiped block, a corrupt envelope, a failed `acceptBlockWinner` are all normal stops).
- Do NOT touch `src/`, `proto/`, `package.json`, `pnpm-lock.yaml`, `config/genesis.json`, or any existing test file.
- Do NOT import `@libp2p/peer-id` (or any package that is only a transitive dep) directly — it is not a direct devDep of `packages/core`.
- Do NOT run `git commit` or `git push` — the orchestrator commits.

## Implementation Notes
- **Single new file, TEST-ONLY.** Only `packages/core/test/block-propagation.test.ts` was created. `git diff` for `packages/core/src`, `packages/core/proto`, `packages/core/package.json`, and `pnpm-lock.yaml` is all EMPTY (verified, gate 4/5/6). The driver composes only root-barrel imports (`../src/index.js`) + vitest + `node:fs`/`node:os`/`node:path`/`node:url`; no `@libp2p/peer-id`, no transitive-dep imports.
- **Driver (`NetNetwork` + `makeNode` + `collectWindow` + `pollReceived`).** One node = its own `FileChainStore` (fresh `mkdtempSync` dir), its own memory-transport adapter (listening `/memory/<name>`, stamped with the node's 4.2 protocol `identityId`), its own `deriveIdentityKeypair(seedFor(i))` identity, a threaded `BalanceMap`, and per-topic read cursors over `adapter.received`. Per window: (a) `nextSlotAndParent` + LOCAL `deriveWindowChallenge`; (b) `signedTicket` + `sendTicket`; (c) own + gossiped tickets deduped by `identityId`, identity-sorted for a deterministic cross-node order, `computeUptimeWeight`, `applyAcceptanceCap`; (d) one pinned `drawWindow` → same winner on every node; (e) winner `mineBlock` + `sendBlock`; (f) every node receives (winner uses its own block — gossipsub does not self-deliver), D6 contiguity check, `acceptBlockWinner`, `applyBlock`; (g) record the `SyncWindowRecord`.
- **Mesh settle (beyond forward-note 1's literal "dial first").** A gossipsub publish made *before the mesh's first post-dial heartbeat* is delivered only to the publisher's (still-empty) mesh/fanout and is LOST (no ack; a lost data message is not retransmitted once it ages out of the 3-heartbeat mcache). Reproduced deterministically: a 3-node full mesh that publishes immediately after dialing drops all inbound gossip for the node with 2 outgoing dials; a bounded settle of ~3 heartbeats (gossipsub `heartbeatInterval` = 1000 ms) after each topology change makes delivery reliable. Implemented as `settleMesh()` — a pure bounded yield (`120 × 25 ms`, the 5.2/5.3 `sleep`+bounded-loop pattern), AD-3-compliant (no wall-clock read, no RNG). `addNode` calls it after dialing.
- **Winner applies AFTER its contiguity check (refines T1(e)/(f) literal).** The plan's T1 text has the winner `applyBlock` in step (e) and the D6 check in step (f). Applied in that order, the winner's head has already advanced, so its own slot-S block is compared against head+1 and fails D6 (off-by-one, `contiguous=false`). The driver therefore has EVERY node — winner included — apply in (f), *after* the D6 check against the PRE-APPLY head, so the winner's own block is contiguous exactly as AC-1/AC-4 require. The winner still mines + publishes in (e); only the apply moved to (f). This is the minimal change that makes the winner's block pass the same D6 gate the peers' blocks pass.
- **Late joiner D's `validWindows` start at its join window (refines T1's "deterministic range" for D).** AC-2 requires D to *receive* block N+1 via gossip, i.e. D must not be that window's draw winner. If D had the same `validWindows` (and thus the same 4.5 weight) as the incumbents, the deterministic draw could select D. The driver gives D a `validWindows` range beginning at its join window (it has no uptime history for the windows it missed), so its weight at window N+1 is 0 — `drawWindow` treats `W=0` as `c^0=1`, worst priority, and it cannot beat an incumbent's `W>0`. D still signs + gossips its ticket (it is in every node's accepted set); it simply cannot win the draw. This is the faithful "fresh node has no prior uptime" reading and is what makes AC-2's "via gossip (not sync)" assertion hold deterministically.
- **AD-3 / AD-5 discipline held.** No `Date.now()`/`Math.random()` in the cadence (the `TRACER_ADDITIVE` row self-scans this file's source and asserts their absence); all waits are bounded `setTimeout` yields (`sleep`/`publishUntilAccepted`/`dialWithRetry`/`settleMesh`/`pollReceived`). No big.js — the one-time display→base-unit conversion goes through the barrel's `fromDisplay` (computed once); balances thread as `BalanceMap` and reload via the barrel's `fromJson`.
- **Gate results (all green, re-run from `packages/core`).** (1) `corepack pnpm test` → **234/234 (33 files)** (229 prior + 5 new). (2) `corepack pnpm typecheck` → exit 0. (3) `corepack pnpm build` → exit 0 (protons regen byte-identical). (4/5/6) `git diff` for `src`, `proto`, and `package.json`+`pnpm-lock.yaml` → all EMPTY. (7) `no-float-guard` + `identity-key-surface` → 11/11 green (within #1).

## Plan Change Log
- (2026-10-12, implementer) Refined T1's per-window step ordering: the draw winner now applies its own block in (f) *after* the D6 contiguity check (not in (e) before it), so the winner's own block passes the same pre-apply-head contiguity gate as its peers' gossiped blocks — required for AC-1/AC-4. No seam re-implemented; `applyBlock` is still the single mutation path, called once per node per window.
- (2026-10-12, implementer) Refined T1/T2's identity convention for the late joiner: node D's `MultiSimIdentity.validWindows` begins at its join window (no uptime history for missed windows) so its 4.5 weight at window N+1 is 0 and it cannot win that draw — required for AC-2's "receives block N+1 via gossip (not sync)". Incumbents' `validWindows` are unchanged.
- (2026-10-12, implementer) Added a bounded post-dial mesh settle (`settleMesh`, ~3 gossipsub heartbeats) in `addNode`, extending forward-note 1's "form the mesh before publishing": a publish before the mesh's first heartbeat is lost over gossipsub, so the driver warms the mesh with a bounded yield before the next window's traffic. AD-3-compliant (bounded `setTimeout` yields, no wall-clock/RNG).

## Review Triage Log
- (2026-10-12, quick lens, iteration 1) **F1 — BUG, FIXED: latent ticket-receive cursor race.** `pollReceived` uses a per-**topic** cursor, but `collectWindow` issued several sequential polls on the same `'tickets'` cursor with *different* per-target predicates. With out-of-order gossip delivery (e.g. the received list = `[C, B]`), the poll for B matches at `i=1` and sets the cursor to 2, so the subsequent poll for C scans only from index 2 (list length 2) and never sees C's ticket, exhausting its bounded polls and throwing after the 10 s window. Code-path-proven (not observed in 21+ runs — low-probability flake, but a real defect in the story's deliverable driver; four of five rows go through `collectWindow`). **Fix:** replaced the sequential per-target polls with a single bounded collect-all loop that matches against the full accumulated `'tickets'` list until every participant's ticket for the slot is present (deduped by `identityId`), robust to any delivery order. The per-topic cursor is retained only for the single-target block receives in `runWindow` / `TRACER_CONTIGUOUS`, where the predicate is monotonic per slot and the cursor is safe. Gate re-run after the patch: 234/234, src/proto/deps EMPTY.
- (2026-10-12, quick lens, iteration 1) **F2 — OBSERVATION, ADDRESSED: tautological AD-10 assertion in `TRACER_ADDITIVE`.** The row built a `/memory/<name>` string and asserted `startsWith('/memory/')` on the string it just constructed (self-fulfilling; no verification value). The load-bearing AD-10 pins are `expect(TRANSPORT).toBe('memory')` (the single transport selector `makeNode` passes to `createNetAdapter`) and the four end-to-end rows, which empirically prove the memory transport works. **Fix:** dropped the tautological loop, kept the `TRANSPORT` pin + a comment pointing to the end-to-end rows as the empirical proof. (Not an AC/rule violation — a clarity improvement.)
- (2026-10-12, quick lens, iteration 1) **Scrutiny questions 1–8: all PASS with evidence** — no seam re-implementation (all 14 seams imported from the root barrel, `applyBlock` is the only mutation path, the file never reads `.secret`); every reject a normal stop (non-extending block + failed `acceptBlockWinner` leave the store un-advanced, no throw); bounded polls with no `Date.now(`/`Math.random(` in the file (self-pinned by `TRACER_ADDITIVE`); the accepted set is genuinely gossiped-ticket-sourced (own + received, deduped, identity-sorted, 4.5 weights, 4.4 cap, challenge derived locally); contiguity is client-side (D6, `nextSlotAndParent` pre-apply check on every node including the winner); the late joiner's sync→reload-balance→gossip-apply composition is correct with D's weight 0; all FIVE forward notes recorded; no seam-signature mismatches. AC-1..AC-5 all met.
