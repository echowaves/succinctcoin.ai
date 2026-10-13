/**
 * 5.5 (TRACER) — block propagation over gossipsub + a fresh node receives
 * the next block (epic-node-network, R1, AD-2/AD-3/AD-7/AD-8/AD-10/AD-12).
 *
 * The live loop END TO END over the MEMORY transport (zero real sockets,
 * AD-10): a node that mines a block (3.2's slot loop + 4.2's signed
 * ticket) publishes it to the blocks topic; every peer validates it
 * (4.3's acceptance path, over the per-window accepted set built from the
 * tickets GOSPIED for that window — 4.4 cap + 4.5 weights) and applies it
 * (AD-2). A node that joins mid-run dials the others, catches up via
 * 5.4's `syncChain`, and then receives the NEXT block via gossip.
 *
 * This file is the NEW multi-node networked driver the ticket's `unknown`
 * calls for (D1): 3.7's `simulateWindows` and 4.8's `simulateMultiWindow`
 * share ONE store + ONE in-process identity set; this driver composes N
 * SEPARATE nodes — each with its own `FileChainStore`, its own net
 * adapter, its own identity keypair — connected over the memory
 * transport, composing ONLY imported seams (never re-implementing them).
 * TEST-ONLY: `src/`, `proto/`, `package.json`, and `pnpm-lock.yaml` are
 * untouched (AD-1 preserved — the driver is not wired into
 * `createCore`).
 *
 * Draw-selected mining cadence (D2, uptime-only, AD-3): every window, ALL
 * nodes build the SAME deterministic accepted set (own + gossiped
 * tickets, deduped by identityId, identity-sorted, 4.4 cap, 4.5 weights)
 * and the SAME challenge (`deriveWindowChallenge(parentHash, slot)`,
 * derived LOCALLY from each node's own head — never wire-trusted, D3), so
 * the ONE pinned draw (`drawWindow`, AD-7 — imported, never
 * re-implemented) picks the SAME winner on every node. The winning node
 * mines (`mineBlock`), applies (`applyBlock`, AD-2), and publishes
 * (`sendBlock`); every other node receives over the blocks topic, checks
 * client-side contiguity (D6: `block.slot === head + 1 &&
 * block.parentHash === head's hash`, via `nextSlotAndParent`), passes
 * `acceptBlockWinner` (4.3), and applies.
 *
 * Receive = a bounded poll of `adapter.received` (D4, AD-3): the adapter
 * exposes no per-topic callback; the driver tracks a per-topic read
 * cursor and uses bounded poll loops (the 5.2/5.3 sleep + MAX_POLLS
 * pattern — a bounded yield between iterations). The cadence is driven by
 * loop iterations and chain-time slots — never a wall-clock read, never an
 * RNG call. A bounded timeout is a liveness bound (loop iterations), not
 * a timestamp.
 *
 * Reject = a normal stop, never a throw (the spine): a non-extending
 * gossiped block, a failed `acceptBlockWinner`, or a decode problem is a
 * normal stop — the store does not advance and nothing throws.
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest` + node
 * builtins `node:fs` / `node:os` / `node:path` / `node:url` for per-test
 * temp dirs) — no deep imports, no transitive-dependency imports (AD-10).
 *
 * Rows (plan Matrix):
 *   TRACER_BLOCK_PROPAGATED      (AC-1) 3-node memory net, 3 windows: the
 *                                     draw-selected node mines; the other
 *                                     two receive via `adapter.received`,
 *                                     pass `acceptBlockWinner` over the
 *                                     gossiped-ticket accepted set, and
 *                                     `applyBlock`; each store advances by
 *                                     one slot per window; committed bytes
 *                                     byte-identical across all stores.
 *   TRACER_CONTIGUOUS            (AC-4) every applied gossiped block passed
 *                                     the D6 contiguity check; the chain
 *                                     is contiguous from slot 0; a
 *                                     non-extending gossiped block is
 *                                     never applied (normal stop, no
 *                                     throw).
 *   TRACER_LATE_JOINER           (AC-2) D joins mid-run with an empty
 *                                     store, `syncChain` to the current
 *                                     head N, then receives + validates +
 *                                     applies block N+1 VIA GOSSIP (not
 *                                     sync); D's committed bytes for
 *                                     0..N+1 byte-identical to A/B/C's.
 *   TRACER_SIGNED_TICKET_VERIFY  (AC-3) a real window's block passes
 *                                     `acceptBlockWinner`; the same block
 *                                     with a tampered (empty) 64-byte
 *                                     winner-ticket signature (identical
 *                                     public fields) fails
 *                                     `acceptBlockWinner` WHILE
 *                                     `verifyDraw` stays true — isolating
 *                                     the AD-12 signature gate.
 *   TRACER_ADDITIVE              (AC-5) the driver composes only imported
 *                                     seams; memory transport only (zero
 *                                     real sockets); bounded polls (no
 *                                     wall-clock reads, no RNG in the
 *                                     cadence); the four topics
 *                                     unchanged.
 *
 * AD-3 discipline: no wall-clock reads, no RNG — pinned 32-byte identity
 * seeds (`seedFor(i)` = 32 bytes of `0x40 + i`, the 4.8 convention) →
 * `deriveIdentityKeypair` (IMPORTED); every challenge =
 * `deriveWindowChallenge`; every commitment = the 4.8 `signedTicket`
 * pinned sha256 of public data; every signature = deterministic Ed25519
 * (the AD-12 digest, IMPORTED via `signedTicket`). Who mines which slot =
 * the pinned draw over the gossiped accepted set (D2).
 * AD-5 discipline: no big.js here — the one-time display → base-unit
 * conversion goes through the barrel's `fromDisplay` (computed ONCE);
 * balances are threaded as `BalanceMap` (integer base units, BigInt) and
 * reloaded through the barrel's `fromJson` (the state-decode boundary).
 * AD-11 discipline: the keypair is a driver-internal value; this file
 * NEVER reads `.secret` — signing goes through the barrel's
 * `signedTicket` (the 4.2 single reader).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  TOPICS,
  Ticket,
  acceptBlockWinner,
  applyAcceptanceCap,
  applyBlock,
  buildSyncSource,
  computeUptimeWeight,
  createNetAdapter,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  drawWindow,
  fromDisplay,
  fromJson,
  loadGenesis,
  mineBlock,
  nextSlotAndParent,
  protoTicketToDrawTicket,
  signedTicket,
  syncChain,
  verifyDraw,
} from '../src/index.js'
import type {
  BalanceMap,
  CappedSet,
  DrawResult,
  MultiSimIdentity,
  NetAdapter,
  ReceivedEnvelope,
  SyncWindowRecord,
  TopicClass,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned parameters (5.5 — deterministic, AD-3)
// ---------------------------------------------------------------------------

/** The repo-root `config/genesis.json` (test dir → core → packages → repo root). */
const GENESIS_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'config',
  'genesis.json',
)

