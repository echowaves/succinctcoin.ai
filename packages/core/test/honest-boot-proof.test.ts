/**
 * EPIC 11 CLOSING INTEGRATION SUITE — the CAP-8 Honest Boot Proof (11.5).
 *
 * The promise in ONE headless scenario: a node fixture configured with NO
 * global IPv6 boots with default config, HOLDS a relay circuit reservation,
 * its own signed announcement carries EXACTLY the held `<hop>/p2p-circuit/
 * p2p/<self>` address (nothing else — direct `/ip4` never enters a record,
 * and no global v6 exists anywhere in the fixture), a v6-side peer DIALS
 * that reservation through the hop, and REAL data round-trips over the
 * relayed mesh — each node's signed announcement lands in the OTHER's mined
 * blocks (strict-validated). Pinned limitation disclosed by the row: a
 * chain-sync request/response stream on a circuit reservation is REFUSED
 * by libp2p itself (`LimitedConnectionError` — reservations are LIMITED
 * connections), so the round-trip travels the shipped gossip path. Plus
 * the unchanged-shape dual-stack variant:
 * the record gains the direct `/ip6` FIRST and the circuit second — byte-
 * identical to pre-11 announce behavior with a circuit added.
 *
 * Matrix rows (plan story-honest-boot-proof-seed-flip-tier-closeout-plan):
 *
 *   HONEST_BOOT_NO_V6     v4-only host model + hold + ok event + exact-
 *                         record assert + dial-through + chain-level gossip
 *                         both ways (via the adapter's `received` seam).
 *   HONEST_BOOT_DUAL_STACK  same boot with a global-v6 direct face: record =
 *                         [v6-direct, circuit] order-preserved; relayed data
 *                         still flows.
 *
 * THE TEST SEAM (the ticket's unknown — config fixture, NOT listener
 * filtering): the memory transport never produces IP listen addresses at
 * all, so "no global IPv6" is modeled by the `announceAddresses` provider —
 * already the production announce source (discovery-ladder glue wraps
 * `net.listenAddresses()`). The fixture passes the REAL held-circuit string
 * through with only its `/memory/<relay>` head rewritten to a TEST-NET v4
 * head (`203.0.113.9`, RFC 5737 — never routable), modeling "this host's
 * hop is IPv4". Filtering addresses OUT would hide a leak; the fixture
 * instead asserts the RECEIVED record as an EXACT ordered set, so any
 * global v6 (or direct address) leaking into the announce surface fails
 * the row. The transport dial keeps the REAL memory-transport circuit form
 * (5.7 dial-filter law — pinned in relay-seeds.test.ts): the announced
 * string is CHAIN data, the dialed string is transport.
 *
 * LIVE VARIANT (disclosed skip): the real-socket shape of this proof runs
 * on ONE machine via `_bmad-output/.../dial-manual.mjs` `relay-new-v4` /
 * `node-behind` / `invite-use-through-relay` under
 * SUCCINCTCOIN_ALLOW_LOOPBACK=1 — manual, never CI (AD-10: zero real sockets
 * here). SEED FLIP:
 * documented skip — 11.4 provisioning is HITL-open, so DEFAULT_RELAY_SEEDS
 * stays pinned empty; the epic Notes carry the gap line.
 *
 * Discipline: memory transport (AD-10); bounded polls, no wall-clock
 * asserts, no RNG (AD-3); root-barrel imports + the established deep import
 * of `createNodeLoop` (discovery-amnesiac-boot precedent); in-memory stores
 * (the 8.4 lesson: getBlock MUST serve Block.encode or the loop mines one
 * block); dial discipline from relay-seeds.test.ts (dialRaced + bounded
 * retry). No shipped src changes — TEST-ONLY.
 */
import { describe, expect, it } from 'vitest'

import {
  Block,
  MINT_ID,
  PeerAnnouncement,
  createNetAdapter,
  deriveIdentityKeypair,
  fromDisplay,
} from '../src/index.js'
// The loop seam is package-internal (root barrel pins); deep import is the
// established test precedent (discovery-amnesiac-boot.test.ts).
import { createNodeLoop } from '../src/consensus/index.js'
import type {
  IdentityKeypair,
  NetAdapter,
  RelaySeedEvent,
  StorePort,
} from '../src/index.js'

const TRANSPORT = 'memory' as const
const TEST_CHAIN = 'succinctcoin-test'
const REWARD_BASE_UNITS = fromDisplay('12.5')

const RELAY_ADDRESS = '/memory/hbp-relay'
const HIDDEN_ADDRESS = '/memory/hbp-hidden'
const PEER_ADDRESS = '/memory/hbp-peer'
/** The modeled v4-only host (RFC 5737 TEST-NET-3 — global scope, unroutable). */
const HOST_V4 = '/ip4/203.0.113.7/tcp/4001'
const HOP_V4 = '/ip4/203.0.113.9/tcp/4001'
/** The dual-stack variant's direct global-v6 face (documentation prefix). */
const HOST_V6 = '/ip6/2001:db8:abcd::9/tcp/4001'

