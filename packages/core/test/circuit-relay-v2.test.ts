/**
 * 5.7 — circuit-relay-v2: a NATed node connects through a relay
 * (epic-node-network, spine E1 / AD-10; AD-3/AD-8/AD-11).
 *
 * The behind-NAT capability: a node with NO direct inbound listener (a
 * "NATed" node) becomes REACHABLE THROUGH A RELAY — a second node dials
 * the NATed node's relay-proxied multiaddr and connects, and a ticket
 * ROUND-TRIPS over the real NetPort gossip path (the existing
 * `sendTicket` → `received.get('tickets')` surface — D5: gossip, not a
 * raw stream). The relay is an ORDINARY libp2p node over the memory
 * transport (zero real sockets, AD-10) that also serves circuits, and it
 * is an OPTIONAL capability: a direct node reaches it by its direct
 * address with no relay hop at all.
 *
 * The "simulated NAT" model (the memory transport has no NAT): the NATed
 * node keeps an OUTBOUND transport (memory) to reach the relay but has no
 * direct LISTEN (inbound) — it is reachable only through the relay. The
 * test still drives every connection explicitly (the 5.1 explicit-`dial`
 * model — the adapter never auto-dials): the NATed node dials the relay
 * (outbound through the "NAT"), the second node dials the relay directly
 * (the hop reuses that relay connection), and then dials the NATed
 * node's relay-proxied multiaddr.
 *
 * MECHANISM NOTE (the plan's D2 wording, corrected by experiment — see
 * the plan's Implementation Notes): a circuit reservation is NOT created
 * by a bare dial of the relay (a 'discovered' reservation needs a pending
 * reservation, which only exists behind a circuit LISTEN), and the
 * circuit listener's `addedRelay` crashes over the memory transport
 * (`confirmObservedAddr` on the relay's process-local `/memory/...`
 * reservation addr → `InvalidParametersError` inside a library-internal
 * event handler — uncatchable, libp2p 3.3.11 + @libp2p/circuit-relay-v2
 * 4.2.13). So the ADAPTER registers the reservation itself: when the
 * operator dials the configured `relayAddress`, the adapter calls a
 * 'configured' `addRelay` on the circuit transport's reservation store —
 * no pending reservation needed, no circuit listener, no crash. No
 * advertise/discovery is involved: the proxied multiaddr is BUILT
 * EXPLICITLY in the test (plan D4).
 *
 * The relay-proxied multiaddr is the PEER-ID-ONLY form
 * `/p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>` (plan D4, corrected
 * by experiment): the circuit transport's dial filter (the
 * multiaddr-matcher `Circuit` matcher) exact-matches a bare
 * `/p2p/<relayId>` relay prefix, and NEVER a `/memory/...` one — a
 * `/memory/relay/p2p/<relayId>/p2p-circuit/...` dial is rejected
 * (`NoValidAddressesError`).
 *
 * The driver REUSES the 5.5/5.6 multi-node shape (D1 — TEST-ONLY, one
 * new file): separate in-process nodes, each with its own net adapter
 * (memory transport, zero real sockets, AD-10) and its own identity
 * keypair (AD-11 — driver-internal, `.secret` never read; signing goes
 * through the barrel's `signedTicket`), composing ONLY root-barrel seams.
 * 5.7 does NOT run the slot loop: the ticket is a pinned fixture
 * (`SLOT = 3n` + `GENESIS_PARENT` 32 zeros, AD-12 → the SAME locally
 * derived challenge on every node, the 5.5 D3 discipline) — no weights,
 * no cap, no draw (this story is about the wire path, not acceptance).
 * `src/` (except `src/net/adapter.ts`), `proto/`, `package.json`, and
 * `pnpm-lock.yaml` are untouched (the git-diff gates run externally).
 *
 * Receive = a bounded poll (5.5 D4, AD-3): the adapter exposes no
 * per-topic callback; the driver tracks a per-topic read cursor
 * (`pollReceived`). The cadence is driven by loop iterations + bounded
 * yields — never a wall-clock read, never an RNG call (the adapter's 10s
 * dial bound is a timeout, not a timestamp).
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest` + node
 * builtin `node:fs` / `node:url`) — no deep imports, no
 * transitive-dependency imports (AD-10).
 *
 * Rows (plan Matrix):
 *   RELAY_HOP               (AC-1) relay (relayRole 'relay') + NATed
 *                                (relayRole 'client', relayAddress, no
 *                                direct listen) + second (relayRole
 *                                default): the NATed node dials the relay
 *                                (circuit reservation); the second node
 *                                dials the NATed node's relay-proxied
 *                                multiaddr (bounded retry) →
 *                                `second.peers()` INCLUDES the NATed
 *                                node's peer id (the hop, via the relay —
 *                                and the NATed node sees the second: the
 *                                relayed connection is bidirectional).
 *   MESSAGE_ROUNDTRIP       (AC-2) after the relay connection +
 *                                settleMesh, the NATed node `sendTicket`s
 *                                a window-S ticket; the second node
 *                                RECEIVES it on `tickets` with
 *                                `sourcePeerId === natedId` (gossip
 *                                through the relay — AD-8/AD-10),
 *                                signature/challenge/commitment
 *                                byte-identical to the published ticket.
 *   NOT_DIRECTLY_REACHABLE  (AC-3) the NATed node was built relayRole
 *                                'client' with a PLACEHOLDER listen the
 *                                adapter ignores (client role →
 *                                `addresses.listen = []` — no direct
 *                                inbound listener): a direct dial of the
 *                                placeholder address FAILS (bounded by
 *                                the adapter's 10s dial timeout), while
 *                                the relay-proxied multiaddr — the ONLY
 *                                path this test uses to reach it —
 *                                connects; the relay + second are
 *                                ordinary direct-listen nodes.
 *   RELAY_OPTIONAL          (AC-4) the second node dials the relay's
 *                                DIRECT address (/memory/relay) with NO
 *                                relay hop (no NATed node at all in this
 *                                topology); the relay `sendTicket`s and
 *                                the second receives it — the relay is
 *                                an ordinary, directly-reachable node;
 *                                a relayRole 'none' node works without
 *                                relay access (the capability is
 *                                optional).
 *   ADDITIVE                (AC-5) root-barrel-only imports (+ vitest +
 *                                node builtins); memory transport only
 *                                (zero real sockets, AD-10); bounded
 *                                polls (no `Date.now` / `Math.random` in
 *                                this file's cadence); the four topics
 *                                pinned; the `src` diff is exactly
 *                                `src/net/adapter.ts`, `proto` EMPTY,
 *                                `package.json`/`pnpm-lock.yaml` EMPTY
 *                                (the git-diff gates run externally).
 *
 * AD-3 discipline: no wall-clock reads, no RNG — pinned 32-byte identity
 * seeds (`seedFor(i)` = 32 bytes of `0x40 + i`, the 4.8 convention) →
 * `deriveIdentityKeypair` (IMPORTED); every challenge =
 * `deriveWindowChallenge` (IMPORTED, derived locally — never wire-
 * trusted); every ticket = the 4.2 `signedTicket` pinned sha256 of
 * public data.
 * AD-11 discipline: the keypair is a driver-internal value; this file
 * NEVER reads `.secret` — signing goes through the barrel's
 * `signedTicket` (the 4.2 single reader).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  TOPICS,
  Ticket,
  createNetAdapter,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  signedTicket,
} from '../src/index.js'
import type {
  IdentityKeypair,
  NetAdapter,
  ReceivedEnvelope,
  TopicClass,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned parameters (5.7 — deterministic, AD-3)
// ---------------------------------------------------------------------------

/** The transport flag (AD-10 — zero real sockets in CI). */
const TRANSPORT = 'memory' as const

