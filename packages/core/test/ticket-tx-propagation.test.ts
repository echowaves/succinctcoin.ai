/**
 * 5.6 — ticket + tx propagation on their own topics (epic-node-network,
 * R1/R3, AD-3/AD-5/AD-7/AD-8/AD-10/AD-12).
 *
 * The live mesh, second half of the epic's Done-when clause (2) (5.5
 * proved the block half): a ticket published on the `tickets` topic by
 * one node is RECEIVED by peers and lands in the peer's capped per-window
 * accepted set — the 4.4 cap + 4.5 weights are ORIGIN-AGNOSTIC (a `proto
 * Ticket` carries no origin field: the peer's accepted set is built purely
 * from `(identityId, nonceCommitment, signature)` + the identity's
 * validWindows, so a gossiped ticket and a local ticket are literally
 * indistinguishable data) — and the gossiped ticket is ELIGIBLE FOR THE
 * DRAW (the pinned `drawWindow` over the capped set returns one of the
 * participants). A tx published on the `tx` topic is received with its
 * DECIMAL-STRING amount/fee intact (AD-5 / R3 — byte-for-byte,
 * `typeof === 'string'`, never a float). And each class travels ONLY on
 * its own topic over the live mesh (AD-8 — the live-mesh version of 5.2's
 * self-publish isolation: real gossiped bytes, not a single-node
 * self-echo).
 *
 * The driver REUSES 5.5's proven shape (D1 — TEST-ONLY, one new file): N
 * separate in-process nodes, each with its own `FileChainStore`, its own
 * net adapter (memory transport, zero real sockets, AD-10), its own
 * identity keypair (AD-11 — driver-internal, `.secret` never read;
 * signing goes through the barrel's `signedTicket`), composing ONLY
 * root-barrel seams (never re-implementing them — AD-7: the draw is
 * imported; the challenge is derived via the imported
 * `deriveWindowChallenge`; the cap / uptime / commitment are imported).
 * A shared-driver extraction from 5.5 is 5.9's (the sweep) domain if
 * wanted — this file is self-contained. `src/`, `proto/`,
 * `package.json`, and `pnpm-lock.yaml` are untouched (AD-1 preserved —
 * the driver is not wired into `createCore`).
 *
 * The pinned window (5.6 does NOT run the slot loop: no block is mined or
 * applied, so the window is a fixed chain-time point, not a store head):
 * `SLOT = 3n` + `GENESIS_PARENT` (32 zeros, AD-12) → every node derives
 * the SAME challenge LOCALLY (never wire-trusted — the 5.5 D3
 * discipline) via the imported `deriveWindowChallenge`. A non-zero slot
 * gives every identity a non-trivial 4.5 weight (3n — valid tickets over
 * windows [0,1,2] of the L=50 lookback), so the weight assertions are not
 * the ramp-from-zero degenerate case.
 *
 * Receive = a bounded poll (5.5 D4, AD-3): the adapter exposes no
 * per-topic callback; the driver tracks a per-topic read cursor
 * (`pollReceived`, single-target-safe) and — for the multi-target ticket
 * collection — ONE bounded collect-all loop over the FULL accumulated
 * `tickets` list (deduped by identityId, keep-first — the 5.5 F1-safe
 * pattern: an out-of-order arrival is never skipped the way a per-target
 * shared cursor could). The cadence is driven by loop iterations +
 * bounded yields — never a wall-clock read, never an RNG call.
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest` + node
 * builtins `node:fs` / `node:os` / `node:path` / `node:url`) — no deep
 * imports, no transitive-dependency imports (AD-10).
 *
 * Rows (plan Matrix):
 *   TICKET_INTO_ACCEPTED_SET  (AC-1) 3-node memory mesh: each node
 *                                publishes its window-S ticket on the
 *                                tickets topic; node B collects own +
 *                                gossiped (F1-safe collect-all),
 *                                identity-sorts, applies 4.5 weights +
 *                                the 4.4 cap → the capped set holds
 *                                exactly {A, B, C}, the gossiped A
 *                                ticket present with its
 *                                local-equivalent weight (origin-
 *                                agnostic) and draw-eligible
 *                                (`drawWindow` over the capped set ∈
 *                                {A, B, C}); a synthetic {localA,
 *                                gossipedA, B} raw set (same identityId,
 *                                different commitments) collapses to 2
 *                                (keep-first) — the cap is origin-
 *                                agnostic.
 *   TX_DECIMAL_STRING         (AC-2) a proto Tx with a 30-digit
 *                                decimal-string amount publishes on the
 *                                tx topic; the receiver's copy has
 *                                amount/fee byte-for-byte (`typeof ===
 *                                'string'`), sender/recipient
 *                                byte-identical, slot preserved (AD-5 /
 *                                R3 — no float ever touched the amount).
 *   TOPIC_ISOLATION           (AC-3) a block on blocks, a ticket on
 *                                tickets, a tx on tx: each peer receives
 *                                ONLY its own class on its own topic
 *                                (exact per-topic counts over the live
 *                                mesh — AD-8).
 *   ADDITIVE                  (AC-4) root-barrel-only imports (+ vitest +
 *                                node builtins); memory transport only
 *                                (zero real sockets, AD-10); bounded
 *                                polls (no `Date.now` / `Math.random` in
 *                                this file's cadence); the four topics
 *                                pinned; `src` / `proto` / deps untouched
 *                                (the git-diff gates run externally).
 *
 * AD-3 discipline: no wall-clock reads, no RNG — pinned 32-byte identity
 * seeds (`seedFor(i)` = 32 bytes of `0x40 + i`, the 4.8 convention) →
 * `deriveIdentityKeypair` (IMPORTED); every challenge =
 * `deriveWindowChallenge` (IMPORTED, derived locally — never wire-
 * trusted); every commitment = the 4.2 `signedTicket` pinned sha256 of
 * public data; every signature = deterministic Ed25519 (the AD-12 digest
 * via `signedTicket`).
 * AD-5 discipline: the tx's amount/fee are DECIMAL STRINGS (the 30-digit
 * amount is beyond float64's precision — a float would lose digits; the
 * byte-for-byte string equality at the receiver is the proof no float
 * ever touched it).
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
  Tx,
  applyAcceptanceCap,
  computeUptimeWeight,
  createNetAdapter,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  drawWindow,
  fromDisplay,
  fromJson,
  loadGenesis,
  protoTicketToDrawTicket,
  signedTicket,
} from '../src/index.js'
import type {
  BalanceMap,
  MultiSimIdentity,
  NetAdapter,
  ReceivedEnvelope,
  TopicClass,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned parameters (5.6 — deterministic, AD-3)
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

/** The closed-system treasury seed (shape parity with 5.5's makeNode). */
const MAX_SUPPLY_DISPLAY = '21000000'