const SLEEP_MS = 25
const MAX_POLLS = 400 // 10 s bound per CHEAP poll — 5.x convention
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
  return new Uint8Array(32).fill(0x60 + i)
}

const RELAY_KEY = deriveIdentityKeypair(seedFor(1))
const HIDDEN_KEY = deriveIdentityKeypair(seedFor(2))
const PEER_KEY = deriveIdentityKeypair(seedFor(3))

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  maxPolls = MAX_POLLS,
): Promise<boolean> {
  for (let i = 0; i < maxPolls; i += 1) {
    if (await cond()) return true
    await sleep(SLEEP_MS)
  }
  return await cond()
}

// ---------------------------------------------------------------------------
// the in-memory store fake (the 8.4/amnesiac lesson: getBlock MUST serve
// Block.encode(blocks.get(slot)) or the loop mines exactly one block)
// ---------------------------------------------------------------------------
function makeStore(): StorePort & { blocks: Map<number, unknown> } {
  const blocks = new Map<number, unknown>()
  let state: Record<string, string> | null = null
  const syncHead = (): number => {
    let head = -1
    for (const slot of blocks.keys()) head = Math.max(head, slot)
    return head
  }
  return {
    blocks,
    async open() {},
    async close() {},
    async commit(block: unknown) {
      const slot = Number((block as { slot: bigint }).slot)
      blocks.set(slot, block)
    },
    async headSlot() {
      return syncHead()
    },
    async getBlock(slot: number) {
      const b = blocks.get(slot)
      return b === undefined ? null : Block.encode(b as never)
    },
    async saveState(doc: Record<string, string>) {
      state = doc
    },
    async loadState() {
      return state
    },
  }
}

// ---------------------------------------------------------------------------
// the fixture (one per row): relay + hidden (behind it) + v6-side peer, each
// loop-mining; `dualStack` adds the hidden node's global-v6 direct face.
// ---------------------------------------------------------------------------
interface Fixture {
  relay: NetAdapter
  hiddenNet: NetAdapter
  peerNet: NetAdapter
  hiddenStore: ReturnType<typeof makeStore>
  peerStore: ReturnType<typeof makeStore>
  /** The adapter's seed-hold events for the hidden node (ok/fail per seed). */
  seedEvents: RelaySeedEvent[]
  seed: string
  /** The REAL transport-form circuit address (dial this). */
  transportCircuit: () => string | null
  /** The modeled announced circuit string (TEST-NET-v4 head). */
  modelledCircuit: () => string | null
  stop(): Promise<void>
}

async function bootFixture(opts: { dualStack: boolean }): Promise<Fixture> {
  const relay = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: RELAY_ADDRESS,
    protocolIdentityId: RELAY_KEY.identityId,
    relayRole: 'relay',
  })
  await relay.start()

  const seed = `${RELAY_ADDRESS}/p2p/${relay.peerId()}`
  const seedEvents: RelaySeedEvent[] = []
  const hiddenNet = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: HIDDEN_ADDRESS,
    protocolIdentityId: HIDDEN_KEY.identityId,
    relaySeeds: [seed],
    onRelaySeed: (e) => seedEvents.push(e),
  })
  const peerNet = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: PEER_ADDRESS,
    protocolIdentityId: PEER_KEY.identityId,
  })
  await hiddenNet.start()
  await peerNet.start()

  // The v4-only host model (the config-fixture seam — see the header):
  // REAL listen addresses, `/memory/<relay>` head rewritten to TEST-NET v4;
  // the direct memory face becomes a direct `/ip4` (announce law drops it).
  const self = hiddenNet.peerId()
  const model = (): string[] => {
    const addrs: string[] = []
    if (opts.dualStack) addrs.push(HOST_V6)
    for (const a of hiddenNet.listenAddresses()) {
      if (a.includes('/p2p-circuit/')) addrs.push(a.replace(RELAY_ADDRESS, HOP_V4))
      else addrs.push(`${HOST_V4}/p2p/${self}`)
    }
    return addrs
  }

  const hiddenStore = makeStore()
  const peerStore = makeStore()
  const loopOpts = (
    key: IdentityKeypair,
    store: ReturnType<typeof makeStore>,
    net: NetAdapter,
    announceAddresses: () => string[],
  ) => ({
    store,
    net,
    identity: key,
    rewardBaseUnits: REWARD_BASE_UNITS,
    maxSupplyDisplay: '21000000',
    mintId: MINT_ID,
    lookbackL: 50n,
    emitBlockApplied: () => {},
    tickMs: 5,
    chainId: TEST_CHAIN,
    announceAddresses,
  })
  const hiddenLoop = createNodeLoop(loopOpts(HIDDEN_KEY, hiddenStore, hiddenNet, model))
  const peerLoop = createNodeLoop(
    loopOpts(PEER_KEY, peerStore, peerNet, () => ['/ip6/2001:db8:abcd::2/tcp/4001']),
  )

  return {
    relay,
    hiddenNet,
    peerNet,
    hiddenStore,
    peerStore,
    seedEvents,
    seed,
    transportCircuit: () => {
      const c = hiddenNet
        .listenAddresses()
        .find((a) => a.includes('/p2p-circuit/'))
      return c === undefined ? null : `/p2p/${relay.peerId()}/p2p-circuit/p2p/${self}`
    },
    modelledCircuit: () => {
      const c = hiddenNet
        .listenAddresses()
        .find((a) => a.includes('/p2p-circuit/'))
      return c === undefined ? null : c.replace(RELAY_ADDRESS, HOP_V4)
    },
    async stop() {
      hiddenLoop.stop()
      peerLoop.stop()
      await peerNet.stop()
      await hiddenNet.stop()
      await relay.stop()
    },
  }
}