/** The relay node's DIRECT listen address (also the NATed node's `relayAddress`). */
const RELAY_ADDRESS = '/memory/relay'
/**
 * The NATed node's PLACEHOLDER listen address — IGNORED by the adapter for
 * the client role (`addresses.listen = []` — the node has NO direct
 * inbound listener; the placeholder exists only because `listenAddress`
 * is a required config field).
 */
const NATED_PLACEHOLDER_LISTEN = '/memory/nated'
/** The second (ordinary) node's direct listen address. */
const SECOND_LISTEN = '/memory/peer'

/**
 * The pinned window (5.7 does not run the slot loop — no block is mined or
 * applied, so the window is a FIXED chain-time point, the 5.5/5.6
 * convention): a non-zero slot + the genesis parent (32 zeros, AD-12) →
 * every node derives the SAME challenge LOCALLY (never wire-trusted —
 * the 5.5 D3 discipline).
 */
const SLOT = 3n
const GENESIS_PARENT = new Uint8Array(32)
/** The pinned window challenge — derived LOCALLY (imported seam). */
const WINDOW_CHALLENGE = deriveWindowChallenge(GENESIS_PARENT, SLOT)

/** Bounded test-side waits (the 5.2/5.3/5.5/5.6 pattern — bounded yields, not clock reads). */
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
 * mesh), so after a dial-topology change we yield ~3 heartbeats before
 * the next publish. 120 × 25 ms = 3000 ms.
 */
