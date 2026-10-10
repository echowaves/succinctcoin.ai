/**
 * `core/net` — the libp2p adapter (epic 5, AD-8/AD-10/AD-12).
 *
 * 5.1 scaffold + 5.2 topics/envelopes: the adapter implements the FULL 1.2
 * `NetPort` surface (`start`/`stop`/`sendBlock`/`sendTicket`/`sendTx`/
 * `peers`) over libp2p (3.3.11) with `noise` + `yamux` + `gossipsub`
 * (17.1.2). Each message class publishes a PROTO ENVELOPE on its OWN stable
 * topic (5.2, AD-8 "one stable topic per message class"):
 *
 *   sendBlock(block)    → BlockEnvelope    on TOPICS.blocks
 *   sendTicket(ticket)  → TicketEnvelope   on TOPICS.tickets
 *   sendTx(tx)          → TxEnvelope       on TOPICS.tx
 *   sendPeerInfo(info)  → PeerInfoEnvelope on TOPICS.peers  (helper, not on NetPort)
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
 *   never CI-exercised). bootstrap/mdns services are 5.3,
 *   circuitRelayTransport is 5.7 — the DEPS are pinned now, wired later.
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
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

import type { Libp2p } from 'libp2p'
import type { GossipSub, Message } from '@libp2p/gossipsub'
import type { Identify } from '@libp2p/identify'
import type { NetPort } from '../ports.js'
import {
  Block,
  Ticket,
  Tx,
  PeerInfo,
  BlockEnvelope,
  TicketEnvelope,
  TxEnvelope,
  PeerInfoEnvelope,
} from '../proto/index.js'
import { TOPICS } from './topics.js'
import type { TopicClass } from './topics.js'

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
  /** Publish a `PeerInfoEnvelope` on `TOPICS.peers`. NOT on the `NetPort` —
   *  peer info is the gossip/discovery surface (5.3 drives it); exposed
   *  here so the peers class round-trips in 5.2. */
  sendPeerInfo(peerInfo: unknown): Promise<void>
  /**
   * Decoded envelopes received on the four class topics (5.2 D5), keyed by
   * topic class. Test observability for now; 5.5 routes the receive path
   * into the core (acceptance path / accepted-set construction).
   */
  readonly received: ReadonlyMap<TopicClass, ReceivedEnvelope[]>
}

/** The service map this adapter's node carries.
 *  `createLibp2p<T>` requires `T extends Record<string, unknown>`; a local
 *  alias keeps the index signature that an `interface` would lose.
 *  `identify` is present because gossipsub hard-depends on it (see
 *  buildNode's services comment). */
type Services = Record<string, unknown> & { gossip: GossipSub; identify: Identify }

/**
 * Build the libp2p node for `config` (D7: transport selected by flag; both
 * paths use noise + yamux). Gossipsub is registered as the `gossip` service;
 * the `message` handler decodes each received envelope on its topic into
 * `received` (5.2 D5). The transport keypair is auto-generated internally
 * by libp2p (D1) — never exposed or read here.
 */
async function buildNode(
  config: NetAdapterConfig,
  received: Map<TopicClass, ReceivedEnvelope[]>,
): Promise<Libp2p<Services>> {
  const node = await createLibp2p<Services>({
    addresses: { listen: [config.listenAddress] },
    transports: [config.transport === 'memory' ? memory() : tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Gossipsub declares the `@libp2p/identify` capability as a hard
    // `serviceDependency` (it tags/penalizes peers via identify). libp2p
    // 3.3.11 ships NO defaults, so `identify()` must be registered here or
    // `createLibp2p` throws `UnmetServiceDependenciesError`.
    services: { gossip: gossipsub(), identify: identify() },
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
    default:
      return null
  }
}

/**
 * `createNetAdapter` — the pure factory (D2). Stores the config, returns
 * the adapter object. The libp2p node is created only inside `start()`, so
 * a `'tcp'` config can be constructed headlessly without opening a socket.
 */
export function createNetAdapter(config: NetAdapterConfig): NetAdapter {
  const received = new Map<TopicClass, ReceivedEnvelope[]>()
  let node: Libp2p<Services> | null = null

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
      node = await buildNode(config, received)
      await node.start()
      // 5.2 D4 — subscribe to ALL FOUR class topics (the 5.1 scratch
      // topic is gone).
      await node.services.gossip.subscribe(TOPICS.blocks)
      await node.services.gossip.subscribe(TOPICS.tickets)
      await node.services.gossip.subscribe(TOPICS.tx)
      await node.services.gossip.subscribe(TOPICS.peers)
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
    async peers() {
      return requireNode().getPeers().map((p) => p.toString())
    },
    async dial(address: string) {
      const ma = multiaddr(address)
      await requireNode().dial(ma, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) })
    },
    peerId() {
      return requireNode().peerId.toString()
    },
    get received() {
      return received
    },
  }
}