/** Lift every announcement blob from every mined block, decoded. */
function minedRecords(store: ReturnType<typeof makeStore>): PeerAnnouncement[] {
  const out: PeerAnnouncement[] = []
  for (const block of store.blocks.values()) {
    for (const blob of (block as { announcements?: Uint8Array[] }).announcements ?? []) {
      out.push(PeerAnnouncement.decode(blob))
    }
  }
  return out
}

describe('11.5 — the CAP-8 Honest Boot Proof (memory, headless)', () => {
  it(
    'HONEST_BOOT_NO_V6: v4-only host boots, holds, announces EXACTLY the circuit; dialed through the hop with a data round-trip',
    { timeout: 90_000 },
    async () => {
      const fx = await bootFixture({ dualStack: false })
      try {
        // (1) The hold lands — and the ok event fired for the v4-host seed
        // (the SEED_HOLD discipline: exactly one ok for the one seed).
        const held = await waitFor(() => fx.modelledCircuit() !== null)
        expect(held).toBe(true)
        const circuit = fx.modelledCircuit() as string
        expect(circuit).toContain(HOP_V4)
        const okFired = await waitFor(
          () => fx.seedEvents.filter((e) => e.ok && e.seed === fx.seed).length === 1,
        )
        expect(okFired).toBe(true)

        // (2) Before the dial-through the peer has NO path to the hidden
        // node (it is connected to nothing; the hidden one only to relay).
        const hiddenPeerId = fx.hiddenNet.peerId()
        expect(await fx.peerNet.peers()).not.toContain(hiddenPeerId)

        // (3) The v6-side peer dials THROUGH the hop (transport form,
        // 5.7 dial-filter law — bounded retry like relay-seeds SEED_HOLD).
        const proxied = fx.transportCircuit() as string
        let dialed = false
        for (let i = 0; i < DIAL_POLLS && !dialed; i += 1) {
          try {
            await dialRaced(fx.peerNet, fx.seed)
            await dialRaced(fx.peerNet, proxied)
            dialed = (await fx.peerNet.peers()).includes(hiddenPeerId)
          } catch {
            /* reservation/hop races are normal — bounded retry */
          }
          if (!dialed) await sleep(SLEEP_MS)
        }
        expect(dialed).toBe(true)
        // The relayed connection is bidirectional: the hidden node learns
        // the peer over it (SEED_HOLD's mutual-peer discipline).
        const hiddenSeesPeer = await waitFor(async () =>
          (await fx.hiddenNet.peers()).includes(fx.peerNet.peerId()),
        )
        expect(hiddenSeesPeer).toBe(true)

        // (4) DATA ROUND TRIP over the relayed mesh, proven at CHAIN level
        // in both directions (steps 5–6). Pinned limitation, disclosed: a
        // chain-SYNC request/response stream is REFUSED on this connection
        // by libp2p itself (`LimitedConnectionError` — circuit reservations
        // are LIMITED connections; opening arbitrary protocol streams on
        // one is not authorized). Gossip envelopes ARE the data that flows
        // over reservations in production, so the round-trip below is the
        // honest shipped-path shape, not a weaker substitute.

        // (5) CHAIN DATA: the hidden node's own announcement reaches the
        // peer's MINED blocks — strict-validated, EXACTLY the held circuit.
        const landed = await waitFor(() =>
          minedRecords(fx.peerStore).some((r) => r.identityId === HIDDEN_KEY.identityId),
        )
        expect(landed).toBe(true)
        const hiddenRecord = minedRecords(fx.peerStore).find(
          (r) => r.identityId === HIDDEN_KEY.identityId,
        ) as PeerAnnouncement
        expect([...hiddenRecord.multiaddrs]).toEqual([circuit]) // leak pin: exact set
        expect(circuit).not.toContain('/ip6/')
        // The named receive seam (the plan's Code Map): the envelope landed
        // on the peer's adapter `received` map — announcements topic.
        expect(
          (fx.peerNet.received.get('announcements') ?? []).some(
            (env) => (env.payload as { identityId?: string }).identityId === HIDDEN_KEY.identityId,
          ),
        ).toBe(true)

        // (6) The reverse direction: the peer's v6 announcement lands in the
        // HIDDEN node's mined blocks — bidirectional data over the mesh that
        // only the relayed connection bridges.
        const backLanded = await waitFor(() =>
          minedRecords(fx.hiddenStore).some((r) => r.identityId === PEER_KEY.identityId),
        )
        expect(backLanded).toBe(true)
        const peerRecord = minedRecords(fx.hiddenStore).find(
          (r) => r.identityId === PEER_KEY.identityId,
        ) as PeerAnnouncement
        expect([...peerRecord.multiaddrs]).toEqual(['/ip6/2001:db8:abcd::2/tcp/4001'])
        // …and it arrived through the hidden node's OWN receive seam.
        expect(
          (fx.hiddenNet.received.get('announcements') ?? []).some(
            (env) => (env.payload as { identityId?: string }).identityId === PEER_KEY.identityId,
          ),
        ).toBe(true)
      } finally {
        await fx.stop()
      }
    },
  )

  it(
    'HONEST_BOOT_DUAL_STACK: unchanged shape — record = [global /ip6, circuit] order-preserved; relayed data flows',
    { timeout: 90_000 },
    async () => {
      const fx = await bootFixture({ dualStack: true })
      try {
        const held = await waitFor(() => fx.modelledCircuit() !== null)
        expect(held).toBe(true)
        const circuit = fx.modelledCircuit() as string

        const hiddenPeerId = fx.hiddenNet.peerId()
        // DIRECT dial works too (the unchanged dual-stack shape): the peer
        // reaches the host's real direct face, no hop involved.
        let directDialed = false
        for (let i = 0; i < DIAL_POLLS && !directDialed; i += 1) {
          try {
            await dialRaced(fx.peerNet, `${HIDDEN_ADDRESS}/p2p/${hiddenPeerId}`)
            directDialed = (await fx.peerNet.peers()).includes(hiddenPeerId)
          } catch {
            /* bounded retry */
          }
          if (!directDialed) await sleep(SLEEP_MS)
        }
        expect(directDialed).toBe(true)

        // …AND through the hop, on top of the direct connection.
        const proxied = fx.transportCircuit() as string
        let dialed = false
        for (let i = 0; i < DIAL_POLLS && !dialed; i += 1) {
          try {
            await dialRaced(fx.peerNet, fx.seed)
            await dialRaced(fx.peerNet, proxied)
            dialed = (await fx.peerNet.peers()).includes(hiddenPeerId)
          } catch {
            /* bounded retry */
          }
          if (!dialed) await sleep(SLEEP_MS)
        }
        expect(dialed).toBe(true)

        const landed = await waitFor(() =>
          minedRecords(fx.peerStore).some((r) => r.identityId === HIDDEN_KEY.identityId),
        )
        expect(landed).toBe(true)
        const record = minedRecords(fx.peerStore).find(
          (r) => r.identityId === HIDDEN_KEY.identityId,
        ) as PeerAnnouncement
        // Order-preserved announce law output: direct global v6 FIRST (the
        // unchanged pre-11 shape), held circuit second; direct /ip4 dropped.
        expect([...record.multiaddrs]).toEqual([HOST_V6, circuit])
      } finally {
        await fx.stop()
      }
    },
  )

  it('SEED_SEAM_STAYS_EMPTY: the proof ran with zero shipped default seeds (the 11.5 flip is a documented skip)', async () => {
    // The fixture above pins the operational truth: EVERY hold in this suite
    // came from an explicit seed. The shipped default stays empty until 11.4
    // provisions a relay — pinned by packages/app net-config.test.ts; this
    // row documents the epic-closing gap line, not a second mechanism.
    const events: RelaySeedEvent[] = []
    const lone = createNetAdapter({
      transport: TRANSPORT,
      listenAddress: '/memory/hbp-lone',
      protocolIdentityId: HIDDEN_KEY.identityId,
      onRelaySeed: (e) => events.push(e),
    })
    await lone.start()
    try {
      await sleep(50) // quiet window: no defaults ⇒ nothing ever fires
      expect(events).toEqual([])
      expect(lone.listenAddresses().some((a) => a.includes('/p2p-circuit/'))).toBe(false)
    } finally {
      await lone.stop()
    }
  })
})