const MESH_SETTLE_POLLS = 120

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
// helpers (the 5.2/5.4/5.5/5.6 bounded-wait pattern — test-side, never in src)
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
 * — the adapter's send methods stay single-shot.
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
 * Dial with the established bounded retry (the 5.2/5.4/5.5/5.6 pattern)
 * so the mesh is formed BEFORE anything is published: the memory
 * transport rejects a dial to an unknown listener until the target has
 * started listening. `polls` overrides the bound (the hop dial needs the
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
 * publish. A pure bounded yield (loop iterations + `setTimeout`) — never a
 * wall-clock read, never an RNG call.
 */
async function settleMesh(): Promise<void> {
  for (let i = 0; i < MESH_SETTLE_POLLS; i += 1) {
    await sleep(SLEEP_MS)
  }
}

/**
 * The bounded poll helper (5.5 D4, AD-3): tracks a per-topic read cursor
 * over `adapter.received.get(topic)`, yielding a bounded `pollMs` between
 * iterations, resolving the FIRST entry matching `predicate` (consuming
 * it — the cursor advances past it), or failing after `maxPolls`.
 * Bounded = event-based (loop iterations + bounded yields), never a
 * wall-clock read; exhaustion is a test-infrastructure liveness failure
 * (the mesh did not deliver in time).
 */
async function pollReceived(
  node: RelayNode,
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
 * The relay-proxied multiaddr (plan D4 — built explicitly, NOT
 * discovered): `/p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>`. The
 * PEER-ID-ONLY form (not `/memory/relay/p2p/<relayId>/p2p-circuit/…`):
 * the circuit transport's dial filter (the multiaddr-matcher `Circuit`
 * matcher) exact-matches a bare `/p2p/<relayId>` relay prefix and NEVER
 * a `/memory/...` one.
 */
function relayProxiedMultiaddr(relayPeerId: string, natedPeerId: string): string {
  return `/p2p/${relayPeerId}/p2p-circuit/p2p/${natedPeerId}`
}

// ---------------------------------------------------------------------------
// the relay topology driver (the 5.5/5.6 multi-node shape, D1)
// ---------------------------------------------------------------------------

/** One role's wiring as the driver passed it to `createNetAdapter`. */
interface NodeConfig {
  relayRole: 'none' | 'relay' | 'client'
  relayAddress?: string
  listenAddress: string
}

/**
 * One networked node (the 5.5 D1 shape): its own net adapter (memory
 * transport, stamped with the node's 4.2 PROTOCOL identity id), its own
 * identity keypair (AD-11 driver-internal value — `.secret` is never read
 * here; signing goes through the barrel's `signedTicket`), and the
 * per-topic read cursors over `adapter.received` (D4). No chain store
 * (5.7 proves the wire path, not application — no mining, no balances).
 */
interface RelayNode {
  name: string
  keypair: IdentityKeypair
  adapter: NetAdapter
  config: NodeConfig
  cursors: Map<TopicClass, number>
}

/**
 * Build one node (the 5.5 node factory, relay-aware): the adapter is
 * stamped with the node's 4.2 protocol identity id and `start()`ed.
 */
async function makeNode(
  name: string,
  seedIndex: number,
  config: NodeConfig,
): Promise<RelayNode> {
  const keypair = deriveIdentityKeypair(seedFor(seedIndex))
  const adapter = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: config.listenAddress,
    protocolIdentityId: keypair.identityId,
    mdns: false,
    relayRole: config.relayRole,
    relayAddress: config.relayAddress,
  })
  await adapter.start()
  return {
    name,
    keypair,
    adapter,
    config,
    cursors: new Map<TopicClass, number>(),
  }
}