/** L = the lookback (genesis `uptimeLookbackL`) — the 4.5 weight input. */
const GENESIS = await loadGenesis(GENESIS_PATH)
const L = BigInt(GENESIS.uptimeLookbackL) // 50 (chain-time windows)
expect(L).toBe(50n) // a genesis change is a protocol change

/** Fixed-emission display params (the genesis emission carries them). */
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'

/** The one-time display → base-unit conversion (AD-5 boundary, computed ONCE). */
const REWARD_BASE_UNITS = fromDisplay(REWARD_DISPLAY)

/** The transport flag (AD-10 — zero real sockets in CI). */
const TRANSPORT = 'memory' as const

/** A 64-byte all-zero signature (the AC-3 tamper — "tampered/empty"). */
const EMPTY_64 = new Uint8Array(64)

/** Bounded test-side waits (the 5.2/5.3 pattern — bounded yields, not clock reads). */
const SLEEP_MS = 25
const MAX_POLLS = 400 // 400 × 25 ms — up to 10 s per bounded poll
const DIAL_POLLS = 40 // 40 × 25 ms — the established dial-retry bound (5.2)
/**
 * Mesh-settle bound (D6/AD-3): gossipsub's heartbeat interval is 1000 ms
 * (100 ms initial delay); the mesh is grafted and the fanout is maintained on
 * those heartbeats. A publish made before the first post-dial heartbeat is
 * lost (fire-and-forget over an empty mesh), so after a dial-topology change
 * we yield ~3 heartbeats before the next publish. 120 × 25 ms = 3000 ms.
 */
const MESH_SETTLE_POLLS = 120

/** The max window count any row runs — sizes the identities' `validWindows`. */
const MAX_WINDOWS = 8

/** The late joiner D's seed index (D1/D5 — the 4.8 `seedFor` convention). */
const D_SEED_INDEX = 3

/**
 * Pinned identity seeds (4.8 convention, no RNG): a 32-byte value filled
 * with `0x40 + i`. `deriveIdentityKeypair` (IMPORTED) maps each seed
 * deterministically to a keypair (the same seed → the same keypair, so
 * the whole fixture is reproducible — AD-3/AD-10).
 */
function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

// ---------------------------------------------------------------------------
// helpers (the 5.2/5.4 bounded-wait pattern — test-side, never in src)
// ---------------------------------------------------------------------------

/** A test-side bounded yield (a timer, not a clock read — the 5.2/5.3 precedent). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Byte-wise equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Run `op` until it resolves (bounded retry — the 5.2 `publishUntilAccepted`
 * pattern). The first publish on a class topic can race gossipsub's mesh /
 * heartbeat handshake: until the publisher knows of a SUBSCRIBED peer,
 * `publish` rejects. The retry is test-side waiting — the adapter's send
 * methods stay single-shot (the `allowPublishToZeroTopicPeers` decision
 * stays DEFERRED, forward note 1: the mesh is formed FIRST, here, via the
 * bounded dial retry below).
 */
async function publishUntilAccepted(op: () => Promise<void>): Promise<void> {
  let lastErr: unknown = null
  for (let i = 0; i < MAX_POLLS; i += 1) {
    try {
      await op()
      return
    } catch (err) {
      lastErr = err
      await sleep(SLEEP_MS)
    }
  }
  throw lastErr
}

/**
 * Dial with the established bounded retry (40 × 25 ms — the 5.2/5.4
 * pattern) so the gossip mesh is formed BEFORE any block is published:
 * the memory transport rejects a dial to an unknown listener until the
 * target has started listening.
 */
async function dialWithRetry(dialer: NetAdapter, address: string): Promise<void> {
  let lastErr: unknown = null
  for (let i = 0; i < DIAL_POLLS; i += 1) {
    try {
      await dialer.dial(address)
      return
    } catch (err) {
      lastErr = err
      await sleep(SLEEP_MS)
    }
  }
  throw lastErr
}

