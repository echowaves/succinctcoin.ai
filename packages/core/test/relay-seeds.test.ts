/**
 * 10.2 — relay seed bootstrap (`net/adapter.ts` hold loop + announce).
 *
 * Memory transport, zero real sockets (AD-10); bounded polls, pinned seeds,
 * no clock reads / RNG in test cadence (AD-3) — the established 5.7 driver
 * discipline. The rows:
 *
 *   SEED_HOLD        relay + seeded client ⇒ the client HOLDS a reservation
 *                    (bounded poll on its own announce surface):
 *                    `listenAddresses()` grows `<seed>/p2p-circuit/p2p/<self>`
 *                    alongside the direct address; an ok event fires. A third
 *                    node then dials the reservation THROUGH the relay — in
 *                    the peer-id-prefixed form (5.7: the memory dial filter
 *                    rejects `/memory/...` circuit prefixes; on tcp the
 *                    announced full-prefix form IS the dialable one and the
 *                    policy accepts it — pinned by the address-policy rows) —
 *                    and the relayed connection is bidirectional.
 *   EMPTY_DEFAULT    no seeds ⇒ zero events, announce set byte-identical to
 *                    pre-10.2 (the empty-default pin, E3).
 *   BAD_SEEDS        junk / parseable-but-no-/p2p seeds: exactly ONE failure
 *                    event each (skipped, never retried), boot unharmed, and
 *                    a GOOD seed in the same list still holds.
 *   DEAD_SEED_BOUNDED  relay absent ⇒ exactly SEED_ATTEMPTS=3 failures then
 *                    silence; no throw; stop() mid-retry cancels (no events
 *                    after stop).
 *   LOSS_DETECT      held reservation's relay stops ⇒ the circuit address
 *                    LEAVES listenAddresses() (connection:close) and re-hold
 *                    attempts are bounded. (Success-after-restart needs a
 *                    stable transport key — real relays persist theirs; the
 *                    adapter regenerates per node, so only the loss half is
 *                    provable headless.)
 */
import { describe, expect, it } from 'vitest'

import { createNetAdapter, deriveIdentityKeypair } from '../src/index.js'
import type { NetAdapter, RelaySeedEvent } from '../src/index.js'

const TRANSPORT = 'memory' as const
const RELAY_ADDRESS = '/memory/rs-relay'
const CLIENT_ADDRESS = '/memory/rs-client'
const THIRD_ADDRESS = '/memory/rs-third'

const SLEEP_MS = 25
const MAX_POLLS = 400 // 10 s bound per CHEAP poll (listenAddresses) — 5.x convention
/**
 * Dial-retry discipline (5.7, hardened for a degraded machine): an adapter
 * dial can cost its FULL 10 s timeout under starvation, so every test-side
 * dial attempt is raced against a short wall — the loop bound below times
 * the retries, never the transport.
 */
const DIAL_POLLS = 60
const DIAL_RACE_MS = 600
function dialRaced(a: NetAdapter, address: string): Promise<void> {
  const p = a.dial(address)
  p.catch(() => {}) // if the race wins, the late dial outcome is irrelevant — never unhandled
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('test-side dial race elapsed')), DIAL_RACE_MS)
    }),
  ])
}
const SEED_ATTEMPTS = 3 // adapter constant — pinned by DEAD_SEED_BOUNDED
const FAST_RETRY_MS = 10 // shrink the adapter's retry spacing for tests

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}
function identity(i: number): string {
  return deriveIdentityKeypair(seedFor(i)).identityId
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Start a plain relay-server adapter (5.7 'relay' role). */
async function startRelay(): Promise<NetAdapter> {
  const relay = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: RELAY_ADDRESS,
    protocolIdentityId: identity(1),
    relayRole: 'relay',
  })
  await relay.start()
  return relay
}