/**
 * The relay topology (the 5.5/5.6 multi-node driver shape, D1): the RELAY
 * node (relayRole 'relay', direct listen RELAY_ADDRESS), the NATed node
 * (relayRole 'client', relayAddress RELAY_ADDRESS, NO direct listen — the
 * placeholder listen is ignored by the adapter), and the SECOND node
 * (relayRole 'none' — the default, direct listen SECOND_LISTEN).
 *
 * WIRING (the operator drives EVERY connection — the explicit-dial model,
 * 5.1 — the adapter never auto-dials):
 *  1. the NATed node dials the relay — its OUTBOUND path "through the
 *     NAT". The adapter registers the circuit reservation on this dial
 *     (fire-and-forget — the hop dial below retries until it lands);
 *  2. the second node dials the relay DIRECTLY (the RELAY_OPTIONAL AC-4
 *     path — no relay hop): the hop's CONNECT request + byte-stream to
 *     the NATed node reuses this relay connection; the relay's STOP
 *     request to the NATed node goes over the NATed node's OWN relay
 *     connection (the relay requires an open connection to the
 *     destination in handleConnect);
 *  3. the second node dials the NATed node THROUGH the relay — the
 *     relay-proxied multiaddr built explicitly (plan D4); bounded retry:
 *     the first attempts can race the reservation (NO_RESERVATION until
 *     it exists).
 *
 * `withNated = false` builds the AC-4 shape (relay + second only — no
 * NATed node, no circuit at all: the second node reaches the relay by its
 * direct address, proving the relay role is a capability, not a
 * requirement).
 */
class RelayTopology {
  readonly relay: RelayNode
  readonly nated: RelayNode | null
  readonly second: RelayNode
  private readonly nodes: RelayNode[]

  private constructor(relay: RelayNode, nated: RelayNode | null, second: RelayNode) {
    this.relay = relay
    this.nated = nated
    this.second = second
    this.nodes = nated === null ? [relay, second] : [relay, nated, second]
  }

  static async build(withNated: boolean): Promise<RelayTopology> {
    const relay = await makeNode('relay', 0, {
      relayRole: 'relay',
      listenAddress: RELAY_ADDRESS,
    })
    const nated = withNated
      ? await makeNode('nated', 1, {
          relayRole: 'client',
          relayAddress: RELAY_ADDRESS,
          listenAddress: NATED_PLACEHOLDER_LISTEN,
        })
      : null
    const second = await makeNode('second', 2, {
      relayRole: 'none',
      listenAddress: SECOND_LISTEN,
    })

    // 1 — the NATed node's outbound dial (circuit reservation on the relay).
    if (nated !== null) {
      await dialWithRetry(nated.adapter, RELAY_ADDRESS)
    }
    // 2 — the second node's DIRECT relay dial (the hop reuses it).
    await dialWithRetry(second.adapter, RELAY_ADDRESS)
    // 3 — the second node's hop dial THROUGH the relay (bounded retry until
    // the reservation exists — see HOP_DIAL_POLLS).
    if (nated !== null) {
      await dialWithRetry(
        second.adapter,
        relayProxiedMultiaddr(relay.adapter.peerId(), nated.adapter.peerId()),
        HOP_DIAL_POLLS,
      )
    }
    return new RelayTopology(relay, nated, second)
  }