/**
 * Bounded mesh-settle (D6/AD-3): after a dial-topology change, yield ~3
 * gossipsub heartbeats so the mesh grafts the new links BEFORE the next
 * publish. A pure bounded yield (loop iterations + `setTimeout`, the 5.2/5.3
 * pattern) — never a wall-clock read, never an RNG call. Rationale: a
 * gossipsub publish made before the mesh forms is delivered only to the
 * publisher's (still-empty) mesh/fanout and is LOST (no ack, and a lost data
 * message is not retransmitted once it ages out of the 3-heartbeat mcache),
 * so the driver warms the mesh explicitly instead of relying on the first
 * window's traffic to do it.
 */
async function settleMesh(): Promise<void> {
  for (let i = 0; i < MESH_SETTLE_POLLS; i += 1) {
    await sleep(SLEEP_MS)
  }
}

// ---------------------------------------------------------------------------
// the multi-node memory-transport driver (D1 — the NEW networked-node
// harness; T1 + T2)
// ---------------------------------------------------------------------------

/**
 * One networked node (D1): its own `FileChainStore` (a fresh temp dir),
 * its own net adapter (memory transport, listening on `/memory/<name>`,
 * stamped with the node's 4.2 PROTOCOL identity id), its own identity
 * keypair (AD-11 driver-internal value — `.secret` is never read here;
 * signing goes through the barrel's `signedTicket`), its threaded
 * `BalanceMap` (AD-2: mutated only via `applyBlock`'s return), and the
 * per-topic read cursors over `adapter.received` (D4).
 */
interface NetNode {
  name: string
  identity: MultiSimIdentity
  adapter: NetAdapter
  store: FileChainStore
  dir: string
  listenAddress: string
  balances: BalanceMap
  cursors: Map<TopicClass, number>
}

/** One node's view of one window (before the block arrives). */
interface WindowContext {
  slot: bigint
  parentHash: Uint8Array<ArrayBuffer>
  challenge: Uint8Array
  capped: CappedSet
  draw: DrawResult
}

/** One node's outcome for one window (receive / validate / apply). */
interface WindowOutcome {
  node: NetNode
  ctx: WindowContext
  /** This node was the draw winner (it mined the block). */
  mined: boolean
  /** This node got the block from the blocks topic (gossip). */
  receivedFromGossip: boolean
  /** The gossiped envelope's `sourcePeerId` (the winner's protocol id). */
  sourcePeerId: string | null
  /** The D6 contiguity check result against this node's own head. */
  contiguous: boolean
  /** `acceptBlockWinner` (4.3) over this node's gossiped-ticket set. */
  accepted: boolean
  /** The block entered this node's chain via `applyBlock` (AD-2). */
  applied: boolean
  block: Block
}

/**
 * The bounded poll helper (D4, AD-3): tracks a per-topic read cursor over
 * `adapter.received.get(topic)`, yielding a bounded `pollMs` between
 * iterations, resolving the FIRST entry matching `predicate` (consuming
 * it — the cursor advances past it), or failing after `maxPolls`. Bounded
 * = event-based (loop iterations + bounded yields), never a wall-clock
 * read; exhaustion is a test-infrastructure liveness failure (the mesh
 * did not deliver in time) — a PROTOCOL reject (a non-extending block, a
 * failed acceptance) is handled by the CALLER as a normal stop, never
 * here.
 */
async function pollReceived(
  node: NetNode,
  topic: TopicClass,
  predicate: (env: ReceivedEnvelope) => boolean,
  opts: { maxPolls?: number; pollMs?: number } = {},
): Promise<ReceivedEnvelope> {
  const maxPolls = opts.maxPolls ?? MAX_POLLS
  const pollMs = opts.pollMs ?? SLEEP_MS
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const list = node.adapter.received.get(topic) ?? []
    const cursor = node.cursors.get(topic) ?? 0
    for (let i = cursor; i < list.length; i += 1) {
      if (predicate(list[i])) {
        node.cursors.set(topic, i + 1)
        return list[i]
      }
    }
    await sleep(pollMs)
  }
  throw new Error(
    `driver: ${node.name} — no ${topic} envelope matched within ${maxPolls} bounded ` +
      `polls (the bounded liveness window was exhausted — the mesh did not deliver in time)`,
  )
}

/**
 * Build one node (the T1 node factory): a fresh `FileChainStore` in its
 * own `mkdtempSync` dir, a memory-transport adapter listening on
 * `/memory/<name>` stamped with the node's 4.2 protocol identity id,
 * `start()`ed, with balances seeded from the store snapshot (absent → the
 * pre-funded `MINT_ID` treasury, the 3.2/4.8 closed-system seed).
 */
async function makeNode(
  name: string,
  seedIndex: number,
  validWindowStart: bigint = 0n,
): Promise<NetNode> {
  const dir = mkdtempSync(join(tmpdir(), `succinctcoin-prop-${name}-`))
  const store = new FileChainStore(dir)
  await store.open()
  const keypair = deriveIdentityKeypair(seedFor(seedIndex))
  const identity: MultiSimIdentity = {
    keypair,
    attestedUntilWindow: 100000n,
    // A deterministic range (4.8 convention) covering every window this
    // driver can run — the 4.5 weight input (ramp from zero, moving
    // lookback — the 4.5 behavior, identical on every node).
    // `validWindowStart` is 0n for a node that was running from the
    // beginning; a LATE joiner passes its join window so it has NO uptime
    // history for the windows it missed (weight 0 there — it cannot win a
    // draw the incumbents have weight for, which is exactly what AC-2 needs:
    // D receives the next block via gossip, it does not mine it).
    validWindows: Array.from({ length: MAX_WINDOWS }, (_, w) => validWindowStart + BigInt(w)),
  }
  const adapter = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: `/memory/${name}`,
    protocolIdentityId: keypair.identityId,
    mdns: false,
  })
  await adapter.start()
  const doc = await store.loadState()
  const balances: BalanceMap =
    doc === null
      ? new Map<string, bigint>([[MINT_ID, fromDisplay(MAX_SUPPLY_DISPLAY)]])
      : fromJson(doc)
  return {
    name,
    identity,
    adapter,
    store,
    dir,
    listenAddress: `/memory/${name}`,
    balances,
    cursors: new Map<TopicClass, number>(),
  }
}

