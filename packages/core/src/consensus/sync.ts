/**
 * `core/consensus` — chain-sync orchestration (5.4, D2/D3/D7/D9).
 *
 * This module is the catch-up ORCHESTRATION (the net module
 * `src/net/sync.ts` is the TRANSPORT — the two never import each other, D7;
 * both import the shared proto layer, AD-12). It composes ONLY imported
 * seams — it never re-implements any of them:
 *
 *   - `deriveWindowChallenge` (3.3, AD-7/AD-12) — the per-window challenge,
 *     derived from each synced block's OWN public data (`parentHash`,
 *     `slot`) — NEVER trusted from the wire (D3);
 *   - `acceptBlockWinner` (4.3, E2 / AD-7 / AD-12) — the acceptance path:
 *     every synced block is verified (the draw gate + the AD-12 signature
 *     gate) BEFORE it is applied. A reject is a NORMAL `false` (never a
 *     throw) → the catch-up STOPS (a tampered block is never applied);
 *   - `applyBlock` (AD-2, the single mutation path) — the ONLY place a
 *     synced block enters the fresh node's chain/ledger. Imported, never
 *     re-implemented; the returned `balances` are threaded forward;
 *   - `fromDisplay` (the AD-5 big.js boundary, via the LEDGER BARREL —
 *     never `big.js` directly) — the reward display→base-unit conversion,
 *     done ONCE outside the loop;
 *   - `fromJson` (the ledger state-decode boundary) — seeding the fresh
 *     store's balances from its snapshot (`null` → a pre-funded `MINT_ID`
 *     treasury, mirroring 4.8's `simulateMultiWindow`);
 *   - `MINT_ID` (the reserved treasury id, 3.2/3.6).
 *
 * `syncChain` (the CLIENT catch-up, D2/D4): reads the peer's streamed
 * `SyncBlock`s (one per window, `fromSlot = headSlot + 1` → the peer's
 * head, SEQUENTIAL — the single-mutation-path constraint), and for each:
 * derive the challenge (3.3) → `acceptBlockWinner` (4.3) → on accept,
 * `applyBlock` (AD-2), threading the balances forward. A reject (a tampered
 * block, a normal `false`) STOPS the catch-up — the last good block stays
 * committed, the bad one is never applied (AC-2).
 *
 * `buildSyncSource` (the SERVER factory, D3/D7): given a peer's per-window
 * records (`{ block, acceptedTickets, weights }`, an array indexed by slot
 * from slot 0), returns the `SyncSource` the transport handler invokes — it
 * yields each window's `SyncBlock` from `fromSlot` up to the last slot
 * (inclusive). The per-window accepted set is the 4.3 input the fresh node
 * needs (D3 — a fresh node has not collected the gossiped tickets for
 * historical windows; the sync payload supplies them).
 *
 * Hygiene: no `big.js` (AD-5 — `fromDisplay`/`fromJson` from the ledger
 * barrel), no `.secret` reads (AD-11 — no keypair is exposed on any
 * read-API surface), no RNG / wall-clock (AD-3 — the catch-up is driven by
 * chain-time slots, the peer's `fromSlot`, never a clock read).
 */
