/**
 * `core/consensus` — the chain-time slot loop + the end-to-end tracer (3.2,
 * R4 + R5).
 *
 * `nextSlotAndParent(store)` derives the NEXT slot + parent hash from the
 * STORE'S PERSISTED HEAD — never the wall clock (AD-3):
 *   - empty chain (`headSlot()` = -1) → slot 0, parent = 32 zero bytes;
 *   - non-empty → slot = head + 1, parent = the head block's stored `hash`
 *     (decoded from the stored wire bytes).
 *
 * `mineAndApply(...)` is the one-block tracer: load the balance snapshot
 * (absent → pre-fund the reserved mint with `maxSupply`), derive the next
 * slot/parent, `mineBlock` (R3), `applyBlock` (R5), return the block. It is
 * the single node producing, persisting, and reloading one valid block —
 * the thinnest consensus path. Standalone: store + params in, block +
 * balances out (3.5 wires this into the `createCore` lifecycle).
 */
import { Block } from '../proto/index.js'
import type { StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { MINT_ID, TRACER_WINNER_ID, mineBlock } from './miner.js'
import { applyBlock } from './apply-block.js'

/**
 * Derive the next slot + parent hash from the store's persisted head
 * (R4, AD-3 — chain time, never the wall clock):
 *
 *   - empty chain (`headSlot()` = -1) → `{ slot: 0n, parentHash: 32 zero
 *     bytes }`;
 *   - non-empty → `{ slot: head + 1, parentHash: the head block's stored
 *     hash }` (decoded from the stored wire bytes — the store hands back
 *     bytes verbatim, so this is the exact hash the head block committed).
 *
 * @throws {Error} if a non-empty chain has no decodable head block — a
 *   corrupt store (a programming/corruption error, not data).
 */
export async function nextSlotAndParent(store: StorePort): Promise<{
  slot: bigint
  parentHash: Uint8Array<ArrayBuffer>
}> {
  const head = await store.headSlot()
  if (head === -1) {
    return { slot: 0n, parentHash: new Uint8Array(32) }
  }
  const bytes = await store.getBlock(head)
  if (bytes === null) {
    const err = new Error(
      `nextSlotAndParent: head slot ${head} has no stored block — corrupt store`,
    )
    ;(err as { code?: string }).code = 'SC-CONSENSUS-1'
    throw err
  }
  const headBlock = Block.decode(bytes)
  return { slot: BigInt(head) + 1n, parentHash: headBlock.hash }
}

/**
 * The end-to-end tracer (one block): produce, persist, and credit a single
 * valid block from a (possibly empty) store.
 *
 *   1. Load the balance snapshot (`loadState` → `fromJson`); if absent,
 *      pre-fund the reserved mint (`MINT_ID`) with `maxSupply` (the
 *      fixed-emission treasury — the closed system the reward credits
 *      against, so `totalSupply` stays `maxSupply`).
 *   2. Derive the next slot + parent from the store head (R4, chain time).
 *   3. `mineBlock` (R3) for the tracer's fixed winner + empty placeholder
 *      ticket.
 *   4. `applyBlock` (R5): credit the reward `MINT_ID → winner`, commit the
 *      block, save the snapshot.
 *
 * `rewardDisplay` is a decimal display string (e.g. `"12.5"`, the genesis
 * `emission.blockReward`); the one-time `fromDisplay` conversion (the AD-5
 * big.js boundary) happens HERE, outside the per-attempt mining loop.
 * `maxSupplyDisplay` is likewise a decimal string (the genesis
 * `emission.maxSupply`).
 *
 * Returns the mined block (persisted) + the new balance map.
 */
export async function mineAndApply(params: {
  store: StorePort
  rewardDisplay: string
  maxSupplyDisplay: string
}): Promise<{ block: Block; balances: BalanceMap }> {
  const { store, rewardDisplay, maxSupplyDisplay } = params

  // 1 — load or seed the balance state (absent snapshot → pre-funded mint).
  const doc = await store.loadState()
  let balances: BalanceMap
  if (doc === null) {
    balances = new Map<string, bigint>([[MINT_ID, fromDisplay(maxSupplyDisplay)]])
  } else {
    balances = fromJson(doc)
  }

  // 2 — the next slot + parent, from the persisted head (R4, AD-3).
  const { slot, parentHash } = await nextSlotAndParent(store)

  // 3 — mine one block for the fixed winner (R3 hot path; empty ticket).
  const block = mineBlock({
    slot,
    parentHash,
    winnerIdentityId: TRACER_WINNER_ID,
    winnerTicket: new Uint8Array(0),
    txCount: 0n,
  })

  // 4 — apply: credit the reward, commit, save the snapshot (R5). The
  //    reward's display→base-unit conversion (big.js, AD-5) is one-time,
  //    OUTSIDE the per-attempt mining loop.
  const newBalances = await applyBlock({
    store,
    block,
    balances,
    rewardBaseUnits: fromDisplay(rewardDisplay),
    mintId: MINT_ID,
  })

  return { block, balances: newBalances }
}
