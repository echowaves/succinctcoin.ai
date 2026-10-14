/**
 * 5.10 (CLOSING) — end-to-end suite (full Done-when): a NATed node
 * discovers, syncs, and gossips through a relay (epic-node-network / CAP-3).
 *
 * The integration proof the whole epic has been building toward: ALL FIVE
 * Done-when hold green together in ONE integrated, headless, memory-
 * transport scenario — a relay (relayRole 'relay') + a NATed node
 * (relayRole 'client', NO direct listen) + two direct nodes A and B
 * (k = 2). TEST-ONLY (the 3.9/4.10/5.8 precedent): the ONLY new file is
 * this one; `src/`, `proto/`, `package.json`, and `pnpm-lock.yaml` are
 * untouched. It COMPOSES the already-built epic-5 seams (the 5.1
 * `createNetAdapter`, the 5.2 per-class topics + proto envelopes, the 5.4
 * `syncChain` / `buildSyncSource`, the 5.5 block-propagation window
 * protocol, the 5.6 ticket/tx own-topic propagation, the 5.7
 * circuit-relay-v2 relay wiring) together with the epic-3/4 seams (the 3.3
 * slot loop / `drawWindow`, the 4.2 `signTicket`, the 4.3
 * `acceptBlockWinner`, the 4.4/4.5 cap/weights, the `applyBlock` ledger) —
 * ALL imported from the ROOT barrel `../src/index.js`, NEVER
 * re-implementing any of them (AD-2 / AD-7). Zero real sockets (AD-10).
 *
 * The integrated topology (ONE per row — the 4.10 per-row isolation;
 * `beforeEach` builds, `afterEach` tears down):
 *   relay — relayRole 'relay', listens on /memory/e5relay. NO store, no
 *           draw participation (a pure relay — nothing requires it to hold
 *           a chain).
 *   NATed — relayRole 'client', relayAddress /memory/e5relay, placeholder
 *           listen the adapter IGNORES (client → addresses.listen = [], no
 *           direct inbound). Has a FileChainStore + participates in the
 *           draw/mining.
 *   A     — relayRole 'none', listens on /memory/e5a. Has a FileChainStore.
 *   B     — relayRole 'none', listens on /memory/e5b. Has a FileChainStore.
 *
 * Wiring (the explicit-dial model — the adapter never auto-dials; the 5.5
 * addNode full-mesh + the 5.7 RelayTopology relay-wiring composition):
 *   1. start the relay;
 *   2. NATed dials the relay FIRST (the outbound "through the NAT" path —
 *      the adapter registers the circuit reservation on that dial,
 *      fire-and-forget) and ALSO dials A and B directly (outbound
 *      /memory/e5a, /memory/e5b) so it can sync + gossip (a node behind
 *      NAT can still dial out);
 *   3. A dials the relay directly (the hop reuses it), THEN dials NATed's
 *      proxied multiaddr /p2p/<relayId>/p2p-circuit/p2p/<natedId> (the 5.7
 *      PEER-ID-ONLY form — a /memory-prefixed relay dial is REJECTED) with
 *      a WIDER poll budget (the first attempts race the reservation) —
 *      this gives NATed an INBOUND connection via the relay (the
 *      NAT-traversal path, DW3);
 *   4. B does the same as A;
 *   5. settleMesh() (bounded yield, ~3 gossipsub heartbeats) before any
 *      publish.
 * Result: NATed has outbound links to A, B, and the relay; A and B each
 * reach NATed THROUGH THE RELAY (the proxied dial) — the realistic NAT
 * topology. The proxied multiaddr is built ONLY from the two peers'
 * peerId() strings (AD-8 / 5.7).
 *
 * Rows (one per Done-when — the plan's "five Done-when → rows" table):
 *   E2E5_R1_NATED_DISCOVER_SYNC_GOSSIP_K  Done-when #1 (R2): (a)
 *                                         DISCOVERS — a bounded poll over
 *                                         NATed's peers() sees BOTH A and B
 *                                         (k = 2, through the relay);
 *                                         (b) syncs — A mines one window
 *                                         (its store advances past
 *                                         genesis) and NATed, still at
 *                                         genesis, syncChain's to A's head
 *                                         (the synced prefix is
 *                                         byte-identical); (c) gossips a
 *                                         test block to k peers — NATed
 *                                         authors a test block on top of
 *                                         its synced head and sendBlock's
 *                                         it; it lands at BOTH A and B on
 *                                         the blocks topic. The whole row
 *                                         is event-bounded (AD-3) over the
 *                                         memory transport.
 *   E2E5_R2_BLOCK_TICKET_TX_OWN_TOPICS    Done-when #2 (R1, AD-8): ONE
 *                                         topic per message class,
 *                                         end-to-end over the live relay
 *                                         mesh: A (the window winner)'s
 *                                         block on the blocks topic, A's
 *                                         REAL signed ticket (signTicket
 *                                         over deriveWindowChallenge) on
 *                                         the tickets topic, a proto Tx
 *                                         (decimal-string amount, AD-5) on
 *                                         the tx topic — each at NATed AND
 *                                         B (k = 2), each on ITS OWN topic
 *                                         (exact 1/1/1 per-topic counts).
 *   E2E5_R3_RELAY_CONNECTS_NATED          Done-when #3 (E1): the
 *                                         circuit-relay-v2 adapter
 *                                         connects the NATed node THROUGH
 *                                         THE RELAY — NATed (client role,
 *                                         no direct listen) is seen by A
 *                                         and B (the proxied dial) and by
 *                                         the relay (the reservation
 *                                         link); a direct dial of NATed's
 *                                         placeholder address FAILS (the
 *                                         proxied multiaddr is the ONLY
 *                                         path to it).
 *   E2E5_R4_DHT_DECISION_NO_DHT           Done-when #4 (E2): the
 *                                         DHT-threshold spike's
 *                                         recommendation is recorded in
 *                                         the epic Notes (the dated
 *                                         2026-10-13 Decision — "do NOT
 *                                         wire Kad-DHT at launch"),
 *                                         package.json has NO
 *                                         @libp2p/kad-dht (dependencies +
 *                                         devDependencies), and a
 *                                         comment-stripped scan of src/**
 *                                         finds NO @libp2p/kad-dht import.
 *                                         The no-DHT non-goal holds.
 *   E2E5_R5_MEMORY_HEADLESS_ZERO_SOCKETS  Done-when #5 (AD-10): the module
 *                                         pins the single transport
 *                                         selector (memory); a self-source
 *                                         scan asserts no wall-clock
 *                                         reads, no RNG, root-barrel-only
 *                                         imports, no transitive-
 *                                         dependency imports; the four
 *                                         topics + the sync stream id are
 *                                         pinned. The relay rows passing
 *                                         headless IS the empirical
 *                                         zero-sockets proof (the 5.x
 *                                         ADDITIVE/NO_DHT_WIRED guard
 *                                         pattern).
 *
 * AD-3 discipline: NO wall clock, NO RNG — every wait is a BOUNDED POLL
 * (a loop of bounded iterations + a bounded setTimeout yield — a liveness
 * bound (loop iterations), NOT a timestamp read); "bounded time" is a
 * count of received messages + a bounded poll budget. Every identity is a
 * pinned seed (seedFor(i) = 32 bytes of 0x40+i, the 4.8 convention)
 * through the imported deriveIdentityKeypair; every ticket commitment is a
 * pinned 32-byte value; every challenge is the imported
 * deriveWindowChallenge (derived locally — never wire-trusted); the draw
 * is the imported drawWindow (AD-7 — never re-implemented).
 * AD-5 discipline: NO big.js, NO float — the one-time display → base-unit
 * conversion goes through the barrel's fromDisplay (computed ONCE); money
 * moves as exact BigInt / decimal strings, compared by exact byte
 * equality.
 * AD-11 discipline: the keypair is a driver-internal value; this file
 * NEVER reads its secret — signing goes through the barrel's signTicket
 * (the 4.2 single reader).
 *
 * Imports: the ROOT BARREL ../src/index.js only (+ vitest + node builtins
 * node:fs / node:os / node:path / node:url) — no deep imports, no
 * transitive-dependency imports (AD-10).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  SYNC_PROTOCOL,
  TOPICS,
  Ticket,
  Tx,
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
  signTicket,
  syncChain,
  verifyTicketSignature,
} from '../src/index.js'
import type {
  BalanceMap,
  CappedSet,
  DrawResult,
  IdentityKeypair,
  MultiSimIdentity,
  NetAdapter,
  ReceivedEnvelope,
  SyncWindowRecord,
  TopicClass,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned parameters (5.10 — deterministic, AD-3)
// ---------------------------------------------------------------------------

/** The transport flag (AD-10 — zero real sockets in CI). */
const TRANSPORT = 'memory' as const

