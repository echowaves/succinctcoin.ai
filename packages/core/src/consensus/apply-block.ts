/**
 * `core/consensus` — `applyBlock`, the single mutation path (AD-2, R5).
 *
 * The ONE place chain + ledger state mutate in the tracer: it applies the
 * block's FULL economic effect as ONE atomic ledger `apply` (AD-2) — the
 * reward transfer `mintId → winner` (the ledger seam has NO mint path —
 * 2.1: an unfunded debit fails SC-LEDGER-1 — so the reward is a transfer
 * out of the pre-funded treasury) plus, for each tx in the `txs` view, the
 * value transfer `tx.from → tx.to` and the fee transfer
 * `tx.from → BURN_ID` (`computeFee(tx.amount, FEE_RATE)`, the 2.2 fee
 * boundary, called exactly once per tx) — commits the block through the
 * store, and saves the balance snapshot. Nothing else in the core may
 * mutate balances (AD-2).
 *
 * The economic model (3.6): the initial allocation is the closed-system
 * treasury (`mintId` pre-funded with `maxSupply`); the fee destination is
 * BURN — the fee moves to the reserved receive-only `BURN_ID`, never to
 * the winner (burning to a neutral account keeps the winner's income = the
 * fixed block reward, independent of network traffic — uptime-only R1).
 * Because the reward and every fee are within-supply transfers,
 * `totalSupply` (sum over ALL identities, including `BURN_ID`) is
 * CONSERVED at every step. `rewardBaseUnits` is integer base units: the
 * one-time display→base-unit conversion (`fromDisplay`, the AD-5 big.js
 * boundary) happens OUTSIDE this module, at the call site that owns the
 * display string.
 *
 * The `txs` are an in-memory VIEW (sender/recipient/amount per tx), not a
 * block payload: the proto `Block` carries only `txCount` (a `Tx` is a
 * separate message). `txs` is OPTIONAL —
 * default `[]` — so a 0-tx block (the tracer's `mineAndApply` path)
 * behaves exactly as 3.2/3.5: reward credit only, no fee, `totalSupply`
 * conserved. Carrying real, verified txs through the loop is beyond epic 5
 * (its networking propagates txs over gossipsub; the loop stays 0-tx).
 *
 * Ordering: ledger first (an over-draw — `SC-LEDGER-1` — leaves the chain
 * and the snapshot untouched), then `store.commit(block)`, then
 * `store.saveState(toJson(newBalances))` (AD-5 decimal-string snapshot,
 * atomic under the store's exclusive lock).
 */
import { PeerAnnouncement } from '../proto/index.js'
import type { Block } from '../proto/index.js'
import type { StorePort } from '../ports.js'
import type { BalanceMap, Transfer } from '../ledger/index.js'
import { apply, computeFee, toJson } from '../ledger/index.js'
import { BURN_ID, FEE_RATE } from './economics.js'
import { validatePeerAnnouncement } from '../discovery/index.js'
import type { SignedPeerAnnouncement } from '../discovery/index.js'

/**
 * CAP-7 (8.3): the hard budget of announcement blobs per block. Over-budget
 * blocks are REJECTED whole — a deterministic rule every node agrees on,
 * no partial-drop ordering to negotiate.
 */
export const MAX_BLOCK_ANNOUNCEMENTS = 8

/** Block rejected for an announcement reason (`SC-ANNOUNCE-1`). */
export class AnnouncementBlockError extends Error {
  readonly code = 'SC-ANNOUNCE-1' as const
  constructor(message: string) {
    super(`SC-ANNOUNCE-1: ${message}`)
    this.name = 'AnnouncementBlockError'
  }
}

/**
 * The CAP-7 discovery context for applying a block (8.3). OPTIONAL:
 * blocks with NO announcements apply with or without it (every pre-8.3
 * caller is byte-for-byte unchanged). With announcements present, a context
 * is REQUIRED — an unscopeable announcement cannot be trusted, so the block
 * is rejected.
 *
 * - `expectedChainId`: this network's genesis chainId (records from other
 *   chains die here).
 * - Freshness is judged at `block.slot` (chain time — identical verdict on
 *   every node whenever it syncs, AD-3).
 * - `onAnnouncements` fires AFTER commit with the validated records + the
 *   originating block key (8.4's address-book handoff; a throwing listener
 *   is a listener bug — it never unwinds the committed block).
 */
export interface ApplyBlockDiscovery {
  expectedChainId: string
  onAnnouncements?: (
    records: SignedPeerAnnouncement[],
    ctx: { blockHashHex: string; slot: bigint },
  ) => void
}

/**
 * One tx's in-memory view (3.6): the sender/recipient/amount the ledger
 * math consumes. `amount` is the VALUE moved `from → to` in integer base
 * units (the fee on top of it is computed at the 2.2 boundary, not
 * carried here). The proto `Tx` message (a separate wire form) is NOT this
 * view — this is the projection `applyBlock` needs.
 */
export interface BlockTx {
  from: string
  to: string
  amount: bigint
}

/**
 * The inputs to `applyBlock` — all threaded in (the tracer is standalone
 * functions; 3.5 wires it into the core lifecycle). `block` is the mined
 * block (already pow-checked + hashed by 3.2's `mineBlock`); `balances` is
 * the current ledger state (the pre-funded treasury included);
 * `rewardBaseUnits` is the fixed-emission reward in integer base units;
 * `mintId` is the reserved treasury id the reward transfers from; `txs` is
 * the OPTIONAL fee-bearing tx view (default `[]` — a 0-tx block behaves
 * exactly as 3.2/3.5; the block's `txCount` is NOT read here — the view
 * IS the tx set).
 */
