/**
 * `core/consensus` — the standalone multi-node memory-transport simulation
 * (3.7, R1: the uptime-only slot rate).
 *
 * The sim proves the core promise on a MEMORY TRANSPORT (D1 — no sockets,
 * no real network; the "network" is ONE chain + ONE accepted ticket set per
 * window, carried by the single-writer store in a single process; epic 5 adds
 * the real network): a single always-up node wins slots at the expected
 * **uptime-proportional rate** (its weight over the sum of the window's ticket
 * weights, from the ONE pinned draw — `drawWindow`, AD-7), **regardless of
 * hardware**, and **no node wins a slot without a valid per-slot ticket**
 * whose `(ticket, nonce)` verifies the draw (the 3.4 launch gate,
 * `verifyDraw`).
 *
 * It REUSES the pinned seams and NEVER re-implements the draw (AD-7) or the
 * challenge (AD-12):
 *   - `drawWindow` (3.3, the ONE draw) — selects the winner BEFORE mining;
 *   - `mineBlock` (3.2, R3) — produces the PoW nonce ONLY for the winner;
 *   - `applyBlock` (3.6, R5) — credits the reward + commits;
 *   - `verifyDraw` (3.4, the launch gate) — re-verifies the winner;
 *   - `nextSlotAndParent` (3.2, R4, AD-3) — chain-time slot/parent;
 *   - `deriveWindowChallenge` (3.3, AD-12) — the per-window challenge;
 *   - `fromDisplay` (the AD-5 big.js boundary, via the ledger barrel — NOT
 *     `big.js` directly, so the 2.5 guard's specifier set is unchanged).
 *
 * Determinism (AD-3, D5): NO `Math.random`, NO wall clock. Every commitment
 * and challenge is a pinned `sha256` of public data. `syntheticTicket` is the
 * pre-epic-4 stand-in for a real gate-verified ticket (epic 4): its
 * `nonceCommitment` is a deterministic per-(node, window) sha256 and its
 * `signature` is empty (the epic-3 convention — 3.4). The nodes' **uptime
 * weights are fixed inputs** to the draw (AD-7: weights are inputs; epic 4
 * derives real weights from the lookback window).
 *
 * NOT wired into `createCore` — a standalone validation harness (3.5's one
 * block per `start()` loop is untouched). Additive surface only.
 */