  /** Stop every adapter (the memory listeners release with the node). */
  async close(): Promise<void> {
    for (const node of this.nodes) {
      await node.adapter.stop()
    }
    this.nodes.length = 0
  }
}

// ---------------------------------------------------------------------------
// RELAY_HOP (AC-1)
// ---------------------------------------------------------------------------

describe('RELAY_HOP (AC-1) — the second node connects to the NATed node THROUGH the relay: peers() includes the NATed peer id', () => {
  it('relay (relayRole relay) + NATed (relayRole client, relayAddress, no direct listen) + second (default): the NATed node dials the relay (circuit reservation); the second node dials the NATed node\'s relay-proxied multiaddr (bounded retry) → second.peers() includes the NATed node\'s transport peer id, and the NATed node sees the second (the relayed connection is bidirectional — the STOP upgrade lands on both sides)', { timeout: 90_000 }, async () => {
    const topo = await RelayTopology.build(true)
    try {
      const nated = topo.nated
      if (nated === null) throw new Error('driver: topology built without the NATed node')

      // AC-1 — the hop happened VIA THE RELAY, not a direct address: the
      // second node's connection list includes the NATed node's transport
      // peer id (the relay-proxied multiaddr was the dial target — built
      // explicitly, plan D4).
      const secondPeers = await topo.second.adapter.peers()
      expect(secondPeers).toContain(nated.adapter.peerId())

      // And the NATed node sees the second — the relayed connection is
      // bidirectional (the relay's STOP CONNECT upgraded the inbound side
      // on the NATed node):
      const natedPeers = await nated.adapter.peers()
      expect(natedPeers).toContain(topo.second.adapter.peerId())

      // The NATed node's other connection is its outbound relay link
      // (the "through the NAT" path) — the full picture of a NATed node:
      // two connections, one outbound-to-relay, one inbound-via-relay.
      expect(natedPeers).toContain(topo.relay.adapter.peerId())
      expect(natedPeers).toHaveLength(2)
    } finally {
      await topo.close()
    }
  })
})

// ---------------------------------------------------------------------------
// MESSAGE_ROUNDTRIP (AC-2)
// ---------------------------------------------------------------------------

describe('MESSAGE_ROUNDTRIP (AC-2) — the NATed node\'s ticket round-trips over the NetPort gossip path through the relay', () => {
  it('after the relay connection + settleMesh, the NATed node sendTicket()s a window-S ticket; the second node receives it on the tickets topic with sourcePeerId === the NATed node\'s 4.2 protocol identity id, signature/challenge/commitment byte-identical to the published ticket (gossip through the relay — AD-8/AD-10, the existing NetPort surface)', { timeout: 90_000 }, async () => {
    const topo = await RelayTopology.build(true)
    try {
      const nated = topo.nated
      if (nated === null) throw new Error('driver: topology built without the NATed node')

      // The mesh grafts the new (relayed) links over ~3 heartbeats BEFORE
      // the publish (5.5 D6 — a publish on a cold mesh is lost).
      await settleMesh()

      // The NATed node publishes the pinned window-S ticket (4.2
      // `signedTicket` — the pinned per-(identity, slot, parent)
      // commitment + the AD-12 signature) on the tickets topic (bounded
      // retry — the first publish can race the mesh handshake).
      const natedTicket = signedTicket(nated.keypair, SLOT, GENESIS_PARENT, WINDOW_CHALLENGE)
      await publishUntilAccepted(() => nated.adapter.sendTicket(natedTicket))

      // The second node RECEIVES it on the `tickets` topic (bounded poll,
      // single-target) — the gossip flowed THROUGH THE RELAY (the only
      // path between the two nodes):
      const env = await pollReceived(topo.second, 'tickets', (e) => {
        const t = e.payload as Ticket
        return t.windowIndex === SLOT
      })

      // AC-2 — the envelope is stamped with the NATed node's 4.2 PROTOCOL
      // identity id (5.2 D3 — the sourcePeerId, NOT the transport peer
      // id, AD-11):
      expect(env.sourcePeerId).toBe(nated.keypair.identityId)

      // And the payload is the published ticket, intact over the wire
      // (proto-decoded at the adapter):
      const t = env.payload as Ticket
      expect(t.windowIndex).toBe(SLOT)
      expect(t.identityId).toBe(nated.keypair.identityId)
      expect(bytesEqual(t.signature, natedTicket.signature)).toBe(true)
      expect(bytesEqual(t.challenge, natedTicket.challenge)).toBe(true)
      expect(bytesEqual(t.nonceCommitment, natedTicket.nonceCommitment)).toBe(true)
    } finally {
      await topo.close()
    }
  })
})