/** The transport flag (AD-10 — zero real sockets in CI). */
const TRANSPORT = 'memory' as const

/**
 * The pinned window under test: 5.6 does not run the slot loop (no block
 * is mined or applied), so the window is a FIXED chain-time point — a
 * non-zero slot, so every identity's 4.5 weight is non-trivial (3n — its
 * valid tickets over windows [0,1,2] of the L=50 lookback), not the
 * ramp-from-zero degenerate case.
 */
const SLOT = 3n

/**
 * The window's parent hash: with no block committed, every node pins the
 * genesis parent (32 zeros, AD-12) — the SAME parent on every node makes
 * the locally-derived challenge the same on every node (the 5.5 D3
 * discipline: derived locally, never wire-trusted).
 */
const GENESIS_PARENT = new Uint8Array(32)

/** The pinned window challenge — derived LOCALLY by every node (imported seam). */
const WINDOW_CHALLENGE = deriveWindowChallenge(GENESIS_PARENT, SLOT)

/**
 * A 30-digit decimal amount (AD-5 / R3): beyond float64's ~15–17
 * significant digits — if a float ever touched it, digits would be lost
 * and the receiver's string could not equal the published one byte-for-
 * byte. The byte-for-byte equality at the receiver IS the no-float proof.
 */
const TX_AMOUNT = '123456789012345678901234567890'
const TX_FEE = '1234567'

