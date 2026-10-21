/**
 * Ticket 7 — auto-relay adapter wiring (`net/adapter.ts` + `net/auto-relay.ts`).
 *
 * Memory transport, zero real sockets (AD-10); injected reachability drives
 * the trigger edge (the 10.1 `reachabilitySource` seam) — no clock reads or
 * RNG in test cadence (AD-3), bounded polls throughout. The rows:
 *
 *   AUTO_HOLD        proven-unreachable auto node with a hop-advertising
 *                    DIRECT peer ⇒ the adapter discovers it (peer store hop
 *                    codec over the direct connection), HOLDS a circuit
 *                    through it (same events + announce surface as manual
 *                    seeds), and a THIRD node dials that circuit through the
 *                    relay — bidirectionally.
 *   AUTO_SERVE       an 'auto' node with NO explicit `relayRole` SERVES hops:
 *                    a seeded client reserves through it (construction-time
 *                    reach is 'unknown', and serving unknown is the policy).
 *   REACHABLE        reachable auto node with the same direct peer ⇒ NOTHING
 *                    is held — no circuit address, no events, ever.
 *   EXPLICIT_ONLY    absent `relayAuto` + proven-unreachable + hop-capable
 *                    direct peer ⇒ still nothing (byte-identical to today:
 *                    the kill-switch path never arms a round, never serves).
 *   SERVES_WHEN_UNREACHABLE  pinned limitation: the server decision is made
 *                    at construction and NEVER re-evaluated — a node that
 *                    later learns it is unreachable keeps serving until
 *                    restart (peer-side selection self-corrects refusals).
 */
import { describe, expect, it } from 'vitest'

import { createNetAdapter, deriveIdentityKeypair } from '../src/index.js'
import type { NetAdapter, RelaySeedEvent } from '../src/index.js'

const TRANSPORT = 'memory' as const
const HUB_ADDRESS = '/memory/ar-hub'
const NODE_B_ADDRESS = '/memory/ar-node-b'
const THIRD_ADDRESS = '/memory/ar-third'
const CLIENT_ADDRESS = '/memory/ar-client'

const SLEEP_MS = 25
const MAX_POLLS = 400 // 10 s bound per CHEAP poll — 5.x convention
/** Shrink the auto-round top-up cadence (default 15_000) for tests. */
const FAST_AUTO_MS = 250
/**
 * Dial-retry discipline (5.7): every test-side dial is raced against a short
 * wall; the loop bound times the retries, never the transport.
 */
const DIAL_POLLS = 60
const DIAL_RACE_MS = 600
function dialRaced(a: NetAdapter, address: string): Promise<void> {
  const p = a.dial(address)
  p.catch(() => {}) // a lost race must never surface as unhandled
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('test-side dial race elapsed')), DIAL_RACE_MS)
    }),
  ])
}

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x50 + i)
}
function identity(i: number): string {
  return deriveIdentityKeypair(seedFor(i)).identityId
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** An adapter with the reachability seam attached: `send` drives the tracker. */
function makeSeamed(
  name: string,
  i: number,
  extra: Partial<Parameters<typeof createNetAdapter>[0]>,
) {
  let report: ((addr: string, reachable: boolean) => void) | null = null
  const net = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: name,
    protocolIdentityId: identity(i),
    reachabilitySource: (cb) => {
      report = cb
      return () => {}
    },
    ...extra,
  })
  const send = (addr: string, reachable: boolean): void => {
    if (report === null) throw new Error('reachability seam not subscribed')
    report(addr, reachable)
  }
  return { net, send }
}

/** Bounded direct dial with the 5.7 retry loop. */
async function dialUntil(a: NetAdapter, address: string): Promise<void> {
  for (let i = 0; i < DIAL_POLLS; i += 1) {
    try {
      await dialRaced(a, address)
      return
    } catch {
      await sleep(SLEEP_MS) // transport warm-up races are normal
    }
  }
  throw new Error(`dial never succeeded: ${address}`)
}

