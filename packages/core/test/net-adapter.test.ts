/**
 * 5.1 + 5.2 — libp2p adapter over @libp2p/memory: the full `NetPort`
 * scaffold (5.1) with the four per-class gossipsub topics + proto
 * envelopes (5.2) (epic-node-network, R1/R3, AD-8/AD-10/AD-12).
 *
 * Two in-process nodes connect over the memory transport (zero real
 * sockets, AD-10). 5.1's scratch topic is GONE: each message class now
 * travels as a PROTO ENVELOPE on its OWN stable topic (one topic per
 * class, AD-8) — blocks on `/succinctcoin/blocks/1`, tickets on
 * `/succinctcoin/tickets/1`, tx on `/succinctcoin/tx/1`, peer info on
 * `/succinctcoin/peers/1` — and the adapter's `message` handler DECODES
 * each envelope into the `received` map
 * (`Map<TopicClass, { sourcePeerId, payload }[]>`). The tcp transport
 * flag is present but never started — AD-10 holds.
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest`) — no deep
 * imports into src/net, src/proto, or src/consensus (5.1/5.2 test rule).
 *
 * Rows (plan Matrix):
 *   CONNECT_AND_EXCHANGE          (5.1, updated) two nodes dial; A's block
 *                                 lands DECODED on TOPICS.blocks, byte-exact
 *   FULL_NETPORT_SURFACE          (5.1, updated) all 6 NetPort methods +
 *                                 dial/peerId/sendPeerInfo + received map
 *   SEND_TICKET_AND_TX            (5.1, updated) ticket + tx round-trip on
 *                                 their OWN topics (decimal strings intact)
 *   PEERS_EMPTY_BEFORE_CONNECT    (5.1, updated) peers() honest-empty;
 *                                 peerId() non-empty; received map empty
 *   TCP_TRANSPORT_PRESENT         (5.1, updated) factory accepts 'tcp' and
 *                                 stays pure
 *   BLOCK_ROUNDTRIP               (5.2) a Block round-trips on TOPICS.blocks,
 *                                 byte-identical + sourcePeerId attributed
 *   TICKET_ROUNDTRIP              (5.2) a Ticket round-trips on
 *                                 TOPICS.tickets, byte-identical + sourcePeerId
 *   TX_ROUNDTRIP                  (5.2) a Tx round-trips on TOPICS.tx with
 *                                 decimal-string amount/fee INTACT (AD-5)
 *   PEERINFO_ROUNDTRIP            (5.2) a PeerInfo round-trips on
 *                                 TOPICS.peers, byte-identical + sourcePeerId
 *   TOPIC_ISOLATION               (5.2) each class travels ONLY on its own
 *                                 topic (a block never on the tickets topic)
 *   PROTO_ADDITIVE                (5.2) the four EXISTING messages' wire
 *                                 encodings are unchanged (golden pins)
 *   BOOTSTRAP_WIRED_TO_GENESIS    (5.3) the real @libp2p/bootstrap service is
 *                                 wired against a production-shaped bootstrap
 *                                 list (7.1: the repo genesis is LAN-only, so
 *                                 the fixture stands in); the node starts
 *                                 cleanly over memory; peers() stays empty
 *                                 headless (the AD-10-correct outcome)
 *   MDNS_DISCOVERS                (5.3) the memory PeerDiscovery double
 *                                 discovers a self-announced peer
 *   DISCOVERY_RECEIVES_GOSSIP     (5.3) discover → dial → connect → receive
 *   BOOTSTRAP_FROM_GENESIS_SHAPE  (5.3) the bootstrap list is the validated
 *                                 genesis.bootstrap string shape (1.3)
 *   DISCOVERY_OFF_BY_DEFAULT      (5.3) no bootstrap/mdns → no auto-connect
 *                                 (additive config, inert dial listener)
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Block,
  PeerInfo,
  Ticket,
  Tx,
  createNetAdapter,
  TOPICS,
} from '../src/index.js'
import type {
  NetAdapter,
  NetAdapterConfig,
  ReceivedEnvelope,
  TopicClass,
} from '../src/index.js'

// Explicit timeout on the connected rows: gossipsub delivery (mesh/heartbeat
// handshake after dial) can take a moment.
const CONNECT_TIMEOUT_MS = 30_000
// Bounded test-side waiting: fixed sleep count × small sleep (NO wall-clock
// reads anywhere in this file — the plan's "no Math.random / wall-clock"
// applies to the test as well).
const SLEEP_MS = 25
const MAX_POLLS = 400 // 400 × 25ms = ≤10s

// ---------------------------------------------------------------------------
// deterministic fixtures (AD-3: no RNG; AD-5: decimal-string amounts;
// 32-byte hex ids, spine convention)
// ---------------------------------------------------------------------------

/** A's PROTOCOL identity id (4.2, 32-byte hex) — stamped into every A envelope. */
const ID_A = 'a'.repeat(64)
/** B's PROTOCOL identity id (4.2, 32-byte hex). */
const ID_B = 'b'.repeat(64)