/** A tx with DECIMAL-STRING amount/fee (AD-5 — never int64/float). */
const FIX_TX: Tx = {
  sender: new Uint8Array(32).fill(0x5a),
  recipient: new Uint8Array(32).fill(0x6b),
  amount: TX_AMOUNT,
  fee: TX_FEE,
  slot: SLOT,
  signature: new Uint8Array(64).fill(0x77),
}

/** Bounded test-side waits (the 5.2/5.3/5.5 pattern — bounded yields, not clock reads). */
const SLEEP_MS = 25
const MAX_POLLS = 400 // 400 × 25 ms — up to 10 s per bounded poll
const DIAL_POLLS = 40 // 40 × 25 ms — the established dial-retry bound (5.2)
/**
 * Mesh-settle bound (5.5 D6/AD-3): gossipsub's heartbeat interval is
 * 1000 ms (100 ms initial delay); the mesh is grafted and the fanout is
 * maintained on those heartbeats. A publish made before the first
 * post-dial heartbeat is lost (fire-and-forget over an empty mesh), so
 * after a dial-topology change we yield ~3 heartbeats before the next
 * publish. 120 × 25 ms = 3000 ms.
 */
const MESH_SETTLE_POLLS = 120

/** The max window count any row runs — sizes the identities' `validWindows`. */
const MAX_WINDOWS = 8

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
// helpers (the 5.2/5.4/5.5 bounded-wait pattern — test-side, never in src)
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
 * Run `op` until it resolves (bounded retry — the 5.2/5.5
 * `publishUntilAccepted` pattern). The first publish on a class topic can
 * race gossipsub's mesh / heartbeat handshake: until the publisher knows
 * of a SUBSCRIBED peer, `publish` rejects. The retry is test-side waiting
 * — the adapter's send methods stay single-shot (the
 * `allowPublishToZeroTopicPeers` decision stays DEFERRED — forward note 1:
 * the mesh is formed FIRST, here, via the bounded dial retry below).
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
 * Dial with the established bounded retry (40 × 25 ms — the 5.2/5.4/5.5
 * pattern) so the gossip mesh is formed BEFORE anything is published:
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
 * Bounded mesh-settle (5.5 D6/AD-3): after a dial-topology change, yield
 * ~3 gossipsub heartbeats so the mesh grafts the new links BEFORE the next
 * publish. A pure bounded yield (loop iterations + `setTimeout`) — never a
 * wall-clock read, never an RNG call. Rationale: a gossipsub publish made
 * before the mesh forms is delivered only to the publisher's (still-empty)
 * mesh/fanout and is LOST (no ack, and a lost data message is not
 * retransmitted once it ages out of the 3-heartbeat mcache), so the driver
 * warms the mesh explicitly instead of relying on the first publish to do
 * it.
 */
async function settleMesh(): Promise<void> {
  for (let i = 0; i < MESH_SETTLE_POLLS; i += 1) {
    await sleep(SLEEP_MS)
  }
}

// ---------------------------------------------------------------------------
// the multi-node memory-transport driver (5.5's proven shape, D1)
// ---------------------------------------------------------------------------

/**
 * One networked node (5.5 D1): its own `FileChainStore` (a fresh temp
 * dir), its own net adapter (memory transport, listening on
 * `/memory/<name>`, stamped with the node's 4.2 PROTOCOL identity id),
 * its own identity keypair (AD-11 driver-internal value — `.secret` is
 * never read here; signing goes through the barrel's `signedTicket`), its
 * threaded `BalanceMap` (shape parity with 5.5's driver — 5.6 proves
 * propagation, not application, so the balances are threaded but not
 * advanced), and the per-topic read cursors over `adapter.received` (D4).
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

/**
 * The bounded poll helper (5.5 D4, AD-3): tracks a per-topic read cursor
 * over `adapter.received.get(topic)`, yielding a bounded `pollMs` between
 * iterations, resolving the FIRST entry matching `predicate` (consuming
 * it — the cursor advances past it), or failing after `maxPolls`. Bounded
 * = event-based (loop iterations + bounded yields), never a wall-clock
 * read; exhaustion is a test-infrastructure liveness failure (the mesh
 * did not deliver in time). SINGLE-TARGET-safe: the cursor is only safe
 * when ONE predicate consumes the topic — the multi-target ticket
 * collection uses the collect-all loop in `collectGossipedTickets`
 * instead (the 5.5 F1 fix).
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
 * Build one node (the 5.5 node factory, identical shape): a fresh
 * `FileChainStore` in its own `mkdtempSync` dir, a memory-transport
 * adapter listening on `/memory/<name>` stamped with the node's 4.2
 * protocol identity id, `start()`ed, with balances seeded from the store
 * snapshot (absent → the pre-funded `MINT_ID` treasury, the 3.2/4.8
 * closed-system seed).
 */
