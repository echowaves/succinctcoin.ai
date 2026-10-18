/**
 * `core/net` — the libp2p adapter (epic 5, AD-8/AD-10/AD-12).
 *
 * 5.1 scaffold + 5.2 topics/envelopes: the adapter implements the FULL 1.2
 * `NetPort` surface (`start`/`stop`/`sendBlock`/`sendTicket`/`sendTx`/
 * `peers`) over libp2p (3.3.11) with `noise` + `yamux` + `gossipsub`
 * (17.1.2). Each message class publishes a PROTO ENVELOPE on its OWN stable
 * topic (5.2, AD-8 "one stable topic per message class"):
 *
 *   sendBlock(block)         → BlockEnvelope         on TOPICS.blocks
 *   sendTicket(ticket)       → TicketEnvelope        on TOPICS.tickets
 *   sendTx(tx)               → TxEnvelope            on TOPICS.tx
 *   sendPeerInfo(info)       → PeerInfoEnvelope      on TOPICS.peers  (helper, not on NetPort)
 *   sendAnnouncement(a)      → AnnouncementEnvelope  on TOPICS.announcements  (8.3, helper)
 *   sendIntroduction(i)      → IntroductionEnvelope  on TOPICS.introductions  (8.4, helper)
 *
 * The 5.1 scratch topic (`/succinctcoin/scratch`) and its raw
 * `receivedMessages` collector are REMOVED: the `message` handler now
 * DECODES each received envelope on its topic into the `received` map
 * (`Map<TopicClass, Array<{ sourcePeerId, payload }>>`).
 *
 * Design notes (see the story plan):
 *
 * - **D1 — transport identity.** The adapter uses libp2p's OWN identity
 *   keypair (a fresh Ed25519 key auto-generated because no `privateKey` is
 *   passed to `createLibp2p`). That is the transport-layer identity — it
 *   identifies the node on the network. It is deliberately DISTINCT from
 *   the 4.2 protocol identity (`src/identity/identity.ts`, the ticket
 *   signing keypair). The adapter never reads the protocol keypair's
 *   `.secret` (AD-11) and never exposes the transport keypair at all —
 *   only its derived `peerId` string.
 * - **D2 — pure factory.** `createNetAdapter` stores the config and returns
 *   the adapter object; the libp2p node is created LAZILY inside `start()`,
 *   so constructing a `'tcp'` adapter never touches a socket (AD-10).
 * - **D3 — protocol identity id (5.2).** `protocolIdentityId` is the
 *   adapter's 4.2 PROTOCOL identity id (a 32-byte hex string) — the id the
 *   acceptance path (4.3) and the per-window accepted-set construction
 *   (4.4/4.5) are keyed by. It is set by the node operator as a plain
 *   string config field (AD-11: no `.secret` read) and stamped into every
 *   envelope as `sourcePeerId` — NOT the libp2p transport peer id (D1).
 * - **D4 — class topics (5.2).** `start()` subscribes to ALL FOUR topics in
 *   `TOPICS` (`src/net/topics.ts`, AD-8); each `send*` encodes its class's
 *   envelope and publishes on the matching topic. The topic alone selects
 *   the envelope to decode (no class discriminator on the wire).
 * - **D5 — receive decoding (5.2).** The gossipsub `message` handler decodes
 *   each received envelope on its topic and stores the DECODED payload +
 *   `sourcePeerId` in the `received` map, keyed by `TopicClass`. 5.2 proves
 *   publish→receive plumbing; routing the decoded messages into the core
 *   (acceptance path, accepted-set construction) is 5.5's job.
 * - **D6 — send is single-shot (5.1 forward note, DEFERRED to 5.5).** When
 *   the send path becomes load-bearing (5.5's live loop), the adapter needs
 *   a retry or an explicit `allowPublishToZeroTopicPeers` decision so the
 *   consensus loop never silently drops a block/ticket/tx. 5.2 keeps the
 *   single-shot send (publish→receive plumbing, not the live loop).
 * - **D7 — transport flag.** `'memory'` → `@libp2p/memory` (the only path
 *   exercised in CI, AD-10); `'tcp'` → `@libp2p/tcp` (present in code,
 *   never CI-exercised). bootstrap/mdns discovery are WIRED in 5.3 (see the
 *   discovery notes in `buildNode`); circuitRelayTransport is 5.7 (D9).
 * - **D8 — relay role (5.7).** `relayRole` selects the circuit-relay-v2
 *   capability (spine E1 / AD-10): `'relay'` registers
 *   `circuitRelayServer()` as the `circuitRelay` service — an ORDINARY node
 *   that also serves circuits; `'client'` (the NATed node) listens on
 *   NOTHING (`addresses.listen = []` — no direct inbound listener, inbound
 *   only via the relay; the config's `listenAddress` is IGNORED for this
 *   role) and registers a circuit reservation on the configured
 *   `relayAddress` WHEN THE OPERATOR DIALS IT via `dial()` (the explicit-
 *   `dial` model — the adapter never auto-dials); `'none'` (default) is the
 *   unchanged direct node. A client is reachable at
 *   `/p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>` (the dialer builds
 *   that multiaddr explicitly — no discovery/advertise).
 * - **D9 — circuitRelayTransport always (5.7).** The circuit transport is
 *   ALWAYS wired (after the direct transport), for EVERY role: it is the
 *   dial-THROUGH-relay capability — even a `'none'` node needs it to dial a
 *   NATed peer's relay-proxied multiaddr. It is inert for a node that never
 *   touches a relay (no reservation), so the 5.1–5.6 nodes are unaffected
 *   (the full-suite gate verifies this). The client's reservation is a
 *   'configured' `addRelay` (D8) — deliberately NOT the circuit LISTEN
 *   path: a 'discovered' reservation needs a pending reservation (which only
 *   exists behind a circuit listen), and the circuit listener's `addedRelay`
 *   would confirm the relay's process-local `/memory/...` addr via
 *   `confirmObservedAddr`, throwing `InvalidParametersError` inside a
 *   library-internal event handler (uncatchable from the adapter — libp2p
 *   3.3.11 + @libp2p/circuit-relay-v2 4.2.13). Gossipsub runs with
 *   `runOnLimitedConnection: true` so gossip flows over relayed (limited)
 *   connections (a no-op for direct ones).
 *
 * Hygiene: no `big.js` (AD-5), no `.secret` reads (AD-11), no RNG, no
 * wall-clock (AD-3 — the 10s dial bound is a timeout, not a timestamp).
 */
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { memory } from '@libp2p/memory'
import { tcp } from '@libp2p/tcp'
import { gossipsub } from '@libp2p/gossipsub'
import { identify } from '@libp2p/identify'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { bootstrap } from '@libp2p/bootstrap'
import { mdns } from '@libp2p/mdns'
import { peerIdFromString } from '@libp2p/peer-id'
import { TypedEventEmitter } from 'main-event'
import { multiaddr, CODE_P2P } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