import type { Block, Ticket as ProtoTicket } from '../proto/index.js'
import type { SyncBlock, SyncRequest } from '../proto/index.js'
import type { StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { MINT_ID } from './miner.js'
import { applyBlock } from './apply-block.js'
import { deriveWindowChallenge } from './draw.js'
import { acceptBlockWinner } from './accept-winner.js'

/**
 * The sync SOURCE (server side, D7) — the structural shape the net
 * transport's handler invokes. Given the slot the client is missing starting
 * from, yield one `SyncBlock` per window (that window's
 * `{ block, acceptedTickets, weights }`) from `fromSlot` up to the last
 * slot (inclusive). Structurally identical to the net module's `SyncSource`
 * (the two are never imported across, D7 — this is the consensus-side
 * declaration, and the net-side one it must satisfy).
 */
export interface SyncSource {
  (fromSlot: bigint): AsyncGenerator<SyncBlock>
}

/**
 * One window's sync record (the peer's per-window state, D3): the mined
 * block + the window's ACCEPTED ticket set (proto `Ticket`, AD-12) + the
 * per-ticket uptime weights (4.5) — exactly what `acceptBlockWinner` (4.3)
 * needs. `records` is indexed by slot from slot 0 (the peer's chain).
 */
export interface SyncWindowRecord {
  /** The window's mined + committed block. */
  block: Block
  /** The window's ACCEPTED proto `Ticket` set (the 4.3 accepted-set input). */
  acceptedTickets: ProtoTicket[]
  /** The window's per-ticket uptime weights, one per `acceptedTickets` (same order). */
  weights: bigint[]
}

/**
 * The sync CLIENT (D7) — the structural shape `syncChain` consumes (the
 * transport's `syncFrom`, never a net import). Given a peer + the ONE
 * `SyncRequest`, yield the peer's streamed `SyncBlock`s (read lazily; the
 * iterable ends when the server half-closes).
 */
export interface SyncClient {
  syncFrom(peer: string, request: SyncRequest): AsyncIterable<SyncBlock>
}

/**
 * `syncChain`'s inputs (D4 — the fresh node PULLS). `client` is the
 * transport's sync surface (a net adapter satisfies it structurally);
 * `peer` is the peer's multiaddr string (the client dials it); `store` is
 * the fresh node's chain store (the catch-up target); `rewardDisplay` /
 * `maxSupplyDisplay` are the genesis display strings (the AD-5 boundary
 * converts them ONCE, outside the loop).
 */
export interface SyncChainParams {
  /** The transport's sync client (a `NetAdapter` satisfies this structurally). */
  client: SyncClient
  /** The peer's multiaddr string (the client dials it, 5.1's explicit connect). */
  peer: string
  /** The fresh node's chain store (the catch-up target — AD-2's mutation path). */
  store: StorePort
  /** The fixed-emission block reward (display units, AD-5). */
  rewardDisplay: string
  /** The max supply (display units, AD-5) — seeds an empty store's treasury. */
  maxSupplyDisplay: string
}

/** `syncChain`'s outcome: how many blocks were applied + the new head slot. */
export interface SyncChainResult {
  /** The number of blocks applied through `applyBlock` (AD-2). */
  applied: number
  /** The fresh store's `headSlot()` after the catch-up (the peer's head if
   *  the whole chain was applied; the last good slot if it stopped early). */
  headSlot: number
}

/**
 * `syncChain` — the CLIENT catch-up (D2/D4/D9). Reads the peer's streamed
 * `SyncBlock`s from `headSlot + 1` (SEQUENTIAL — the single-mutation-path
 * constraint), and for each block:
 *
 *   1. derive the window's challenge from the block's OWN public data
 *      (`deriveWindowChallenge(block.parentHash, block.slot)` — 3.3,
 *      IMPORTED, NEVER trusted from the wire, D3);
 *   2. run the 4.3 acceptance path (`acceptBlockWinner` — the draw gate +
 *      the AD-12 signature gate, IMPORTED). A reject (a tampered block —
 *      a NORMAL `false`, never a throw) STOPS the catch-up: the last good
 *      block stays committed, the bad one is never applied (AC-2);
 *   3. on accept, `applyBlock` (AD-2, the single mutation path, IMPORTED) —
 *      the block's ONLY entry into the fresh chain/ledger; the returned
 *      `balances` are threaded forward.
 *
 * The fresh store's balances are seeded from its snapshot (`loadState`,
 * `null` → a pre-funded `MINT_ID` treasury via `fromDisplay(maxSupply)`,
 * mirroring 4.8's `simulateMultiWindow`); the reward is converted
 * display→base-units ONCE, outside the loop (`fromDisplay(reward)`).
 *
 * The catch-up is driven by CHAIN-TIME slots (the peer's `fromSlot`), never
 * a clock read or RNG (AD-3).
 */
export async function syncChain(params: SyncChainParams): Promise<SyncChainResult> {
  const { client, peer, store, rewardDisplay, maxSupplyDisplay } = params

  // Seed the fresh store's balances from its snapshot (absent snapshot →
  // pre-funded `MINT_ID` treasury, the closed-system seed — mirroring 4.8's
  // `simulateMultiWindow`).
  const doc = await store.loadState()
  let balances: BalanceMap =
    doc === null
      ? new Map<string, bigint>([[MINT_ID, fromDisplay(maxSupplyDisplay)]])
      : fromJson(doc)

  // The AD-5 boundary conversion ONCE, OUTSIDE the loop (the per-attempt
  // mining loop never re-converts — the 3.2/4.8 precedent).
  const rewardBaseUnits = fromDisplay(rewardDisplay)

  // The catch-up STARTS at the fresh node's head + 1 (empty store → slot 0,
  // D2 — sequential from the client's head, not binary search). `headSlot()`
  // is a `number` (the store's slot index) — the u64be/u64be chain-time slot
  // is a `bigint`, so convert explicitly.
  const fromSlot = BigInt(await store.headSlot()) + 1n
  const request: SyncRequest = { fromSlot }

  let applied = 0
  for await (const syncBlock of client.syncFrom(peer, request)) {
    const { block, acceptedTickets, weights } = syncBlock

    // A `SyncBlock` MUST carry a block (the server always yields one — the
    // generated type marks the nested message optional because it cannot know
    // the wire guarantees presence). A block-less frame is malformed — STOP
    // the catch-up (a normal stop, never a throw, like a 4.3 reject).
    if (block === undefined) break

    // 1 — the window's challenge, derived from the block's OWN public data
    //     (3.3, IMPORTED — NEVER trusted from the wire, D3).
    const challenge = deriveWindowChallenge(block.parentHash, block.slot)

    // 2 — the 4.3 acceptance path (IMPORTED): the draw gate + the AD-12
    //     signature gate. A reject is a NORMAL `false` (never a throw) →
    //     STOP the catch-up (a tampered block is never applied, AC-2).
    const accept = acceptBlockWinner(block, acceptedTickets, weights, challenge)
    if (!accept) break

    // 3 — AD-2, the single mutation path (IMPORTED): apply the block, thread
    //     the returned balances forward.
    balances = await applyBlock({
      store,
      block,
      balances,
      rewardBaseUnits,
      mintId: MINT_ID,
    })
    applied++
  }

  return { applied, headSlot: await store.headSlot() }
}

/**
 * `buildSyncSource` — the SERVER factory (D3/D7). Given a peer's per-window
 * records (`{ block, acceptedTickets, weights }`, an array indexed by slot
 * from slot 0), returns the `SyncSource` the net transport's handler
 * invokes: it yields each window's `SyncBlock` from `fromSlot` up to the
 * last slot (inclusive). A `fromSlot` beyond the last slot yields nothing
 * (a client that is already at/ahead of the peer's head catches up zero
 * blocks — a normal stop). The per-window accepted set is the 4.3 input the
 * fresh node needs (D3 — supplied by the sync payload).
 */
export function buildSyncSource(records: ReadonlyArray<SyncWindowRecord>): SyncSource {
  return async function* (fromSlot: bigint): AsyncGenerator<SyncBlock> {
    // `records` is indexed by slot from slot 0 — `fromSlot` → that index.
    for (let i = Number(fromSlot); i < records.length; i++) {
      const record = records[i]
      yield {
        block: record.block,
        acceptedTickets: record.acceptedTickets,
        weights: record.weights,
      }
    }
  }
}