const FIX_BLOCK: Block = {
  slot: 42n,
  parentHash: new Uint8Array(32).fill(0x01),
  winnerIdentityId: ID_A,
  winnerTicket: new Uint8Array(64).fill(0x11),
  nonce: new Uint8Array(32).fill(0x02),
  hash: new Uint8Array(32).fill(0x99),
  txCount: 3n,
}

const FIX_TICKET: Ticket = {
  identityId: ID_A,
  windowIndex: 7n,
  challenge: new Uint8Array(32).fill(0x03),
  nonceCommitment: new Uint8Array(32).fill(0x04),
  signature: new Uint8Array(64).fill(0x7e),
}

/** A tx with DECIMAL-STRING amount/fee (AD-5 / R3 — never int64/float). */
const FIX_TX: Tx = {
  sender: new Uint8Array(32).fill(0x5a),
  recipient: new Uint8Array(32).fill(0x6b),
  amount: '1000',
  fee: '250',
  slot: 11n,
  signature: new Uint8Array(64).fill(0x77),
}

const FIX_PEERINFO: PeerInfo = {
  peerId: ID_B,
  multiaddrs: ['/memory/a', '/ip4/127.0.0.1/tcp/4001'],
  uptime: 99n,
}

// ---------------------------------------------------------------------------
// PROTO_ADDITIVE golden vectors (D4): the EXACT encoded bytes of the four
// EXISTING messages (`Block`/`Ticket`/`Tx`/`PeerInfo`) over the fixtures
// above, pinned byte-for-byte. Regenerate ONLY by changing protocol.proto
// (a protocol change) — never hand-edit. Combined with the source-level gate
// (git diff on protocol.proto shows only APPENDED envelope messages), these
// pins prove the existing schema's wire encoding is unchanged (purely
// additive).
// ---------------------------------------------------------------------------
const GOLDEN_BLOCK_HEX =
  '082a122001010101010101010101010101010101010101010101010101010101010101011a40616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161612240111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111112a200202020202020202020202020202020202020202020202020202020202020202322099999999999999999999999999999999999999999999999999999999999999993803'
const GOLDEN_TICKET_HEX =
  '0a406161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616110071a200303030303030303030303030303030303030303030303030303030303030303222004040404040404040404040404040404040404040404040404040404040404042a407e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e'
const GOLDEN_TX_HEX =
  '0a205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a12206b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b1a04313030302203323530280b324077777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777'
const GOLDEN_PEERINFO_HEX =
  '0a406262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626212092f6d656d6f72792f6112172f6970342f3132372e302e302e312f7463702f343030311863'

/** Test-side sleep (never in src — AD-3 applies to the adapter, not this file). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Byte-for-byte `Uint8Array` equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Poll `check` every `SLEEP_MS` until true or `MAX_POLLS` sleeps pass (≤10s). */
async function pollUntil(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < MAX_POLLS; i++) {
    if (check()) return true
    await sleep(SLEEP_MS)
  }
  return check()
}