import type { Libp2p, Libp2pInit } from 'libp2p'
import type { GossipSub, Message } from '@libp2p/gossipsub'
import type { Identify } from '@libp2p/identify'
import type { CircuitRelayService } from '@libp2p/circuit-relay-v2'
import type { PeerDiscovery, PeerDiscoveryEvents, PeerId } from '@libp2p/interface'
import type { NetPort } from '../ports.js'
import {
  Block,
  Ticket,
  Tx,
  PeerInfo,
  AnnouncementEnvelope,
  IntroductionEnvelope,
  BlockEnvelope,
  TicketEnvelope,
  TxEnvelope,
  PeerInfoEnvelope,
  SyncRequest,
  SyncBlock,
} from '../proto/index.js'
import type { Introduction, PeerAnnouncement } from '../proto/index.js'
import { TOPICS } from './topics.js'
import type { TopicClass } from './topics.js'
import { SYNC_PROTOCOL, makeSyncHandler, syncFrom } from './sync.js'
import type { SyncSource } from './sync.js'

/** The dial bound for `dial()` (D2 — a timeout, never a clock read). */
const DIAL_TIMEOUT_MS = 10_000

/**
 * Adapter factory config (D2/D3).
 */
export interface NetAdapterConfig {
  /** 'memory' (CI path) or 'tcp' (production; present but not CI-exercised). */
  transport: 'memory' | 'tcp'
  /** Listen address. Memory: '/memory/<name>'. TCP: '/ip4/0.0.0.0/tcp/<port>'. */
  listenAddress: string
  /**
   * The node's 4.2 PROTOCOL identity id (a 32-byte hex string) — stamped
   * into every published envelope as `sourcePeerId` (5.2 D3). Set by the
   * node operator; a plain string field, never a keypair (AD-11).
   */
  protocolIdentityId: string
  /**
   * 5.3 D1 — the multiaddr list the REAL `@libp2p/bootstrap` service dials.
   * In production this is the validated `genesis.bootstrap` (each entry
   * `/…/p2p/<peerId>` — bootstrap requires a `/p2p` component and filters out
   * entries without one). Optional: `undefined`/empty → no bootstrap service
   * (discovery is OFF by default, AC-4).
   */
  bootstrap?: string[]
  /**
   * 5.3 D1 — when true, register a `PeerDiscovery` service for LAN discovery.
   * Over the memory transport the service is the internal `buildMdnsDiscovery`
   * double (D3); over tcp it is the real `@libp2p/mdns` `mdns()` (present in
   * code, never CI-exercised — AD-10). The flag is the SAME either way. Default
   * false → no mDNS service.
   */
  mdns?: boolean
  /**
   * 5.3 D1 — TEST-ONLY, honored only when `mdns` is true over the MEMORY
   * transport. The list of `/…/p2p/<peerId>` multiaddrs the double announces
   * (stands in for the UDP broadcast a real mdns node answers with). Ignored
   * over tcp (the real `mdns()` announces the node itself, no list needed).
   */
  mdnsAnnounce?: string[]
  /**
   * 5.7 D8 — the circuit-relay role. `'relay'` registers the
   * `circuitRelayServer()` service (an ordinary node that also serves
   * circuits); `'client'` is the NATed node — NO direct listen (`listen`
   * address ignored, inbound only via the relay) + a circuit reservation on
   * `relayAddress` when the operator dials it; `'none'` (default) is the
   * unchanged direct node.
   */
  relayRole?: 'none' | 'relay' | 'client'
  /**
   * 5.7 D8 — the relay's multiaddr (`client` role only). The OPERATOR dials
   * it via the adapter's `dial()`; dialing it registers a circuit
   * reservation on that relay (the adapter does NOT auto-dial — the
   * explicit-`dial` model, 5.1). The NATed node is then reachable at
   * `/p2p/<relayPeerId>/p2p-circuit/p2p/<natedPeerId>` (the dialer builds
   * that multiaddr explicitly).
   */
  relayAddress?: string
}