/** The driver knows every identity's `validWindows` (the 4.5 weight input). */
function validWindowsFor(
  participants: ReadonlyArray<NetNode>,
  identityId: string,
): ReadonlyArray<bigint> {
  const p = participants.find((n) => n.identity.keypair.identityId === identityId)
  if (p === undefined) {
    throw new Error(`driver: unknown identity ${identityId} in the accepted set`)
  }
  return p.identity.validWindows
}

/**
 * (a)–(d): one node's per-window collection (D2 + D3): derive the next
 * slot + parent from its OWN store head (chain-time, AD-3), derive the
 * window challenge LOCALLY (never wire-trusted), sign + gossip its ticket
 * (4.2 — the 4.8 commitment convention), collect own + received tickets
 * (bounded poll, deduped by identityId — robust whether or not gossipsub
 * self-delivers), identity-sort for a DETERMINISTIC cross-node order,
 * derive each ticket's 4.5 weight, apply the 4.4 cap, and run the ONE
 * pinned draw (AD-7 — imported, never re-implemented).
 */
async function collectWindow(
  node: NetNode,
  participants: ReadonlyArray<NetNode>,
  slot: bigint,
): Promise<WindowContext> {
  // (a) the next slot + parent from this node's persisted head (R4, AD-3).
  const { slot: derivedSlot, parentHash } = await nextSlotAndParent(node.store)
  if (derivedSlot !== slot) {
    throw new Error(
      `driver: ${node.name}'s head is slot ${derivedSlot}, expected ${slot} ` +
        `(the nodes are out of sync — a driver invariant, not a protocol reject)`,
    )
  }
  // The window's challenge — derived LOCALLY from this node's own head
  // (D3): the same parentHash + slot on every in-sync node → the same
  // challenge on every node, never trusted from the wire.
  const challenge = deriveWindowChallenge(parentHash, slot)

  // (b) sign this node's window ticket (4.2 — the 4.8 commitment
  // convention: the pinned per-(identity, slot, parent) commitment + the
  // AD-12 Ed25519 signature) and gossip it to the tickets topic.
  const own = signedTicket(node.identity.keypair, slot, parentHash, challenge)
  await publishUntilAccepted(() => node.adapter.sendTicket(own))

  // (c) collect OWN + RECEIVED tickets for this slot in ONE bounded loop
  // until every participant's ticket is in (deduped by identityId — robust
  // whether or not gossipsub self-delivers, AND to any delivery order: a
  // single loop matching against the full accumulated list, so an
  // out-of-order arrival can never be skipped the way a per-target shared
  // cursor could skip it — the cursor is only safe for the single-target
  // block receives in runWindow, not for multi-target ticket collection).
  const tickets: Ticket[] = [own]
  const seen = new Set<string>([own.identityId])
  const expectedIds = new Set(
    participants.filter((p) => p !== node).map((p) => p.identity.keypair.identityId),
  )
  for (
    let attempt = 0;
    attempt < MAX_POLLS && seen.size < participants.length;
    attempt += 1
  ) {
    for (const env of node.adapter.received.get('tickets') ?? []) {
      const t = env.payload as Ticket
      if (t.windowIndex !== slot) continue
      if (!expectedIds.has(t.identityId)) continue
      if (seen.has(t.identityId)) continue
      tickets.push(t)
      seen.add(t.identityId)
    }
    if (seen.size < participants.length) await sleep(SLEEP_MS)
  }
  if (seen.size < participants.length) {
    const missing = [...expectedIds].filter((id) => !seen.has(id))
    throw new Error(
      `driver: ${node.name} — no tickets for [${missing.join(', ')}] within ` +
        `${MAX_POLLS} bounded polls (the mesh did not deliver in time)`,
    )
  }

  // A DETERMINISTIC cross-node order (identityId-sorted): every node
  // builds the SAME accepted set (same membership, same order), so the
  // capped set + weights + draw input are byte-identical on every node.
  tickets.sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))

  // 4.5 — each ticket's uptime weight from its identity's valid-window
  // history (the driver knows every identity's `validWindows`).
  const weights = tickets.map((t) =>
    computeUptimeWeight(validWindowsFor(participants, t.identityId), slot, L),
  )

  // 4.4 — the acceptance cap (keep-first, at most one ticket per
  // identity) UPSTREAM of the draw — a no-op for one ticket per
  // identity, applied for the wire path's shape (gossip can carry
  // duplicates).
  const capped = applyAcceptanceCap({ tickets, weights })

  // (d) the ONE pinned draw (AD-7 — imported, never re-implemented) picks
  // the winner from the capped set.
  const draw = drawWindow(
    capped.tickets.map(protoTicketToDrawTicket),
    challenge,
    capped.weights,
  )
  return { slot, parentHash, challenge, capped, draw }
}