/** Paths resolved relative to THIS test file (test dir → core → packages → repo root). */
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const GENESIS_PATH = join(TEST_DIR, '..', '..', '..', 'config', 'genesis.json')

/** L = the lookback (genesis uptimeLookbackL) — the 4.5 weight input. */
const GENESIS = await loadGenesis(GENESIS_PATH)
const L = BigInt(GENESIS.uptimeLookbackL) // 50 (chain-time windows)
expect(L).toBe(50n) // a genesis change is a protocol change

/** Fixed-emission display params (the genesis emission carries them). */
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'

/** The one-time display → base-unit conversion (AD-5 boundary, computed ONCE). */
const REWARD_BASE_UNITS = fromDisplay(REWARD_DISPLAY)

/** The integrated topology's pinned addresses (the 5.7 fixed-address convention). */
const RELAY_ADDRESS = '/memory/e5relay'
/** The NATed node's PLACEHOLDER listen — IGNORED by the adapter for the client role. */
const NATED_PLACEHOLDER = '/memory/e5nated'
const A_LISTEN = '/memory/e5a'
const B_LISTEN = '/memory/e5b'

/** Pinned identity seed indices (distinct, the 4.8 convention). */
const RELAY_SEED_INDEX = 0
const NATED_SEED_INDEX = 1
const A_SEED_INDEX = 2
const B_SEED_INDEX = 3

/** The R4/R5 scan paths (resolved relative to this test file). */
const REPO_ROOT = join(TEST_DIR, '..', '..', '..')
const CORE_DIR = join(TEST_DIR, '..')
const EPIC_DOC_PATH = join(
  REPO_ROOT,
  '_bmad-output',
  'initiative-succinctcoin-ai',
  'epic-node-network',
  'epic-node-network.md',
)
const PKG_PATH = join(CORE_DIR, 'package.json')
const SRC_DIR = join(CORE_DIR, 'src')

/** Bounded test-side waits (the 5.2/5.3/5.5/5.6/5.7 pattern — bounded yields, not clock reads). */
const SLEEP_MS = 25
const MAX_POLLS = 400 // 400 × 25 ms — up to 10 s per bounded poll
const DIAL_POLLS = 40 // 40 × 25 ms — the established dial-retry bound (5.2)
/**
 * Hop-dial bound (5.7): the relay-proxied dial retries until the NATed
 * node's circuit reservation EXISTS. The adapter registers the
 * reservation fire-and-forget right after the operator dials the relay,
 * so the first hop-dial attempts can race it (the relay answers
 * NO_RESERVATION until it exists). 120 × 25 ms = 3 s.
 */
const HOP_DIAL_POLLS = 120
/**
 * Mesh-settle bound (5.5 D6/AD-3): gossipsub's heartbeat interval is
 * 1000 ms; the mesh is grafted on those heartbeats. A publish made before
 * the first post-dial heartbeat is lost (fire-and-forget over an empty
 * mesh), so after a dial-topology change we yield ~3 heartbeats before the
 * next publish. 120 × 25 ms = 3000 ms.
 */
const MESH_SETTLE_POLLS = 120

/** The max window count any row runs — sizes the identities' `validWindows`. */
const MAX_WINDOWS = 8

/**
 * The R2 tx fixture: a 30-digit decimal-string amount (AD-5 / R3) — beyond
 * float64's ~15–17 significant digits; the byte-for-byte string equality
 * at the receiver is the proof no float ever touched it (the 5.6 pin).
 */
const TX_AMOUNT = '123456789012345678901234567890'
const TX_FEE = '1234567'
const FIX_TX: Tx = {
  sender: new Uint8Array(32).fill(0x5a),
  recipient: new Uint8Array(32).fill(0x6b),
  amount: TX_AMOUNT,
  fee: TX_FEE,
  slot: 0n,
  signature: new Uint8Array(64).fill(0x77),
}

/**
 * Pinned identity seeds (4.8 convention, no RNG): a 32-byte value filled
 * with 0x40 + i. deriveIdentityKeypair (IMPORTED) maps each seed
 * deterministically to a keypair (same seed → same keypair, so the whole
 * fixture is reproducible — AD-3/AD-10).
 */
function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