/**
 * One decoded envelope received on a class topic (5.2 D5).
 */
export interface ReceivedEnvelope {
  /** The publisher's PROTOCOL identity id (the 4.2 identityId, 32-byte hex). */
  sourcePeerId: string
  /** The DECODED payload message (`Block`/`Ticket`/`Tx`/`PeerInfo`). */
  payload: unknown
}

/**
 * The adapter surface: the FULL 1.2 `NetPort` contract plus the extensions
 * the tests (and 5.3's discovery) need (D2).
 */
export interface NetAdapter extends NetPort {
  /** Explicitly dial a peer by multiaddr string (5.1's connect mechanism;
   *  discovery-driven connecting is 5.3). 10s AbortSignal.timeout. */
  dial(address: string): Promise<void>
  /** The libp2p peer ID string of this node (transport identity — D1). */
  peerId(): string
  /**
   * This node's LISTEN addresses as multiaddr strings (8.5) — what an
   * announcement should carry so peers can dial back. With
   * `listenAddress: .../tcp/0` these are the ACTUAL bound addresses (the
   * ephemeral port resolved); the memory transport reports its own
   * `/memory/<name>` id. Requires a started node (throws pre-`start()` /
   * post-`stop()` like every other node method). NOT on the `NetPort`.
   */
  listenAddresses(): string[]
  /** Publish a `PeerInfoEnvelope` on `TOPICS.peers`. NOT on the `NetPort` —
   *  peer info is the gossip/discovery surface (5.3 drives it); exposed
   *  here so the peers class round-trips in 5.2. */
  sendPeerInfo(peerInfo: unknown): Promise<void>
  /**
   * Publish an `AnnouncementEnvelope` on `TOPICS.announcements` (CAP-7,
   * ticket 8.3). NOT on the `NetPort` — same discovery surface as
   * `sendPeerInfo`; the node loop only publishes announcements it has
   * VALIDATED (verify-before-relay is the loop's rule).
   */
  sendAnnouncement(announcement: PeerAnnouncement): Promise<void>
  /**
   * Publish an `IntroductionEnvelope` on `TOPICS.introductions` (CAP-7,
   * ticket 8.4). NOT on the `NetPort` — same discovery surface as
   * `sendAnnouncement`; the node loop only publishes introductions it has
   * signed itself or VALIDATED (verify-before-relay, the 8.3 rule).
   */
  sendIntroduction(introduction: Introduction): Promise<void>
  /**
   * Decoded envelopes received on the class topics (5.2 D5; six classes
   * since 8.4), keyed by topic class. Test observability for now; 5.5
   * routes the receive path into the core (acceptance path / accepted-set
   * construction).
   */
  readonly received: ReadonlyMap<TopicClass, ReceivedEnvelope[]>