import { createHash } from 'node:crypto'
import type { Block, Ticket as ProtoTicket } from '../proto/index.js'
import { Ticket } from '../proto/index.js'
import type { StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { MINT_ID, mineBlock } from './miner.js'
import { applyBlock } from './apply-block.js'
import { deriveWindowChallenge, drawWindow } from './draw.js'
import type { DrawTicket } from './draw.js'
import { verifyDraw } from './verify-draw.js'
import { nextSlotAndParent } from './slot-loop.js'

/**
 * A simulated node (3.7): a 64-hex identity id + its fixed uptime weight.
 *
 * `uptime` is the node's draw weight (AD-7: a non-negative integer INPUT to
 * the draw — the pre-epic-4 stand-in for "valid tickets over lookback L").
 * The always-up node carries the HIGHEST weight, so it wins the most (R1).
 * Weights are distinct inputs, not derived from any observed traffic.
 */
export interface SimNode {
  /** A 64-hex identity id (spine convention: 32-byte hex). */
  identityId: string
  /** The node's fixed uptime weight (draw input, AD-7; non-negative). */
  uptime: bigint
}

/**
 * The window's accepted set (AD-7): for each simulated node, its `DrawTicket`
 * (the two fields the draw consumes), its uptime weight, and its proto
 * `Ticket` (the wire form, for encoding the winner's into the block).
 *
 * Built in `nodes` order, so `tickets[i]` / `weights[i]` / `protoTickets[i]`
 * all refer to `nodes[i]` — the ordering `drawWindow` requires (same-order
 * tickets + weights).
 */
export interface WindowAcceptedSet {
  /** Each node's draw-input ticket (`identityId` + `nonceCommitment`). */
  tickets: DrawTicket[]
  /** Each node's uptime weight, in the SAME order as `tickets`. */
  weights: bigint[]
  /** Each node's proto `Ticket` (AD-12 wire form), in the SAME order. */
  protoTickets: ProtoTicket[]
}

/**
 * One window end-to-end (draw → mine → apply → verify).
 */
export interface SimWindowResult {
  /** The mined + committed block (its `winnerTicket` carries the winner's proto `Ticket`). */
  block: Block
  /** The draw winner's identity id (`block.winnerIdentityId`). */
  winnerId: string
  /** The window's accepted ticket set (the 3.4 re-verify input). */
  tickets: DrawTicket[]
  /** The window's uptime weights (the 3.4 re-verify input), ordered with `tickets`. */
  weights: bigint[]
  /** The window's challenge `deriveWindowChallenge(block.parentHash, block.slot)`. */
  challenge: Uint8Array
  /** `verifyDraw(block, tickets, weights, challenge)` — the 3.4 launch gate. */
  verify: boolean
}

/**
 * The domain-separation prefix of the synthetic commitment
 * (`"SC-SIM-COMMIT/1"` — a versioned domain tag, AD-12 style; distinct from
 * the tracer's `"SC-TRACER-COMMIT/1"`).
 */
const COMMIT_DOMAIN = new TextEncoder().encode('SC-SIM-COMMIT/1')

/**
 * `FIXED_PARENT` — the 32 zero-byte parent for the PURE rate schedule
 * (`drawSchedule`, SIM_RATE): with a fixed parent + the window index as the
 * slot, every challenge and commitment is a pinned sha256 of public data, so
 * the whole 4000-window schedule is fully deterministic (AD-3).
 */
const FIXED_PARENT = new Uint8Array(32)

/**
 * The synthetic per-window proto `Ticket` for a simulated node (D5, AD-3):
 *
 *   - `identityId` = the node's id;
 *   - `windowIndex` = the slot;
 *   - `challenge` = a copy of the (32-byte) window challenge (the proto
 *     field requires the ArrayBuffer-backed form);
 *   - `nonceCommitment` = `sha256("SC-SIM-COMMIT/1" ‖ utf8(identityId) ‖
 *     u64be(slot) ‖ parentHash)` — 32 bytes, a PINNED sha256 of public data
 *     (no RNG / wall clock), distinct per (node, window);
 *   - `signature` = empty (epic 4 verifies it — the epic-3 convention, 3.4).
 *
 * The commitment does NOT depend on the challenge (the draw consumes only
 * `identityId` + `nonceCommitment`); the challenge is carried for the
 * 3.4 window-binding + the `SIM_TICKET_CONFORMS` row.
 */
export function syntheticTicket(
  node: SimNode,
  slot: bigint,
  parentHash: Uint8Array,
  challenge: Uint8Array,
): ProtoTicket {
  const idBytes = new TextEncoder().encode(node.identityId)
  const slotPart = new Uint8Array(8)
  new DataView(slotPart.buffer).setBigUint64(0, slot, false) // u64be, AD-12
  // The pinned commitment (AD-3): domain ‖ identity ‖ u64be(slot) ‖ parent.
  const digest = createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(idBytes)
    .update(slotPart)
    .update(parentHash)
    .digest()
  // Copy the digest into a fresh 32-byte buffer — the ArrayBuffer-backed form
  // `Ticket.nonceCommitment` requires (the `digest` is typed
  // `Uint8Array<ArrayBufferLike>` under TS 5.9's generic typed arrays).
  const nonceCommitment = new Uint8Array(32)
  nonceCommitment.set(digest)
  // Copy the (32-byte) challenge the same way.
  const challengeCopy = new Uint8Array(32)
  challengeCopy.set(challenge)
  return {
    identityId: node.identityId,
    windowIndex: slot,
    challenge: challengeCopy,
    nonceCommitment,
    signature: new Uint8Array(0),
  }
}

/**
 * The window's accepted ticket set (AD-7): every simulated node's
 * `DrawTicket` + uptime weight + proto `Ticket` for the window, in `nodes`
 * order (so `tickets[i]` / `weights[i]` / `protoTickets[i]` align with
 * `nodes[i]`).
 */
export function windowAcceptedSet(
  nodes: ReadonlyArray<SimNode>,
  slot: bigint,
  parentHash: Uint8Array,
  challenge: Uint8Array,
): WindowAcceptedSet {
  const tickets: DrawTicket[] = []
  const weights: bigint[] = []
  const protoTickets: ProtoTicket[] = []
  for (const node of nodes) {
    const t = syntheticTicket(node, slot, parentHash, challenge)
    protoTickets.push(t)
    tickets.push({ identityId: t.identityId, nonceCommitment: t.nonceCommitment })
    weights.push(node.uptime)
  }
  return { tickets, weights, protoTickets }
}

/**
 * One window end-to-end on the memory transport (D1): derive the next slot +
 * parent from the STORE's head (R4, AD-3), derive the window's challenge
 * (AD-12), build the accepted set, run the ONE pinned draw (`drawWindow`,
 * AD-7) to pick the winner, `mineBlock` (R3) for that winner with the winner's
 * encoded proto `Ticket` as `winnerTicket`, `applyBlock` (R5 — credit the
 * reward `MINT_ID → winner`, commit, save), then re-verify with `verifyDraw`
 * (3.4 launch gate).
 *
 * The reward + max-supply display→base-unit conversion (`fromDisplay`, the
 * AD-5 big.js boundary via the ledger barrel) happens ONCE per window,
 * OUTSIDE the per-attempt mining loop — exactly as `slot-loop.ts` does.
 * The store head is threaded forward by the caller (`simulateNetwork`) via the
 * single-writer commit — the memory transport.
 */
export async function simulateWindow(params: {
  store: StorePort
  rewardDisplay: string
  maxSupplyDisplay: string
  nodes: ReadonlyArray<SimNode>
}): Promise<SimWindowResult> {
  const { store, rewardDisplay, maxSupplyDisplay, nodes } = params

  // The AD-5 boundary conversions ONCE per window (outside the mining loop).
  const rewardBaseUnits = fromDisplay(rewardDisplay)

  // 1 — load or seed the balance state (absent snapshot → pre-funded mint,
  //    the closed-system treasury, mirroring `mineAndApply`).
  const doc = await store.loadState()
  const balances: BalanceMap =
    doc === null
      ? new Map<string, bigint>([[MINT_ID, fromDisplay(maxSupplyDisplay)]])
      : fromJson(doc)

  // 2 — the next slot + parent, from the persisted head (R4, AD-3).
  const { slot, parentHash } = await nextSlotAndParent(store)

  // 3 — the window's challenge (AD-12): derived from the EXACT parentHash +
  //    slot the block will commit to. Copied into a fresh 32-byte buffer so
  //    the `Uint8Array<ArrayBuffer>` forms the proto `Ticket` requires hold.
  const derivedChallenge = deriveWindowChallenge(parentHash, slot)
  const challenge = new Uint8Array(32)
  challenge.set(derivedChallenge)

  // 4 — the window's accepted ticket set (AD-7).
  const { tickets, weights, protoTickets } = windowAcceptedSet(
    nodes,
    slot,
    parentHash,
    challenge,
  )

  // 5 — the ONE pinned draw (AD-7, imported — never re-implemented) picks the
  //    winner BEFORE any mining (D3: hardware-independent by construction).
  const draw = drawWindow(tickets, challenge, weights)
  const winnerIdentityId = draw.winnerIdentityId
  const winnerProtoTicket = protoTickets[draw.index]

  // 6 — mine one block for the ALREADY-SELECTED winner (R3 hot path), with the
  //    winner's proto `Ticket` ENCODED (protons, AD-12 wire form) as
  //    `winnerTicket` (so the block carries a verifiable ticket — 3.4).
  const block = mineBlock({
    slot,
    parentHash,
    winnerIdentityId,
    winnerTicket: Ticket.encode(winnerProtoTicket),
    txCount: 0n,
  })

  // 7 — apply: credit the reward `MINT_ID → winner`, commit, save (R5).
  await applyBlock({
    store,
    block,
    balances,
    rewardBaseUnits,
    mintId: MINT_ID,
  })

  // 8 — the 3.4 launch gate: re-verify the block's claimed winner against the
  //    accepted set (pure function of the set — AD-7 boundary rule).
  const verify = verifyDraw(block, tickets, weights, challenge)

  return { block, winnerId: winnerIdentityId, tickets, weights, challenge, verify }
}

/**
 * Run `windows` windows through the memory transport, threading the store
 * head forward (each `simulateWindow` reads the next slot/parent from the
 * head committed by the previous — ONE chain, ONE accepted set per window, D1).
 *
 * Returns each window's block + winner + the launch-gate result.
 */
export async function simulateNetwork(params: {
  store: StorePort
  rewardDisplay: string
  maxSupplyDisplay: string
  nodes: ReadonlyArray<SimNode>
  windows: number
}): Promise<Array<{ block: Block; winnerId: string; verify: boolean }>> {
  const { store, rewardDisplay, maxSupplyDisplay, nodes, windows } = params
  const out: Array<{ block: Block; winnerId: string; verify: boolean }> = []
  for (let w = 0; w < windows; w++) {
    const r = await simulateWindow({ store, rewardDisplay, maxSupplyDisplay, nodes })
    out.push({ block: r.block, winnerId: r.winnerId, verify: r.verify })
  }
  return out
}

/**
 * The PURE rate schedule (SIM_RATE — NO mining): for window `w` ∈ [0,
 * `windows`), `challenge = deriveWindowChallenge(FIXED_PARENT, w)`, `slot =
 * w`, and `drawWindow` over the nodes' synthetic tickets → the winner id.
 *
 * Fully deterministic (AD-3, D5): `FIXED_PARENT` (32 zero bytes) + the window
 * index as the slot make every challenge and commitment a pinned sha256 of
 * public data, so the schedule is reproducible across runs/engines (the
 * stability IS the AD-7 guarantee — mirroring 3.3's `PROPORTIONAL_RATE`).
 * This is the fast, store-free path the `SIM_RATE` row consumes.
 */
export function drawSchedule(
  nodes: ReadonlyArray<SimNode>,
  windows: number,
): Array<{ winnerId: string; slot: bigint }> {
  const out: Array<{ winnerId: string; slot: bigint }> = []
  for (let w = 0; w < windows; w++) {
    const slot = BigInt(w)
    const challenge = deriveWindowChallenge(FIXED_PARENT, slot)
    const { tickets, weights } = windowAcceptedSet(nodes, slot, FIXED_PARENT, challenge)
    const draw = drawWindow(tickets, challenge, weights)
    out.push({ winnerId: draw.winnerIdentityId, slot })
  }
  return out
}