// ---------------------------------------------------------------------------
// helpers (the 5.2/5.4/5.5/5.6/5.7 bounded-wait pattern — test-side glue,
// never in src; the protocol seams themselves are all imported)
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
 * Run op until it resolves (bounded retry — the 5.2/5.5
 * publishUntilAccepted pattern). The first publish on a class topic can
 * race gossipsub's mesh / heartbeat handshake: until the publisher knows
 * of a SUBSCRIBED peer, publish rejects. The retry is test-side waiting —
 * the adapter's send methods stay single-shot.
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
 * Dial with the established bounded retry (the 5.2/5.4/5.5/5.6/5.7
 * pattern) so the mesh is formed BEFORE anything is published: the memory
 * transport rejects a dial to an unknown listener until the target has
 * started listening. polls overrides the bound (the hop dial needs the
 * wider HOP_DIAL_POLLS — see its comment).
 */
async function dialWithRetry(
  dialer: NetAdapter,
  address: string,
  polls: number = DIAL_POLLS,
): Promise<void> {
  let lastErr: unknown = null
  for (let i = 0; i < polls; i += 1) {
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
 * publish. A pure bounded yield (loop iterations + setTimeout) — never a
 * wall-clock read, never an RNG call.
 */
async function settleMesh(): Promise<void> {
  for (let i = 0; i < MESH_SETTLE_POLLS; i += 1) {
    await sleep(SLEEP_MS)
  }
}

/**
 * The bounded poll helper (5.5 D4, AD-3): tracks a per-topic read cursor
 * over adapter.received.get(topic), yielding a bounded SLEEP_MS between
 * iterations, resolving the FIRST entry matching predicate (consuming it —
 * the cursor advances past it), or failing after maxPolls. Bounded =
 * event-based (loop iterations + bounded yields), never a wall-clock read;
 * exhaustion is a test-infrastructure liveness failure (the mesh did not
 * deliver in time). SINGLE-TARGET-safe (one predicate consumes the topic).
 */
async function pollReceived(
  node: RelayNode,
  topic: TopicClass,
  predicate: (env: ReceivedEnvelope) => boolean,
  opts: { maxPolls?: number } = {},
): Promise<ReceivedEnvelope> {
  const maxPolls = opts.maxPolls ?? MAX_POLLS
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const list = node.adapter.received.get(topic) ?? []
    const cursor = node.cursors.get(topic) ?? 0
    for (let i = cursor; i < list.length; i += 1) {
      if (predicate(list[i])) {
        node.cursors.set(topic, i + 1)
        return list[i]
      }
    }
    await sleep(SLEEP_MS)
  }
  throw new Error(
    `driver: ${node.name} — no ${topic} envelope matched within ${maxPolls} bounded ` +
      `polls (the bounded liveness window was exhausted — the mesh did not deliver in time)`,
  )
}

/**
 * Bounded poll of adapter.peers() until it INCLUDES every expected peer
 * id (the 5.8 pollPeerCount pattern generalized to a membership set —
 * absorbs async peer-store updates after the last dial). Event-bounded
 * (loop iterations + bounded yields) — AD-3.
 */
async function pollPeers(
  node: RelayNode,
  expected: string[],
  maxPolls: number = MAX_POLLS,
): Promise<string[]> {
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const peers = await node.adapter.peers()
    if (expected.every((p) => peers.includes(p))) return peers
    await sleep(SLEEP_MS)
  }
  throw new Error(
    `driver: ${node.name} — peers() did not include [${expected.join(', ')}] within ` +
      `${maxPolls} bounded polls (the bounded liveness window was exhausted)`,
  )
}

/**
 * Bounded wait until all three payload classes (a block, a ticket, a tx)
 * have arrived at node (the R2 per-topic isolation liveness gate — the
 * 5.6 waitAllClasses pattern) — throws on bound exhaustion.
 */
async function waitAllClasses(node: RelayNode): Promise<void> {
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
 * The relay-proxied multiaddr (5.7 D4 — built explicitly, NOT discovered):
 * /p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>. The PEER-ID-ONLY form
 * (a /memory-prefixed relay dial is REJECTED — the circuit transport's dial
 * filter exact-matches a bare /p2p/<relayId> relay prefix and NEVER a
 * /memory/... one). Built ONLY from the two peers' peerId() strings.
 */
function relayProxiedMultiaddr(relayPeerId: string, natedPeerId: string): string {
  return `/p2p/${relayPeerId}/p2p-circuit/p2p/${natedPeerId}`
}

// ---------------------------------------------------------------------------
// the integrated relay-topology driver (the 5.5/5.6/5.7 multi-node shape,
// D1 — TEST-ONLY; composes only imported seams)
// ---------------------------------------------------------------------------

/** One role's wiring as the driver passed it to createNetAdapter. */
interface NodeConfig {
  relayRole: 'none' | 'relay' | 'client'
  relayAddress?: string
  listenAddress: string
}

/**
 * One networked node (the 5.5/5.7 driver shape): its own net adapter
 * (memory transport, stamped with the node's 4.2 PROTOCOL identity id) +
 * its own identity keypair (AD-11 driver-internal value — its secret is
 * never read here; signing goes through the barrel's signTicket) + the
 * per-topic read cursors over adapter.received (5.5 D4). The relay variant
 * holds NO store and no draw identity (a pure relay).
 */
interface RelayNode {
  name: string
  keypair: IdentityKeypair
  adapter: NetAdapter
  config: NodeConfig
  cursors: Map<TopicClass, number>
}

/**
 * A chain node: the relay-node shape + its own FileChainStore (a fresh
 * temp dir), its draw identity (the 4.5 valid-window history), and its
 * threaded BalanceMap (AD-2: mutated only via applyBlock's return).
 */
interface ChainNode extends RelayNode {
  identity: MultiSimIdentity
  store: FileChainStore
  dir: string
  balances: BalanceMap
}

/**
 * Build the relay node (the 5.7 node factory, relay role): a started
 * createNetAdapter over the memory transport listening on the relay
 * address. NO store, no draw participation — a pure relay.
 */
async function makeRelayNode(
  name: string,
  seedIndex: number,
  listenAddress: string,
): Promise<RelayNode> {
  const keypair = deriveIdentityKeypair(seedFor(seedIndex))
  const adapter = createNetAdapter({
    transport: TRANSPORT,
    listenAddress,
    protocolIdentityId: keypair.identityId,
    mdns: false,
    relayRole: 'relay',
  })
  await adapter.start()
  return {
    name,
    keypair,
    adapter,
    config: { relayRole: 'relay', listenAddress },
    cursors: new Map<TopicClass, number>(),
  }
}

/**
 * Build one chain node (the 5.5 node factory, relay-aware): a fresh
 * FileChainStore in its own mkdtempSync dir, a memory-transport adapter
 * stamped with the node's 4.2 protocol identity id (relayRole /
 * relayAddress threaded), start()ed, with balances seeded from the store
 * snapshot (absent → the pre-funded MINT_ID treasury, the 3.2/4.8
 * closed-system seed).
 */
async function makeChainNode(
  name: string,
  seedIndex: number,
  config: NodeConfig,
): Promise<ChainNode> {
  const dir = mkdtempSync(join(tmpdir(), `succinctcoin-e5-${name}-`))
  const store = new FileChainStore(dir)
  await store.open()
  const keypair = deriveIdentityKeypair(seedFor(seedIndex))
  const identity: MultiSimIdentity = {
    keypair,
    attestedUntilWindow: 100000n,
    // A deterministic range (4.8 convention) covering every window this
    // suite can run — the 4.5 weight input (ramp from zero, moving
    // lookback — the 4.5 behavior, identical on every node).
    validWindows: Array.from({ length: MAX_WINDOWS }, (_, w) => BigInt(w)),
  }
  const adapter = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: config.listenAddress,
    protocolIdentityId: keypair.identityId,
    mdns: false,
    relayRole: config.relayRole,
    relayAddress: config.relayAddress,
  })
  await adapter.start()
  const doc = await store.loadState()
  const balances: BalanceMap =
    doc === null
      ? new Map<string, bigint>([[MINT_ID, fromDisplay(MAX_SUPPLY_DISPLAY)]])
      : fromJson(doc)
  return {
    name,
    keypair,
    identity,
    adapter,
    store,
    dir,
    config,
    balances,
    cursors: new Map<TopicClass, number>(),
  }
}