  // -------------------------------------------------------------------------
  // 5.4 — chain sync (D7/D8 — NOT on the 1.2 `NetPort`; the `NetAdapter`
  // extension, like `dial`/`peerId`/`sendPeerInfo`). The sync transport is
  // a dedicated request/response STREAM (`SYNC_PROTOCOL`), distinct from the
  // four gossip topics. The source is registered on the SERVER (the peer
  // with the chain); `syncFrom` is the CLIENT (the fresh node pulling).
  // -------------------------------------------------------------------------
  /**
   * Register the sync SOURCE the peer streams on inbound sync requests (the
   * server side, D7). The source yields the peer's per-window
   * `{ block, acceptedTickets, weights }` from `fromSlot` to its head.
   * Registered lazily: `start()` registers the stream handler once, and the
   * handler reads the CURRENT source at stream-open time (the operator may
   * call `setSyncSource` after `start()`). `null` clears it (inbound sync
   * requests then yield zero blocks). NOT on the `NetPort` (D8).
   */
  setSyncSource(source: SyncSource | null): void
  /**
   * The CLIENT sync (D4/D7): dial `peer`'s `SYNC_PROTOCOL`, send ONE
   * `SyncRequest`, half-close, and YIELD the server's streamed `SyncBlock`s
   * (proto-decoded, AD-12). `peer` is a multiaddr string (the 5.1 `dial`
   * form). Returns an `AsyncIterable<SyncBlock>` (the decoded blocks in
   * stream order — the structural-client shape the consensus `syncChain`
   * consumes, D7). NOT on the `NetPort` (D8).
   */
  syncFrom(peer: string, request: SyncRequest): AsyncIterable<SyncBlock>
}

/** The service map this adapter's node carries.
 *  `createLibp2p<T>` requires `T extends Record<string, unknown>`; a local
 *  alias keeps the index signature that an `interface` would lose.
 *  `identify` is present because gossipsub hard-depends on it (see
 *  buildNode's services comment). 5.7 D8: `circuitRelay` is present only
 *  for `relayRole: 'relay'` nodes (the circuit-relay SERVER). */
type Services = Record<string, unknown> & {
  gossip: GossipSub
  identify: Identify
  circuitRelay?: CircuitRelayService
}

/**
 * 5.3 D3 — the memory-transport mDNS service TEST DOUBLE (not a no-op).
 *
 * A `TypedEventEmitter<PeerDiscoveryEvents>` (assignable to `@libp2p/interface`
 * `PeerDiscovery`) that is Startable, so libp2p's `components.start()` runs it.
 * On `start()` it emits one `peer` event per announced `/…/p2p/<id>` multiaddr,
 * filtering out any self-announcement (peer id === own) so it never
 * "discovers" itself — mirroring libp2p's own self-guard in `#onDiscoveryPeer`.
 *
 * This exercises the REAL libp2p discovery bridge (the same
 * `#onDiscoveryPeer` → `peer:update` → `peer:discovery` path a real mdns would
 * drive), differing from real mdns only in the source of the announcement (the
 * test-supplied `mdnsAnnounce` list instead of a UDP query). INTERNAL — driven
 * through the public `createNetAdapter` config (`mdns: true` + `mdnsAnnounce`),
 * never exported (D8).
 */
class MemoryMdnsDiscovery extends TypedEventEmitter<PeerDiscoveryEvents> {
  private readonly announce: string[]
  private readonly ownPeerId: PeerId

  constructor(announce: string[], ownPeerId: PeerId) {
    super()
    this.announce = announce
    this.ownPeerId = ownPeerId
  }

  /** Startable: `components.start()` invokes this. */
  start(): void {
    for (const str of this.announce) {
      const ma = multiaddr(str)
      // ES2022 target has no `Array.prototype.findLast` — walk the components
      // (in order) for the `/p2p/<id>` one, keeping the LAST match (mirrors
      // bootstrap's `findLast`).
      let p2pComponent: string | undefined
      for (const c of ma.getComponents()) {
        if (c.code === CODE_P2P) p2pComponent = c.value
      }
      // Entries without a `/p2p/<id>` component carry no discoverable peer.
      if (p2pComponent === undefined) continue
      const id = peerIdFromString(p2pComponent)
      // Self-guard: never "discover" our own peer id.
      if (id.toString() === this.ownPeerId.toString()) continue
      this.safeDispatchEvent('peer', { detail: { id, multiaddrs: [ma] } })
    }
  }

