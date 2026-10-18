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

import { Ticket, PeerAnnouncement, Introduction } from '../proto/index.js'
import type { Ticket as ProtoTicket } from '../proto/index.js'
import type { PeerAnnouncement as PeerAnnouncementMsg } from '../proto/index.js'
import type { Introduction as IntroductionMsg } from '../proto/index.js'
import type { NetPort, StorePort } from '../ports.js'
import {
  MAX_MULTIADDRS,
  signIntroduction,
  signPeerAnnouncement,
  validateIntroduction,
  validatePeerAnnouncement,
} from '../discovery/index.js'
import type { SignedPeerAnnouncement } from '../discovery/index.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { TRACER_WINNER_ID, mineBlock } from './miner.js'
import { applyBlock, MAX_BLOCK_ANNOUNCEMENTS } from './apply-block.js'
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
   * gossiped tickets → single-node. CAP-7 (8.3): `sendAnnouncement` is the
   * same shape of OPTIONAL adapter extension as `received` — a port without
   * it simply publishes nothing (validation + relay bookkeeping still run
   * over whatever arrives).
   */
  net: NetPort & {
    readonly received?: ReadonlyMap<TopicClass, ReceivedEnvelope[]>
    sendAnnouncement?(announcement: PeerAnnouncementMsg): Promise<void>
    sendIntroduction?(introduction: IntroductionMsg): Promise<void>
  }
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
  /**
   * CAP-7 (8.3): this network's genesis chainId — the scope every
   * announcement is validated against. ABSENT ⇒ the loop announces nothing,
   * relays nothing, and includes no announcements in blocks (every pre-8.3
   * caller is byte-for-byte unchanged).
   */
  chainId?: string
  /**
   * CAP-7 (8.3): how many slots an own announcement stays valid for
   * (`slotEnd = slotStart + N`). Default 32 — a few minutes of chain time,
   * long enough to survive into a block, short enough that stale addresses
   * expire without cleanup.
   */
  announceValiditySlots?: number
  /**
   * CAP-7 (8.3): the local listen/relay multiaddrs to advertise. Empty (or
   * absent) ⇒ nothing to advertise YET (a NATed node pre-relay has no
   * public address — A6) and the own announcement is skipped this window.
   */
  announceAddresses?: () => string[]
  /**
   * CAP-7 (8.3): pass-through of `applyBlock`'s post-commit emission — the
   * validated announcements of each committed block + its origin key
   * (8.4's address-book handoff).
   */
  onAnnouncements?: (
    records: SignedPeerAnnouncement[],
    ctx: { blockHashHex: string; slot: bigint },
  ) => void
  /**
   * CAP-7 (8.4): enable the introduction leg — per-window vouches for the
   * OTHER identities whose announcements this loop has verified, plus
   * verify-before-relay of gossiped introductions (the 8.3 rule). Requires
   * `chainId` (and an `identity` to produce — without one it only relays).
   * ABSENT/false ⇒ zero introduction traffic: every pre-8.4 loop is
   * byte-for-byte unchanged.
   */
  introduce?: boolean
  /**
   * CAP-7 (8.4): fires per GOSSIPED announcement record that verified AND
   * was accepted into the known set (a replace happened) — the hint-grade
   * ingest seam 8.5's boot ladder wires into an address book. Own
   * announcements and stale duplicates never fire it. A throwing listener
   * is swallowed (the emission-never-unwinds rule of 8.3).
   */
  onGossipedAnnouncement?: (record: PeerAnnouncementMsg, slot: bigint) => void
  /**
   * CAP-7 (8.4): same seam for gossiped introductions that verified and
   * were accepted (relay-once key replaced) — the corroboration ingest 8.5
   * wires into the book.
   */
  onGossipedIntroduction?: (introduction: IntroductionMsg, slot: bigint) => void
}

/**
 * The tracer ticket's domain-separation prefix (the 3.2/3.5 pinned domain
 * tag, AD-12 style — byte-identical to `slot-loop.ts`'s tracer ticket so a
 * no-identity loop and the boot path produce the same commitment for the
 * same `(slot, parentHash)`).
 */