/**
 * The integrated relay topology (the 5.5 full-mesh + the 5.7
 * RelayTopology composition, ONE per row): the RELAY node (relayRole
 * 'relay', direct listen RELAY_ADDRESS, no store), the NATed node
 * (relayRole 'client', relayAddress RELAY_ADDRESS, NO direct listen — the
 * placeholder listen is ignored by the adapter), and the two DIRECT nodes
 * A and B (relayRole 'none'). The operator drives EVERY connection (the
 * explicit-dial model, 5.1 — the adapter never auto-dials).
 */
class E2ETopology {
  readonly relay: RelayNode
  readonly nated: ChainNode
  readonly a: ChainNode
  readonly b: ChainNode

  private constructor(relay: RelayNode, nated: ChainNode, a: ChainNode, b: ChainNode) {
    this.relay = relay
    this.nated = nated
    this.a = a
    this.b = b
  }

  static async build(): Promise<E2ETopology> {
    const relay = await makeRelayNode('relay', RELAY_SEED_INDEX, RELAY_ADDRESS)
    const nated = await makeChainNode('nated', NATED_SEED_INDEX, {
      relayRole: 'client',
      relayAddress: RELAY_ADDRESS,
      listenAddress: NATED_PLACEHOLDER,
    })
    const a = await makeChainNode('a', A_SEED_INDEX, {
      relayRole: 'none',
      listenAddress: A_LISTEN,
    })
    const b = await makeChainNode('b', B_SEED_INDEX, {
      relayRole: 'none',
      listenAddress: B_LISTEN,
    })

    // 1 — the NATed node's outbound dials: the relay FIRST (the "through
    //     the NAT" path — the adapter registers the circuit reservation on
    //     that dial, fire-and-forget), then A and B DIRECTLY (a node behind
    //     NAT can still dial out — it can sync + gossip).
    await dialWithRetry(nated.adapter, RELAY_ADDRESS)
    await dialWithRetry(nated.adapter, A_LISTEN)
    await dialWithRetry(nated.adapter, B_LISTEN)
    // 2 — A dials the relay directly (the hop reuses it), THEN dials
    //     NATed's proxied multiaddr with the WIDER hop budget (the first
    //     attempts race the reservation — NO_RESERVATION until it lands).
    //     This gives NATed an INBOUND connection via the relay (the
    //     NAT-traversal path, DW3).
    await dialWithRetry(a.adapter, RELAY_ADDRESS)
    await dialWithRetry(
      a.adapter,
      relayProxiedMultiaddr(relay.adapter.peerId(), nated.adapter.peerId()),
      HOP_DIAL_POLLS,
    )
    // 3 — B does the same as A (dials the relay + NATed's proxied
    //     multiaddr).
    await dialWithRetry(b.adapter, RELAY_ADDRESS)
    await dialWithRetry(
      b.adapter,
      relayProxiedMultiaddr(relay.adapter.peerId(), nated.adapter.peerId()),
      HOP_DIAL_POLLS,
    )
    // 4 — settle the mesh (~3 gossipsub heartbeats) BEFORE any publish
    //     (5.5 D6 — a publish on a cold mesh is lost).
    await settleMesh()
    return new E2ETopology(relay, nated, a, b)
  }