  /** Startable: nothing to release — the double holds no timer or socket. */
  stop(): void {
    /* inert */
  }
}

/**
 * 5.3 D3 — factory for the memory-transport mDNS double. The param needs only
 * `peerId` (for the self-filter); the libp2p `Components` the node passes it
 * structurally satisfies that. Returns a `PeerDiscovery`-assignable service.
 * INTERNAL — not exported (D8).
 */
function buildMdnsDiscovery(
  announce: string[],
): (components: { peerId: PeerId }) => PeerDiscovery {
  return (components) => new MemoryMdnsDiscovery(announce, components.peerId)
}

/**
 * 5.3 D2/D3 — build the node's `peerDiscovery` service array:
 *  - the REAL `@libp2p/bootstrap` service dials `config.bootstrap` (the genesis
 *    bootstrap list) after its 1 s timer and AUTO-DIALS each entry (D2);
 *  - when `config.mdns`, the memory transport registers the internal
 *    `buildMdnsDiscovery` double (D3) and the tcp transport the real `mdns()`
 *    (present, never CI-exercised — AD-10);
 *  - an EMPTY array when neither `bootstrap` nor `mdns` is set → discovery OFF
 *    (AC-4: an additive-config node behaves exactly as it did in 5.2).
 *
 * The return type is `Libp2pInit['peerDiscovery']` so the libp2p `Components`
 * type (not re-exported from the `libp2p` root) is checked at the call site.
 */
function buildPeerDiscovery(config: NetAdapterConfig): Libp2pInit['peerDiscovery'] {
  const discovery = []
  if (config.bootstrap !== undefined && config.bootstrap.length > 0) {
    discovery.push(bootstrap({ list: config.bootstrap }))
  }
  if (config.mdns === true) {
    discovery.push(
      config.transport === 'memory'
        ? buildMdnsDiscovery(config.mdnsAnnounce ?? [])
        : mdns(),
    )
  }
  return discovery
}

/**
 * Build the libp2p node for `config` (D7: transport selected by flag; both
 * paths use noise + yamux). Gossipsub is registered as the `gossip` service;
 * the `message` handler decodes each received envelope on its topic into
 * `received` (5.2 D5). 5.3 adds the discovery services (`peerDiscovery`) and a
 * single `peer:discovery` dial listener. The transport keypair is
 * auto-generated internally by libp2p (D1) — never exposed or read here.
 */
