---
ticket: "4"
epic: epic-node-network
status: "built"
review: quick
review_source: pinned
covers: ["R1"]
baseline_revision: "d28772750c2670ae8e342ac2b68e37e03d4a1d15"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/topics.ts
  - packages/core/src/net/index.ts
  - packages/core/src/consensus/multi-sim.ts
  - packages/core/src/consensus/apply-block.ts
  - packages/core/src/consensus/accept-winner.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/ports.ts
  - packages/core/src/proto/index.ts
  - packages/core/proto/protocol.proto
  - packages/core/src/index.ts
  - packages/core/test/net-adapter.test.ts
  - packages/core/test/multi-sim.test.ts
  - config/genesis.json
---

# 5.4 — Chain sync: a new node fetches the chain from a peer

## Story of truth

Add the **sync path**: a newly-connected node with an **empty (or shorter) chain** requests the
blocks it is missing from a peer that has them, and **applies** them through the existing
`applyBlock` seam (AD-2 — the single mutation path, **imported, never re-implemented**), so it
**catches up** to the peer's head slot. Because a fresh node has not been listening long enough
to have collected the winner tickets for historical windows, the per-window **accepted set** that
4.3's acceptance path needs is **supplied by the sync payload** (the tickets gossiped for that
window, fetched alongside the block) — sync + the tickets together supply it (the ticket's
"collected as they arrive, or fetched alongside the sync payload in the test", settled to the
latter — D3).

Every synced block is verified by the **existing 4.3 acceptance path** (`acceptBlockWinner` over
public data) before it is applied. A **tampered block** in the sync payload is **rejected** (a
normal `false`, never a throw) and is **never applied**.

The hard rules (from the ticket):
- **R1** — a fresh node fetches + applies the chain, reaching the peer's head; every block passes
  the 4.3 acceptance path.
- **AD-2** — blocks enter the fresh node ONLY through `applyBlock` (imported, never re-implemented).
- **4.3** — the acceptance path (`acceptBlockWinner`) verifies every synced block.
- **AD-12** — the sync messages are proto-encoded (the proto is the schema owner).
- **AD-10** — memory transport, zero real sockets in CI.
- **AD-3** — no wall-clock / RNG; catch-up is driven by chain-time slots.

What is **not** in scope: the live mine→publish→validate loop (5.5), ticket/tx own-topic
propagation (5.6), relay (5.7), DHT (5.8). Sync here is a **pull** (a directed request/response),
distinct from the gossip topics (5.2) and discovery (5.3). It is **not** wired into `createCore`
(AD-1 — the 3.7/4.8 standalone-harness precedent); the test drives it.

## Acceptance criteria (the ticket's `verify`, made concrete)

