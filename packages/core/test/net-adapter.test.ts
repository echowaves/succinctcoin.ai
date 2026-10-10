/**
 * 5.1 — libp2p adapter scaffold over @libp2p/memory (epic-node-network, R1,
 * AD-8/AD-10).
 *
 * Two in-process nodes connect over the memory transport (zero real sockets)
 * and exchange one raw message on the scratch gossipsub topic; the adapter
 * implements the FULL 1.2 `NetPort` surface plus the `dial`/`peerId`/
 * `receivedMessages` extensions. The tcp transport flag is present (row 5)
 * but never started — AD-10 holds.
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest`) — no deep
 * imports into src/net or src/proto (5.1 test rule).
 *
 * Rows (plan Matrix):
 *   CONNECT_AND_EXCHANGE          two nodes dial; A's block lands byte-exact
 *   FULL_NETPORT_SURFACE          all 6 NetPort methods + 3 extensions present
 *   SEND_TICKET_AND_TX            ticket + tx payloads round-trip byte-for-byte
 *   PEERS_EMPTY_BEFORE_CONNECT    peers() honest-empty; peerId() non-empty
 *   TCP_TRANSPORT_PRESENT         factory accepts 'tcp' and stays pure
 */
import { describe, expect, it } from 'vitest'

import { createNetAdapter } from '../src/index.js'
import type { NetAdapterConfig } from '../src/index.js'

// Explicit timeout on the connected rows: gossipsub delivery (mesh/heartbeat
// handshake after dial) can take a moment.
const CONNECT_TIMEOUT_MS = 30_000
// Bounded test-side waiting: fixed sleep count × small sleep (NO wall-clock
// reads anywhere in this file — the plan's "no Math.random / wall-clock"
// applies to the test as well).
const SLEEP_MS = 25
const MAX_POLLS = 400 // 400 × 25ms = ≤10s

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
 * Run `op` until it resolves (bounded retry, ≤10s). The first publish on the
 * scratch topic can race B's SUBSCRIBE landing on A — until A's gossipsub
 * knows of a subscribed peer, `publish` rejects with
 * `PublishError.NoPeersSubscribedToTopic`. The retry is test-side waiting:
 * the adapter's send methods themselves are single-shot.
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

/** Start A (listens /memory/a) + B (listens /memory/b) and dial them. */
async function connectPair(): Promise<{ a: ReturnType<typeof createNetAdapter>, b: ReturnType<typeof createNetAdapter> }> {
  const a = createNetAdapter({ transport: 'memory', listenAddress: '/memory/a' })
  const b = createNetAdapter({ transport: 'memory', listenAddress: '/memory/b' })
  await a.start()
  await b.start()
  await b.dial('/memory/a')
  return { a, b }
}

describe('CONNECT_AND_EXCHANGE — two nodes connect and exchange one message (R1, AD-10)', () => {
  it('B dials A; A sendBlock → B receives the exact UTF-8 JSON bytes; stops idempotent', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      // Dial is bidirectional at the connection level — peers() is honest on
      // BOTH sides.
      const aPeers = await a.peers()
      const bPeers = await b.peers()
      expect(aPeers).toContain(b.peerId())
      expect(bPeers).toContain(a.peerId())

      await publishUntilAccepted(() => a.sendBlock({ slot: 1, note: 'hello' }))
      const expected = new TextEncoder().encode(JSON.stringify({ slot: 1, note: 'hello' }))
      const delivered = await pollUntil(() => b.receivedMessages.length >= 1)
      expect(delivered).toBe(true)
      // EXACTLY one message: one publish, one subscriber.
      expect(b.receivedMessages.length).toBe(1)
      expect(bytesEqual(b.receivedMessages[0], expected)).toBe(true)
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
  it('all 6 NetPort methods + dial/peerId/receivedMessages are present; peers() honest-empty', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const adapter = createNetAdapter({ transport: 'memory', listenAddress: '/memory/surface' })

    // Contract shape: the six NetPort methods…
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
    expect(typeof adapter.sendBlock).toBe('function')
    expect(typeof adapter.sendTicket).toBe('function')
    expect(typeof adapter.sendTx).toBe('function')
    expect(typeof adapter.peers).toBe('function')
    // …and the three 5.1 extensions.
    expect(typeof adapter.dial).toBe('function')
    expect(typeof adapter.peerId).toBe('function')
    expect(Array.isArray(adapter.receivedMessages)).toBe(true)

    await adapter.start()
    try {
      // No peers dialed → honest empty (no throw).
      expect(await adapter.peers()).toEqual([])
      expect(adapter.receivedMessages).toEqual([])
      // peerId() is non-empty even before any connection (transport identity,
      // D1 — libp2p's own keypair, derived at node construction).
      expect(adapter.peerId()).not.toBe('')
    } finally {
      await adapter.stop()
    }
  })
})

describe('SEND_TICKET_AND_TX — ticket + tx payloads round-trip byte-for-byte (R1, AD-5)', () => {
  it('A sends a ticket then a tx (decimal strings); B receives both, in order', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const { a, b } = await connectPair()
    try {
      const ticket = { identityId: 'x', windowIndex: 1 }
      const tx = { amount: '1.5', fee: '0.001' }
      await publishUntilAccepted(() => a.sendTicket(ticket))
      await a.sendTx(tx)

      const delivered = await pollUntil(() => b.receivedMessages.length === 2)
      expect(delivered).toBe(true)

      const expectedTicket = new TextEncoder().encode(JSON.stringify(ticket))
      const expectedTx = new TextEncoder().encode(JSON.stringify(tx))
      // Order is preserved: gossipsub's `sendRpc` is fire-and-forget (a
      // synchronous `outboundStream.push`, not awaited), but both publishes
      // push onto the SAME ordered outbound stream for the single peer, so the
      // ticket's RPC precedes the tx's RPC. The `await` merely serializes the
      // two pushes; the shared ordered stream is what guarantees receipt order.
      expect(bytesEqual(b.receivedMessages[0], expectedTicket)).toBe(true)
      expect(bytesEqual(b.receivedMessages[1], expectedTx)).toBe(true)
    } finally {
      await a.stop()
      await b.stop()
    }
  })
})

describe('PEERS_EMPTY_BEFORE_CONNECT — peers() is honest (NetPort.peers)', () => {
  it('fresh started adapter: peers() === [] and peerId() non-empty', { timeout: CONNECT_TIMEOUT_MS }, async () => {
    const adapter = createNetAdapter({ transport: 'memory', listenAddress: '/memory/lone' })
    await adapter.start()
    try {
      expect(await adapter.peers()).toEqual([])
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
    const config: NetAdapterConfig = {
      transport: 'tcp',
      listenAddress: '/ip4/127.0.0.1/tcp/0',
    }
    const adapter = createNetAdapter(config)
    expect(typeof adapter.start).toBe('function')
    expect(Array.isArray(adapter.receivedMessages)).toBe(true)
    // Do NOT call start() — it would open a real socket (AD-10).
  })
})