async function buildNode(
  config: NetAdapterConfig,
  received: Map<TopicClass, ReceivedEnvelope[]>,
  getSource: () => SyncSource | null,
): Promise<Libp2p<Services>> {
  // 5.7 D8 — the client (NATed) role listens on NOTHING: no direct inbound
  // listener (inbound only via the relay), so the config's `listenAddress`
  // is ignored for this role.
  const isClient = config.relayRole === 'client'
  const node = await createLibp2p<Services>({
    addresses: { listen: isClient ? [] : [config.listenAddress] },
    // 5.7 D9 — `circuitRelayTransport` is ALWAYS wired (after the direct
    // transport): the dial-THROUGH-relay capability a 'none' node needs to
    // reach a relayed peer; inert for a node that never touches a relay.
    transports: [config.transport === 'memory' ? memory() : tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Gossipsub declares the `@libp2p/identify` capability as a hard
    // `serviceDependency` (it tags/penalizes peers via identify). libp2p
    // 3.3.11 ships NO defaults, so `identify()` must be registered here or
    // `createLibp2p` throws `UnmetServiceDependenciesError`.
    // 5.7 D9 — `runOnLimitedConnection: true` lets gossip flow over relayed
    // (limited) connections (a no-op for direct ones).
    services: {
      gossip: gossipsub({ runOnLimitedConnection: true }),
      identify: identify(),
      // 5.7 D8 — the relay role registers the circuit-relay SERVER (serves
      // hops to reserved clients); 'none'/'client' nodes carry no server.
      ...(config.relayRole === 'relay' ? { circuitRelay: circuitRelayServer() } : {}),
    },
    // 5.3 D2/D3 — the discovery services (real `bootstrap` over the genesis
    // list; the mDNS double over memory / real `mdns()` over tcp). Empty when
    // neither `bootstrap` nor `mdns` is set → discovery OFF (AC-4, additive).
    peerDiscovery: buildPeerDiscovery(config),
    // 5.3 D4 (critical) — CONSTRUCT but do NOT START. `createLibp2p` otherwise
    // awaits `node.start()` internally, and `components.start()` runs every
    // Startable discovery service's `start()` at that point (the mDNS double
    // emits its `peer` events then). The node-level `peer:discovery` dial
    // listener (below) would be attached AFTER that internal start and would
    // MISS the early event. With `start: false` the node is only constructed;
    // the two listeners are attached here, and the adapter's `start()` then
    // calls `node.start()` — so the listener is in place before any discovery
    // service can fire (D4: "registered before `node.start()`, so it cannot
    // miss an early event").
    start: false,
  })

  // 5.2 D5 — observe all four class topics. Registered before `node.start()`,
  // so no message can slip past the subscription window. Each message is
  // DECODED as its topic's envelope; the topic alone selects the class (no
  // class discriminator on the wire).
  node.services.gossip.addEventListener('message', (event: Event) => {
    const msg = (event as CustomEvent<Message>).detail
    const entry = decodeReceived(msg.topic, msg.data)
    if (entry !== null) {
      received.set(entry.class, [...(received.get(entry.class) ?? []), entry.env])
    }
  })

  // 5.4 — register the sync STREAM handler (request/response over a
  // dedicated libp2p stream, D1 — NOT a gossip topic). Registered BEFORE
  // `node.start()` (buildNode runs first) so the protocol is advertised
  // once the node is up — a dialer that connects after `node.start()` finds
  // the protocol already handled (multistream-select routing). The handler
  // reads the CURRENT source lazily (the operator may `setSyncSource` after
  // `start()`).
  await node.handle(SYNC_PROTOCOL, makeSyncHandler(getSource))

  // 5.3 D4 — ONE node-level `peer:discovery` listener dials discovered peers.
  // Registered before `node.start()` (buildNode runs first) so it cannot miss
  // an early event. For each discovered non-self `PeerInfo`, dial the first
  // announced multiaddr fire-and-forget with the 10 s bound (AD-3 — a
  // timeout, not a clock read); a failed dial is ignored (the peer may
  // already be connected via bootstrap's auto-dial, or transiently
  // unreachable — normal, never a throw). This ADDS discovery-driven
  // connecting alongside 5.1's explicit `dial()` (AC-5 — not a replacement).
  node.addEventListener('peer:discovery', (event) => {
    const info = event.detail
    if (info.id.toString() === node.peerId.toString()) return
    const ma = info.multiaddrs[0]
    if (ma === undefined) return
    void node
      .dial(ma, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) })
      .catch(() => {
        /* fire-and-forget: a failed dial is a NORMAL ignore (spine). */
      })
  })

  return node
}

/**
 * Decode a received envelope by its topic (5.2 D4/D5). Returns the topic
 * class + decoded envelope, or `null` if the topic is not one of the four
 * class topics (non-topic messages are ignored, as 5.1 ignored everything
 * off the scratch topic).
 */
function decodeReceived(
  topic: string,
  data: Uint8Array,
): { class: TopicClass; env: ReceivedEnvelope } | null {
  switch (topic) {
    case TOPICS.blocks: {
      const env = BlockEnvelope.decode(data)
      return { class: 'blocks', env: { sourcePeerId: env.sourcePeerId, payload: env.block } }
    }
    case TOPICS.tickets: {
      const env = TicketEnvelope.decode(data)
      return { class: 'tickets', env: { sourcePeerId: env.sourcePeerId, payload: env.ticket } }
    }
    case TOPICS.tx: {
      const env = TxEnvelope.decode(data)
      return { class: 'tx', env: { sourcePeerId: env.sourcePeerId, payload: env.tx } }
    }
    case TOPICS.peers: {
      const env = PeerInfoEnvelope.decode(data)
      return {
        class: 'peers',
        env: { sourcePeerId: env.sourcePeerId, payload: env.peerInfo },
      }
    }
    case TOPICS.announcements: {
      const env = AnnouncementEnvelope.decode(data)
      return {
        class: 'announcements',
        env: { sourcePeerId: env.sourcePeerId, payload: env.announcement },
      }
    }
    case TOPICS.introductions: {
      const env = IntroductionEnvelope.decode(data)
      return {
        class: 'introductions',
        env: { sourcePeerId: env.sourcePeerId, payload: env.introduction },
      }
    }
    default:
      return null
  }
}

/**
 * 5.7 D8 — the minimal structural views the reservation helper needs.
 * The `libp2p` root exports the `Libp2p` INTERFACE (no `components`
 * member); the concrete class carries `components.transportManager` at
 * runtime, so the helper reads it through `NodeWithTransportManager`. And
 * `circuitRelayTransport()` returns a FACTORY (the package does not export
 * the transport class), so the instantiated transport is located by its
 * `Symbol.toStringTag` and read through `CircuitReservationSeam`:
 * `reservationStore.addRelay(peer, 'configured')` registers the client's
 * circuit reservation on that relay.
 * INTERNAL — not exported.
 */