  /** Stop every adapter, close every store, remove every temp dir. */
  async close(): Promise<void> {
    for (const n of [this.relay, this.nated, this.a, this.b]) {
      await n.adapter.stop()
    }
    for (const n of [this.nated, this.a, this.b]) {
      await n.store.close()
      rmSync(n.dir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// the window protocol (composed from the imported seams — the 5.5
// runWindow window loop, miner form; the seams are NEVER re-implemented)
// ---------------------------------------------------------------------------

/** One window's composed outcome (the draw input set, the winner, the block). */
interface WindowRun {
  slot: bigint
  parentHash: Uint8Array<ArrayBuffer>
  challenge: Uint8Array
  /** The miner's own signed window ticket (4.2, AD-12). */
  ticket: Ticket
  /** The capped accepted set (4.4) the draw ran over. */
  capped: CappedSet
  /** The ONE pinned draw's result (AD-7). */
  draw: DrawResult
  /** The mined block (pow-checked + hashed by the imported mineBlock). */
  block: Block
  /** The 5.4 per-window sync record (the winner's capped set + weights). */
  record: SyncWindowRecord
}

/**
 * One window's SIGNED ticket (4.2): a pinned 32-byte nonce commitment
 * (AD-3 — a deterministic public-data commitment, the 5.6 convention) +
 * the imported signTicket over the EXACT AD-12 digest
 * (sha256 of identityId, u64be windowIndex, challenge, nonceCommitment).
 * The keypair's secret is never read here — signTicket is the single
 * reader (AD-11).
 */
function signWindowTicket(keypair: IdentityKeypair, slot: bigint, challenge: Uint8Array): Ticket {
  const nonceCommitment = new Uint8Array(32).fill(0x5a)
  const signature = signTicket(keypair, { windowIndex: slot, challenge, nonceCommitment })
  // The proto Ticket types its byte fields as Uint8Array<ArrayBuffer>; the
  // seams above declare the wider Uint8Array. These are plain byte COPIES
  // into fresh ArrayBuffers (deterministic — same bytes, AD-3/AD-5 clean):
  return {
    identityId: keypair.identityId,
    windowIndex: slot,
    challenge: new Uint8Array(challenge),
    nonceCommitment,
    signature: new Uint8Array(signature),
  }
}

/** The driver knows every identity's validWindows (the 4.5 weight input). */
function validWindowsFor(
  participants: ReadonlyArray<ChainNode>,
  identityId: string,
): ReadonlyArray<bigint> {
  const p = participants.find((n) => n.identity.keypair.identityId === identityId)
  if (p === undefined) {
    throw new Error(`driver: unknown identity ${identityId} in the accepted set`)
  }
  return p.identity.validWindows
}

/**
 * Run ONE window, composed from the imported seams (the 5.5 runWindow
 * window protocol, miner form): (a) the next slot + parent from the
 * miner's OWN store head (the 3.3 slot loop, AD-3 chain time); (b) the
 * window challenge derived LOCALLY (never wire-trusted — the 5.5 D3
 * discipline); (c) the miner signs its window ticket (4.2 signTicket —
 * the AD-12 digest) and gossips it on the tickets topic; (d) the accepted
 * set = own + the gossiped tickets of the other eligible participants (the
 * 5.5 F1-safe collect-all — ONE bounded loop over the full accumulated
 * list, deduped by identityId), identityId-sorted for a DETERMINISTIC
 * cross-node order, the 4.5 uptime weight per ticket, the 4.4 acceptance
 * cap, and the ONE pinned draw (AD-7 — imported, never re-implemented);
 * (e) the miner mines for the draw winner (the imported mineBlock) and
 * publishes on the blocks topic. Returns the window's SyncWindowRecord
 * (the 5.4 sync-source input — the winner's capped set + weights,
 * byte-identical on every in-sync node).
 */
async function mineWindow(miner: ChainNode, participants: ChainNode[]): Promise<WindowRun> {
  // (a) the next slot + parent from this node's persisted head (AD-3).
  const { slot, parentHash } = await nextSlotAndParent(miner.store)
  // (b) the window's challenge — derived LOCALLY from this node's own head
  //     (never trusted from the wire).
  const challenge = deriveWindowChallenge(parentHash, slot)
  // (c) sign this node's window ticket (4.2) and gossip it to the tickets
  //     topic.
  const own = signWindowTicket(miner.identity.keypair, slot, challenge)
  await publishUntilAccepted(() => miner.adapter.sendTicket(own))
  // (d) collect OWN + RECEIVED tickets for this slot in ONE bounded loop
  //     until every other eligible participant's ticket is in (deduped by
  //     identityId — robust whether or not gossipsub self-delivers, and to
  //     any delivery order: a single loop matching against the full
  //     accumulated list).
  const tickets: Ticket[] = [own]
  const seen = new Set<string>([own.identityId])
  const expectedIds = new Set(
    participants.filter((p) => p !== miner).map((p) => p.identity.keypair.identityId),
  )
  for (let attempt = 0; attempt < MAX_POLLS && seen.size < participants.length; attempt += 1) {
    for (const env of miner.adapter.received.get('tickets') ?? []) {
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
      `driver: ${miner.name} — no tickets for [${missing.join(', ')}] within ${MAX_POLLS} ` +
        `bounded polls (the mesh did not deliver in time)`,
    )
  }
  // A DETERMINISTIC cross-node order (identityId-sorted): every node builds
  // the SAME accepted set (same membership, same order), so the capped set
  // + weights + draw input are byte-identical on every node.
  tickets.sort((x, y) => (x.identityId < y.identityId ? -1 : x.identityId > y.identityId ? 1 : 0))
  // 4.5 — each ticket's uptime weight from its identity's valid-window
  //     history (the driver knows every identity's validWindows).
  const weights = tickets.map((t) =>
    computeUptimeWeight(validWindowsFor(participants, t.identityId), slot, L),
  )
  // 4.4 — the acceptance cap (keep-first, at most one ticket per identity)
  //     UPSTREAM of the draw (a no-op for one ticket per identity; the
  //     wire-path shape).
  const capped = applyAcceptanceCap({ tickets, weights })
  // The ONE pinned draw (AD-7 — imported, never re-implemented) picks the
  // winner from the capped set.
  const draw = drawWindow(
    capped.tickets.map(protoTicketToDrawTicket),
    challenge,
    capped.weights,
  )
  // (e) the miner mines for the draw winner and publishes to the blocks
  //     topic.
  const block = mineBlock({
    slot,
    parentHash,
    winnerIdentityId: draw.winnerIdentityId,
    winnerTicket: Ticket.encode(capped.tickets[draw.index]),
    txCount: 0n,
  })
  await publishUntilAccepted(() => miner.adapter.sendBlock(block))
  // The driver records the window's sync record (5.4 D5 — the winner's
  // capped set, byte-identical on every in-sync node).
  const record: SyncWindowRecord = {
    block,
    acceptedTickets: capped.tickets,
    weights: capped.weights,
  }
  return { slot, parentHash, challenge, ticket: own, capped, draw, block, record }
}

/**
 * The miner applies its OWN block (the 5.5 winner path): the D6
 * contiguity check against the node's own pre-apply head, the 4.3
 * acceptance path (acceptBlockWinner — the draw gate + the AD-12
 * signature gate, imported), and the single mutation path (applyBlock,
 * AD-2). A driver-invariant failure (a non-contiguous block, or the
 * acceptance path rejecting the miner's own block) is a test-
 * infrastructure error — a loud throw, never a silent skip.
 */
async function applyOwnBlock(node: ChainNode, run: WindowRun): Promise<void> {
  const { slot: expectSlot, parentHash: expectParent } = await nextSlotAndParent(node.store)
  const contiguous =
    run.block.slot === expectSlot && bytesEqual(run.block.parentHash, expectParent)
  if (!contiguous) {
    throw new Error(
      `driver: ${node.name} — own block is not contiguous against its pre-apply head ` +
        `(a driver invariant, not a protocol reject)`,
    )
  }
  const accepted = acceptBlockWinner(run.block, run.capped.tickets, run.capped.weights, run.challenge)
  if (!accepted) {
    throw new Error(
      `driver: ${node.name} — own block failed acceptBlockWinner (a driver invariant)`,
    )
  }
  node.balances = await applyBlock({
    store: node.store,
    block: run.block,
    balances: node.balances,
    rewardBaseUnits: REWARD_BASE_UNITS,
    mintId: MINT_ID,
  })
}

// ---------------------------------------------------------------------------
// source-scan helpers (the 4.1 GATE_NO_BLOB_LEAK / 4.7 / 4.10 pattern,
// verbatim — test-side, never in src)
// ---------------------------------------------------------------------------

/** Recursively collect every .ts file under dir. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Remove block and line comments (both preserved as blank lines so line
 * structure is intact). Safe for this codebase because no string or
 * template literal contains a comment marker (the 4.10 verified claim).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** dir-relative path with / separators (stable for assertion messages). */
function rel(dir: string, p: string): string {
  return p.slice(dir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// the relay-topology rows (R1–R3) — ONE integrated headless memory-
// transport scenario per row (the 4.10 per-row isolation): beforeEach
// builds the topology (3 stores + 4 adapters + the explicit-dial wiring +
// the mesh settle); afterEach tears it all down (stop the adapters, close
// the stores, remove the temp dirs).
// ---------------------------------------------------------------------------

describe('EPIC 5 CLOSING END-TO-END — full Done-when (5.10) — relay topology rows (R1–R3)', () => {
  let topo: E2ETopology | null = null

  beforeEach(async () => {
    topo = await E2ETopology.build()
  })
  afterEach(async () => {
    if (topo !== null) {
      const t = topo
      topo = null
      await t.close()
    }
  })

  function requireTopo(): E2ETopology {
    if (topo === null) throw new Error('driver: topology is not built (beforeEach did not run)')
    return topo
  }

  // -------------------------------------------------------------------------
  // E2E5_R1_NATED_DISCOVER_SYNC_GOSSIP_K (Done-when #1, R2)
  // -------------------------------------------------------------------------
  it('E2E5_R1_NATED_DISCOVER_SYNC_GOSSIP_K: discovers k=2 (NATed peers() include BOTH A and B, through the relay); A mines one window (its store advances past genesis); NATed — still at genesis — syncChain to A (head reaches A, prefix byte-identical); NATed authors a test block on top of its synced head and sendBlock — it lands at BOTH A and B (k=2, gossiped over the live relay mesh)', async () => {
    const t = requireTopo()
    const { nated, a } = t
    const aPeerId = a.adapter.peerId()
    const bPeerId = t.b.adapter.peerId()

    // (a) DISCOVER — k=2: NATed's peer store sees BOTH direct peers
    //     (bounded poll — the connections are live from the wiring; the
    //     poll absorbs async peer-store updates).
    await pollPeers(nated, [aPeerId, bPeerId])

    // (b) SYNC — A mines one window over A's own store (A is the only
    //     eligible participant for this window — the draw is the imported
    //     pinned seam over A's accepted set); A applies its own block
    //     (contiguity + the 4.3 acceptance path) — A's store advances
    //     past genesis:
    const run = await mineWindow(a, [a])
    expect(run.slot).toBe(0n)
    expect(run.draw.winnerIdentityId).toBe(a.identity.keypair.identityId)
    await applyOwnBlock(a, run)
    expect(await a.store.headSlot()).toBe(0)
    // A registers the sync SOURCE (the per-window record, indexed by slot
    // from slot 0 — the 5.4 server factory, imported) before NATed's pull:
    a.adapter.setSyncSource(buildSyncSource([run.record]))

    // NATed — still at genesis — pulls the catch-up via the imported
    // syncChain over its live link to A (a dedicated stream, NOT gossip;
    // the seam derives each challenge locally, runs 4.3, and applies
    // through the single mutation path):
    expect(await nated.store.headSlot()).toBe(-1)
    const result = await syncChain({
      client: nated.adapter,
      peer: A_LISTEN,
      store: nated.store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    expect(result.applied).toBe(1)
    expect(result.headSlot).toBe(0)
    // NATed's head slot REACHED A's (bounded — the sync is done):
    expect(await nated.store.headSlot()).toBe(await a.store.headSlot())
    // The synced prefix is BYTE-IDENTICAL (the same canonical encoding,
    // AD-12 — exact byte comparison, AD-5):
    const natedB0 = await nated.store.getBlock(0)
    const aB0 = await a.store.getBlock(0)
    expect(natedB0).not.toBeNull()
    expect(aB0).not.toBeNull()
    expect(bytesEqual(natedB0!, aB0!)).toBe(true)
    // The sync persisted NATed's balance snapshot — reload it (the 5.5 D5
    // balance reload; fromJson is the state-decode boundary):
    const doc = await nated.store.loadState()
    expect(doc).not.toBeNull()
    nated.balances = fromJson(doc!)

    // (c) GOSSIP — NATed authors a test block on top of its synced head
    //     (composing the window protocol on the imported seams: the slot
    //     loop, the local challenge, the signed ticket, the 4.5 weight,
    //     the 4.4 cap, the pinned draw, mineBlock) and sendBlock's it —
    //     the block lands at BOTH A and B (k=2) on the blocks topic:
    const testRun = await mineWindow(nated, [nated])
    expect(testRun.slot).toBe(1n)
    expect(testRun.draw.winnerIdentityId).toBe(nated.identity.keypair.identityId)
    await applyOwnBlock(nated, testRun)
    expect(await nated.store.headSlot()).toBe(1)

    const envA = await pollReceived(a, 'blocks', (e) => (e.payload as Block).slot === 1n)
    const envB = await pollReceived(t.b, 'blocks', (e) => (e.payload as Block).slot === 1n)
    // The envelopes are stamped with NATed's 4.2 PROTOCOL identity id
    // (5.2 D3 — the sourcePeerId, NOT the transport peer id, AD-11):
    expect(envA.sourcePeerId).toBe(nated.identity.keypair.identityId)
    expect(envB.sourcePeerId).toBe(nated.identity.keypair.identityId)
    // And the payload is the published block, intact over the wire —
    // byte-identical canonical encoding at all k peers (the 5.5 invariant):
    expect(bytesEqual(Block.encode(envA.payload as Block), Block.encode(testRun.block))).toBe(true)
    expect(bytesEqual(Block.encode(envB.payload as Block), Block.encode(testRun.block))).toBe(true)
  }, 90_000)

  // -------------------------------------------------------------------------
  // E2E5_R2_BLOCK_TICKET_TX_OWN_TOPICS (Done-when #2, R1, AD-8)
  // -------------------------------------------------------------------------
  it('E2E5_R2_BLOCK_TICKET_TX_OWN_TOPICS: A (the window winner) sendBlock — the block at NATed AND B on the blocks topic; A’s REAL signed ticket (signTicket over deriveWindowChallenge) at NATed AND B on the tickets topic; A sendTx (a proto Tx, decimal-string amount) at NATed AND B on the tx topic — each class on ITS OWN topic, exact 1/1/1 per-topic counts (AD-8, over the live relay mesh)', async () => {
    const t = requireTopo()
    const { nated, a, b } = t
    const aId = a.identity.keypair.identityId

    // A (the window winner) runs window 0: it signs + gossips its REAL
    // signed ticket (signTicket over the locally derived challenge — the
    // 4.2 AD-12 digest), draws (A is the only eligible participant — A
    // wins), mines, and sendBlock's the block. A applies its own block
    // (the window is real, not a fixture):
    const run = await mineWindow(a, [a])
    expect(run.slot).toBe(0n)
    expect(run.draw.winnerIdentityId).toBe(aId)
    await applyOwnBlock(a, run)
    expect(await a.store.headSlot()).toBe(0)

    // The block lands at NATed AND B (k=2) on the BLOCKS topic (AD-8 —
    // the block class's OWN topic, over the live relay mesh):
    const blkNated = await pollReceived(nated, 'blocks', (e) => (e.payload as Block).slot === 0n)
    const blkB = await pollReceived(b, 'blocks', (e) => (e.payload as Block).slot === 0n)
    expect(blkNated.sourcePeerId).toBe(aId)
    expect(blkB.sourcePeerId).toBe(aId)
    expect(bytesEqual(Block.encode(blkNated.payload as Block), Block.encode(run.block))).toBe(true)
    expect(bytesEqual(Block.encode(blkB.payload as Block), Block.encode(run.block))).toBe(true)

    // A's REAL signed ticket (gossipped in the window step) lands at
    // NATed AND B on the TICKETS topic:
    const tkNated = await pollReceived(
      nated,
      'tickets',
      (e) => (e.payload as Ticket).windowIndex === 0n,
    )
    const tkB = await pollReceived(b, 'tickets', (e) => (e.payload as Ticket).windowIndex === 0n)
    expect(tkNated.sourcePeerId).toBe(aId)
    expect(tkB.sourcePeerId).toBe(aId)
    const tk = tkNated.payload as Ticket
    expect(tk.identityId).toBe(aId)
    expect(tk.windowIndex).toBe(0n)
    // The payload is the published ticket, intact over the wire (byte-
    // identical signature / challenge / commitment):
    expect(bytesEqual(tk.signature, run.ticket.signature)).toBe(true)
    expect(bytesEqual(tk.challenge, run.challenge)).toBe(true)
    expect(bytesEqual(tk.nonceCommitment, run.ticket.nonceCommitment)).toBe(true)
    // And the ticket is REAL — its signature verifies from PUBLIC data
    // alone (the 4.2 verifyTicketSignature seam, imported — the AD-12
    // signature is load-bearing over the wire):
    expect(
      verifyTicketSignature(
        aId,
        { windowIndex: tk.windowIndex, challenge: tk.challenge, nonceCommitment: tk.nonceCommitment },
        tk.signature,
      ),
    ).toBe(true)

    // A sendTx's a proto Tx (the 30-digit decimal-string amount, AD-5) —
    // it lands at NATed AND B on the TX topic:
    await publishUntilAccepted(() => a.adapter.sendTx(FIX_TX))
    const txNated = await pollReceived(
      nated,
      'tx',
      (e) => (e.payload as Tx).amount === TX_AMOUNT,
    )
    const txB = await pollReceived(b, 'tx', (e) => (e.payload as Tx).amount === TX_AMOUNT)
    expect(txNated.sourcePeerId).toBe(aId)
    expect(txB.sourcePeerId).toBe(aId)
    const tx = txNated.payload as Tx
    // AD-5 / R3 — the decimal strings INTACT, byte-for-byte (a float ever
    // touching the 30-digit amount would lose digits and this equality
    // could not hold):
    expect(typeof tx.amount).toBe('string')
    expect(tx.amount).toBe(TX_AMOUNT)
    expect(tx.fee).toBe(TX_FEE)
    expect(bytesEqual(tx.sender, FIX_TX.sender)).toBe(true)
    expect(bytesEqual(tx.recipient, FIX_TX.recipient)).toBe(true)
    expect(bytesEqual(tx.signature, FIX_TX.signature)).toBe(true)
    expect(bytesEqual(Tx.encode(tx), Tx.encode(FIX_TX))).toBe(true)

    // AD-8 — each class on ITS OWN topic: at each peer the EXACT per-topic
    // counts are 1/1/1 (one block, one ticket, one tx — a leaked class
    // would bump a count to 2):
    for (const peer of [nated, b]) {
      await waitAllClasses(peer)
      const blocksList = peer.adapter.received.get('blocks') ?? []
      const ticketsList = peer.adapter.received.get('tickets') ?? []
      const txsList = peer.adapter.received.get('tx') ?? []
      expect(blocksList).toHaveLength(1)
      expect(ticketsList).toHaveLength(1)
      expect(txsList).toHaveLength(1)
    }
  }, 90_000)

  // -------------------------------------------------------------------------
  // E2E5_R3_RELAY_CONNECTS_NATED (Done-when #3, E1)
  // -------------------------------------------------------------------------
  it('E2E5_R3_RELAY_CONNECTS_NATED: the circuit-relay-v2 adapter connects the NATed node THROUGH THE RELAY — a bounded poll confirms NATed’s peers() include A and B, the relay’s peers() include the NATed node (the reservation link), A and B each reached NATed via the proxied multiaddr; NATed is relayRole client with no direct listen (a direct dial of its placeholder address FAILS — the proxied multiaddr is the ONLY path)', async () => {
    const t = requireTopo()
    const { relay, nated, a, b } = t
    const natedPeerId = nated.adapter.peerId()
    const aPeerId = a.adapter.peerId()
    const bPeerId = b.adapter.peerId()

    // (a) NATed sees BOTH direct peers — k=2 discovery over the live relay
    //     mesh (bounded poll):
    await pollPeers(nated, [aPeerId, bPeerId])
    // (b) the relay sees NATed — NATed's outbound reservation link (the
    //     "through the NAT" path):
    await pollPeers(relay, [natedPeerId])
    // (c) A and B each reached NATed THROUGH THE RELAY — the proxied dial
    //     (/p2p/<relayId>/p2p-circuit/p2p/<natedId>, built from the two
    //     peers' peerId() strings) connected (the 5.7 NAT-traversal path,
    //     exercised on the memory relay):
    await pollPeers(a, [natedPeerId])
    await pollPeers(b, [natedPeerId])

    // (d) the NATed node is the client role: relayRole 'client' + the
    //     relay address configured + the placeholder listen the adapter
    //     IGNORES (client → addresses.listen = [] — NO direct inbound
    //     listener):
    expect(nated.config.relayRole).toBe('client')
    expect(nated.config.relayAddress).toBe(RELAY_ADDRESS)
    expect(nated.config.listenAddress).toBe(NATED_PLACEHOLDER)
    // The relay + A + B are ordinary direct-listen nodes (their
    // listenAddress IS honored — they were dialed directly in the wiring):
    expect(relay.config.relayRole).toBe('relay')
    expect(relay.config.listenAddress).toBe(RELAY_ADDRESS)
    expect(a.config.relayRole).toBe('none')
    expect(a.config.listenAddress).toBe(A_LISTEN)
    expect(b.config.relayRole).toBe('none')
    expect(b.config.listenAddress).toBe(B_LISTEN)

    // (e) BEHAVIORAL — NATed is NOT directly reachable: a direct dial of
    //     its placeholder address FAILS (no listener there — the memory
    //     transport rejects it; the proxied multiaddr in (c) is the ONLY
    //     path to NATed):
    let directDialRejected = false
    try {
      await a.adapter.dial(NATED_PLACEHOLDER)
    } catch {
      directDialRejected = true
    }
    expect(directDialRejected).toBe(true)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// the guard rows (R4–R5) — pure file scans over the repo (no network, no
// topology: building a ~3 s relay mesh for a doc-scan row would blow these
// rows' default timeout budget — they run without the per-row topology;
// the relay rows above carry the AD-10 empirical proof)
// ---------------------------------------------------------------------------

describe('EPIC 5 CLOSING END-TO-END — full Done-when (5.10) — guard rows (R4–R5)', () => {
  // -------------------------------------------------------------------------
  // E2E5_R4_DHT_DECISION_NO_DHT (Done-when #4, E2)
  // -------------------------------------------------------------------------
  it('E2E5_R4_DHT_DECISION_NO_DHT: the epic Notes carry the dated 2026-10-13 DHT Decision (do NOT wire Kad-DHT at launch — the known-list model suffices); packages/core/package.json has NO @libp2p/kad-dht in dependencies OR devDependencies; a comment-stripped scan of src/** finds NO @libp2p/kad-dht import — the no-DHT non-goal holds', () => {
    // (a) the epic Notes contain the dated DHT Decision (the 5.8 spike's
    //     recommendation — RECORDED, not wired):
    const epicDoc = readFileSync(EPIC_DOC_PATH, 'utf8')
    expect(epicDoc).toMatch(/2026-10-13/)
    expect(epicDoc).toMatch(/do NOT wire Kad-DHT/)
    expect(epicDoc).toMatch(/DHT threshold/)

    // (b) the DHT package is ABSENT from package.json (dependencies +
    //     devDependencies):
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@libp2p/kad-dht')
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('@libp2p/kad-dht')

    // (c) a comment-stripped scan of src/** finds NO @libp2p/kad-dht
    //     import anywhere in the source:
    const offenders: string[] = []
    for (const file of tsFiles(SRC_DIR)) {
      const src = stripComments(readFileSync(file, 'utf8'))
      if (/@libp2p\/kad-dht/.test(src)) offenders.push(rel(CORE_DIR, file))
    }
    expect(offenders).toEqual([])
  })

  // -------------------------------------------------------------------------
  // E2E5_R5_MEMORY_HEADLESS_ZERO_SOCKETS (Done-when #5, AD-10)
  // -------------------------------------------------------------------------
  it('E2E5_R5_MEMORY_HEADLESS_ZERO_SOCKETS: TRANSPORT pins memory (the single selector passed to every createNetAdapter); a self-source scan asserts no wall-clock reads, no RNG, root-barrel-only ../src/index.js imports, no transitive-dependency imports; the four class topics + the sync stream id are pinned — the relay rows passing headless IS the empirical zero-sockets proof', () => {
    // The module pins the SINGLE transport selector (makeRelayNode /
    // makeChainNode pass it to every createNetAdapter), so pinning it
    // pins every node's transport — zero real sockets in CI (AD-10):
    expect(TRANSPORT).toBe('memory')

    // This file's own source (the self-scan — the 5.x ADDITIVE/
    // NO_DHT_WIRED guard pattern):
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Bounded polls, no wall-clock reads, no RNG in the cadence (AD-3):
    expect(selfSource).not.toMatch(/Date\.now\s*\(/)
    expect(selfSource).not.toMatch(/\bMath\.random\s*\(/)
    // Root-barrel-only imports: every ../src/ import specifier in this
    // file is the root barrel ../src/index.js (no deep imports into
    // src/net, src/proto, src/consensus, ...):
    const srcImports = [...selfSource.matchAll(/from\s+['"](\.\.\/src\/[^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    expect(srcImports.length).toBeGreaterThan(0)
    expect([...new Set(srcImports)]).toEqual(['../src/index.js'])
    // No transitive-dependency imports (no @libp2p/*, no @multiformats/* —
    // the network is driven through the root-barrel surface only):
    expect(selfSource).not.toMatch(/from\s+['"]@libp2p\//)
    expect(selfSource).not.toMatch(/from\s+['"]@multiformats\//)

    // The stable protocol constants are UNCHANGED (AD-8 — a topic string
    // and a stream id are protocol constants): the four class topics +
    // the dedicated sync stream id:
    expect(TOPICS.blocks).toBe('/succinctcoin/blocks/1')
    expect(TOPICS.tickets).toBe('/succinctcoin/tickets/1')
    expect(TOPICS.tx).toBe('/succinctcoin/tx/1')
    expect(TOPICS.peers).toBe('/succinctcoin/peers/1')
    expect(SYNC_PROTOCOL).toBe('/succinctcoin/sync/1')
  })
})
