/**
 * `core/consensus` — the chain-time slot loop + the end-to-end tracer (3.2,
 * R4 + R5), rewired at 3.4 for the verifiable draw (R2).
 *
 * `nextSlotAndParent(store)` derives the NEXT slot + parent hash from the
 * STORE'S PERSISTED HEAD — never the wall clock (AD-3):
 *   - empty chain (`headSlot()` = -1) → slot 0, parent = 32 zero bytes;
 *   - non-empty → slot = head + 1, parent = the head block's stored `hash`
 *     (decoded from the stored wire bytes).
 *
 * `mineAndApply(...)` is the one-block tracer: load the balance snapshot
 * (absent → pre-fund the reserved mint with `maxSupply`), derive the next
 * slot/parent, derive the window's challenge (AD-7), build the node's proto
 * `Ticket`, run the pinned `drawWindow` over the ticket set, `mineBlock`
 * (R3) for the DRAW WINNER with the winner's encoded `Ticket` as
 * `winnerTicket`, `applyBlock` (R5), return the block. It is the single
 * node producing, persisting, and reloading one valid block — the
 * thinnest consensus path. Standalone: store + params in, block + balances
 * out (3.5 wires this into the `createCore` lifecycle).
 *
 * Single-node behavior stays invariant (3.2 pins): with the default (no
 * `otherTickets`), the sole ticket wins its own draw, so the block still
 * mines for `TRACER_WINNER_ID` — now carrying that ticket's NON-empty
 * encoded proto `Ticket` (3.4 replaced the empty placeholder; the 3.2
 * `mineAndApply`-derived pins do not check the ticket's length, and
 * `mineBlock`/`BlockTemplate` are untouched).
 */