describe('ticket 7 — auto-relay adapter wiring (memory, headless)', () => {
  it('AUTO_HOLD: unreachable + hop-capable direct peer ⇒ circuit held and a third node dials through', async () => {
    const events: RelaySeedEvent[] = []
    // The hub is an ordinary AUTO node — no `relayRole` anywhere: serving
    // (and being picked) is pure policy.
    const hub = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: HUB_ADDRESS,
      protocolIdentityId: identity(1),
      relayAuto: 'auto',
    })
    const { net: b, send } = makeSeamed(NODE_B_ADDRESS, 2, {
      relayAuto: 'auto',
      autoRelayRetryMs: FAST_AUTO_MS,
      onRelaySeed: (e: RelaySeedEvent) => events.push(e),
    })
    const third = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: THIRD_ADDRESS,
      protocolIdentityId: identity(3),
    })
    await hub.start()
    await b.start()
    await third.start()
    try {
      // B knows the hub over a DIRECT connection (the candidate source).
      await dialUntil(b, `${HUB_ADDRESS}/p2p/${hub.peerId()}`)
      const hubId = hub.peerId()
      const bId = b.peerId()
      expect((await b.peers()).includes(hubId)).toBe(true)

      // The trigger edge: B is proven unreachable on its only address.
      const bAddr = b.listenAddresses()[0] as string
      send(bAddr, false)
      expect(b.reachability()).toBe('unreachable')

      // The auto hold lands — same announce surface as a manual seed (the
      // discovered seed text is the hub's live direct address + peer id).
      const circuit = `${HUB_ADDRESS}/p2p/${hubId}/p2p-circuit/p2p/${bId}`
      let held = false
      for (let i = 0; i < MAX_POLLS && !held; i += 1) {
        held = b.listenAddresses().includes(circuit)
        if (!held) await sleep(SLEEP_MS)
      }
      expect(held).toBe(true)
      // Honesty still holds (10.1): the proven-dead direct address is GONE,
      // the circuit stays announced — B is now reachable ONLY via the relay.
      const announced = b.listenAddresses()
      expect(announced).not.toContain(bAddr)
      expect(announced).toContain(circuit)
      // Same events as manual seeds:
      expect(events.some((e) => e.ok && e.seed === `${HUB_ADDRESS}/p2p/${hubId}`)).toBe(
        true,
      )

      // A third node dials B THROUGH the hub — peer-id-only circuit form
      // (5.7 dial-filter law), relay known first (the hop reuses that conn).
      let dialed = false
      for (let i = 0; i < DIAL_POLLS && !dialed; i += 1) {
        try {
          await dialRaced(third, `${HUB_ADDRESS}/p2p/${hubId}`)
          await dialRaced(third, `/p2p/${hubId}/p2p-circuit/p2p/${bId}`)
          dialed = (await third.peers()).includes(bId)
        } catch {
          /* reservation/hop races are normal — bounded retry */
        }
        if (!dialed) await sleep(SLEEP_MS)
      }
      expect(dialed).toBe(true)
      // Bidirectional over the relayed connection:
      let seen = false
      for (let i = 0; i < MAX_POLLS && !seen; i += 1) {
        seen = (await b.peers()).includes(third.peerId())
        if (!seen) await sleep(SLEEP_MS)
      }
      expect(seen).toBe(true)

      // stop() stands the round chain down: no events after the quiet window.
      const settled = events.length
      await b.stop()
      await sleep(4 * FAST_AUTO_MS + 50)
      expect(events.length).toBe(settled)
    } finally {
      await third.stop().catch(() => {})
      await b.stop().catch(() => {})
      await hub.stop().catch(() => {})
    }
  }, 60_000)

  it('AUTO_SERVE: an auto node with no relayRole serves hops to a seeded client', async () => {
    const events: RelaySeedEvent[] = []
    const hub = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: HUB_ADDRESS,
      protocolIdentityId: identity(11),
      relayAuto: 'auto', // NO relayRole — policy serves (reach 'unknown')
    })
    await hub.start()
    const seed = `${HUB_ADDRESS}/p2p/${hub.peerId()}`
    const client2 = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(13),
      relaySeeds: [seed],
      onRelaySeed: (e) => events.push(e),
    })
    try {
      await client2.start()
      let held = false
      for (let i = 0; i < MAX_POLLS && !held; i += 1) {
        held = client2.listenAddresses().some((x) => x.includes('/p2p-circuit/'))
        if (!held) await sleep(SLEEP_MS)
      }
      expect(held).toBe(true)
      expect(events.some((e) => e.ok && e.seed === seed)).toBe(true)
    } finally {
      await client2.stop().catch(() => {})
      await hub.stop().catch(() => {})
    }
  }, 30_000)

  it('REACHABLE: a reachable auto node with a hop-capable peer holds NOTHING', async () => {
    const events: RelaySeedEvent[] = []
    const hub = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: HUB_ADDRESS,
      protocolIdentityId: identity(21),
      relayAuto: 'auto',
    })
    const { net: b, send } = makeSeamed(NODE_B_ADDRESS, 22, {
      relayAuto: 'auto',
      autoRelayRetryMs: FAST_AUTO_MS,
      onRelaySeed: (e: RelaySeedEvent) => events.push(e),
    })
    await hub.start()
    await b.start()
    try {
      await dialUntil(b, `${HUB_ADDRESS}/p2p/${hub.peerId()}`)
      send(b.listenAddresses()[0] as string, true) // proven REACHABLE
      expect(b.reachability()).toBe('reachable')
      // A generous window (several round cadences): nothing ever arrives.
      await sleep(4 * FAST_AUTO_MS + 100)
      expect(b.listenAddresses().some((x) => x.includes('/p2p-circuit/'))).toBe(false)
      expect(events).toEqual([])
    } finally {
      await b.stop().catch(() => {})
      await hub.stop().catch(() => {})
    }
  }, 30_000)

  it('EXPLICIT_ONLY: absent relayAuto + unreachable + hop peer ⇒ nothing (today, byte-identical)', async () => {
    const events: RelaySeedEvent[] = []
    const hub = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: HUB_ADDRESS,
      protocolIdentityId: identity(31),
      // NO relayAuto anywhere — the kill-switch default (explicit-only).
    })
    const { net: b, send } = makeSeamed(NODE_B_ADDRESS, 32, {
      autoRelayRetryMs: FAST_AUTO_MS,
      onRelaySeed: (e: RelaySeedEvent) => events.push(e),
    })
    await hub.start()
    await b.start()
    try {
      await dialUntil(b, `${HUB_ADDRESS}/p2p/${hub.peerId()}`)
      send(b.listenAddresses()[0] as string, false) // proven UNREACHABLE
      expect(b.reachability()).toBe('unreachable')
      await sleep(4 * FAST_AUTO_MS + 100)
      // No circuit appears… and the hub serves nothing either (no server on
      // an explicit-only construction-time decision): B's announce set is
      // exactly what 10.1 honesty leaves — the direct address, proven-dead.
      expect(b.listenAddresses().some((x) => x.includes('/p2p-circuit/'))).toBe(false)
      expect(events).toEqual([])
    } finally {
      await b.stop().catch(() => {})
      await hub.stop().catch(() => {})
    }
  }, 30_000)

  it('SERVES_WHEN_UNREACHABLE: pinned limitation — the server never stops mid-run', async () => {
    const events: RelaySeedEvent[] = []
    // The hub is auto (so it serves while 'unknown') AND seamed: after it is
    // proven unreachable its server KEEPS running (no dynamic stop/start —
    // rejected on the 10.3 pin review's grounds; peer-side selection absorbs
    // refusals). A client seeded through it still holds.
    const { net: hub, send } = makeSeamed(HUB_ADDRESS, 41, { relayAuto: 'auto' })
    await hub.start()
    const seed = `${HUB_ADDRESS}/p2p/${hub.peerId()}`
    send(hub.listenAddresses()[0] as string, false) // hub proven dead-ish…
    expect(hub.reachability()).toBe('unreachable')
    const client = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(42),
      relaySeeds: [seed],
      onRelaySeed: (e) => events.push(e),
    })
    await client.start()
    try {
      let held = false
      for (let i = 0; i < MAX_POLLS && !held; i += 1) {
        held = client.listenAddresses().some((x) => x.includes('/p2p-circuit/'))
        if (!held) await sleep(SLEEP_MS)
      }
      expect(held).toBe(true) // …and it still served the reservation
    } finally {
      await client.stop().catch(() => {})
      await hub.stop().catch(() => {})
    }
  }, 30_000)
})
