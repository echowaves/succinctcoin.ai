/**
 * `core/consensus` — the integrated slot loop (6.1, AD-9: "the consensus
 * loop, the single writer in the main process").
 *
 * `createNodeLoop(opts)` is the RUNNING NODE: a `setTimeout`-driven,
 * bounded-poll tick (AD-3: the slot advances by loop iteration via
 * `nextSlotAndParent` over the persisted head — NEVER a wall clock;
 * `tickMs` is a host/test constant, not a timestamp). Each tick
 * (`runWindow`) COMPOSES the built seams — it never re-implements any of
 * them (AD-7/AD-2):
 *
 *   1. `nextSlotAndParent(store)` — the next slot + parent from the
 *      persisted head (chain time, AD-3);
 *   2. `deriveWindowChallenge(parentHash, slot)` — the window's challenge
 *      (AD-7 — imported, never re-derived);
 *   3. the LOCAL ticket (D2): a real SIGNED ticket when `opts.identity` is
 *      injected (the 4.8 `signedTicket` seam — `signTicket` over the EXACT
 *      AD-12 digest, the identity module's single `.secret` reader), else
 *      the tracer ticket (empty signature, `TRACER_WINNER_ID` — the
 *      3.2/3.5 single-node default, so every `createCore(makePorts())`
 *      caller that passes no identity still mines);
 *   4. the GOSSIPED tickets for the window (D3): a bounded poll of the
 *      adapter's accumulated `received['tickets']` — ONE read of the
 *      append-only list, filtered to this slot (present only when `net`
 *      carries the `received` map — a bare `NetPort` → no gossiped
 *      tickets → single-node);
 *   5. the accepted set (D3): local FIRST (the keep-first dedup keeps the
 *      local ticket for its identity), then the gossiped; deduped by
 *      `identityId` (keep-first), identity-sorted (deterministic order
 *      regardless of gossip arrival order), then `applyAcceptanceCap`
 *      (4.4 — composed, never re-implemented);
 *   6. weights via `computeUptimeWeight` (4.5) — the local participant's
 *      tracked mined slots in `[slot−L, slot−1]` (D1); gossiped identities
 *      have no tracked history in this loop → weight `0n` (the ramp from
 *      zero — an identity cannot claim uptime it has not earned, 4.5 D3);
 *   7. the ONE pinned draw (`drawWindow`, AD-7 — imported, NEVER
 *      re-implemented) picks the winner from the capped set (conformed via
 *      the 4.3 `protoTicketToDrawTicket`); a single participant always
 *      wins its own draw;
 *   8. `mineBlock` (R3 hot path) for the draw winner, with the winner's
 *      proto `Ticket` ENCODED (AD-12 wire form) as `winnerTicket`;
 *   9. `applyBlock` (AD-2 — the SINGLE mutation path): credit the reward,
 *      commit the block, save the balance snapshot;
 *  10. `net.sendBlock(block)` — gossip the mined block (the 5.2 D6
 *      single-shot send: a send failure is a NORMAL outcome — the block is
 *      already persisted; the gossip is best-effort, never a loop-killer);
 *  11. `emitBlockApplied` — the AD-9 UI data source (the key-free
 *      `BlockApplied` payload, AD-11).
 *
 * `stop()` clears the pending timer + sets the stopped flag (idempotent).
 * The loop holds the local identity's mined-slot history (`Set<bigint>`) —
 * the slots the local identity WON — as its 4.5 uptime-weight input (D1).
 *
 * Hygiene: AD-11 — the loop NEVER reads `keypair.secret` (it signs via the
 * imported `signedTicket` seam, which routes through `signTicket`, the
 * identity module's own single reader — the 4.7 scan stays exactly
 * `['identity/identity.ts']`). AD-5 — no `big.js` here: the one-time
 * display→base-unit conversions go through the ledger boundary
 * (`fromDisplay`/`fromJson`), never `big.js` directly. AD-3 — no
 * `Date.now`/`Math.random`/wall clock: the cadence is bounded-poll +
 * `setTimeout` only.
 */