export interface ApplyBlockParams {
  store: StorePort
  block: Block
  balances: BalanceMap
  rewardBaseUnits: bigint
  mintId: string
  txs?: ReadonlyArray<BlockTx>
  /** CAP-7 (8.3): see `ApplyBlockDiscovery`. */
  discovery?: ApplyBlockDiscovery
}

/**
 * `applyBlock` — the single mutation path (AD-2):
 *
 *   1. apply the block's FULL economic effect as ONE `apply` call (atomic —
 *      AD-2's single mutation path): the reward transfer
 *      `{ from: mintId, to: winner, amount: rewardBaseUnits }` + for each
 *      tx, the value transfer `{ from: tx.from, to: tx.to, amount:
 *      tx.amount }` AND the fee transfer `{ from: tx.from, to: BURN_ID,
 *      amount: computeFee(tx.amount, FEE_RATE) }` (the 2.2 boundary,
 *      exactly once per tx). Every debit is validated against the running
 *      totals before any transfer is applied: an over-draw throws
 *      `SC-LEDGER-1` BEFORE anything is committed. All transfers are
 *      within-supply, so `totalSupply` is unchanged (closed system).
 *   2. `store.commit(block)` — persist the block's canonical wire bytes and
 *      advance the head.
 *   3. `store.saveState(toJson(newBalances))` — persist the balance
 *      snapshot (decimal strings, AD-5).
 *
 * Returns the new `BalanceMap` (the caller threads it forward; the tracer's
 * `mineAndApply` returns it alongside the block).
 */
export async function applyBlock(params: ApplyBlockParams): Promise<BalanceMap> {
  const { store, block, balances, rewardBaseUnits, mintId } = params
  const txs: ReadonlyArray<BlockTx> = params.txs ?? []
  const winner = block.winnerIdentityId

  // 0 — CAP-7 (8.3): validate the block's anchored announcements BEFORE any
  //     mutation (all-or-nothing: one bad blob rejects the whole block).
  //     Count cap first (cheapest), then decode, then the full 8.2
  //     validator at THIS block's slot. No discovery context + non-empty
  //     announcements ⇒ reject (an unscopeable record cannot be trusted).
  const blobs = block.announcements ?? []
  let validated: SignedPeerAnnouncement[] | null = null
  if (blobs.length > 0) {
    if (blobs.length > MAX_BLOCK_ANNOUNCEMENTS) {
      throw new AnnouncementBlockError(
        `block carries ${blobs.length} announcements; the budget is ${MAX_BLOCK_ANNOUNCEMENTS}`,
      )
    }
    if (params.discovery === undefined) {
      throw new AnnouncementBlockError(
        'block carries announcements but no discovery context (chainId scope) was supplied',
      )
    }
    validated = []
    for (const [i, blob] of blobs.entries()) {
      let record: SignedPeerAnnouncement
      try {
        record = PeerAnnouncement.decode(blob) as SignedPeerAnnouncement
      } catch {
        throw new AnnouncementBlockError(`announcement[${i}] is not a decodable PeerAnnouncement`)
      }
      const verdict = validatePeerAnnouncement(record, {
        currentSlot: block.slot,
        expectedChainId: params.discovery.expectedChainId,
      })
      if (!verdict.ok) {
        throw new AnnouncementBlockError(`announcement[${i}] rejected: ${verdict.reason}`)
      }
      validated.push(record)
    }
  }

  // 1 — the block's full economic effect, through the ledger's single
  //    mutation seam (AD-2), as ONE atomic apply. The reward credit is
  //    first (the winner's income is the fixed block reward — fees burn to
  //    BURN_ID, never to the winner); each tx contributes its value
  //    transfer + its fee (computed at the 2.2 boundary, exactly once).
  const transfers: Transfer[] = [
    { from: mintId, to: winner, amount: rewardBaseUnits },
  ]
  for (const tx of txs) {
    transfers.push({ from: tx.from, to: tx.to, amount: tx.amount })
    transfers.push({ from: tx.from, to: BURN_ID, amount: computeFee(tx.amount, FEE_RATE) })
  }
  const newBalances = apply(balances, transfers)

  // 2 — commit the block (canonical wire bytes + head advance).
  await store.commit(block)

  // 3 — save the balance snapshot (AD-5: decimal-string base units).
  await store.saveState(toJson(newBalances))

  // 4 — CAP-7 (8.3): post-commit emission — 8.4's address-book handoff.
  //     The block is already committed; a throwing listener never unwinds
  //     it (a listener bug is a listener bug). The records are the CANONICAL
  //     decode of the anchored blobs: what the chain attested is the blob,
  //     and every node decodes it identically (deterministic), so the
  //     address book consumes the fields the anchored bytes attest.
  if (validated !== null && params.discovery?.onAnnouncements !== undefined) {
    try {
      params.discovery.onAnnouncements(validated, {
        blockHashHex: bytesToHex(block.hash),
        slot: block.slot,
      })
    } catch {
      /* swallowed on purpose — the commit stands */
    }
  }

  return newBalances
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