/**
 * The multi-node memory-transport driver (D1): N separate nodes, each
 * with its own store + adapter + identity, full-mesh dialed (bounded dial
 * retry — the mesh is formed BEFORE any block is published, forward note
 * 1), running the per-window draw-selected cadence (D2/D3), and recording
 * the per-window `SyncWindowRecord`s (D5 — the late joiner's sync source).
 */
class NetNetwork {
  readonly nodes: NetNode[] = []
  /** The per-window records, indexed by slot from slot 0 (D5). */
  readonly records: SyncWindowRecord[] = []

  /**
   * Add a node; it dials every existing node (bounded retry) → full mesh.
   * After a topology change the gossipsub MESH must form before any publish
   * (D6/AD-3): a publish made before the mesh's first heartbeat is sent only
   * to the publisher's (still-empty) mesh/fanout and is LOST — gossipsub is
   * fire-and-forget over the mesh (no ack, no retransmit of a lost data
   * message once it ages out of the mcache). `settleMesh()` is the bounded
   * yield that lets the 1 s heartbeats graft the new links, so the very next
   * `runWindow` publishes onto a warm mesh.
   */
  async addNode(
    name: string,
    seedIndex: number,
    validWindowStart: bigint = 0n,
  ): Promise<NetNode> {
    const node = await makeNode(name, seedIndex, validWindowStart)
    let dialed = false
    for (const existing of this.nodes) {
      await dialWithRetry(node.adapter, existing.listenAddress)
      dialed = true
    }
    this.nodes.push(node)
    if (dialed) await settleMesh()
    return node
  }

  /**
   * Run one window (the T1 per-window loop, D2 + D3): (a) every node
   * derives its next slot/parent from its own head + the LOCAL challenge;
   * (b) every node signs + gossips its ticket; (c) every node collects
   * own + received tickets (deduped), derives 4.5 weights, applies the
   * 4.4 cap; (d) every node runs the ONE pinned draw — the SAME winner
   * everywhere; (e) the winning node mines + applies + publishes; (f)
   * every node receives (the winner: its own block — gossipsub does not
   * self-deliver), contiguity-checks (D6), accepts (4.3), and applies
   * (non-winners, with their own threaded balances); (g) the driver
   * records the window's `SyncWindowRecord` (D5).
   */
  async runWindow(slot: bigint): Promise<WindowOutcome[]> {
    const participants = this.nodes

    // (a)–(d) in parallel across all participants.
    const contexts = await Promise.all(
      participants.map((n) => collectWindow(n, participants, slot)),
    )

    // The pinned draw is deterministic — every node picked the SAME
    // winner (D2). Locate the winner among the participants.
    const winnerId = contexts[0].draw.winnerIdentityId
    const winnerIdx = participants.findIndex(
      (n) => n.identity.keypair.identityId === winnerId,
    )
    if (winnerIdx === -1) {
      throw new Error(`driver: the draw winner ${winnerId} is not a participant`)
    }
    const winnerNode = participants[winnerIdx]
    const wctx = contexts[winnerIdx]

    // (e) the winning node mines for the draw winner and publishes to the
    // blocks topic. The winner applies its own block in (f) — AFTER its D6
    // contiguity check against its PRE-APPLY head — exactly like the
    // non-winners, so the check sees the head the block actually extends
    // (applying first would advance the head and make the winner's own
    // block look one slot short).
    const block = mineBlock({
      slot,
      parentHash: wctx.parentHash,
      winnerIdentityId: winnerId,
      winnerTicket: Ticket.encode(wctx.capped.tickets[wctx.draw.index]),
      txCount: 0n,
    })
    await publishUntilAccepted(() => winnerNode.adapter.sendBlock(block))

    // (g) the driver records the window's sync record (D5) — the winner's
    // capped set (byte-identical on every node — the deterministic order).
    this.records.push({
      block,
      acceptedTickets: wctx.capped.tickets,
      weights: wctx.capped.weights,
    })

    // (f) every node: receive, contiguity-check (D6), accept (4.3), apply
    // (non-winners). A reject (non-extending OR failed acceptance) is a
    // NORMAL stop: never applied, never a throw.
    return Promise.all(
      participants.map(async (node, i) => {
        const ctx = contexts[i]
        const isWinner = i === winnerIdx
        let receivedBlock: Block
        let receivedFromGossip = false
        let sourcePeerId: string | null = null
        if (isWinner) {
          receivedBlock = block
        } else {
          const env = await pollReceived(node, 'blocks', (e) => {
            const b = e.payload as Block
            return b.slot === slot
          })
          receivedBlock = env.payload as Block
          receivedFromGossip = true
          sourcePeerId = env.sourcePeerId
        }
        // D6 — client-side contiguity against this node's OWN head: the
        // gossip peers (not a trusted sync source) are the block source,
        // so the client checks itself before applying.
        const { slot: expectSlot, parentHash: expectParent } = await nextSlotAndParent(node.store)
        const contiguous =
          receivedBlock.slot === expectSlot && bytesEqual(receivedBlock.parentHash, expectParent)
        // 4.3 — the acceptance path over this node's gossiped-ticket set.
        const accepted = acceptBlockWinner(
          receivedBlock,
          ctx.capped.tickets,
          ctx.capped.weights,
          ctx.challenge,
        )
        // Normal stop on a reject (D6/D2): never applied, never thrown.
        // EVERY node — winner included — applies here, after its contiguity
        // check, so the check is always against the pre-apply head.
        let applied = false
        if (contiguous && accepted) {
          node.balances = await applyBlock({
            store: node.store,
            block: receivedBlock,
            balances: node.balances,
            rewardBaseUnits: REWARD_BASE_UNITS,
            mintId: MINT_ID,
          })
          applied = true
        }
        return {
          node,
          ctx,
          mined: isWinner,
          receivedFromGossip,
          sourcePeerId,
          contiguous,
          accepted,
          applied,
          block: receivedBlock,
        }
      }),
    )
  }