async function makeNode(
  name: string,
  seedIndex: number,
  validWindowStart: bigint = 0n,
): Promise<NetNode> {
  const dir = mkdtempSync(join(tmpdir(), `succinctcoin-ttp-${name}-`))
  const store = new FileChainStore(dir)
  await store.open()
  const keypair = deriveIdentityKeypair(seedFor(seedIndex))
  const identity: MultiSimIdentity = {
    keypair,
    attestedUntilWindow: 100000n,
    // A deterministic range (4.8 convention) covering every window this
    // driver can run — the 4.5 weight input (ramp from zero, moving
    // lookback — the 4.5 behavior, identical on every node).
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
 * The 5.5 F1-safe collect-all (T1): publish this node's OWN window-S
 * ticket (4.2 `signedTicket` — the pinned per-(identity, slot, parent)
 * commitment + the AD-12 signature), then ONE bounded loop over the FULL
 * ACCUMULATED `tickets` list until every OTHER participant's ticket for
 * that window is present (deduped by identityId, keep-first — robust
 * whether or not gossipsub self-delivers, AND to any delivery order: the
 * loop matches against the full accumulated list, so an out-of-order
 * arrival can never be skipped the way a per-target shared cursor could).
 * Bounded (≤ MAX_POLLS) — exhaustion is a liveness failure (the mesh did
 * not deliver in time). Returns the raw collected set (own + gossiped,
 * deduped) — the CALLER identity-sorts, derives the 4.5 weights, and
 * applies the 4.4 cap (the AC-1 set construction).
 */
async function collectGossipedTickets(
  node: NetNode,
  participants: ReadonlyArray<NetNode>,
  slot: bigint,
): Promise<Ticket[]> {
  const own = signedTicket(node.identity.keypair, slot, GENESIS_PARENT, WINDOW_CHALLENGE)
  await publishUntilAccepted(() => node.adapter.sendTicket(own))

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
  return tickets
}

/**
 * Bounded wait until all three payload classes (a block, a ticket, a tx)
 * have arrived at `node` (the TOPIC_ISOLATION row's liveness gate) —
 * throws on bound exhaustion (the mesh did not deliver in time).
 */
async function waitAllClasses(node: NetNode): Promise<void> {
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const nb = node.adapter.received.get('blocks')?.length ?? 0
    const nt = node.adapter.received.get('tickets')?.length ?? 0
    const nx = node.adapter.received.get('tx')?.length ?? 0
    if (nb >= 1 && nt >= 1 && nx >= 1) return
    await sleep(SLEEP_MS)
  }
  throw new Error(
    `driver: ${node.name} — not all three classes (block/ticket/tx) arrived ` +
      `within ${MAX_POLLS} bounded polls (the mesh did not deliver in time)`,
  )
}

/**
 * The multi-node memory-transport driver (5.5 D1): N separate nodes, each
 * with its own store + adapter + identity, full-mesh dialed (bounded dial
 * retry — the mesh is formed BEFORE anything is published, forward note
 * 1). 5.6 has no `runWindow` (no mining / no `applyBlock`) — the rows
 * publish on the class topics and read `adapter.received` directly.
 */
class NetNetwork {
  readonly nodes: NetNode[] = []

  /**
   * Add a node; it dials every existing node (bounded retry) → full mesh.
   * After a topology change the gossipsub MESH must form before any publish
   * (5.5 D6/AD-3): a publish made before the mesh's first heartbeat is
   * sent only to the publisher's (still-empty) mesh/fanout and is LOST —
   * gossipsub is fire-and-forget over the mesh (no ack, no retransmit of
   * a lost data message once it ages out of the mcache). `settleMesh()`
   * is the bounded yield that lets the 1 s heartbeats graft the new links,
   * so the very next publish lands on a warm mesh.
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

  /** Stop every adapter, close every store, remove every temp dir. */
  async close(): Promise<void> {
    for (const node of this.nodes) {
      await node.adapter.stop()
      await node.store.close()
      rmSync(node.dir, { recursive: true, force: true })
    }
    this.nodes.length = 0
  }
}

// ---------------------------------------------------------------------------
// TICKET_INTO_ACCEPTED_SET (AC-1)
// ---------------------------------------------------------------------------

describe('TICKET_INTO_ACCEPTED_SET (AC-1) — a gossiped ticket lands in the peer\'s capped accepted set: origin-agnostic weight + draw-eligible', () => {
  it('3-node memory mesh: each node publishes its window-S ticket on the tickets topic; node B collects own + gossiped (F1-safe collect-all), identity-sorts, applies 4.5 weights + the 4.4 cap → capped set holds exactly {A, B, C}, the gossiped A ticket present with its local-equivalent weight and draw-eligible; a synthetic {localA, gossipedA, B} set collapses to 2 (keep-first)', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      const [a, b, c] = [
        await net.addNode('tia-a', 0),
        await net.addNode('tia-b', 1),
        await net.addNode('tia-c', 2),
      ]
      const nodes = [a, b, c]
      const aId = a.identity.keypair.identityId
      const bId = b.identity.keypair.identityId
      const cId = c.identity.keypair.identityId

      // Every node signs + gossips its OWN window-S ticket and collects
      // the full set (own + gossiped, deduped by identityId, keep-first) —
      // the 5.5 F1-safe collect-all, in parallel across all participants.
      const collected = await Promise.all(
        nodes.map((n) => collectGossipedTickets(n, nodes, SLOT)),
      )

      // Node B's view (the AC's receiver): identity-sort for a
      // DETERMINISTIC order, derive each ticket's 4.5 weight from its
      // identity's validWindows (the driver knows them all), apply the
      // 4.4 cap (a no-op on an all-distinct set — the shape is what the
      // wire path requires).
      const bTickets = collected[1]
      expect(bTickets).toHaveLength(3)
      expect(bTickets.map((t) => t.identityId).sort()).toEqual([aId, bId, cId].sort())
      const sorted = [...bTickets].sort((x, y) =>
        x.identityId < y.identityId ? -1 : x.identityId > y.identityId ? 1 : 0,
      )
      const weights = sorted.map((t) =>
        computeUptimeWeight(validWindowsFor(nodes, t.identityId), SLOT, L),
      )
      const capped = applyAcceptanceCap({ tickets: sorted, weights })

      // B's capped set holds EXACTLY {A, B, C} — one ticket per identity.
      expect(capped.tickets).toHaveLength(3)
      expect(capped.tickets.map((t) => t.identityId).sort()).toEqual([aId, bId, cId].sort())

      // The GOSPISED A ticket (received over the tickets topic — not
      // local to B): it is in B's capped set, BYTE-IDENTICAL to the
      // ticket A published (the pinned 4.2 commitment — recomputed
      // locally from public data: same seed → same keypair → same
      // signature)…
      const aCapped = capped.tickets.find((t) => t.identityId === aId)
      expect(aCapped).toBeDefined()
      const aLocal = signedTicket(a.identity.keypair, SLOT, GENESIS_PARENT, WINDOW_CHALLENGE)
      expect(aCapped!.windowIndex).toBe(SLOT)
      expect(bytesEqual(aCapped!.challenge, aLocal.challenge)).toBe(true)
      expect(bytesEqual(aCapped!.nonceCommitment, aLocal.nonceCommitment)).toBe(true)
      expect(bytesEqual(aCapped!.signature, aLocal.signature)).toBe(true)
      // …and it came OVER THE WIRE, stamped with A's protocol identity id
      // (the envelope's sourcePeerId — AD-12 / 5.2 D3):
      const aWire = (b.adapter.received.get('tickets') ?? []).find(
        (e) => (e.payload as Ticket).identityId === aId,
      )
      expect(aWire).toBeDefined()
      expect(aWire!.sourcePeerId).toBe(aId)
      // …with the SAME weight the identity would get from a LOCALLY-mined
      // ticket: `computeUptimeWeight(A.validWindows, SLOT, L)` — the
      // origin-agnostic 4.5 (the set is keyed by identityId + validWindows,
      // never by where the ticket came from).
      const aIdx = capped.tickets.indexOf(aCapped!)
      const aWeight = computeUptimeWeight(a.identity.validWindows, SLOT, L)
      expect(aWeight).toBe(3n) // non-trivial: valid over windows [0,1,2] of the L=50 lookback
      expect(capped.weights[aIdx]).toBe(aWeight)
      // …and the SAME weight as B's own (LOCAL) ticket in the same set:
      const bIdx = capped.tickets.indexOf(capped.tickets.find((t) => t.identityId === bId)!)
      expect(capped.weights[aIdx]).toBe(capped.weights[bIdx])

      // Draw-eligible: the ONE pinned draw (AD-7 — imported, never
      // re-implemented) over B's capped set returns one of the three
      // participants…
      const draw = drawWindow(
        capped.tickets.map(protoTicketToDrawTicket),
        WINDOW_CHALLENGE,
        capped.weights,
      )
      expect(nodes.some((n) => n.identity.keypair.identityId === draw.winnerIdentityId)).toBe(true)
      expect(draw.uptime).toBe(capped.weights[draw.index])

      // Sub-assertion (the ORIGIN-AGNOSTIC cap): a direct
      // `applyAcceptanceCap` on a synthetic RAW set holding a "local" A
      // ticket and a "gossiped" A ticket (same identityId, DIFFERENT
      // commitments — the real attack shape: one identity, multiple
      // tickets in a window) + B's ticket collapses to 2 — keep-first
      // keeps the localA (the first occurrence, input order):
      const localA = signedTicket(a.identity.keypair, SLOT, GENESIS_PARENT, WINDOW_CHALLENGE, 0n)
      const gossipedA = signedTicket(a.identity.keypair, SLOT, GENESIS_PARENT, WINDOW_CHALLENGE, 1n)
      expect(bytesEqual(localA.nonceCommitment, gossipedA.nonceCommitment)).toBe(false)
      const bTicket = bTickets.find((t) => t.identityId === bId)!
      const raw = applyAcceptanceCap({
        tickets: [localA, gossipedA, bTicket],
        weights: [
          computeUptimeWeight(a.identity.validWindows, SLOT, L),
          computeUptimeWeight(a.identity.validWindows, SLOT, L),
          computeUptimeWeight(b.identity.validWindows, SLOT, L),
        ],
      })
      expect(raw.tickets).toHaveLength(2)
      expect(raw.tickets[0]).toBe(localA) // keep-first (the cap is a pure filter — same reference)
      expect(raw.tickets[0].identityId).toBe(aId)
      expect(raw.tickets[1].identityId).toBe(bId)
      expect(raw.weights[0]).toBe(aWeight)
      expect(raw.weights[1]).toBe(computeUptimeWeight(b.identity.validWindows, SLOT, L))
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// TX_DECIMAL_STRING (AC-2)
// ---------------------------------------------------------------------------

describe('TX_DECIMAL_STRING (AC-2) — a gossiped tx keeps its decimal-string amount/fee byte-for-byte (AD-5 / R3)', () => {
  it('node A publishes a proto Tx on the tx topic with a 30-digit decimal-string amount; node B receives it with amount/fee the exact published strings (typeof === string, byte-for-byte), sender/recipient byte-identical, and slot preserved', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      const a = await net.addNode('txd-a', 0)
      const b = await net.addNode('txd-b', 1)

      // A publishes the tx on the `tx` topic (the envelope carries A's
      // protocol identity id as sourcePeerId — 5.2 D3).
      await publishUntilAccepted(() => a.adapter.sendTx(FIX_TX))

      // B receives it on the `tx` topic (bounded poll, single-target).
      const env = await pollReceived(b, 'tx', (e) => {
        const t = e.payload as Tx
        return t.slot === SLOT && t.amount === TX_AMOUNT
      })
      expect(env.sourcePeerId).toBe(a.identity.keypair.identityId)

      const t = env.payload as Tx
      // AD-5 / R3 — the decimal strings INTACT, byte-for-byte (a float
      // ever touching the 30-digit amount would lose digits and this
      // string equality could not hold):
      expect(typeof t.amount).toBe('string')
      expect(t.amount).toBe(TX_AMOUNT)
      expect(typeof t.fee).toBe('string')
      expect(t.fee).toBe(TX_FEE)
      // sender/recipient byte-identical, slot preserved:
      expect(t.sender.byteLength).toBe(32)
      expect(bytesEqual(t.sender, FIX_TX.sender)).toBe(true)
      expect(t.recipient.byteLength).toBe(32)
      expect(bytesEqual(t.recipient, FIX_TX.recipient)).toBe(true)
      expect(t.slot).toBe(SLOT)
      // The 64-byte signature survived the wire unchanged:
      expect(t.signature.byteLength).toBe(64)
      expect(bytesEqual(t.signature, FIX_TX.signature)).toBe(true)
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// TOPIC_ISOLATION (AC-3)
// ---------------------------------------------------------------------------

describe('TOPIC_ISOLATION (AC-3) — each class travels ONLY on its own topic over the live mesh (AD-8)', () => {
  it('a block on blocks, a ticket on tickets, a tx on tx: each peer\'s received list holds EXACTLY its own class per topic (one block, one ticket, one tx — a leaked class would bump a count)', { timeout: 90_000 }, async () => {
    const net = new NetNetwork()
    try {
      const a = await net.addNode('tis-a', 0)
      const b = await net.addNode('tis-b', 1)
      const c = await net.addNode('tis-c', 2)
      const aId = a.identity.keypair.identityId

      // Three well-formed payloads, one per class (the block is a pinned
      // fixture — the row is about TOPICS, not mining; the ticket and the
      // tx are the real 4.2-signed ticket and the AD-5 decimal-string tx):
      const block: Block = {
        slot: SLOT,
        parentHash: GENESIS_PARENT,
        winnerIdentityId: aId,
        winnerTicket: new Uint8Array(64).fill(0x11),
        nonce: new Uint8Array(32).fill(0x02),
        hash: new Uint8Array(32).fill(0x99),
        txCount: 0n,
      }
      const ticket = signedTicket(a.identity.keypair, SLOT, GENESIS_PARENT, WINDOW_CHALLENGE)
      await publishUntilAccepted(() => a.adapter.sendBlock(block))
      await publishUntilAccepted(() => a.adapter.sendTicket(ticket))
      await publishUntilAccepted(() => a.adapter.sendTx(FIX_TX))

      // Each PEER (B and C — the publisher's own self-echo is out of
      // scope for isolation) receives all three classes…
      for (const peer of [b, c]) {
        await waitAllClasses(peer)
        // …and the EXACT per-topic counts are 1/1/1: the peer got one
        // block, one ticket, one tx — NOTHING else (a block leaked onto
        // the tickets topic — or any cross-class leak — would bump a
        // count to 2):
        const blocksList = peer.adapter.received.get('blocks') ?? []
        const ticketsList = peer.adapter.received.get('tickets') ?? []
        const txsList = peer.adapter.received.get('tx') ?? []
        expect(blocksList).toHaveLength(1)
        expect(ticketsList).toHaveLength(1)
        expect(txsList).toHaveLength(1)

        // The blocks topic holds ONLY the block (no ticket/tx envelope):
        const blk = blocksList[0].payload as Block
        expect(blk.slot).toBe(SLOT)
        expect(blk.winnerIdentityId).toBe(aId)
        expect(bytesEqual(blk.hash, block.hash)).toBe(true)
        expect(blocksList[0].sourcePeerId).toBe(aId)
        // The tickets topic holds ONLY the ticket:
        const tk = ticketsList[0].payload as Ticket
        expect(tk.identityId).toBe(aId)
        expect(tk.windowIndex).toBe(SLOT)
        expect(bytesEqual(tk.nonceCommitment, ticket.nonceCommitment)).toBe(true)
        expect(bytesEqual(tk.signature, ticket.signature)).toBe(true)
        expect(ticketsList[0].sourcePeerId).toBe(aId)
        // The tx topic holds ONLY the tx (decimal strings intact, AD-5):
        const tx = txsList[0].payload as Tx
        expect(tx.amount).toBe(TX_AMOUNT)
        expect(tx.fee).toBe(TX_FEE)
        expect(tx.slot).toBe(SLOT)
        expect(bytesEqual(tx.sender, FIX_TX.sender)).toBe(true)
        expect(bytesEqual(tx.recipient, FIX_TX.recipient)).toBe(true)
        expect(txsList[0].sourcePeerId).toBe(aId)
      }
    } finally {
      await net.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ADDITIVE (AC-4)
// ---------------------------------------------------------------------------

describe('ADDITIVE (AC-4) — TEST-ONLY: root-barrel-only imports, memory transport only, bounded polls, the four topics pinned', () => {
  it('the driver composes only root-barrel seams (+ vitest + node builtins); the mesh is memory-transport-only (zero real sockets); the cadence is bounded-poll driven (no Date.now / Math.random in this file); the four class topics are pinned; no new deps', () => {
    // The driver composes the IMPORTED seams — every one of these is the
    // ROOT BARREL export the driver calls (this file contains no local
    // re-implementation of the draw, the acceptance cap, the uptime
    // weight, the commitment, or the challenge):
    const seams = [
      signedTicket,
      deriveWindowChallenge,
      computeUptimeWeight,
      applyAcceptanceCap,
      drawWindow,
      protoTicketToDrawTicket,
      deriveIdentityKeypair,
      createNetAdapter,
      loadGenesis,
    ]
    for (const seam of seams) {
      expect(typeof seam).toBe('function')
    }
    // The proto payload codecs (the value side of the type+value exports):
    expect(typeof Block.encode).toBe('function')
    expect(typeof Ticket.encode).toBe('function')
    expect(typeof Tx.encode).toBe('function')

    // Memory transport only (AD-10 — zero real sockets in CI): `TRANSPORT`
    // is the SINGLE transport selector in this file (makeNode passes it to
    // createNetAdapter), so pinning it pins every node's transport. The
    // three end-to-end rows above are the EMPIRICAL AD-10 proof — they run
    // over the memory transport and pass.
    expect(TRANSPORT).toBe('memory')

    // This file's own source:
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Root-barrel-only imports: every `../src/` import specifier in this
    // file is the root barrel `../src/index.js` (no deep imports into
    // src/net, src/proto, src/consensus, …):
    const srcImports = [...selfSource.matchAll(/from\s+['"](\.\.\/src\/[^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    expect(srcImports.length).toBeGreaterThan(0)
    expect([...new Set(srcImports)]).toEqual(['../src/index.js'])
    // Bounded polls, no wall-clock reads, no RNG in the cadence (AD-3):
    expect(selfSource).not.toMatch(/Date\.now\s*\(/)
    expect(selfSource).not.toMatch(/\bMath\.random\s*\(/)

    // The four stable gossipsub topics are UNCHANGED (the 5.2 pins — a
    // topic string is a protocol constant, AD-8):
    expect(TOPICS.blocks).toBe('/succinctcoin/blocks/1')
    expect(TOPICS.tickets).toBe('/succinctcoin/tickets/1')
    expect(TOPICS.tx).toBe('/succinctcoin/tx/1')
    expect(TOPICS.peers).toBe('/succinctcoin/peers/1')
  })
})