const TRACER_COMMIT_DOMAIN = new TextEncoder().encode('SC-TRACER-COMMIT/1')

/** Default own-announcement validity window, slots (8.3). */
const DEFAULT_ANNOUNCE_VALIDITY_SLOTS = 32

/** CAP-7 (8.4): per-window cap on fresh vouches this loop signs (the
 * gossip-budget sibling of the block announcement budget; with the once-
 * per-subject rule it bounds total introduction traffic). */
const MAX_INTRODUCED_PER_WINDOW = 4
/** Memory bound for the relay-dedup set (one signer flooding subjects
 * cannot grow it without limit): oldest-observed vouches evict first, ties
 * by lexicographically-greatest key — deterministic. */
const MAX_KNOWN_INTROS = 256

/** 32-byte hex identity id shape (the pre-dedup gate; the validators own
 * the full shape rules — this only needs enough to build a safe key). */
const HEX64 = /^[0-9a-f]{64}$/

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

/**
 * CAP-7 (8.3): the canonical wire blob of an announcement — what goes in
 * block field 8 VERBATIM (winnerTicket precedent: store-and-forward, no
 * re-encode hazard) and what the deterministic hex ordering sorts by.
 */
function encodeAnnouncementBlob(record: PeerAnnouncementMsg): Uint8Array {
  return PeerAnnouncement.encode(record)
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

  // CAP-7 (8.3): the known announcements — ONE entry per identityId (the
  // newest `slotStart` wins), each carrying the canonical wire blob used
  // for block inclusion + hex ordering. Entries expire out of the set when
  // they fail validation at the current slot.
  // (the field is `wire`, never `blob` — that member name belongs to the
  // gate credential's single reader, AD-4 scan).
  const known = new Map<string, { record: PeerAnnouncementMsg; wire: Uint8Array }>()

  // CAP-7 (8.4): the known introductions — ONE entry per `(signer,
  // subject)` pair (the newest `slotObserved` wins; the replace IS the
  // relay dedup, exactly like the announcements set above) + the subjects
  // this loop has already vouched for (producer: once per subject per loop
  // lifetime — a vouch is a point-in-time observation, not a heartbeat).
  const knownIntros = new Map<string, { intro: IntroductionMsg }>()
  const introduced = new Set<string>()

  /**
   * CAP-7 (8.3): one announcement pass per window — publish own (fresh,
   * every window), validate + relay gossiped (once per `(identityId,
   * slotStart)`: the newest-wins replace below IS the dedup — a record
   * enters `known` at most once per key, and only entry-entries relay),
   * then produce the block candidates: fresh entries sorted by blob hex,
   * capped at the block budget. All validation is at THIS window's chain-
   * time slot (AD-3); forged/expired/stale records simply never enter
   // the set, so they can never reach a block.
   */
  async function processAnnouncements(slot: bigint): Promise<Uint8Array[]> {
    if (opts.chainId === undefined) return [] // discovery not configured — pre-8.3 loop
    const validity = BigInt(opts.announceValiditySlots ?? DEFAULT_ANNOUNCE_VALIDITY_SLOTS)

    // own fresh announcement — replaces our entry, published every window.
    if (opts.identity !== undefined) {
      // At most the per-RECORD multiaddr ceiling travels (a longer record
      // would be invalid everywhere); slicing keeps presence alive where
      // skipping the announce entirely would kill it silently.
      const addrs = (opts.announceAddresses?.() ?? []).slice(0, MAX_MULTIADDRS)
      if (addrs.length >= 1) {
        const record: PeerAnnouncementMsg = {
          identityId: opts.identity.identityId,
          multiaddrs: [...addrs],
          slotStart: slot,
          slotEnd: slot + validity,
          chainId: opts.chainId,
          signature: new Uint8Array(0),
        }
        // `new Uint8Array` copies the 64-byte signature into the
        // ArrayBuffer-backed form the generated message declares (TS 5.9
        // generic typed arrays — same bytes).
        record.signature = new Uint8Array(signPeerAnnouncement(opts.identity, record))
        known.set(record.identityId, { record, wire: encodeAnnouncementBlob(record) })
        try {
          await opts.net.sendAnnouncement?.(record)
        } catch {
          /* best-effort gossip — the block is the durable anchor */
        }
      }
    }

    // gossiped announcements: validate at this slot, newest-wins per identity,
    // relay each NEW entry exactly once (mesh forwarding is untrusted noise —
    // only loop-validated records relay).
    const received = opts.net.received
    if (received !== undefined) {
      for (const env of received.get('announcements') ?? []) {
        const rec = env.payload as PeerAnnouncementMsg
        const verdict = validatePeerAnnouncement(rec, {
          currentSlot: slot,
          expectedChainId: opts.chainId,
        })
        if (!verdict.ok) continue
        const prev = known.get(rec.identityId)
        if (prev !== undefined && BigInt(prev.record.slotStart) >= BigInt(rec.slotStart)) {
          continue // stale or duplicate — no replace, no relay
        }
        known.set(rec.identityId, { record: rec, wire: encodeAnnouncementBlob(rec) })
        try {
          await opts.net.sendAnnouncement?.(rec)
        } catch {
          /* best-effort */
        }
        // 8.4 hint-ingest seam (the boot ladder's book feed): fires only
        // for verified, ACCEPTED gossiped records. A throwing listener
        // never unwinds the loop (the 8.3 emission rule).
        try {
          opts.onGossipedAnnouncement?.(rec, slot)
        } catch {
          /* listener errors are the listener's own */
        }
      }
    }

    // block candidates: fresh entries only (expired drop out of the set),
    // deterministic order by blob hex, capped at the budget.
    const fresh: { record: PeerAnnouncementMsg; wire: Uint8Array }[] = []
    for (const [id, entry] of known) {
      const verdict = validatePeerAnnouncement(entry.record, {
        currentSlot: slot,
        expectedChainId: opts.chainId,
      })
      if (!verdict.ok) {
        known.delete(id)
        continue
      }
      fresh.push(entry)
    }
    fresh.sort((a, b) => (bytesToHex(a.wire) < bytesToHex(b.wire) ? -1 : 1))
    return fresh.slice(0, MAX_BLOCK_ANNOUNCEMENTS).map((entry) => entry.wire)
  }

  /**
   * CAP-7 (8.4): the introduction leg — runs right AFTER the announcement
   * pass so this window's accepted observations are vouchable.
   *
   * Producer: for every OTHER identity whose announcement sits verified in
   * the known set (and which this loop has not vouched for yet), sign an
   * Introduction("saw them online at this slot"), capped per window and in
   * deterministic subject-id order. Gossiped intros are relayed exactly
   * once per `(signer, subject)` with verify-before-relay — the 8.3 rule
   * verbatim; forged/expired/wrong-chain vouches never leave this node.
   */
  async function processIntroductions(slot: bigint): Promise<void> {
    if (opts.chainId === undefined || opts.introduce !== true) return // pre-8.4 loop

    // producer — needs an identity to sign with; known-minus-self, only
    // CURRENTLY-valid observations, once per subject, capped + sorted.
    if (opts.identity !== undefined) {
      const subjects: string[] = []
      for (const [id, entry] of known) {
        if (id === opts.identity.identityId || introduced.has(id)) continue
        const verdict = validatePeerAnnouncement(entry.record, {
          currentSlot: slot,
          expectedChainId: opts.chainId,
        })
        if (!verdict.ok) continue
        subjects.push(id)
      }
      subjects.sort()
      for (const subject of subjects.slice(0, MAX_INTRODUCED_PER_WINDOW)) {
        // Untyped literal + `as const` so `reachability` keeps its literal
        // type for signIntroduction while staying assignable to the proto
        // message (whose field is a plain string).
        const intro = {
          signerIdentityId: opts.identity.identityId,
          subjectIdentityId: subject,
          slotObserved: slot,
          reachability: 'direct' as const,
          chainId: opts.chainId,
          signature: new Uint8Array(0),
        }
        intro.signature = new Uint8Array(signIntroduction(opts.identity, intro))
        knownIntros.set(`${intro.signerIdentityId}|${intro.subjectIdentityId}`, { intro })
        introduced.add(subject)
        try {
          await opts.net.sendIntroduction?.(intro)
        } catch {
          /* best-effort gossip — the vouch is re-offered by every peer that saw them */
        }
      }
    }

    // gossiped introductions: verify-before-relay, newest-slotObserved
    // replace per (signer, subject) — the replace IS the relay dedup.
    const received = opts.net.received
    if (received === undefined) return
    for (const env of received.get('introductions') ?? []) {
      const rec = env.payload as IntroductionMsg
      // Cheap pre-dedup BEFORE Ed25519 (the DoS floor): a pair already held
      // at least as fresh can never improve the set, and skipping never
      // relays — verify-before-relay survives, since only VERIFIED records
      // were ever stored. Junk shapes read as junk here and fall through
      // to the validator untouched.
      const raw = env.payload as { signerIdentityId?: unknown; subjectIdentityId?: unknown; slotObserved?: unknown }
      if (
        typeof raw.signerIdentityId === 'string' &&
        typeof raw.subjectIdentityId === 'string' &&
        HEX64.test(raw.signerIdentityId) &&
        HEX64.test(raw.subjectIdentityId)
      ) {
        const heldKey = `${raw.signerIdentityId}|${raw.subjectIdentityId}`
        const held = knownIntros.get(heldKey)
        const observed = raw.slotObserved
        if (
          held !== undefined &&
          (typeof observed === 'bigint' ||
            (typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0)) &&
          BigInt(held.intro.slotObserved) >= BigInt(observed)
        ) {
          continue // stale or duplicate — no verify, no replace, no relay
        }
      }
      const verdict = validateIntroduction(rec, {
        currentSlot: slot,
        expectedChainId: opts.chainId,
      })
      if (!verdict.ok) continue
      const key = `${rec.signerIdentityId}|${rec.subjectIdentityId}`
      knownIntros.set(key, { intro: rec })
      try {
        await opts.net.sendIntroduction?.(rec)
      } catch {
        /* best-effort */
      }
      try {
        opts.onGossipedIntroduction?.(rec, slot)
      } catch {
        /* listener errors are the listener's own */
      }
    }

    // Memory bound: evict oldest-observed (ties: greatest key) past the cap.
    while (knownIntros.size > MAX_KNOWN_INTROS) {
      let worstKey: string | undefined
      let worstSlot: bigint | undefined
      for (const [key, entry] of knownIntros) {
        const observed = BigInt(entry.intro.slotObserved)
        if (
          worstSlot === undefined ||
          observed < worstSlot ||
          (observed === worstSlot && key > (worstKey ?? ''))
        ) {
          worstKey = key
          worstSlot = observed
        }
      }
      if (worstKey === undefined) break
      knownIntros.delete(worstKey)
    }
  }

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

    // 8½ — CAP-7 (8.3): the announcement pass (own publish, gossiped
    //      validate + relay-once, block candidates). Runs every window —
    //      announcing is not gated on winning. Empty without `chainId`.
    const announcements = await processAnnouncements(slot)

    // 8¾ — CAP-7 (8.4): the introduction leg (vouch production + relay-
    //      once), after the announcement pass so this window's accepted
    //      observations are vouchable. No-op without `introduce: true`.
    await processIntroductions(slot)

    // 9 — mine one block for the draw winner (R3 hot path), with the
    //     winner's proto `Ticket` ENCODED (AD-12 wire form) as
    //     `winnerTicket` — so the block carries a verifiable (signed, when
    //     an identity is injected) ticket. CAP-7: the window's announcement
    //     candidates ride in field 8 (proto blobs, verbatim).
    const block = mineBlock({
      slot,
      parentHash,
      winnerIdentityId: draw.winnerIdentityId,
      winnerTicket: Ticket.encode(winnerProtoTicket),
      txCount: 0n,
      announcements,
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
      // CAP-7 (8.3): the discovery scope — chainId + the post-commit
      // emission pass-through. Absent chainId ⇒ undefined (pre-8.3 path).
      discovery:
        opts.chainId !== undefined
          ? { expectedChainId: opts.chainId, onAnnouncements: opts.onAnnouncements }
          : undefined,
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