import { Block, Ticket } from '../proto/index.js'
import type { Ticket as ProtoTicket } from '../proto/index.js'
import { createHash } from 'node:crypto'
import type { StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { MINT_ID, TRACER_WINNER_ID, mineBlock } from './miner.js'
import { applyBlock } from './apply-block.js'
import { deriveWindowChallenge, drawWindow } from './draw.js'
import type { DrawTicket } from './draw.js'

/**
 * An other node's ticket + its draw weight (AD-7): the accepted-set member
 * the draw races against the node's own ticket. `weight` is the ticket's
 * non-negative integer uptime weight (draw input; epic 4 derives it from
 * the lookback window).
 */
export interface OtherTicket {
  /** The other node's proto `Ticket` (AD-12 wire form; the draw consumes
   * its `identityId` + `nonceCommitment`). */
  ticket: ProtoTicket
  /** The ticket's non-negative integer uptime weight (AD-7). */
  weight: bigint
}

/**
 * The tracer node's per-window proto `Ticket` (AD-12 / AD-7): the node's
 * `identityId` (`TRACER_WINNER_ID`), the window's `slot`, the window's
 * `challenge` (AD-7), a DETERMINISTIC `nonceCommitment` (the draw's only
 * randomness source — derived from `sha256("SC-TRACER-COMMIT/1" ‖
 * parentHash ‖ u64be(slot))`, so a rerun on the same chain reproduces the
 * same ticket; no wall clock, no RNG, AD-3), and an EMPTY `signature`
 * (epic 4 verifies it; the tracer signs nothing).
 */
function tracerTicket(
  slot: bigint,
  parentHash: Uint8Array,
  challenge: Uint8Array,
): ProtoTicket {
  const domain = new TextEncoder().encode('SC-TRACER-COMMIT/1')
  const noncePart = new Uint8Array(8)
  new DataView(noncePart.buffer).setBigUint64(0, slot, false) // u64be, AD-12
  // Copy the digest into a fresh 32-byte buffer — the ArrayBuffer-backed
  // form `Ticket.nonceCommitment` requires (the `digest` is typed
  // `Uint8Array<ArrayBufferLike>`).
  const digest = createHash('sha256')
    .update(domain)
    .update(parentHash)
    .update(noncePart)
    .digest()
  const nonceCommitment = new Uint8Array(32)
  nonceCommitment.set(digest)
  // Copy the (32-byte) challenge the same way (the `deriveWindowChallenge`
  // digest is typed `Uint8Array<ArrayBufferLike>`).
  const challengeCopy = new Uint8Array(32)
  challengeCopy.set(challenge)
  return {
    identityId: TRACER_WINNER_ID,
    windowIndex: slot,
    challenge: challengeCopy,
    nonceCommitment,
    signature: new Uint8Array(0),
  }
}

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
 *   3. Derive the window's challenge (`deriveWindowChallenge(parentHash,
 *      slot)`, AD-7) and build the node's proto `Ticket` for the window.
 *   4. Run the pinned `drawWindow` (AD-7) over the ticket set — the
 *      node's ticket (weight `weight`, default 1n) + any `otherTickets` —
 *      to select the winner.
 *   5. `mineBlock` (R3) for the DRAW WINNER, with the winner's proto
 *      `Ticket` ENCODED (protons, AD-12 wire form) as `winnerTicket` — so
 *      the block carries a verifiable ticket (`verifyDraw`, 3.4).
 *   6. `applyBlock` (R5): credit the reward `MINT_ID → winner`, commit the
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
  /**
   * Other nodes' accepted tickets to race in the draw (AD-7 accepted-set
   * members), each with its uptime weight. OPTIONAL — the default (absent /
   * empty) keeps the single-node flow: the sole ticket wins its own draw,
   * so the block still mines for `TRACER_WINNER_ID` (3.2 invariance).
   */
  otherTickets?: ReadonlyArray<OtherTicket>
  /** The node's own ticket's uptime weight (default 1n; ≥ 0, AD-7). */
  weight?: bigint
}): Promise<{ block: Block; balances: BalanceMap }> {
  const { store, rewardDisplay, maxSupplyDisplay } = params
  const otherTickets: ReadonlyArray<OtherTicket> = params.otherTickets ?? []
  const weight: bigint = params.weight ?? 1n

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

  // 3 — the window's challenge (AD-7): derived from the EXACT parentHash +
  //    slot the block will commit to — the same two inputs the verifier
  //    recomputes (`deriveWindowChallenge(block.parentHash, block.slot)`).
  //    Copied into a fresh 32-byte buffer (the digest is 32 bytes) so the
  //    `Uint8Array<ArrayBuffer>` forms the proto `Ticket` requires hold.
  const derivedChallenge = deriveWindowChallenge(parentHash, slot)
  const challenge = new Uint8Array(32)
  challenge.set(derivedChallenge)

  // 4 — the node's per-window proto ticket + the full accepted set.
  const ownTicket = tracerTicket(slot, parentHash, challenge)
  const drawTickets: DrawTicket[] = [
    { identityId: ownTicket.identityId, nonceCommitment: ownTicket.nonceCommitment },
    ...otherTickets.map((o) => ({
      identityId: o.ticket.identityId,
      nonceCommitment: o.ticket.nonceCommitment,
    })),
  ]
  const drawWeights: bigint[] = [weight, ...otherTickets.map((o) => o.weight)]

  // 5 — the ONE pinned draw (AD-7, imported — never re-implemented) picks
  //    the winner from the full ticket set.
  const draw = drawWindow(drawTickets, challenge, drawWeights)

  // 6 — the winner's proto Ticket (the node's own when it won, else the
  //    other node's) ENCODED into the block's `winnerTicket` (AD-12 wire
  //    form). A sole ticket always wins its own draw, so the default
  //    single-node path still mines for TRACER_WINNER_ID (3.2 invariant).
  const winnerProtoTicket: ProtoTicket =
    draw.index === 0 ? ownTicket : otherTickets[draw.index - 1].ticket
  const winnerIdentityId = draw.winnerIdentityId

  // 7 — mine one block for the draw winner (R3 hot path).
  const block = mineBlock({
    slot,
    parentHash,
    winnerIdentityId,
    winnerTicket: Ticket.encode(winnerProtoTicket),
    txCount: 0n,
  })

  // 8 — apply: credit the reward, commit, save the snapshot (R5). The
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