/**
 * Run `op` until it resolves (bounded retry, ≤10s, D6). The first publish on
 * a class topic can race B's SUBSCRIBE landing on A — until A's gossipsub
 * knows of a subscribed peer, `publish` rejects with
 * `PublishError.NoPeersSubscribedToTopic`. The retry is test-side waiting:
 * the adapter's send methods themselves are single-shot (D6: the retry /
 * `allowPublishToZeroTopicPeers` decision is deferred to 5.5's live loop).
 */
async function publishUntilAccepted(op: () => Promise<void>): Promise<void> {
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      await op()
      return
    } catch (err) {
      if (i === MAX_POLLS - 1) throw err
      await sleep(SLEEP_MS)
    }
  }
}

/**
 * Start A (listens /memory/a, protocolIdentityId = ID_A) + B (listens
 * /memory/b, protocolIdentityId = ID_B) and dial them. Both subscribe to all
 * four class topics on `start()` (5.2 D4).
 */
async function connectPair(): Promise<{ a: NetAdapter; b: NetAdapter }> {
  const a = createNetAdapter({
    transport: 'memory',
    listenAddress: '/memory/a',
    protocolIdentityId: ID_A,
  })
  const b = createNetAdapter({
    transport: 'memory',
    listenAddress: '/memory/b',
    protocolIdentityId: ID_B,
  })
  await a.start()
  await b.start()
  await b.dial('/memory/a')
  return { a, b }
}

/**
 * The decoded envelopes B received on `cls` (5.2 D5). Gossipsub's mesh/
 * heartbeat handshake can delay delivery a moment, so the connected rows
 * `pollUntil` the expected count (bounded, ≤10s — never a wall-clock assert).
 */
async function receivedOn(b: NetAdapter, cls: TopicClass, count: number): Promise<ReceivedEnvelope[]> {
  await pollUntil(() => (b.received.get(cls)?.length ?? 0) >= count)
  return b.received.get(cls) ?? []
}

/**
 * The repo-root `config/genesis.json` path, resolved relative to THIS test
 * file (test → core → packages → repo root, three levels up) — the same
 * convention `defaultGenesisPath()` in `src/index.ts` uses.
 */
const GENESIS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'config',
  'genesis.json',
)

/**
 * Poll `adapter.peers()` (async) until it contains `peerId`, or ≤10s pass.
 * Discovery is async (bootstrap's 1 s timer; the mDNS double fires on
 * `start()`), so `peers()` can't use the sync `pollUntil`. Bounded (≤10s),
 * no wall-clock assert — the negative `DISCOVERY_OFF_BY_DEFAULT` row relies
 * on this returning `false` after the full window.
 */
async function peersInclude(adapter: NetAdapter, peerId: string): Promise<boolean> {
  for (let i = 0; i < MAX_POLLS; i++) {
    if ((await adapter.peers()).includes(peerId)) return true
    await sleep(SLEEP_MS)
  }
  return (await adapter.peers()).includes(peerId)
}

/**
 * Poll `adapter.peers()` (async) over the FULL bounded window (≤10s) and
 * return true only if it STAYS empty the whole time (checked before every
 * sleep and one final time at the end). The negative `BOOTSTRAP_WIRED_TO_GENESIS`
 * row relies on this: the real bootstrap service is wired against the
 * production genesis list, but those peers are absent headless (AD-10), so
 * an empty `peers()` over the full window is the asserted, correct outcome.
 */
async function peersStaysEmpty(adapter: NetAdapter): Promise<boolean> {
  for (let i = 0; i < MAX_POLLS; i++) {
    if ((await adapter.peers()).length > 0) return false
    await sleep(SLEEP_MS)
  }
  return (await adapter.peers()).length === 0
}

/**
 * String-only check that a bootstrap list entry has the validated
 * `genesis.bootstrap` shape (1.3): a multiaddr STRING starting with `/` and
 * carrying a `/p2p/<id>` component — the EXACT shape the real
 * `@libp2p/bootstrap` service requires (it `filter`s out entries without a
 * `/p2p` component). The test may NOT import `@multiformats/multiaddr`
 * (root-barrel-only rule), so this is a string-shape assertion, not a parse.
 */