interface NodeWithTransportManager {
  components: {
    transportManager: {
      getTransports(): unknown[]
    }
  }
}
interface CircuitReservationSeam {
  reservationStore: {
    addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>
  }
}

/**
 * 5.7 D8/D9 — register a circuit reservation on the relay a client-role
 * node just dialed. The 'configured' relay type — deliberately NOT the
 * circuit LISTEN / 'discovered' path: a 'discovered' reservation needs a
 * PENDING reservation (which only exists behind a circuit listen, and the
 * client role listens on nothing — `addresses.listen = []`), and the
 * circuit listener's `addedRelay` would confirm the relay's process-local
 * `/memory/...` reservation addr via `confirmObservedAddr`, throwing
 * `InvalidParametersError` (non-IP/DNS) inside a library-internal event
 * handler — an uncatchable uncaughtException (libp2p 3.3.11 +
 * @libp2p/circuit-relay-v2 4.2.13). A 'configured' `addRelay` needs no
 * pending reservation and, with no circuit listener registered, nothing
 * confirms the reservation addrs. The `addRelay` also runs the RESERVE
 * handshake, which creates the RELAY-side reservation entry the relay's
 * hop handler checks (`get(dstPeer)` + an open connection to it); the
 * client-side entry additionally keeps the NATed node's own `onStop` off
 * the crashing circuit-listen path.
 * Fire-and-forget: a failed reservation is a NORMAL outcome (spine — never
 * a throw); a later relay-proxied dial then simply fails (NO_RESERVATION)
 * and the operator retries.
 * INTERNAL — driven by `dial(relayAddress)`, not on the NetPort surface.
 */
function reserveCircuitOnRelay(
  node: Libp2p<Services> & NodeWithTransportManager,
  relayPeer: PeerId,
): void {
  const transport = node.components.transportManager
    .getTransports()
    .find(
      (t) =>
        Object.prototype.toString.call(t) ===
        '[object @libp2p/circuit-relay-v2-transport]',
    ) as unknown as CircuitReservationSeam | undefined
  if (transport === undefined) return
  void transport.reservationStore.addRelay(relayPeer, 'configured').catch(() => {
    /* a failed reservation is a NORMAL outcome (spine) — never a throw. */
  })
}

/**
 * `createNetAdapter` — the pure factory (D2). Stores the config, returns
 * the adapter object. The libp2p node is created only inside `start()`, so
 * a `'tcp'` config can be constructed headlessly without opening a socket.
 */