- **AC-1 (catch-up reaches the peer's head).** A fresh node (empty `FileChainStore`) connected
  to a peer with **N** mined blocks fetches and **applies** all **N** through `applyBlock` (AD-2);
  the fresh node's `store.headSlot()` reaches the peer's head (`N - 1`). Every fetched block
  passes the **4.3 acceptance path** (`acceptBlockWinner` over public data, the per-window accepted
  set supplied by the sync payload). The fresh node's committed block bytes are
  **byte-identical** to the peer's (`store.getBlock(slot)` matches on both sides).
- **AC-2 (tampered block rejected, never applied).** A **tampered block** in the sync payload
  (its `winnerIdentityId` changed to a foreign id — a "non-drawn-winner claim") is **rejected** by
  the 4.3 acceptance path (a **normal `false`, never a throw**) and is **never applied**: the
  fresh node's `headSlot()` stops at `T - 1` (the last good block before the tampered slot `T`),
  and the tampered block is absent from the fresh store.
- **AC-3 (sequential catch-up from the client's head + 1).** The catch-up applies blocks in
  **slot order** (0, 1, 2, …), starting from the client's current `headSlot + 1` (empty store →
  slot 0); each applied block's `parentHash` matches the previously-applied block's `hash` (the
  chain is contiguous — no binary search, no out-of-order apply).
- **AC-4 (request/response over a dedicated stream, proto-encoded).** Sync travels over a
  **dedicated libp2p STREAM** (request/response), NOT a gossip topic: the client sends ONE
  `SyncRequest`, the server streams one `SyncBlock` per window; both are **proto-encoded**
  (AD-12) and u32be length-prefix framed on the stream. The sync protocol is a stable constant,
  **distinct** from the four gossip topics (a sync message never on a gossip topic; a block never
  on the sync stream's gossip path).
- **AC-5 (additive; seams imported).** The 16 existing `net-adapter` rows + every prior suite stay
  green unchanged. The 4.3/AD-2/3.3 seams are **imported, not re-implemented** — `accept-winner.ts`
  / `apply-block.ts` / `draw.ts` are **byte-identical**. The four gossip topics
  (`src/net/topics.ts`) are byte-identical. The proto change is **purely additive** (2 new messages
  appended; the 8 existing messages byte-identical). The 2.5 no-float guard and 4.7
  identity-key-surface guard stay green (the new `src/consensus/sync.ts` never imports `big.js`
  directly — it imports `fromDisplay` from the ledger barrel, like the sim modules; and no
  `.secret` is read). No new deps.

## Design decisions (settling the ticket's `unknown`)

- **D1 — sync protocol shape: request/response over a libp2p STREAM, NOT a gossip topic.** The
  ticket's `unknown` ("request/response over a libp2p stream vs a gossip topic") is settled to
  **request/response over a stream** because sync is a **directed, potentially-large PULL** (a
  client pulls the whole chain from one server), not a many-to-many broadcast. A gossip topic would
  flood every peer with the full chain — the wrong primitive. libp2p 3.3.11's verified stream API:
  the **server** registers `node.handle(SYNC_PROTOCOL, (stream, conn) => …)`; the **client** opens a
  duplex stream with `node.dialProtocol(peer, SYNC_PROTOCOL)` → a `Stream`; `Stream.send(data)`
  writes; the `Stream` is an `AsyncIterable<Uint8Array | Uint8ArrayList>` for reads; `Stream.close()`
  half-closes (signals "no more data"). This is the clean request/response fit: the client writes
  the `SyncRequest`, half-closes, reads the streamed `SyncBlock`s until the server half-closes.

- **D2 — catch-up ordering: SEQUENTIAL from the client's head + 1, NOT binary search.** The ticket's
  `unknown` ("sequential from slot 0 vs binary search") is settled to **sequential from the client's
  `headSlot + 1`** because `applyBlock` (AD-2) is the **single, sequential** mutation path: it
  credits the reward, commits the block, and advances the head; a block's `parentHash` must match the
  **previously-committed** block's `hash`. Fetching from the middle (binary search) would break the
  sequential apply + parent-hash chain. The client starts at `headSlot + 1` (empty store → slot 0)
  and applies 0, 1, 2, … up to the peer's head. (Binary search is an optimization incompatible with
  the sequential-apply constraint — out of scope.)

- **D3 — the per-window accepted set is supplied by the sync payload (fetched alongside the block).**
  A fresh node has not collected the gossiped tickets for historical windows, so it cannot derive the
  4.5 uptime weights / 4.4-capped accepted set on its own. The `SyncBlock` therefore carries, per
  window, the **block + the window's accepted ticket set + the per-ticket weights** — exactly what
  `acceptBlockWinner(block, acceptedTickets, weights, challenge)` needs. The `challenge` is **derived
  by the fresh node** from the block's own public data (`deriveWindowChallenge(block.parentHash,
  block.slot)` — 3.3, imported) — NOT trusted from the wire. This is the ticket's "fetched alongside
  the sync payload" option (the simpler, honest one for a fresh catch-up node). The deeper question
  of a node independently re-deriving weights from gossiped tickets + its own collected history (the
  "collected as they arrive" option) is a follow-up (5.6 feeds the receiver's accepted set) — 5.4
  settles to the sync-payload option. The weights are the window's **derived** 4.5 uptime weights,
  supplied by the (test-trusted) peer so a fresh node can run the 4.3 acceptance path without having
  been online for the whole history.

- **D4 — the sync is CLIENT-triggered (the fresh node pulls).** After discovering + connecting to the
  peer (5.3 discovery, or 5.1's explicit `dial()`), the fresh node calls `syncChain` (the client
  orchestration) with `fromSlot = headSlot + 1`. The peer's registered sync source streams from
  `fromSlot` to its head. Sync is a PULL — the peer does not push the chain to new peers.

- **D5 — additive; NOT wired into `createCore`.** The sync transport (net) + the catch-up
  orchestration (consensus) are **standalone** (the 3.7 `sim.ts` / 4.8 `multi-sim.ts` precedent — a
  validation harness, not the boot path). `createCore` is **not** modified (it does not auto-sync;
  the test drives it). AD-1 holds: the net module is the transport, the consensus module is the
  orchestration, and they do **not** import each other (both import the shared proto layer, AD-12).

- **D6 — no new deps.** The sync transport uses the **existing** libp2p (`handle` / `dialProtocol`),
  the **existing** protons-generated proto codecs, and `node:crypto`/builtins for framing. **No** new
  `package.json` entry, **no** lockfile change.

- **D7 — module split (no cross-import cycle).**
  - `src/net/sync.ts` (NEW, **net** module) — the **transport**: the stable `SYNC_PROTOCOL` constant,
    the u32be length-prefix framing helpers, the **server handler factory** (reads the framed
    `SyncRequest`, invokes the registered source, writes each framed `SyncBlock`, half-closes), and
    the **client** `syncFrom(peer, request)` (opens the stream, writes the framed request, half-closes,
    reads the framed responses, yields decoded `SyncBlock`s). Pure networking — **no** consensus logic
    (no accept/apply). Imports the proto types (`SyncRequest`/`SyncBlock`) + libp2p. Does **not**
    import `src/consensus`.
  - `src/consensus/sync.ts` (NEW, **consensus** module) — the **orchestration**: `syncChain` (the
    **client** catch-up — for each `SyncBlock`: derive the challenge (3.3), run `acceptBlockWinner`
    (4.3), and on accept `applyBlock` (AD-2), threading the balances forward; a reject is a **normal
    stop**, never a throw) + `buildSyncSource(chain)` (the **server** factory — given the peer's
    per-window `{ block, acceptedTickets, weights }`, returns the generator that streams them from
    `fromSlot`). Composes ONLY imported seams (`deriveWindowChallenge` / `acceptBlockWinner` /
    `applyBlock` / `fromDisplay` / `fromJson` / `MINT_ID`) — **never re-implements** any of them.
    Takes the client as a **structural** `{ syncFrom(peer, request): AsyncIterable<SyncBlock> }` (no
    net import). Imports the proto types + the consensus seams. Does **not** import `src/net`.
  - The **adapter** (`src/net/adapter.ts`) gains `setSyncSource(source)` + `syncFrom(peer, request)`
    (net-surface extensions, like `dial`/`peerId`/`sendPeerInfo` — **not** on the 1.2 `NetPort`):
    `setSyncSource` stores the source the registered handler reads; `syncFrom` delegates to the
    transport client. The handler is registered in `start()` (after `node.start()`) so the protocol
    is advertised once the node is up.

- **D8 — the 1.2 `NetPort` is unchanged.** The sync surface (`setSyncSource`/`syncFrom`) is on the
  `NetAdapter` extension (the 5.1 `dial`/`peerId`/`sendPeerInfo` precedent — "NOT on the `NetPort`"),
  not on the frozen `NetPort` seam. No `src/ports.ts` change.

- **D9 — the sync path's gate is the 4.3 acceptance path (per the ticket).** `syncChain` verifies each
  synced block with `acceptBlockWinner` (the draw gate + the AD-12 signature gate — the ticket's named
  acceptance path) before applying. A **PoW re-check** (`powCheck`/`blockDigest`, the 3.2/3.9 domain)
  is **out of 5.4 scope** (the ticket names the 4.3 acceptance path as the gate; the blocks are already
  PoW-validated at mine time on the trusted test peer). A tampered block (wrong winner) fails the 4.3
  draw gate → rejected. (Re-adding a PoW re-check to the sync path is a follow-up if the threat model
  demands it; noted here, not built.)

## Code map (the files the implementer touches)

- `packages/core/proto/protocol.proto` — append **two** messages (D3/D4): `SyncRequest { int64
  fromSlot = 1; }` and `SyncBlock { Block block = 1; repeated Ticket acceptedTickets = 2; repeated
  int64 weights = 3; }`. **Purely additive** — the eight existing messages (`Block`/`Ticket`/`Tx`/
  `PeerInfo` + the four envelopes) are UNCHANGED (no field-number or type changes).
- `packages/core/src/proto/protocol.ts` — **REGENERATED** by protons (`corepack pnpm build` runs
  `generate:proto`); **do not hand-edit**.
- `packages/core/src/proto/index.ts` — add the two re-exports (`SyncRequest`, `SyncBlock`: each as a
  message **type** + a **value** codec namespace: `export type SyncRequest = succinctcoin.SyncRequest`
  + `export const SyncRequest = succinctcoin.SyncRequest`, same for `SyncBlock`). Additive.
- `packages/core/src/net/sync.ts` — **NEW**: `SYNC_PROTOCOL` (stable constant, D4), the u32be
  length-prefix framing helpers (encode a frame; parse framed messages from the accumulated stream
  bytes), the **server handler factory** (D1), and the **client** `syncFrom` (D1). Imports the proto
  types (`SyncRequest`/`SyncBlock`) + libp2p types. No `src/consensus` import.
- `packages/core/src/net/adapter.ts` — `NetAdapter` gains `setSyncSource(source)` + `syncFrom(peer,
  request)` (D7, NOT on the `NetPort`); the adapter factory captures a `sourceRef`; `start()`
  registers the sync stream handler (after `node.start()`). Existing rows/methods unchanged.
- `packages/core/src/net/index.ts` — additive re-exports (`SYNC_PROTOCOL` + the sync surface types).
- `packages/core/src/consensus/sync.ts` — **NEW**: `syncChain` (client catch-up, D7) + `buildSyncSource`
  (server factory, D3/D7) + the structural `SyncClient`/`SyncSource` types. Composes imported seams
  only. No `src/net` import.
- `packages/core/src/consensus/index.ts` — additive re-exports (`syncChain`, `buildSyncSource`, the
  sync types).
- `packages/core/src/index.ts` — additive re-exports (`syncChain`, `buildSyncSource`, `SyncRequest`,
  `SyncBlock`) so the test imports them from the root barrel.
- `packages/core/test/chain-sync.test.ts` — **NEW**: the 5 sync rows (Matrix). Root-barrel-only
  imports (`../src/index.js` + `vitest` + node builtins for `mkdtempSync`/`tmpdir`/`join`/
  `fileURLToPath`).

**Do NOT touch:** `src/ledger/**`, `src/identity/**`, `src/config/**`, `src/ports.ts`, `src/events/**`,
`src/net/topics.ts` (the four topics unchanged), the other consensus modules (`apply-block.ts`,
`accept-winner.ts`, `draw.ts`, `uptime.ts`, `acceptance-cap.ts`, `verify-draw.ts`, `miner.ts`,
`slot-loop.ts`, `economics.ts`, `sim.ts`, `multi-sim.ts`), `packages/core/package.json` (no new deps),
`config/genesis.json`. The 2.5 no-float guard + 4.7 identity-key-surface guard must stay green (the new
`src/consensus/sync.ts` imports `fromDisplay`/`fromJson` from the ledger barrel — never `big.js`
directly — and never reads `.secret`).

## Tasks

- [x] **T1 — proto (additive).** Append `SyncRequest` + `SyncBlock` to `protocol.proto` (D3/D4); run
  `corepack pnpm build` (regenerates `src/proto/protocol.ts`); add the two re-exports to
  `src/proto/index.ts`. Verify the diff is **appended-only** — the eight existing messages are
  byte-identical (the `git diff` shows only the two new `message` blocks).
- [x] **T2 — net transport.** New `src/net/sync.ts` (D1/D4): `SYNC_PROTOCOL`, the u32be framing
  helpers, the server handler factory, and the client `syncFrom`. In `src/net/adapter.ts`: add
  `setSyncSource`/`syncFrom` to `NetAdapter`, capture `sourceRef`, register the handler in `start()`.
  Additive net-barrel re-exports.
- [x] **T3 — consensus orchestration.** New `src/consensus/sync.ts` (D7): `syncChain` (client catch-up:
  derive challenge → `acceptBlockWinner` → `applyBlock`, thread balances, reject = normal stop) +
  `buildSyncSource` (server factory: stream `{block, acceptedTickets, weights}` from `fromSlot`).
  Compose imported seams only. Additive consensus-barrel re-exports. Root-barrel re-exports.
- [x] **T4 — tests.** New `test/chain-sync.test.ts`: the 5 sync rows (Matrix below). A test-side
  driver mines **N** blocks on a real `FileChainStore` (a loop calling the imported `simulateMultiWindow`
  4.8, capturing per-window `block` + `tickets` + `weights`) = the "peer with N mined blocks"; two
  net adapters over the memory transport connect (5.1 explicit `dial`); the peer registers
  `setSyncSource(buildSyncSource(peerChain))`; the fresh node runs `syncChain`. Root-barrel-only.
- [x] **T5 — gate.** Run the full verification trio + the additive gates (below): proto additive-only
  (existing 8 byte-identical), consensus scope = only `sync.ts` + barrel, net scope = only `sync.ts` /
  `adapter.ts` / `index.ts` (topics byte-identical), protected trees EMPTY, guards green, no new deps.

## Matrix (every frozen row → a passing test)

| Row | Proves | Mechanism under test |
| --- | --- | --- |
| `SYNC_CATCHUP` (AC-1) | a fresh node (empty `FileChainStore`) connected to a peer with **N** mined blocks fetches + **applies all N** via `applyBlock` (AD-2), each passing `acceptBlockWinner` (4.3); the fresh `headSlot()` reaches the peer's head (`N-1`); the fresh committed bytes are **byte-identical** to the peer's (`getBlock(slot)` matches). | dedicated sync stream (request/response) → decode `SyncBlock` → 4.3 accept → AD-2 apply |
| `SYNC_TAMPERED_REJECTED` (AC-2) | the peer's sync payload carries a **tampered block** at slot `T` (`winnerIdentityId` → a foreign 64-hex id, a non-drawn-winner claim); the fresh node applies slots `0..T-1`, then `acceptBlockWinner` returns a **normal `false`** (never a throw) at `T` and the catch-up **stops**; the fresh `headSlot()` === `T-1` and the tampered block is **absent** from the fresh store. A direct unit assertion pins `acceptBlockWinner(tampered) === false`. | 4.3 acceptance path rejects a tampered block (normal `false`); AD-2 never applies it |
| `SYNC_SEQUENTIAL_FROM_HEAD` (AC-3) | the catch-up applies blocks in **slot order** from the client's `headSlot + 1` (empty store → slot 0); each applied block's `parentHash` === the previously-applied block's `hash` (contiguous chain — sequential, **not** binary search / not out-of-order). | D2 sequential ordering (the single-mutation-path constraint) |
| `SYNC_REQUEST_RESPONSE_STREAM` (AC-4, AD-12) | sync travels over a **dedicated libp2p STREAM** (the client sends ONE `SyncRequest`, the server streams one `SyncBlock`/window) — NOT a gossip topic; `SyncRequest`/`SyncBlock` are **proto-encoded** (AD-12), u32be length-prefix framed; `SYNC_PROTOCOL` is a stable constant **distinct** from the four gossip topics (`src/net/topics.ts` byte-identical). | D1 request/response stream + AD-12 proto + framing |
| `SYNC_ADDITIVE` (AC-5) | the 16 existing `net-adapter` rows + every prior suite stay green unchanged; the 4.3/AD-2/3.3 seams are **imported** (not re-implemented — `accept-winner.ts` / `apply-block.ts` / `draw.ts` byte-identical); the four topics byte-identical; the proto is **additive-only** (8 existing messages byte-identical, 2 new appended); no new deps. | AD-2 import-not-reimplement + additive scope + guard suites |

(The rows map to the `verify` clauses: `SYNC_CATCHUP` + `SYNC_SEQUENTIAL_FROM_HEAD` = "fetches and
applies them, headSlot reaches the peer's head, every block passes the 4.3 acceptance path";
`SYNC_TAMPERED_REJECTED` = "a tampered block is rejected (never applied)"; `SYNC_REQUEST_RESPONSE_STREAM`
= the settled D1/D4 (request/response over a stream, proto-encoded — the ticket's `unknown`);
`SYNC_ADDITIVE` = "applyBlock imported, not re-implemented (AD-2)" + the additive scope. All over the
memory transport, zero real sockets, bounded test-side waiting, explicit 60 s row timeouts (the mining
loop is the slow part — the 4.8 precedent).)

## Verification commands (the acceptance gate)

Run from `packages/core` (or the repo root as noted):

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` → all green (224 prior + 5 new sync rows).
2. `corepack pnpm typecheck 2>&1 | tail -1` → clean.
3. `corepack pnpm build 2>&1 | tail -1` → clean (protons regen + tsc).
4. **Proto additive-only:** `git diff -- packages/core/proto/protocol.proto` → shows ONLY the two
   appended `message` blocks (`SyncRequest`/`SyncBlock`); the eight existing messages are byte-identical.
   `src/proto/protocol.ts` is a clean regen (byte-identical to a fresh `corepack pnpm generate:proto`);
   `src/proto/index.ts` gains exactly the two re-exports.
5. **Consensus scope:** `git diff --name-only -- packages/core/src/consensus` → ONLY
   `src/consensus/sync.ts` (new) + `src/consensus/index.ts` (barrel). Every other consensus module is
   byte-identical.
6. **Net scope:** `git diff --name-only -- packages/core/src/net` → `src/net/sync.ts` (new) +
   `src/net/adapter.ts` (modified) + `src/net/index.ts` (barrel). `src/net/topics.ts` byte-identical.
7. **Protected trees untouched:** `git diff --name-only -- packages/core/src/ledger
   packages/core/src/identity packages/core/src/config packages/core/src/ports.ts
   packages/core/src/events` → EMPTY.
8. **Guard suites green** (covered by #1, listed to be explicit): no-float-guard (6) +
   identity-key-surface (5).
9. **No new deps:** `git diff --stat -- packages/core/package.json pnpm-lock.yaml` → EMPTY (no install).

## Never

- No real sockets in CI (AD-10): the memory transport is the only exercised path; sync is a
  request/response **stream**, not a new gossip topic (the four topics are unchanged, AD-8).
- No re-implementation of any consensus seam (AD-2/4.3/3.3): `applyBlock` / `acceptBlockWinner` /
  `deriveWindowChallenge` are **imported**, never re-derived or re-minted.
- No `big.js` in `src/net` **or** the new `src/consensus/sync.ts` (AD-5): `sync.ts` imports
  `fromDisplay`/`fromJson` from the ledger barrel (the AD-5 boundary), never `big.js` directly — the
  2.5 no-float guard's import-specifier set stays exactly `['ledger/display.ts','ledger/fee.ts']`.
- No `.secret` read (AD-11); no RNG / wall-clock in `src` (AD-3 — the catch-up is driven by chain-time
  slots; the 10 s dial bound is a timeout, not a clock read).
- A reject (a tampered block) is a **normal `false` / normal stop** — **never a throw** (spine:
  "reject = normal false, never a throw"). The ONLY throw paths are the existing seam ones (a
  malformed `winnerTicket` → `DrawError SC-CONSENSUS-2`; a store/ledger error → `SC-*`).
- Do NOT wire sync into `createCore` (AD-1) or change the 1.2 `NetPort` (D8) or `src/ports.ts`.
- Do NOT add a new dep (D6) or change the four topics / the eight existing proto messages.
- Do NOT run `git commit` / `git push` — the orchestrator commits.

## Implementation Notes

Built per the story of truth. All five matrix rows land in a single new file,
`packages/core/test/chain-sync.test.ts` (5 `it`s — 224 prior + 5 new = 229 total,
32 files). Seams are IMPORTED, never re-implemented (AD-2/4.3/3.3).

**Files created**
- `packages/core/src/net/sync.ts` — the sync transport. `SYNC_PROTOCOL`
  (`/succinctcoin/sync/1`, a stable constant distinct from the 4 gossip topics),
  u32be length-prefix framing (`encodeFrame`/`FrameAccumulator`), `decodeFramed`
  (stream → `SyncBlock`), `makeSyncHandler` (server: read ONE `SyncRequest`,
  stream `SyncBlock`s from the source, half-close), `syncFrom` (client: dial,
  send ONE `SyncRequest`, half-close, read the `SyncBlock` stream). A
  `SyncSource` interface abstracts the block provider (the test supplies it).
- `packages/core/src/consensus/sync.ts` — the orchestration. `syncChain`
  (client-side: seed balances from the store / mint the genesis supply for an
  empty store, compute `fromSlot = headSlot+1`, for each `SyncBlock` derive the
  challenge (3.3, `deriveWindowChallenge(parentHash, slot)`) and run the 4.3
  acceptance (`acceptBlockWinner` over public data) BEFORE applying via the
  AD-2 `applyBlock`; a rejected block is a normal stop — never a throw).
  `buildSyncSource` (test helper: an `AsyncGenerator` of `SyncWindowRecord`s
  from the peer store). The per-window accepted set (tickets + weights) comes
  from the `SyncBlock` payload (D3), not re-collected.
- `packages/core/test/chain-sync.test.ts` — the 5 rows (memory transport, AD-10).

**Files modified (barrels + adapter only — additive)**
- `packages/core/proto/protocol.proto` — appended `SyncRequest` + `SyncBlock`
  (purely additive; the 8 existing messages are byte-identical).
- `packages/core/src/proto/protocol.ts` — regenerated (clean, idempotent —
  a fresh `generate:proto` reproduces it byte-for-byte).
- `packages/core/src/proto/index.ts` — re-exported `SyncRequest`/`SyncBlock`
  (type + value).
- `packages/core/src/net/adapter.ts` — `NetAdapter` gains `setSyncSource` +
  `syncFrom` (client); `buildNode` registers the sync stream handler before
  `node.start()`. The 1.2 `NetPort` is NOT changed (D8).
- `packages/core/src/net/index.ts` — re-exported `SYNC_PROTOCOL` + the
  `SyncSource` type.
- `packages/core/src/consensus/index.ts` — re-exported `syncChain`,
  `buildSyncSource`, and the sync types.
- `packages/core/src/index.ts` — root barrel re-exports the sync surface
  (`syncChain`, `buildSyncSource`, `SyncRequest`/`SyncBlock`, types). The
  net `SyncSource` is NOT re-exported at the root (avoids a duplicate
  identifier with the consensus `SyncSource`); the consensus `SyncSource` is
  the public one.

**Verification (all green, run ×2 for determinism)**
- `corepack pnpm test` → `Test Files 32 passed (32)`, `Tests 229 passed (229)`
  (both runs identical, ~29 s).
- `corepack pnpm typecheck` → clean (tsc exit 0).
- `corepack pnpm build` → clean (protons regen + tsc exit 0).
- Proto additive-only: `git diff -- packages/core/proto/protocol.proto` shows
  ONLY the two appended messages; `src/proto/protocol.ts` idempotent on regen.
- Scope: consensus = `sync.ts` (new) + `index.ts`; net = `sync.ts` (new) +
  `adapter.ts` + `index.ts`; `topics.ts` byte-identical; protected trees
  (ledger/identity/config/ports.ts/events) EMPTY; `package.json`/`pnpm-lock.yaml`
  EMPTY (no new deps). Guard suites (no-float + identity-key-surface) green.
- No `git commit` / `git push` (orchestrator commits).

**Plan-prose notes / minor divergences (none change the rows)**
- `SyncBlock.block` is OPTIONAL in the generated protons interface (nested
  message fields are optional). `syncChain` guards `block === undefined` as a
  normal stop — a defensive guard only; the well-formed stream always carries
  a block (proven by the catch-up row).
- The client `syncFrom` takes a libp2p `DialTarget` (peer id / multiaddr); the
  adapter's `syncFrom(peer: string, ...)` wraps it. The test dials with the
  peer's multiaddr string.
- The golden proto vectors in the test reuse the 5.2 `net-adapter` golden pins
  (byte-identical constants) to prove the 8 existing messages are unchanged;
  the two new sync messages' wire form is exercised by the round-trip in the
  catch-up rows.
- The `SYNC_ADDITIVE` row mines a small chain (bounded, 60 s timeout) to
  compose the imported seams; it is the only row with real mining cost.

## Plan Change Log

- (build) Implemented T1–T5. No plan changes: the story of truth, hard rules
  (R1/AD-2/4.3/AD-12/AD-10/AD-3), the 5-row matrix, the verification commands,
  and the Never list were followed as written. The 5 matrix rows map 1:1 to the
  5 `it`s in `chain-sync.test.ts`. The only judgment calls were the two
  defensive guards noted in Implementation Notes (optional `block` field; the
  `SyncSource` getter so the handler can be set after node start) — both keep
  the rows green without changing their meaning.
- (review) Quick lens (1 iteration): 3 findings, 0 code changes. All are coverage/
  robustness observations, not defects or plan violations — each is consistent with the
  frozen plan's trusted-peer trust model (D2/D9) and the sanctioned seam-throw Never-list
  entry. Resolved by the Review Triage Log: F1 (adversarial framing chunking unpinned) + F3
  (client-side contiguity not enforced) + F2 (catch the seam `DrawError` on a malformed
  block) are carried as 5.5 forward notes (they land with the live loop's untrusted-peer
  threat model). No plan prose was wrong — the matrix rows are accurate (AC-3's contiguity
  is proven for the well-formed, in-order case; the framing is round-trip-verified). No gate
  re-run needed (no code changed; the post-implementation gate stands green).

## Review Triage Log

**Quick lens (reviewer subagent), 1 iteration — 3 findings, 0 code changes.**
The reviewer independently re-ran the suite (`229 passed`, typecheck clean), read the spine
+ all context files + the diff, and answered the 9 scrutiny questions. All 9 scrutiny
answers were CORRECT on re-verification: no consensus seam re-implemented (`draw.ts` /
`accept-winner.ts` / `apply-block.ts` byte-identical in the diff); the tamper / missing-block /
missing-source / protocol-violation paths are normal stops; the framing code is partial-frame-
safe; the proto is additive-only; the no-float big.js import set stays exactly
`['ledger/display.ts','ledger/fee.ts']` (neither `src/net/sync.ts` nor `src/consensus/sync.ts`
imports `big.js`); no real sockets / wall-clock / RNG in the new `src`; the four golden pins
are byte-identical to the 5.2 `net-adapter` pins; no root-barrel `SyncSource` duplicate
(net's is NOT re-exported at the root; the consensus one is the public one); the sync surface
(`setSyncSource`/`syncFrom`) is on the `NetAdapter`, NOT the 1.2 `NetPort` (`ports.ts`
untouched). The 3 findings are coverage/robustness observations, NOT defects and NOT plan
violations — each is consistent with the frozen plan's trust model and is resolved by
documentation + a forward note. **No code change, so the green gate stands** (229/229, 32
files, typecheck/build clean, proto additive-only, consensus + net scope clean, protected
trees + deps EMPTY).

- **F1 — u32be framing's partial-frame-safety is untested.** The reviewer confirms the
  `FrameAccumulator`/`decodeFramed` code IS partial-frame-safe (holds a trailing partial,
  yields multiple complete frames from one chunk, copies `Uint8ArrayList` parts) — but no
  frozen row adversarially pins a frame split across chunks / two frames coalesced / a
  `Uint8ArrayList` chunk. **Triage: NOTE (no code change).** The framing IS exercised by the
  catch-up round-trips (encode → accumulate → decode; a framing bug would fail
  `SYNC_CATCHUP`) — only the adversarial chunking is unpinned. Pinning it cleanly requires
  either exporting the module-private framing helpers (a barrel expansion the frozen plan did
  NOT sanction) or a fragile fake libp2p `Stream`. The memory transport (the ONLY transport in
  CI, AD-10) delivers frames such that the round-trip already covers the normal case.
  **Forward note (5.5/5.7):** add a dedicated framing unit test (via exported framing helpers)
  when a real or relayed transport lands, where chunking becomes adversarial.
- **F2 — a malformed streamed `SyncBlock` makes the 4.3 seam throw; `syncChain` doesn't catch
  it.** A proto-valid but semantically-malformed block (an undecodable `winnerTicket` →
  `DrawError SC-CONSENSUS-2`, or an empty / length-mismatched `acceptedTickets`/`weights`
  set) throws out of the `for await` and rejects the whole `syncChain`, rather than stopping
  at that slot. **Triage: NOTE — sanctioned, NOT a defect / NOT a plan violation.** The plan's
  Never list EXPLICITLY allows it: "The ONLY throw paths are the existing seam ones (a
  malformed `winnerTicket` → `DrawError SC-CONSENSUS-2`; a store/ledger error → `SC-*`)." The
  spine's "reject = normal `false`, never a throw" rule governs the ACCEPTANCE DECISION (a
  valid block whose winner is not the drawn winner → normal `false`, proven by
  `SYNC_TAMPERED_REJECTED`); a malformed block is a PROTOCOL FAULT, not an acceptance decision,
  and propagates the documented seam `DrawError` — exactly as every other `acceptBlockWinner`
  caller does. In 5.4's trusted-peer model this is unreachable (the test peer mines valid
  blocks; the memory transport does not corrupt). **Forward note (5.5):** if the sync-peer
  threat model becomes untrusted, `syncChain` should catch the seam `DrawError` and stop the
  catch-up (a normal stop) rather than rejecting the whole Promise.
- **F3 — AC-3's contiguity is server-guaranteed, not client-enforced.** `syncChain` never
  checks `block.parentHash` against the fresh node's current head `hash` before `applyBlock`;
  it trusts the server to stream in slot order (and `FileChainStore.commit` does no parent /
  contiguity check). A peer streaming forked / out-of-order blocks (each individually 4.3-
  valid for its own window) would be applied into a non-contiguous chain without detection.
  **Triage: NOTE — consistent with D2/D9, NOT a defect in 5.4's model.** D2 settles the
  ordering as "the client applies 0, 1, 2, …" and D9 defers extra re-checks because "the
  blocks are already PoW-validated at mine time on the trusted test peer." AC-3's row proves
  contiguity for the well-formed, in-order case (which it does). **Forward note (5.5):** add a
  client-side contiguity check (`block.parentHash === current head hash`) before `applyBlock`
  when sync peers become untrusted.
- **Minor (no action): the `SYNC_ADDITIVE` row's inline comment overstates the golden pins.**
  The comment says "the 8 EXISTING proto messages' wire encodings are byte-identical (the 5.2
  golden pins)", but the four golden pins cover the four PAYLOAD messages
  (`Block`/`Ticket`/`Tx`/`PeerInfo`); the full 8-message set (the four + the four envelopes)
  is proven unchanged by the source-level `git diff` gate (verification command #4, which the
  orchestrator ran: additive-only). This is the SAME 4-payload-message pin as the 5.2
  precedent — the claim is TRUE (pins + gate together prove it); the comment just folds the
  gate's proof into the pins' description. Cosmetic; left as-is (matches 5.2).

**Result:** all 3 findings resolved by documentation + forward notes; NO code changes; the
post-implementation gate (229/229, 32 files, typecheck/build clean, proto additive-only,
consensus/net scope clean, protected trees + deps EMPTY) stands. The three forward notes
(sync hardening: client-side contiguity check + catch the seam `DrawError` on a malformed
block + a dedicated framing unit test) are carried to 5.5 (the live loop, where the
untrusted-peer threat model and real/relayed chunking land).