import { createHash } from 'node:crypto'

import { Ticket } from '../proto/index.js'
import type { Ticket as ProtoTicket } from '../proto/index.js'
import type { NetPort, StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { TRACER_WINNER_ID, mineBlock } from './miner.js'
import { applyBlock } from './apply-block.js'
import { deriveWindowChallenge, drawWindow } from './draw.js'
import { nextSlotAndParent } from './slot-loop.js'
import { signedTicket } from './multi-sim.js'
import { applyAcceptanceCap } from './acceptance-cap.js'
import { computeUptimeWeight } from './uptime.js'
import { protoTicketToDrawTicket } from './accept-winner.js'
import type { IdentityKeypair } from '../identity/identity.js'
import type { CoreEvents } from '../events/types.js'
import type { ReceivedEnvelope, TopicClass } from '../net/index.js'

/**
 * The `BlockApplied` event payload (6.1, AD-11 — key-free). The single
 * owner of the shape is `CoreEvents['BlockApplied']` in
 * `core/events/types.ts` (AD-9); this alias is the loop's named seam.
 */
export type BlockAppliedPayload = CoreEvents['BlockApplied']

/**
 * The inputs to the integrated slot loop (6.1, D1). All protocol logic is
 * COMPOSED from the imported seams — this options object only carries the
 * loop's wiring + the one-time (caller-side, AD-5) converted constants.
 */
export interface NodeLoopOptions {
  /** The single-writer store (AD-9). */
  store: StorePort
  /**
   * The net port. When it carries the adapter's accumulated `received` map
   * (a `NetAdapter`), the window's accepted set includes the gossiped
   * tickets for the slot (D3); a bare `NetPort` (no `received`) → no
   * gossiped tickets → single-node.
   */
  net: NetPort & { readonly received?: ReadonlyMap<TopicClass, ReceivedEnvelope[]> }
  /**
   * The node's 4.2 PROTOCOL identity (D2). When present, the loop signs its
   * ticket with `signTicket` (a real signed ticket, AD-12); when absent,
   * the loop uses the tracer ticket (empty signature, `TRACER_WINNER_ID`) —
   * the single-node default. The loop NEVER reads `.secret` (AD-11).
   */
  identity?: IdentityKeypair
  /**
   * The fixed-emission reward in INTEGER base units (the one-time
   * display→base-unit conversion — `fromDisplay`, the AD-5 big.js boundary
   * — happens at the CALLER, never per window).
   */
  rewardBaseUnits: bigint
  /** The hard cap on total supply, decimal display string (AD-5). */
  maxSupplyDisplay: string
  /** The reserved treasury id the reward transfers from (3.6 closed system). */
  mintId: string
  /** The uptime lookback `L` in windows (genesis `uptimeLookbackL`, 4.5). */
  lookbackL: bigint
  /** The AD-9 UI data source: the key-free `BlockApplied` payload (AD-11). */
  emitBlockApplied: (p: BlockAppliedPayload) => void
  /** The `setTimeout` tick cadence in ms (host/test constant, D1). */
  tickMs: number
}

/**
 * The tracer ticket's domain-separation prefix (the 3.2/3.5 pinned domain
 * tag, AD-12 style — byte-identical to `slot-loop.ts`'s tracer ticket so a
 * no-identity loop and the boot path produce the same commitment for the
 * same `(slot, parentHash)`).
 */
const TRACER_COMMIT_DOMAIN = new TextEncoder().encode('SC-TRACER-COMMIT/1')

/**
 * The tracer ticket (D2 fallback — the 3.2/3.5 single-node default):
 * `TRACER_WINNER_ID`, the window's `slot` + `challenge`, a DETERMINISTIC
 * `nonceCommitment` (`sha256("SC-TRACER-COMMIT/1" ‖ parentHash ‖
 * u64be(slot))` — no wall clock, no RNG, AD-3), and an EMPTY `signature`
 * (the tracer signs nothing; 4.2/4.3 verify real signatures only when an
 * identity is injected).
 */
function tracerTicket(slot: bigint, parentHash: Uint8Array, challenge: Uint8Array): ProtoTicket {
  const noncePart = new Uint8Array(8)
  new DataView(noncePart.buffer).setBigUint64(0, slot, false) // u64be, AD-12
  const digest = createHash('sha256')
    .update(TRACER_COMMIT_DOMAIN)
    .update(parentHash)
    .update(noncePart)
    .digest()
  // Copy into fresh 32-byte buffers — the ArrayBuffer-backed forms the
  // proto `Ticket` requires (the digests are `Uint8Array<ArrayBufferLike>`
  // under TS's generic typed arrays).
  const nonceCommitment = new Uint8Array(32)
  nonceCommitment.set(digest)
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

/** Bytes → lowercase hex (the module-local byte-helper pattern, AD-5). */
function bytesToHex(buf: Uint8Array): string {
  let out = ''
  for (let i = 0; i < buf.byteLength; i += 1) {
    out += buf[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * The integrated slot loop (6.1, D1): a `setTimeout`-driven tick that runs
 * one window per tick, composing the imported seams (never re-implementing
 * the draw / the ledger apply / the net — AD-7/AD-2/AD-8).
 *
 * Returns `{ stop() }`: clears the pending timer + sets the stopped flag
 * (idempotent — a second `stop()` is a no-op, and a window already in
 * flight completes but schedules no further tick).
 */
export function createNodeLoop(opts: NodeLoopOptions): { stop(): void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  // The local identity's mined-slot history (D1): the slots the local
  // participant WON the draw — its 4.5 uptime-weight input (the count of
  // these in `[slot−L, slot−1]`, via the pure `computeUptimeWeight`).
  const minedSlots = new Set<bigint>()

  /** Schedule the next tick (a no-op once stopped). */
  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void runWindow()
    }, opts.tickMs)
  }

  /** One tick: run a window, then reschedule (unless stopped). */
  async function runWindow(): Promise<void> {
    if (stopped) return
    try {
      await window()
    } catch {
      // A failed window does NOT halt the loop: `applyBlock` is atomic
      // (ledger first, then commit, then snapshot — nothing is half-
      // committed on a throw), so the next tick re-derives the same slot
      // from the persisted head and retries. A window error is a normal
      // outcome, never a process crash.
    }
    schedule()
  }

  /**
   * One window end to end (the plan's 11-step composition). See the module
   * doc for the seam-by-seam breakdown.
   */
  async function window(): Promise<void> {
    const { store } = opts

    // 1 — load or seed the balance state (absent snapshot → the pre-funded
    //     treasury, the closed system, 3.6/AD-2).
    const doc = await store.loadState()
    const balances: BalanceMap =
      doc === null
        ? new Map<string, bigint>([[opts.mintId, fromDisplay(opts.maxSupplyDisplay)]])
        : fromJson(doc)

    // 2 — the next slot + parent, from the persisted head (R4, AD-3).
    const { slot, parentHash } = await nextSlotAndParent(store)

    // 3 — the window's challenge (AD-7 — imported), copied into a fresh
    //     32-byte buffer (the ArrayBuffer-backed form the proto `Ticket`
    //     requires).
    const challenge = new Uint8Array(32)
    challenge.set(deriveWindowChallenge(parentHash, slot))

    // 4 — the LOCAL ticket (D2): a real SIGNED ticket when the identity is
    //     injected (the 4.8 `signedTicket` seam — the AD-12 digest is
    //     imported, never re-implemented; the loop never reads `.secret`),
    //     else the tracer ticket (empty signature, `TRACER_WINNER_ID`).
    const localTicket: ProtoTicket =
      opts.identity !== undefined
        ? signedTicket(opts.identity, slot, parentHash, challenge)
        : tracerTicket(slot, parentHash, challenge)
    const localId = localTicket.identityId

    // 5 — the GOSSIPED tickets for the window (D3): a bounded poll of the
    //     adapter's accumulated `received['tickets']` — ONE read of the
    //     append-only list, filtered to this slot (the adapter exposes no
    //     per-topic callback; a bare `NetPort` has no `received` →
    //     single-node).
    const gossiped: ProtoTicket[] = []
    const received = opts.net.received
    if (received !== undefined) {
      for (const env of received.get('tickets') ?? []) {
        const t = env.payload as ProtoTicket
        if (t.windowIndex === slot) gossiped.push(t)
      }
    }

    // 6 — the accepted set (D3): local FIRST (the keep-first dedup keeps
    //     the local ticket for its identity), then the gossiped; deduped
    //     by `identityId` (keep-first), identity-sorted (deterministic
    //     order regardless of gossip arrival order), then the 4.4 cap
    //     (a no-op after the dedup — composed, never re-implemented).
    const raw: ProtoTicket[] = [localTicket, ...gossiped]
    const deduped: ProtoTicket[] = []
    const seen = new Set<string>()
    for (const t of raw) {
      if (seen.has(t.identityId)) continue // 2nd ticket from the same identity: dropped
      seen.add(t.identityId)
      deduped.push(t)
    }
    deduped.sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))

    // 7 — the weights (4.5, the pure derivation): the local participant's
    //     tracked mined slots (D1 — the slots the local identity won);
    //     gossiped identities have no tracked history in this loop →
    //     weight `0n` (the ramp from zero — an identity cannot claim
    //     uptime it has not earned).
    const weights: bigint[] = deduped.map((t) =>
      t.identityId === localId
        ? computeUptimeWeight([...minedSlots], slot, opts.lookbackL)
        : 0n,
    )
    const capped = applyAcceptanceCap({ tickets: deduped, weights })

    // 8 — the ONE pinned draw (AD-7 — imported, never re-implemented)
    //     picks the winner from the capped set (conformed to the draw
    //     input via the 4.3 conformance seam). A single participant always
    //     wins its own draw.
    const draw = drawWindow(
      capped.tickets.map(protoTicketToDrawTicket),
      challenge,
      capped.weights,
    )
    const winnerProtoTicket = capped.tickets[draw.index]

    // 9 — mine one block for the draw winner (R3 hot path), with the
    //     winner's proto `Ticket` ENCODED (AD-12 wire form) as
    //     `winnerTicket` — so the block carries a verifiable (signed, when
    //     an identity is injected) ticket.
    const block = mineBlock({
      slot,
      parentHash,
      winnerIdentityId: draw.winnerIdentityId,
      winnerTicket: Ticket.encode(winnerProtoTicket),
      txCount: 0n,
    })

    // 10 — apply: credit the reward, commit the block, save the snapshot
    //      (AD-2 — the single mutation path). The reward's
    //      display→base-unit conversion happened ONCE at the caller (D1).
    await applyBlock({
      store,
      block,
      balances,
      rewardBaseUnits: opts.rewardBaseUnits,
      mintId: opts.mintId,
    })

    // 11 — the local identity's mined-slot history (D1): the slot is
    //      tracked iff the local identity won the draw.
    if (draw.winnerIdentityId === localId) {
      minedSlots.add(slot)
    }

    // 12 — gossip the mined block (the 5.2 D6 single-shot send: a send
    //      failure is a NORMAL outcome — the block is already persisted;
    //      the gossip is best-effort, never a loop-killer).
    try {
      await opts.net.sendBlock(block)
    } catch {
      /* a send failure is a normal outcome (the block is persisted). */
    }

    // 13 — the AD-9 UI data source: the key-free `BlockApplied` payload
    //      (AD-11 — the winner's public identity id + public block facts
    //      only; `ticketCount` = the accepted set's size for this window).
    opts.emitBlockApplied({
      slot: Number(slot),
      hash: bytesToHex(block.hash),
      winnerIdentityId: draw.winnerIdentityId,
      ticketCount: capped.tickets.length,
      txCount: Number(block.txCount),
    })
  }

  // Start the tick chain (the first window fires after `tickMs`).
  schedule()

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      if (timer !== null) clearTimeout(timer)
    },
  }
}