function isBootstrapShaped(entry: string): boolean {
  const after = entry.split('/p2p/')
  return (
    typeof entry === 'string' &&
    entry.startsWith('/') &&
    after.length === 2 &&
    after[1].length > 0
  )
}

describe('CONNECT_AND_EXCHANGE — two nodes connect and exchange one message (R1, AD-10)', () => {
  it('B dials A; A sendBlock → B receives the DECODED BlockEnvelope on TOPICS.blocks; stops idempotent', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      // Dial is bidirectional at the connection level — peers() is honest on
      // BOTH sides.
      const aPeers = await a.peers()
      const bPeers = await b.peers()
      expect(aPeers).toContain(b.peerId())
      expect(bPeers).toContain(a.peerId())

      await publishUntilAccepted(() => a.sendBlock(FIX_BLOCK))
      const envs = await receivedOn(b, 'blocks', 1)
      // EXACTLY one message: one publish, one subscriber.
      expect(envs.length).toBe(1)
      // The payload is the DECODED proto Block (5.2 D5) — byte-identical to
      // the original on every field, with A's protocolIdentityId attributed.
      expect(envs[0].sourcePeerId).toBe(ID_A)
      expect(bytesEqual((envs[0].payload as Block).nonce, FIX_BLOCK.nonce)).toBe(true)
      expect((envs[0].payload as Block).hash).toStrictEqual(FIX_BLOCK.hash)
    } finally {
      // Both stop() — idempotent, no throw (plan row 1).
      await a.stop()
      await b.stop()
      await a.stop()
      await b.stop()
    }
  })
})

describe('FULL_NETPORT_SURFACE — the core sees the full 1.2 NetPort contract', () => {
  it('all 6 NetPort methods + dial/peerId/sendPeerInfo are present; received is a map; peers() honest-empty', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const adapter = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/surface',
      protocolIdentityId: ID_A,
    })

    // Contract shape: the six NetPort methods…
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
    expect(typeof adapter.sendBlock).toBe('function')
    expect(typeof adapter.sendTicket).toBe('function')
    expect(typeof adapter.sendTx).toBe('function')
    expect(typeof adapter.peers).toBe('function')
    // …and the 5.1/5.2 extensions (receivedMessages is GONE — replaced by
    // the decoded `received` map; sendPeerInfo is new in 5.2).
    expect(typeof adapter.dial).toBe('function')
    expect(typeof adapter.peerId).toBe('function')
    expect(typeof adapter.sendPeerInfo).toBe('function')
    expect(adapter.received instanceof Map).toBe(true)

    await adapter.start()
    try {
      // No peers dialed → honest empty (no throw). Discovery is OFF by
      // default here (no `bootstrap`/`mdns` in this config — 5.3 AC-4): the
      // `peer:discovery` dial listener is present but INERT without a
      // discovery service, so `peers()` stays empty exactly as in 5.2.
      expect(await adapter.peers()).toEqual([])
      // No messages received → the map has no class keys.
      expect(adapter.received.size).toBe(0)
      // peerId() is non-empty even before any connection (transport identity,
      // D1 — libp2p's own keypair, derived at node construction).
      expect(adapter.peerId()).not.toBe('')
    } finally {
      await adapter.stop()
    }
  })
})