export function createNetAdapter(config: NetAdapterConfig): NetAdapter {
  const received = new Map<TopicClass, ReceivedEnvelope[]>()
  let node: Libp2p<Services> | null = null
  // 5.4 — the sync source (server side). Captured by `buildNode`'s handler
  // via a GETTER so the operator may `setSyncSource` after `start()` (the
  // handler reads the current source at stream-open time). `null` = no
  // source (inbound sync requests yield zero blocks).
  let syncSource: SyncSource | null = null
  const getSyncSource = (): SyncSource | null => syncSource

  function requireNode(): Libp2p<Services> {
    if (node === null) {
      throw new Error(
        'SC-NET-1: net adapter is not started — call start() before this operation',
      )
    }
    return node
  }

  /**
   * Publish one envelope on its class topic (5.2 D4). Single-shot (D6: the
   * retry / `allowPublishToZeroTopicPeers` decision is DEFERRED to 5.5).
   */
  async function publish(topic: string, data: Uint8Array): Promise<void> {
    await requireNode().services.gossip.publish(topic, data)
  }

  return {
    async start() {
      // Idempotent: a second start() on a running adapter is a no-op; a
      // start() after stop() re-creates a fresh node.
      if (node !== null) return
      node = await buildNode(config, received, getSyncSource)
      await node.start()
      // 5.2 D4 — subscribe to ALL class topics (the 5.1 scratch topic is
      // gone; six since 8.3's announcements + 8.4's introductions classes).
      await node.services.gossip.subscribe(TOPICS.blocks)
      await node.services.gossip.subscribe(TOPICS.tickets)
      await node.services.gossip.subscribe(TOPICS.tx)
      await node.services.gossip.subscribe(TOPICS.peers)
      await node.services.gossip.subscribe(TOPICS.announcements)
      await node.services.gossip.subscribe(TOPICS.introductions)
    },
    async stop() {
      // Idempotent (5.1 test row 1: stop() is called twice, must not throw).
      if (node === null) return
      await node.stop()
      node = null
    },
    sendBlock(block: unknown) {
      // `NetPort.send*(unknown)` per 1.2 — the adapter casts to the
      // generated proto type (callers pass proto-conformant objects).
      return publish(
        TOPICS.blocks,
        BlockEnvelope.encode({ block: block as Block, sourcePeerId: config.protocolIdentityId }),
      )
    },
    sendTicket(ticket: unknown) {
      return publish(
        TOPICS.tickets,
        TicketEnvelope.encode({ ticket: ticket as Ticket, sourcePeerId: config.protocolIdentityId }),
      )
    },
    sendTx(tx: unknown) {
      return publish(
        TOPICS.tx,
        TxEnvelope.encode({ tx: tx as Tx, sourcePeerId: config.protocolIdentityId }),
      )
    },
    sendPeerInfo(peerInfo: unknown) {
      // NOT on the `NetPort` — peer info is the gossip/discovery surface
      // (5.3 drives it); exposed here so the peers class round-trips in 5.2.
      return publish(
        TOPICS.peers,
        PeerInfoEnvelope.encode({ peerInfo: peerInfo as PeerInfo, sourcePeerId: config.protocolIdentityId }),
      )
    },
    sendAnnouncement(announcement: PeerAnnouncement) {
      // NOT on the `NetPort` — CAP-7 discovery surface (8.3). The loop
      // publishes ONLY validated announcements (verify-before-relay).
      return publish(
        TOPICS.announcements,
        AnnouncementEnvelope.encode({ announcement, sourcePeerId: config.protocolIdentityId }),
      )
    },
    sendIntroduction(introduction: Introduction) {
      // NOT on the `NetPort` — CAP-7 discovery surface (8.4). The loop
      // publishes ONLY its own signed or validated introductions.
      return publish(
        TOPICS.introductions,
        IntroductionEnvelope.encode({ introduction, sourcePeerId: config.protocolIdentityId }),
      )
    },
    async peers() {
      return requireNode().getPeers().map((p) => p.toString())
    },
    async dial(address: string) {
      const ma = multiaddr(address)
      const conn = await requireNode().dial(ma, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) })
      // 5.7 D8 — client role: dialing the CONFIGURED relay registers a
      // circuit reservation on it (the operator's explicit dial drives the
      // capability — the adapter never auto-dials). Fire-and-forget: a
      // failed reservation is a NORMAL outcome (the relay may be offline or
      // not speak the hop codec) — see `reserveCircuitOnRelay`.
      if (
        config.relayRole === 'client' &&
        config.relayAddress !== undefined &&
        address === config.relayAddress
      ) {
        // The runtime node is the concrete `Libp2p` class (it carries
        // `components`); the root export is the interface without it.
        void reserveCircuitOnRelay(
          requireNode() as Libp2p<Services> & NodeWithTransportManager,
          conn.remotePeer,
        )
      }
    },
    peerId() {
      return requireNode().peerId.toString()
    },
    listenAddresses() {
      // 8.5 — the announce-address source for CAP-7 announcements: the
      // node's REAL bound listen addresses (ephemeral `tcp/0` resolved).
      return requireNode().getMultiaddrs().map((ma) => ma.toString())
    },
    // 5.4 — chain sync (D7/D8 — NOT on the 1.2 `NetPort`).
    setSyncSource(source: SyncSource | null) {
      // Store the source the registered stream handler reads LAZILY at
      // stream-open time (the handler is registered in `start()`, before the
      // operator may call this — the getter is the seam). `null` clears it
      // (inbound sync requests then yield zero blocks, a normal stop).
      syncSource = source
    },
    syncFrom(peer: string, request: SyncRequest) {
      // The CLIENT (D4/D7): delegate to the transport client, dialing the
      // node's own `dialProtocol` (the 5.1 `dial` mechanism — an explicit
      // connection, not discovery). The multiaddr string is parsed to the
      // `DialTarget` `dialProtocol` accepts (the same `multiaddr()` the
      // adapter's `dial` uses). Returns the `AsyncIterable` of decoded
      // `SyncBlock`s (stream order — the server streams them `fromSlot` →
      // head, D2). NOT `async`: the transport client returns the iterable
      // synchronously (the dial is lazy, inside the generator).
      return syncFrom(requireNode(), multiaddr(peer), request)
    },
    get received() {
      return received
    },
  }
}