  /** Stop every adapter, close every store, remove every temp dir. */
  async close(): Promise<void> {
    for (const node of this.nodes) {
      await node.adapter.stop()
      await node.store.close()
      rmSync(node.dir, { recursive: true, force: true })
    }
    this.nodes.length = 0
    this.records.length = 0
  }
}

// ---------------------------------------------------------------------------
// TRACER_BLOCK_PROPAGATED (AC-1)
// ---------------------------------------------------------------------------

describe('TRACER_BLOCK_PROPAGATED (AC-1) — the draw-selected node mines; the other two receive, validate, and apply over gossip', () => {
  it('3-node memory net, 3 windows: exactly one node (the draw winner) mines per window; the other two receive via adapter.received, pass acceptBlockWinner over the gossiped-ticket accepted set, and applyBlock; each store advances by one slot per window; committed bytes byte-identical', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      const [a, b, c] = [
        await net.addNode('bp-a', 0),
        await net.addNode('bp-b', 1),
        await net.addNode('bp-c', 2),
      ]
      const windows = 3
      for (let s = 0; s < windows; s += 1) {
        const outcomes = await net.runWindow(BigInt(s))

        // D2 determinism: every node ran the SAME draw over the SAME
        // gossiped-ticket accepted set → the SAME winner everywhere.
        const winners = outcomes.map((o) => o.ctx.draw.winnerIdentityId)
        expect(new Set(winners).size).toBe(1)

        // Exactly ONE node mined — the draw winner.
        const mined = outcomes.filter((o) => o.mined)
        expect(mined).toHaveLength(1)
        const winner = mined[0]
        const winnerNode = winner.node
        expect(winner.block.winnerIdentityId).toBe(winner.ctx.draw.winnerIdentityId)

        for (const o of outcomes) {
          if (o.mined) {
            // The winner applied its own block (e) — contiguous + accepted.
            expect(o.receivedFromGossip).toBe(false)
            expect(o.contiguous).toBe(true)
            expect(o.accepted).toBe(true)
            expect(o.applied).toBe(true)
          } else {
            // The other two RECEIVED the block over the blocks topic
            // (gossip), attributed to the winner's protocol identity id…
            expect(o.receivedFromGossip).toBe(true)
            expect(o.sourcePeerId).toBe(winnerNode.identity.keypair.identityId)
            // …passed 4.3 over the SAME gossiped-ticket accepted set…
            expect(o.contiguous).toBe(true)
            expect(o.accepted).toBe(true)
            // …and applied it (AD-2).
            expect(o.applied).toBe(true)
          }
        }

        // Each store advanced by EXACTLY one slot this window.
        for (const n of net.nodes) {
          expect(await n.store.headSlot()).toBe(s)
        }
        // The committed wire bytes for this slot are byte-identical across
        // all three stores (same canonical encoding, AD-12).
        const bytes = await Promise.all(net.nodes.map((n) => n.store.getBlock(s)))
        for (const by of bytes) expect(by).not.toBeNull()
        expect(bytesEqual(bytes[0]!, bytes[1]!)).toBe(true)
        expect(bytesEqual(bytes[1]!, bytes[2]!)).toBe(true)
      }

      // Every applied slot (0..windows−1) is byte-identical across all
      // three stores.
      for (let s = 0; s < windows; s += 1) {
        const bytes = await Promise.all([a, b, c].map((n) => n.store.getBlock(s)))
        for (const by of bytes) expect(by).not.toBeNull()
        expect(bytesEqual(bytes[0]!, bytes[1]!)).toBe(true)
        expect(bytesEqual(bytes[1]!, bytes[2]!)).toBe(true)
      }
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// TRACER_CONTIGUOUS (AC-4)
// ---------------------------------------------------------------------------

describe('TRACER_CONTIGUOUS (AC-4) — client-side contiguity (D6): every applied gossiped block extends the head; a non-extending block is never applied (normal stop)', () => {
  it('every applied gossiped block passed the D6 check; the chain is contiguous from slot 0 on every node; a non-extending gossiped block (a slot jump + a wrong parentHash) is never applied and no throw escapes', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      await net.addNode('ct-a', 0)
      await net.addNode('ct-b', 1)
      await net.addNode('ct-c', 2)
      const windows = 2
      for (let s = 0; s < windows; s += 1) {
        const outcomes = await net.runWindow(BigInt(s))
        // Every applied gossiped block satisfied the D6 contiguity check
        // against the applying node's own head.
        for (const o of outcomes) {
          expect(o.contiguous).toBe(true)
          expect(o.accepted).toBe(true)
          expect(o.applied).toBe(true)
        }
      }

      // The chain is contiguous from slot 0 on every node: slot 0's
      // parent is the genesis parent (32 zeros); each slot's parentHash
      // === the previous slot's committed hash (byte-for-byte).
      const zeros = new Uint8Array(32)
      for (const n of net.nodes) {
        const b0 = Block.decode((await n.store.getBlock(0))!)
        expect(bytesEqual(b0.parentHash, zeros)).toBe(true)
        for (let s = 1; s < windows; s += 1) {
          const bs = Block.decode((await n.store.getBlock(s))!)
          const bp = Block.decode((await n.store.getBlock(s - 1))!)
          expect(bytesEqual(bs.parentHash, bp.hash)).toBe(true)
        }
      }

      // A deliberately NON-EXTENDING gossiped block is never applied — a
      // normal stop, no throw. Two variants (the plan's examples):
      const publisher = net.nodes[0]
      const headBefore = await publisher.store.headSlot()
      const headBig = BigInt(headBefore)
      const last = Block.decode((await publisher.store.getBlock(headBefore))!)
      // (1) a block for slot + 2 (a slot jump past the head).
      const slotSkip: Block = { ...last, slot: last.slot + 2n }
      // (2) slot = head + 1 but a WRONG parentHash.
      const badParent: Block = {
        ...last,
        slot: headBig + 1n,
        parentHash: new Uint8Array(32).fill(0xee),
      }
      await publishUntilAccepted(() => publisher.adapter.sendBlock(slotSkip))
      await publishUntilAccepted(() => publisher.adapter.sendBlock(badParent))

      // Every RECEIVING node checks contiguity and rejects both (normal
      // stop — never applied, no throw escapes the receive path).
      for (const n of net.nodes) {
        if (n === publisher) continue // the publisher's store is not on the receive path
        for (let i = 0; i < 2; i += 1) {
          const env = await pollReceived(n, 'blocks', (e) => {
            const blk = e.payload as Block
            return blk.slot > headBig
          })
          const blk = env.payload as Block
          const { slot: expectSlot, parentHash: expectParent } = await nextSlotAndParent(n.store)
          const contiguous = blk.slot === expectSlot && bytesEqual(blk.parentHash, expectParent)
          // Non-extending → the D6 check is FALSE → normal stop.
          expect(contiguous).toBe(false)
        }
        // The store did NOT advance.
        expect(await n.store.headSlot()).toBe(headBefore)
      }
      expect(await publisher.store.headSlot()).toBe(headBefore)
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// TRACER_LATE_JOINER (AC-2 + AC-4)
// ---------------------------------------------------------------------------

describe('TRACER_LATE_JOINER (AC-2) — a fresh node syncs to the head, then receives + validates + applies the NEXT block via gossip (not sync)', () => {
  it('D joins mid-run with an empty store, syncChain to head N, participates in window N+1 (signs + publishes its ticket), and receives + applies block N+1 via gossip; D reaches N+1 with committed bytes byte-identical to A/B/C for slots 0..N+1', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      const [a, b, c] = [
        await net.addNode('lj-a', 0),
        await net.addNode('lj-b', 1),
        await net.addNode('lj-c', 2),
      ]
      // Run A/B/C to head N−1 (2 windows → head 1).
      const preWindows = 2
      for (let s = 0; s < preWindows; s += 1) {
        const outcomes = await net.runWindow(BigInt(s))
        for (const o of outcomes) {
          expect(o.applied).toBe(true)
        }
      }
      const headN = await a.store.headSlot()
      expect(headN).toBe(preWindows - 1)

      // A source node registers the sync SOURCE (the per-window records
      // accumulated from the loop, D5) — the handler reads it lazily at
      // stream-open time.
      a.adapter.setSyncSource(buildSyncSource(net.records))

      // D: a fresh node (empty store) that dials A/B/C (bounded dial
      // retry — the mesh is formed before D publishes). D's `validWindows`
      // start at its join window (headN + 1): it has NO uptime history for
      // the windows it missed, so its 4.5 weight at window N+1 is 0 and it
      // cannot win that draw (AC-2 — D receives the next block via gossip,
      // it does not mine it). The incumbents keep weight > 0 and pick the
      // winner among themselves.
      const d = await net.addNode('lj-d', D_SEED_INDEX, BigInt(headN + 1))
      expect(await d.store.headSlot()).toBe(-1)

      // The catch-up via 5.4's syncChain (a dedicated stream — NOT gossip).
      const result = await syncChain({
        client: d.adapter,
        peer: a.listenAddress,
        store: d.store,
        rewardDisplay: REWARD_DISPLAY,
        maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
      })
      expect(result.applied).toBe(preWindows)
      expect(result.headSlot).toBe(headN)
      expect(await d.store.headSlot()).toBe(headN)

      // `applyBlock` persisted D's balance snapshot during the sync —
      // reload it (the D5 balance reload; `fromJson` is the state-decode
      // boundary).
      const doc = await d.store.loadState()
      expect(doc).not.toBeNull()
      d.balances = fromJson(doc!)

      // D PARTICIPATES in window N+1: it signs + publishes its ticket,
      // collects the gossiped set, and — as a peer — receives block N+1
      // over the blocks topic, contiguity-checks (D6), accepts (4.3), and
      // applies (AD-2). (AC-2: "via gossip (not sync)".)
      const outcomes = await net.runWindow(BigInt(headN + 1))
      const dOut = outcomes.find((o) => o.node === d)
      expect(dOut).toBeDefined()
      // D is a GOSPIP receiver in this window (the next block came over
      // the blocks topic, not the sync stream).
      expect(dOut!.mined).toBe(false)
      expect(dOut!.receivedFromGossip).toBe(true)
      expect(dOut!.sourcePeerId).toBe(
        outcomes.find((o) => o.mined)!.node.identity.keypair.identityId,
      )
      expect(dOut!.contiguous).toBe(true)
      expect(dOut!.accepted).toBe(true)
      expect(dOut!.applied).toBe(true)

      // D reached N+1 …
      expect(await d.store.headSlot()).toBe(headN + 1)
      // … and D's committed block bytes for slots 0..N+1 are
      // BYTE-IDENTICAL to A/B/C's (the sync'd prefix + the gossiped next).
      for (let s = 0; s <= headN + 1; s += 1) {
        const dBytes = await d.store.getBlock(s)
        expect(dBytes).not.toBeNull()
        for (const n of [a, b, c]) {
          expect(await n.store.getBlock(s)).not.toBeNull()
          expect(bytesEqual(dBytes!, (await n.store.getBlock(s))!)).toBe(true)
        }
      }
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// TRACER_SIGNED_TICKET_VERIFY (AC-3)
// ---------------------------------------------------------------------------

describe('TRACER_SIGNED_TICKET_VERIFY (AC-3) — the AD-12 signature gate is load-bearing over the wire', () => {
  it('a real window\'s block passes acceptBlockWinner; the same block with a corrupted (empty) 64-byte winner-ticket signature (identical public fields) fails acceptBlockWinner WHILE verifyDraw stays true', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      await net.addNode('sv-a', 0)
      await net.addNode('sv-b', 1)
      await net.addNode('sv-c', 2)
      const outcomes = await net.runWindow(0n)
      // Take the REAL window's block + its CappedSet + challenge (the
      // winner's context — byte-identical on every node).
      const winner = outcomes.find((o) => o.mined)
      expect(winner).toBeDefined()
      const block = winner!.block
      const cappedTickets = winner!.ctx.capped.tickets
      const cappedWeights = winner!.ctx.capped.weights
      const challenge = winner!.ctx.challenge

      // The real AD-12 signature → `acceptBlockWinner` = true (draw gate
      // AND signature gate — 4.3).
      expect(acceptBlockWinner(block, cappedTickets, cappedWeights, challenge)).toBe(true)

      // Corrupted: IDENTICAL public fields (`identityId`, `windowIndex`,
      // `challenge`, `nonceCommitment`) but a tampered (empty) 64-byte
      // signature.
      const decodedWinnerTicket = Ticket.decode(block.winnerTicket)
      const corrupted: Block = {
        ...block,
        winnerTicket: Ticket.encode({ ...decodedWinnerTicket, signature: EMPTY_64 }),
      }
      // The signature gate fails → `acceptBlockWinner` = false (a normal
      // reject — never a throw)…
      expect(acceptBlockWinner(corrupted, cappedTickets, cappedWeights, challenge)).toBe(false)
      // …while the DRAW gate ALONE still passes — isolating the AD-12
      // signature as exactly what makes the block peer-verifiable (the
      // 4.8/4.10 R2 precedent, now over the wire).
      expect(
        verifyDraw(corrupted, cappedTickets.map(protoTicketToDrawTicket), cappedWeights, challenge),
      ).toBe(true)
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// TRACER_ADDITIVE (AC-5)
// ---------------------------------------------------------------------------

describe('TRACER_ADDITIVE (AC-5) — TEST-ONLY, additive: imported seams only, memory transport only, bounded polls', () => {
  it('the driver composes only imported seams (no re-implementation); the network is memory-transport-only (zero real sockets); the cadence is bounded-poll driven (no wall-clock reads, no RNG in this file); the four topics are unchanged', () => {
    // The driver composes the IMPORTED seams — every one of these is the
    // ROOT BARREL export the driver calls (this file contains no local
    // re-implementation of the draw, the mining loop, the acceptance
    // path, the cap, the uptime, the commitment, or the challenge):
    const seams = [
      mineBlock,
      drawWindow,
      applyBlock,
      acceptBlockWinner,
      applyAcceptanceCap,
      computeUptimeWeight,
      signedTicket,
      deriveWindowChallenge,
      protoTicketToDrawTicket,
      deriveIdentityKeypair,
      nextSlotAndParent,
      verifyDraw,
      syncChain,
      buildSyncSource,
    ]
    for (const seam of seams) {
      expect(typeof seam).toBe('function')
    }

    // Memory transport only (AD-10 — zero real sockets in CI): `TRANSPORT`
    // is the SINGLE transport selector in this file (makeNode passes it to
    // createNetAdapter), so pinning it pins every node's transport. The
    // four end-to-end rows above are the EMPIRICAL AD-10 proof — they run
    // over the memory transport and pass.
    expect(TRANSPORT).toBe('memory')

    // Bounded polls, no wall-clock reads, no RNG in the cadence: this
    // file's own source contains no wall-clock read and no RNG call (the
    // cadence is loop iterations + bounded `sleep` yields only — the
    // 5.2/5.3 precedent).
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    expect(selfSource).not.toMatch(/Date\.now\s*\(/)
    expect(selfSource).not.toMatch(/\bMath\.random\s*\(/)

    // The four stable gossipsub topics are UNCHANGED (the 5.2 pins — a
    // topic string is a protocol constant, AD-8).
    expect(TOPICS.blocks).toBe('/succinctcoin/blocks/1')
    expect(TOPICS.tickets).toBe('/succinctcoin/tickets/1')
    expect(TOPICS.tx).toBe('/succinctcoin/tx/1')
    expect(TOPICS.peers).toBe('/succinctcoin/peers/1')
  })
})