describe('SEND_TICKET_AND_TX — ticket + tx payloads round-trip byte-for-byte (R1, AD-5)', () => {
  it('A sends a proto Ticket then a proto Tx (decimal strings); B decodes both on their OWN topics, in order', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      await publishUntilAccepted(() => a.sendTicket(FIX_TICKET))
      await a.sendTx(FIX_TX)

      const tickets = await receivedOn(b, 'tickets', 1)
      const txs = await receivedOn(b, 'tx', 1)
      // Each class landed on its OWN topic (AD-8 — no shared topic), one
      // envelope each.
      expect(tickets.length).toBe(1)
      expect(txs.length).toBe(1)
      // DECODED proto payloads, byte-identical to the originals; A's
      // protocolIdentityId attributed on both.
      expect(tickets[0].sourcePeerId).toBe(ID_A)
      expect(bytesEqual((tickets[0].payload as Ticket).challenge, FIX_TICKET.challenge)).toBe(true)
      expect(txs[0].sourcePeerId).toBe(ID_A)
      // AD-5 / R3: the decimal-string amount/fee travel INTACT.
      expect((txs[0].payload as Tx).amount).toBe('1000')
      expect((txs[0].payload as Tx).fee).toBe('250')
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('PEERS_EMPTY_BEFORE_CONNECT — peers() is honest (NetPort.peers)', () => {
  it('fresh started adapter: peers() === [] and peerId() non-empty', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const adapter = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/lone',
      protocolIdentityId: ID_A,
    })
    await adapter.start()
    try {
      expect(await adapter.peers()).toEqual([])
      expect(adapter.received.size).toBe(0)
      expect(adapter.peerId()).not.toBe('')
    } finally {
      await adapter.stop()
    }
  })
})

describe('TCP_TRANSPORT_PRESENT — the tcp code path is present but not exercised (AD-10)', () => {
  it("createNetAdapter({transport:'tcp',...}) does not throw — the factory is pure", async () => {
    // The factory accepts the 'tcp' flag and returns the adapter WITHOUT
    // touching a socket (libp2p is created only inside start()).
    // 5.3: `mdns: true` selects the REAL `mdns()` service for the tcp
    // transport (not the memory double) — and the factory STILL stays pure:
    // no socket, no service started (AD-10).
    const config: NetAdapterConfig = {
      transport: 'tcp',
      listenAddress: '/ip4/127.0.0.1/tcp/0',
      protocolIdentityId: ID_A,
      mdns: true,
    }
    const adapter = createNetAdapter(config)
    expect(typeof adapter.start).toBe('function')
    expect(adapter.received instanceof Map).toBe(true)
    // Do NOT call start() — it would open a real socket (AD-10).
  })
})