describe('10.2 — relay seed bootstrap (memory, headless)', () => {
  it('SEED_HOLD: held reservation appears in listenAddresses; a third node dials through the relay', async () => {
    const events: RelaySeedEvent[] = []
    const relay = await startRelay()
    const client = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(2),
      relaySeeds: [`${RELAY_ADDRESS}/p2p/${relay.peerId()}`],
      onRelaySeed: (e) => events.push(e),
    })
    const third = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: THIRD_ADDRESS,
      protocolIdentityId: identity(3),
    })
    await client.start()
    await third.start()
    try {
      // The hold lands: the announced set gains the circuit address.
      const clientId = client.peerId()
      const circuit = `${RELAY_ADDRESS}/p2p/${relay.peerId()}/p2p-circuit/p2p/${clientId}`
      let held = false
      for (let i = 0; i < MAX_POLLS && !held; i += 1) {
        held = client.listenAddresses().includes(circuit)
        if (!held) await sleep(SLEEP_MS)
      }
      expect(held).toBe(true)
      expect(events.some((e) => e.ok && e.seed === `${RELAY_ADDRESS}/p2p/${relay.peerId()}`)).toBe(true)
      // The direct address is STILL there (seeds are additive).
      expect(client.listenAddresses()).toContain(`${CLIENT_ADDRESS}/p2p/${clientId}`)

      // Dial THROUGH the relay — peer-id-prefixed form (5.7 dial-filter law);
      // the third must know the relay first (the hop reuses that connection).
      const relayProxied = `/p2p/${relay.peerId()}/p2p-circuit/p2p/${clientId}`
      let dialed = false
      for (let i = 0; i < DIAL_POLLS && !dialed; i += 1) {
        try {
          await dialRaced(third, `${RELAY_ADDRESS}/p2p/${relay.peerId()}`)
          await dialRaced(third, relayProxied)
          dialed = (await third.peers()).includes(clientId)
        } catch {
          /* reservation/hop races are normal — bounded retry */
        }
        if (!dialed) await sleep(SLEEP_MS)
      }
      expect(dialed).toBe(true)
      // Bidirectional: the client learned the third over the relayed conn.
      let seen = false
      for (let i = 0; i < MAX_POLLS && !seen; i += 1) {
        seen = (await client.peers()).includes(third.peerId())
        if (!seen) await sleep(SLEEP_MS)
      }
      expect(seen).toBe(true)
    } finally {
      await third.stop()
      await client.stop()
      await relay.stop()
    }
  })

  it('EMPTY_DEFAULT: no seeds ⇒ no events, announce set unchanged', async () => {
    const events: RelaySeedEvent[] = []
    const a = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(4),
      onRelaySeed: (e) => events.push(e),
    })
    await a.start()
    try {
      expect(a.listenAddresses()).toEqual([
        `${CLIENT_ADDRESS}/p2p/${a.peerId()}`,
      ])
      await sleep(50) // quiet window (review F4): nothing EVER arrives
    } finally {
      await a.stop()
    }
    expect(events).toEqual([])
  })

  it('BAD_SEEDS: junk + missing-/p2p seeds fail once each (skipped, not retried); good seed still holds', async () => {
    const events: RelaySeedEvent[] = []
    const relay = await startRelay()
    const good = `${RELAY_ADDRESS}/p2p/${relay.peerId()}`
    const client = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(5),
      relaySeeds: ['not-a-multiaddr', RELAY_ADDRESS, good],
      onRelaySeed: (e) => events.push(e),
      relaySeedRetryMs: FAST_RETRY_MS,
    })
    await client.start()
    try {
      let held = false
      for (let i = 0; i < MAX_POLLS && !held; i += 1) {
        held = client.listenAddresses().some((x) => x.includes('/p2p-circuit/'))
        if (!held) await sleep(SLEEP_MS)
      }
      expect(held).toBe(true)
      const fails = (seed: string): number =>
        events.filter((e) => e.seed === seed && !e.ok).length
      expect(fails('not-a-multiaddr')).toBe(1) // skipped: parse failure
      expect(fails(RELAY_ADDRESS)).toBe(1) // skipped: no /p2p component
      expect(events.some((e) => e.seed === good && e.ok)).toBe(true)
    } finally {
      await client.stop()
      await relay.stop()
    }
  })

  it('DEAD_SEED_BOUNDED: absent relay ⇒ exactly SEED_ATTEMPTS failures, then silence; stop() cancels', async () => {
    // A valid peer id for the (never-started) dead relay:
    const ghost = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: '/memory/rs-ghost',
      protocolIdentityId: identity(6),
    })
    await ghost.start()
    const ghostId = ghost.peerId()
    await ghost.stop()

    const events: RelaySeedEvent[] = []
    const client = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(7),
      relaySeeds: [`${RELAY_ADDRESS}/p2p/${ghostId}`],
      onRelaySeed: (e) => events.push(e),
      relaySeedRetryMs: FAST_RETRY_MS,
    })
    await client.start()
    try {
      for (let i = 0; i < MAX_POLLS && events.length < SEED_ATTEMPTS; i += 1) {
        await sleep(SLEEP_MS)
      }
      expect(events.length).toBe(SEED_ATTEMPTS) // bounded — never a 4th
      expect(events.every((e) => !e.ok)).toBe(true)
      expect(client.reachability()).toBe('unknown') // boot unharmed
    } finally {
      await client.stop()
    }
    // No events after stop (epoch-dropped):
    const afterStop = events.length
    await sleep(10 * FAST_RETRY_MS + 50)
    expect(events.length).toBe(afterStop)
  })

  it('LOSS_DETECT: relay stops ⇒ circuit address leaves the announce set; re-hold is bounded', async () => {
    const events: RelaySeedEvent[] = []
    const relay = await startRelay()
    const seed = `${RELAY_ADDRESS}/p2p/${relay.peerId()}`
    const client = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: CLIENT_ADDRESS,
      protocolIdentityId: identity(8),
      relaySeeds: [seed],
      onRelaySeed: (e) => events.push(e),
      relaySeedRetryMs: FAST_RETRY_MS,
    })
    await client.start()
    try {
      let held = false
      for (let i = 0; i < MAX_POLLS && !held; i += 1) {
        held = client.listenAddresses().some((x) => x.includes('/p2p-circuit/'))
        if (!held) await sleep(SLEEP_MS)
      }
      expect(held).toBe(true)

      await relay.stop() // the connection closes → loss
      let lost = false
      for (let i = 0; i < MAX_POLLS && !lost; i += 1) {
        lost = !client.listenAddresses().some((x) => x.includes('/p2p-circuit/'))
        if (!lost) await sleep(SLEEP_MS)
      }
      expect(lost).toBe(true)
      // The loss TRIGGERS a re-hold episode (review F2: pin that it runs,
      // not just that it bounds) — and that episode is BOUNDED at exactly
      // SEED_ATTEMPTS failures (the dead relay can never answer).
      const fails0 = () => events.filter((e) => !e.ok).length
      for (let i = 0; i < 120 && fails0() < SEED_ATTEMPTS; i += 1) {
        await sleep(SLEEP_MS)
      }
      expect(fails0()).toBe(SEED_ATTEMPTS) // re-held AND bounded — never a 4th
      const settled = fails0()
      await sleep(4 * FAST_RETRY_MS + 50)
      expect(fails0()).toBe(settled) // …and the episode ENDS
    } finally {
      await client.stop()
    }
  })
})