// ---------------------------------------------------------------------------
// NOT_DIRECTLY_REACHABLE (AC-3)
// ---------------------------------------------------------------------------

describe('NOT_DIRECTLY_REACHABLE (AC-3) — the NATed node has no direct listen: the relay-proxied multiaddr is the only path to it', () => {
  it('the NATed node was built relayRole client with a placeholder listen the adapter IGNORES (client role → addresses.listen = [] — no direct inbound listener): a direct dial of the placeholder address FAILS immediately (the memory transport rejects a dial to an address with no listener — there is no 10s timeout to wait out), while the relay-proxied multiaddr — the ONLY path this test uses to reach it — connects; the relay + second are ordinary direct-listen nodes (only the NATed node lacks one)', { timeout: 90_000 }, async () => {
    const topo = await RelayTopology.build(true)
    try {
      const nated = topo.nated
      if (nated === null) throw new Error('driver: topology built without the NATed node')

      // CONFIG — the driver's roles are the single source of the
      // topology's reachability shape (the adapter maps them: 'client' →
      // addresses.listen = [] + reservation on relayAddress; 'relay' →
      // circuitRelayServer + direct listen; 'none' → direct listen):
      expect(nated.config.relayRole).toBe('client')
      expect(nated.config.relayAddress).toBe(RELAY_ADDRESS)
      // the placeholder listen — present in the config (the field is
      // required), IGNORED by the adapter for the client role:
      expect(nated.config.listenAddress).toBe(NATED_PLACEHOLDER_LISTEN)
      // the relay + second are ordinary direct-listen nodes (their
      // listenAddress IS honored — they were dialed directly in the
      // topology wiring):
      expect(topo.relay.config.relayRole).toBe('relay')
      expect(topo.relay.config.listenAddress).toBe(RELAY_ADDRESS)
      expect(topo.second.config.relayRole).toBe('none')
      expect(topo.second.config.listenAddress).toBe(SECOND_LISTEN)

      // BEHAVIORAL (1) — the NATed node is NOT directly reachable: a
      // direct dial of its placeholder address fails IMMEDIATELY (the
      // memory transport rejects a dial to an address with no listener —
      // there is no 10s timeout to wait out — AD-3).
      let directDialRejected = false
      try {
        await topo.second.adapter.dial(NATED_PLACEHOLDER_LISTEN)
      } catch {
        directDialRejected = true
      }
      expect(directDialRejected).toBe(true)

      // BEHAVIORAL (2) — the relay-proxied multiaddr IS the path: the
      // topology wiring dialed it (bounded retry until the reservation
      // existed) and the connection is live — the second node's peer list
      // includes the NATed node (reached ONLY through the relay):
      expect(await topo.second.adapter.peers()).toContain(nated.adapter.peerId())
    } finally {
      await topo.close()
    }
  })
})

// ---------------------------------------------------------------------------
// RELAY_OPTIONAL (AC-4)
// ---------------------------------------------------------------------------