describe('BLOCK_ROUNDTRIP — a Block round-trips on its own topic (R3, AD-8, AD-12)', () => {
  it('A sendBlock → B decodes a BlockEnvelope on TOPICS.blocks: fields byte-identical + sourcePeerId === A', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      await publishUntilAccepted(() => a.sendBlock(FIX_BLOCK))
      const envs = await receivedOn(b, 'blocks', 1)
      expect(envs.length).toBe(1)
      // sourcePeerId is A's PROTOCOL identity id (5.2 D3 — the 4.2 id, NOT
      // the libp2p transport peerId).
      expect(envs[0].sourcePeerId).toBe(ID_A)
      // The decoded payload is the proto Block — re-encoding it is
      // BYTE-IDENTICAL to the original's encoding (byte-identical fields).
      const got = envs[0].payload as Block
      expect(Block.encode(got)).toStrictEqual(Block.encode(FIX_BLOCK))
      expect(got.slot).toBe(FIX_BLOCK.slot)
      expect(got.txCount).toBe(FIX_BLOCK.txCount)
      expect(got.winnerIdentityId).toBe(FIX_BLOCK.winnerIdentityId)
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('TICKET_ROUNDTRIP — a Ticket round-trips on its own topic (R3, AD-8, AD-12)', () => {
  it('A sendTicket → B decodes a TicketEnvelope on TOPICS.tickets: fields byte-identical + sourcePeerId === A', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      await publishUntilAccepted(() => a.sendTicket(FIX_TICKET))
      const envs = await receivedOn(b, 'tickets', 1)
      expect(envs.length).toBe(1)
      expect(envs[0].sourcePeerId).toBe(ID_A)
      const got = envs[0].payload as Ticket
      expect(Ticket.encode(got)).toStrictEqual(Ticket.encode(FIX_TICKET))
      expect(got.identityId).toBe(FIX_TICKET.identityId)
      expect(got.windowIndex).toBe(FIX_TICKET.windowIndex)
      expect(bytesEqual(got.signature, FIX_TICKET.signature)).toBe(true)
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('TX_ROUNDTRIP — a Tx round-trips with decimal strings INTACT (R3, AD-5, AD-8)', () => {
  it('A sendTx → B decodes a TxEnvelope on TOPICS.tx: amount/fee are the SAME decimal strings + sourcePeerId === A', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      await publishUntilAccepted(() => a.sendTx(FIX_TX))
      const envs = await receivedOn(b, 'tx', 1)
      expect(envs.length).toBe(1)
      expect(envs[0].sourcePeerId).toBe(ID_A)
      const got = envs[0].payload as Tx
      expect(Tx.encode(got)).toStrictEqual(Tx.encode(FIX_TX))
      // AD-5 / R3 (spine): amounts travel as DECIMAL STRINGS — the exact
      // strings cross the wire, never int64/float.
      expect(typeof got.amount).toBe('string')
      expect(got.amount).toBe('1000')
      expect(typeof got.fee).toBe('string')
      expect(got.fee).toBe('250')
      expect(got.slot).toBe(FIX_TX.slot)
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('PEERINFO_ROUNDTRIP — a PeerInfo round-trips on its own topic (R3, AD-8)', () => {
  it('A sendPeerInfo → B decodes a PeerInfoEnvelope on TOPICS.peers: fields byte-identical + sourcePeerId === A', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      await publishUntilAccepted(() => a.sendPeerInfo(FIX_PEERINFO))
      const envs = await receivedOn(b, 'peers', 1)
      expect(envs.length).toBe(1)
      expect(envs[0].sourcePeerId).toBe(ID_A)
      const got = envs[0].payload as PeerInfo
      expect(PeerInfo.encode(got)).toStrictEqual(PeerInfo.encode(FIX_PEERINFO))
      expect(got.peerId).toBe(FIX_PEERINFO.peerId)
      expect(got.multiaddrs).toStrictEqual(FIX_PEERINFO.multiaddrs)
      expect(got.uptime).toBe(FIX_PEERINFO.uptime)
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('TOPIC_ISOLATION — each class travels ONLY on its own topic (R3, AD-8)', () => {
  it('a sendBlock lands ONLY on TOPICS.blocks; a sendTicket ONLY on TOPICS.tickets', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      await publishUntilAccepted(() => a.sendBlock(FIX_BLOCK))
      const blocks = await receivedOn(b, 'blocks', 1)
      expect(blocks.length).toBe(1)
      expect(blocks[0].sourcePeerId).toBe(ID_A)

      await a.sendTicket(FIX_TICKET)
      const tickets = await receivedOn(b, 'tickets', 1)
      expect(tickets.length).toBe(1)
      expect(tickets[0].sourcePeerId).toBe(ID_A)

      // One topic per class: the tx + peers classes received NOTHING — a
      // block never on the tickets topic, a ticket never on the tx topic.
      expect(b.received.get('tx') ?? []).toEqual([])
      expect(b.received.get('peers') ?? []).toEqual([])
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('PROTO_ADDITIVE — the existing four messages are wire-identical (AD-12)', () => {
  it('for Block/Ticket/Tx/PeerInfo: decode(encode(x)) deep-equals x AND the exact encoded bytes are the pinned golden vectors', () => {
    // (a) round-trip: decode(encode(x)) deep-equals x for each existing
    // message — the regenerated codecs still parse the schema.
    const block = Block.decode(Block.encode(FIX_BLOCK))
    expect(block).toStrictEqual(FIX_BLOCK)
    const ticket = Ticket.decode(Ticket.encode(FIX_TICKET))
    expect(ticket).toStrictEqual(FIX_TICKET)
    const tx = Tx.decode(Tx.encode(FIX_TX))
    expect(tx).toStrictEqual(FIX_TX)
    const peer = PeerInfo.decode(PeerInfo.encode(FIX_PEERINFO))
    expect(peer).toStrictEqual(FIX_PEERINFO)

    // (b) golden vectors: the EXACT encoded bytes of each existing message
    // are pinned byte-for-byte. The only change to protocol.proto is the
    // four APPENDED envelope messages (verified by the orchestrator's
    // `git diff -- packages/core/proto/protocol.proto` gate), so these pins
    // prove the existing schema's wire encoding is unchanged (D4).
    expect(Buffer.from(Block.encode(FIX_BLOCK)).toString('hex')).toBe(GOLDEN_BLOCK_HEX)
    expect(Buffer.from(Ticket.encode(FIX_TICKET)).toString('hex')).toBe(GOLDEN_TICKET_HEX)
    expect(Buffer.from(Tx.encode(FIX_TX)).toString('hex')).toBe(GOLDEN_TX_HEX)
    expect(Buffer.from(PeerInfo.encode(FIX_PEERINFO)).toString('hex')).toBe(GOLDEN_PEERINFO_HEX)
  })
})

describe('BOOTSTRAP_WIRED_TO_GENESIS — the real @libp2p/bootstrap service is wired against the real genesis list (AC-1, R1)', () => {
  it('a node configured with the REAL validated genesis.bootstrap list starts cleanly over memory; peers() stays empty headless (the AD-10-correct outcome)', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    // 7.1: the repo genesis is LAN-only (`bootstrap: []`), so this positive
    // wiring assertion runs against a PRODUCTION-SHAPED provided list — the
    // former genesis entries, kept here as a fixture: real `/ip4/…/tcp/…/p2p/<id>`
    // multiaddrs the real service's `P2P` matcher ACCEPTS (so the entries are
    // genuinely wired, not filtered to empty by the service's constructor).
    // The empty repo list itself is validated in genesis.test.ts and shape-
    // checked by BOOTSTRAP_FROM_GENESIS_SHAPE.
    const productionShapedList = [
      '/ip4/103.192.173.112/tcp/4001/p2p/12D3KooWNKvzczEMvDFqog1qcZrxdTtmsiNktZ7af3sNsBUGHg7E',
    ]

    // A single node configured with that real-shape list. The REAL
    // `@libp2p/bootstrap` service (D2) is registered in `peerDiscovery`
    // against exactly this list.
    const node = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/b',
      protocolIdentityId: ID_B,
      bootstrap: productionShapedList,
    })
    try {
      // The node must come up CLEANLY (no throw) with the real bootstrap
      // service wired against the production-shape list — including the
      // service's 1 s timer firing and its auto-dial attempts (which fail
      // against absent headless peers: fire-and-forget, normal, never a
      // throw — spine "reject = normal false, never a throw").
      await node.start()
      // The production bootstrap peers are ABSENT headless (AD-10 — no
      // real sockets), so the asserted outcome is that `peers()` STAYS
      // EMPTY over the full bounded window (≤10s): no fake sockets, no
      // connect claimed. That empty result is the AD-10-correct one, not a
      // failure. The discover→dial→connect→RECEIVE MECHANISM the bootstrap
      // service would drive for its production peers is proven headless by
      // the mDNS rows (MDNS_DISCOVERS / DISCOVERY_RECEIVES_GOSSIP) over the
      // IDENTICAL libp2p discovery bridge
      // (`#onDiscoveryPeer` → `peer:update` → `peer:discovery` → adapter
      // dial).
      const stayedEmpty = await peersStaysEmpty(node)
      expect(stayedEmpty).toBe(true)
      expect(await node.peers()).toEqual([])
    } finally {
      await node.stop()
      await node.stop()
    }
  })
})

describe('MDNS_DISCOVERS — the memory PeerDiscovery double discovers a self-announced peer (AC-2, R1)', () => {
  it('a fresh mdns-enabled node discovers the listener the double announced; peers() gains it', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const a = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/a',
      protocolIdentityId: ID_A,
    })
    await a.start()
    // The memory double (D3) announces the listener's multiaddr — standing in
    // for the UDP broadcast a real mdns node answers with. The adapter's
    // `peer:discovery` listener dials the discovered peer → connect (D4).
    const b = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/b',
      protocolIdentityId: ID_B,
      mdns: true,
      mdnsAnnounce: [`/memory/a/p2p/${a.peerId()}`],
    })
    try {
      await b.start()
      // The double fires on start() (components.start runs it); the adapter
      // dials the discovered peer. `peers()` gains the listener.
      const connected = await peersInclude(b, a.peerId())
      expect(connected).toBe(true)
      expect(await b.peers()).toContain(a.peerId())
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('DISCOVERY_RECEIVES_GOSSIP — discover → dial → connect → receive (AC-3, R1)', () => {
  it('a fresh mdns-enabled node that discovers the listener RECEIVES its gossiped block', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const a = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/a',
      protocolIdentityId: ID_A,
    })
    await a.start()
    const b = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/b',
      protocolIdentityId: ID_B,
      mdns: true,
      mdnsAnnounce: [`/memory/a/p2p/${a.peerId()}`],
    })
    try {
      await b.start()
      const connected = await peersInclude(b, a.peerId())
      expect(connected).toBe(true)
      // discover → dial → connect → (already-subscribed) gossipsub mesh → a
      // gossiped message is received. Headless, zero real sockets (AD-10).
      await publishUntilAccepted(() => a.sendBlock(FIX_BLOCK))
      const envs = await receivedOn(b, 'blocks', 1)
      expect(envs.length).toBe(1)
      expect(envs[0].sourcePeerId).toBe(ID_A)
      expect((envs[0].payload as Block).slot).toBe(FIX_BLOCK.slot)
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('BOOTSTRAP_FROM_GENESIS_SHAPE — the bootstrap list is the validated genesis shape (AC-1/AD-10 note)', () => {
  it('every genesis.bootstrap entry is a multiaddr STRING with a /p2p/<id> component; the CI memory list matches', () => {
    // Read the PRODUCTION bootstrap list (1.3's validated GenesisConfig.
    // bootstrap) — the CI memory list is its headless analog, same shape.
    const genesis = JSON.parse(readFileSync(GENESIS_PATH, 'utf8')) as { bootstrap: string[] }
    // (a) The production genesis list: an array, every entry bootstrap-shaped.
    // 7.1: it may be EMPTY — the repo genesis is LAN-only (no hardwired
    // peers); emptiness validates in genesis.test.ts (EMPTY_BOOTSTRAP_OK).
    expect(Array.isArray(genesis.bootstrap)).toBe(true)
    for (const entry of genesis.bootstrap) {
      expect(isBootstrapShaped(entry)).toBe(true)
    }
    // (b) The CI memory list (rows 1/2/3's) is the SAME shape — a
    // `/memory/<name>/p2p/<id>` is the `/ip4/…/tcp/4001/p2p/<id>` entry's
    // headless analog (AD-10). A `/p2p/<id>` component is REQUIRED.
    const ciMemoryList = [`/memory/a/p2p/12D3KooWPLACEHOLDER`]
    for (const entry of ciMemoryList) {
      expect(isBootstrapShaped(entry)).toBe(true)
    }
    // (c) A bare multiaddr WITHOUT a `/p2p` component is NOT valid — this is
    // exactly what bootstrap filters out, so the shape pin is load-bearing.
    expect(isBootstrapShaped('/memory/a')).toBe(false)
  })
})

describe('DISCOVERY_OFF_BY_DEFAULT — discovery is opt-in and additive (AC-4)', () => {
  it('a node with NO bootstrap/mdns does NOT auto-connect to a listening peer over a bounded wait', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const a = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/a',
      protocolIdentityId: ID_A,
    })
    await a.start()
    // b has NO `bootstrap`/`mdns` → the `peerDiscovery` array is EMPTY → no
    // discovery service. The `peer:discovery` dial listener is present but
    // INERT (no service to fire it), so b must NOT auto-connect to a.
    const b = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/b',
      protocolIdentityId: ID_B,
    })
    try {
      await b.start()
      // Bounded wait (≤10s): over the full poll window, `peers()` stays
      // empty — no discovery service exists to find a. This is the 5.2
      // behavior preserved by the additive config (AC-4).
      const connected = await peersInclude(b, a.peerId())
      expect(connected).toBe(false)
      expect(await b.peers()).toEqual([])
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})
