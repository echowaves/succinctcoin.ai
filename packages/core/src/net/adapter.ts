/**
 * `core/net` — the libp2p adapter (epic 5, AD-8/AD-10).
 *
 * 5.1 scaffold: the adapter implements the FULL 1.2 `NetPort` surface
 * (`start`/`stop`/`sendBlock`/`sendTicket`/`sendTx`/`peers`) plus the
 * `dial`/`peerId`/`receivedMessages` extensions the scaffold test needs,
 * over libp2p (3.3.11) with `noise` + `yamux` + `gossipsub` (17.1.2).
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
 * - **D3 — scratch topic.** 5.1 uses a single scratch topic
 *   `'/succinctcoin/scratch'`: the three send methods serialize their
 *   argument as a UTF-8 JSON string (a plain `Uint8Array` payload) and
 *   publish on it. Placeholder — 5.2 replaces it with the four
 *   class-specific topics + proto envelopes (AD-8).
 * - **D4 — transport flag.** `'memory'` → `@libp2p/memory` (the only path
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

/** The single 5.1 scratch topic (D3 — replaced by 5.2's per-class topics). */
const SCRATCH_TOPIC = '/succinctcoin/scratch'

/** The dial bound for `dial()` (D2 — a timeout, never a clock read). */
const DIAL_TIMEOUT_MS = 10_000

/**
 * Adapter factory config (D2).
 */
export interface NetAdapterConfig {
  /** 'memory' (CI path) or 'tcp' (production; present but not CI-exercised). */
  transport: 'memory' | 'tcp'
  /** Listen address. Memory: '/memory/<name>'. TCP: '/ip4/0.0.0.0/tcp/<port>'. */
  listenAddress: string
}

/**
 * The 5.1 adapter surface: the FULL 1.2 `NetPort` contract plus the
 * extensions the scaffold test (and 5.3's discovery) need (D2).
 */
export interface NetAdapter extends NetPort {
  /** Explicitly dial a peer by multiaddr string (5.1's connect mechanism;
   *  discovery-driven connecting is 5.3). 10s AbortSignal.timeout. */
  dial(address: string): Promise<void>
  /** The libp2p peer ID string of this node (transport identity — D1). */
  peerId(): string
  /** Raw payloads received on the scratch topic (test observability only —
   *  5.2+ routes the real receive path into the core). */
  readonly receivedMessages: Uint8Array[]
}

/**
 * Build the libp2p node for `config` (D4: transport selected by flag; both
 * paths use noise + yamux). Gossipsub is registered as the `gossip` service;
 * the scratch-topic `message` handler appends each received payload to
 * `receivedMessages` (D5). The transport keypair is auto-generated
 * internally by libp2p (D1) — never exposed or read here.
 */
async function buildNode(
  config: NetAdapterConfig,
  receivedMessages: Uint8Array[],
): Promise<Libp2p<Services>> {
  const node = await createLibp2p<Services>({
    addresses: { listen: [config.listenAddress] },
    transports: [config.transport === 'memory' ? memory() : tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Gossipsub declares the `@libp2p/identify` capability as a hard
    // `serviceDependency` (it tags/penalizes peers via identify). libp2p
    // 3.3.11 ships NO defaults, so `identify()` must be registered here or
    // `createLibp2p` throws `UnmetServiceDependenciesError`. See Plan Change
    // Log (the plan's D6 dep list omits `@libp2p/identify`; gossipsub
    // 17.1.2 requires it at node-construction time).
    services: { gossip: gossipsub(), identify: identify() },
  })

  // D5 — observe the scratch topic. Registered before `node.start()`, so no
  // message can slip past the subscription window.
  node.services.gossip.addEventListener('message', (event: Event) => {
    const msg = (event as CustomEvent<Message>).detail
    if (msg.topic === SCRATCH_TOPIC) {
      receivedMessages.push(msg.data)
    }
  })

  return node
}

/** The service map this adapter's node carries.
 *  `createLibp2p<T>` requires `T extends Record<string, unknown>`; a local
 *  alias keeps the index signature that an `interface` would lose.
 *  `identify` is present because gossipsub hard-depends on it (see above). */
type Services = Record<string, unknown> & { gossip: GossipSub; identify: Identify }

/**
 * `createNetAdapter` — the pure factory (D2). Stores the config, returns
 * the adapter object. The libp2p node is created only inside `start()`, so
 * a `'tcp'` config can be constructed headlessly without opening a socket.
 */
export function createNetAdapter(config: NetAdapterConfig): NetAdapter {
  const receivedMessages: Uint8Array[] = []
  let node: Libp2p<Services> | null = null

  function requireNode(): Libp2p<Services> {
    if (node === null) {
      throw new Error(
        'SC-NET-1: net adapter is not started — call start() before this operation',
      )
    }
    return node
  }

  /** D3 — the one private publish helper shared by the three send methods
   *  (5.2 splits them onto their own topics + proto envelopes). */
  async function publishScratch(payload: unknown): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(payload))
    await requireNode().services.gossip.publish(SCRATCH_TOPIC, data)
  }

  return {
    async start() {
      // Idempotent: a second start() on a running adapter is a no-op; a
      // start() after stop() re-creates a fresh node.
      if (node !== null) return
      node = await buildNode(config, receivedMessages)
      await node.start()
      node.services.gossip.subscribe(SCRATCH_TOPIC)
    },
    async stop() {
      // Idempotent (5.1 test row 1: stop() is called twice, must not throw).
      if (node === null) return
      await node.stop()
      node = null
    },
    sendBlock(block: unknown) {
      return publishScratch(block)
    },
    sendTicket(ticket: unknown) {
      return publishScratch(ticket)
    },
    sendTx(tx: unknown) {
      return publishScratch(tx)
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
    get receivedMessages() {
      return receivedMessages
    },
  }
}