describe('RELAY_OPTIONAL (AC-4) — the relay is a capability, not a requirement: the relay node is directly reachable without any relay hop', () => {
  it('relay (relayRole relay) + second (relayRole none) ONLY — no NATed node, no reservation or hop (the circuit transport is wired but inert): the second node dials the relay\'s DIRECT address (/memory/relay) with no relay hop; the relay sendTicket()s a window-S ticket and the second node receives it with sourcePeerId === the relay\'s 4.2 protocol identity id — the relay is an ordinary, directly-reachable node and a relayRole none node works without relay access', { timeout: 90_000 }, async () => {
    const topo = await RelayTopology.build(false)
    try {
      expect(topo.nated).toBeNull()

      // The second node (relayRole 'none') reached the relay over its
      // DIRECT address in the topology wiring — no relay-proxied multiaddr
      // anywhere in this topology (the circuit transport is wired on both
      // nodes — D3 — but inert: no reservation, no hop).
      expect(await topo.second.adapter.peers()).toContain(topo.relay.adapter.peerId())

      // The mesh grafts the direct link over ~3 heartbeats BEFORE the
      // publish (5.5 D6).
      await settleMesh()

      // The RELAY node — an ordinary node that also serves circuits —
      // publishes the pinned window-S ticket on the tickets topic:
      const relayTicket = signedTicket(
        topo.relay.keypair,
        SLOT,
        GENESIS_PARENT,
        WINDOW_CHALLENGE,
      )
      await publishUntilAccepted(() => topo.relay.adapter.sendTicket(relayTicket))

      // The second node receives it on the `tickets` topic — over the
      // DIRECT link (no hop):
      const env = await pollReceived(topo.second, 'tickets', (e) => {
        const t = e.payload as Ticket
        return t.windowIndex === SLOT
      })
      expect(env.sourcePeerId).toBe(topo.relay.keypair.identityId)
      const t = env.payload as Ticket
      expect(t.windowIndex).toBe(SLOT)
      expect(t.identityId).toBe(topo.relay.keypair.identityId)
      expect(bytesEqual(t.signature, relayTicket.signature)).toBe(true)
    } finally {
      await topo.close()
    }
  })
})

// ---------------------------------------------------------------------------
// ADDITIVE (AC-5)
// ---------------------------------------------------------------------------

describe('ADDITIVE (AC-5) — TEST-ONLY: root-barrel-only imports, memory transport only, bounded polls, the four topics pinned', () => {
  it('the driver composes only root-barrel seams (+ vitest + node builtins); the topology is memory-transport-only (zero real sockets, AD-10); the cadence is bounded-poll driven (no Date.now / Math.random in this file); the four class topics are pinned; the src diff is exactly src/net/adapter.ts, proto and deps untouched (the git-diff gates run externally)', () => {
    // The driver composes the IMPORTED seams — every one of these is the
    // ROOT BARREL export the driver calls (this file contains no local
    // re-implementation of the ticket signing, the challenge derivation,
    // or the identity keypair):
    const seams = [
      signedTicket,
      deriveWindowChallenge,
      deriveIdentityKeypair,
      createNetAdapter,
    ]
    for (const seam of seams) {
      expect(typeof seam).toBe('function')
    }
    // The proto payload codec (the value side of the type+value export):
    expect(typeof Ticket.encode).toBe('function')

    // Memory transport only (AD-10 — zero real sockets in CI): `TRANSPORT`
    // is the SINGLE transport selector in this file (makeNode passes it to
    // createNetAdapter), so pinning it pins every node's transport. The
    // four end-to-end rows above are the EMPIRICAL AD-10 proof — they run
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
    // No transitive-dependency imports (no `@libp2p/*`, no
    // `@multiformats/*` — the relay capability is ADAPTER-OWNED, D1; the
    // test drives it through the root-barrel surface only):
    expect(selfSource).not.toMatch(/from\s+['"]@libp2p\//)
    expect(selfSource).not.toMatch(/from\s+['"]@multiformats\//)
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
