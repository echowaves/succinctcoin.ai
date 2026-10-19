/**
 * 8.4 (LOOP) — introductions gossiped end to end (epic-bootstrap-free-
 * discovery, CAP-7; AD-3/AD-10/AD-12).
 *
 * The slice this file pins:
 *   PRODUCER rows — with `introduce: true` a loop vouches every OTHER
 *                   identity whose announcement it verified ("saw them
 *                   online at this slot", reachability 'direct'), and the
 *                   mesh relays each `(signer, subject)` pair EXACTLY ONCE
 *                   per node — verify-before-relay, forged vouches never
 *                   leave the node that received them.
 *   OFF row       — without `introduce` the loop is pre-8.4: valid intros
 *                   sitting in its inbox are not even relayed.
 *   E2E row       — the 8.5 seam proven early: hint-grade records + vouches
 *                   streamed through the loop callbacks into a REAL address
 *                   book promote an identity to dial-eligible with EXACTLY
 *                   three distinct signers (no self-vouch leaks in).
 *   ADAPTER row   — `IntroductionEnvelope` round-trips on the real adapter
 *                   surface (memory transport, zero sockets, AD-10).
 *
 * Determinism (AD-3): pinned seeds (`seedFor(i)` = 32 bytes of `0x40 + i`),
 * every slot is chain time, waits are BOUNDED polls (iterations), never
 * wall-clock asserts. The fake mesh net doubles the adapter extensions
 * (`received` + `sendIntroduction`) — the ADAPTER row covers the real leg.
 */
import { describe, expect, it } from 'vitest'

import {
  Block,
  Introduction,
  IntroductionEnvelope,
  MINT_ID,
  createAddressBook,
  createNetAdapter,
  deriveIdentityKeypair,
  fromDisplay,
  signIntroduction,
  validateIntroduction,
} from '../src/index.js'
// The loop seam is package-internal (root barrel pins); deep import is the
// established test precedent (see discovery-block-tracer.test.ts).
import { createNodeLoop } from '../src/consensus/index.js'
import type {
  IdentityKeypair,
  Introduction as IntroductionMsg,
  NetAdapter,
  PeerAnnouncement as PeerAnnouncementMsg,
  ReceivedEnvelope,
  StorePort,
  TopicClass,
  Block as BlockMsg,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned fixtures (deterministic — AD-3)
// ---------------------------------------------------------------------------

const TEST_CHAIN = 'succinctcoin-test'
const REWARD_BASE_UNITS = fromDisplay('12.5')

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}
const KEY_A: IdentityKeypair = deriveIdentityKeypair(seedFor(0))
const KEY_B: IdentityKeypair = deriveIdentityKeypair(seedFor(1))
const KEY_C: IdentityKeypair = deriveIdentityKeypair(seedFor(2))
const KEY_D: IdentityKeypair = deriveIdentityKeypair(seedFor(3))
const KEY_E: IdentityKeypair = deriveIdentityKeypair(seedFor(4))

const addrFor = (name: string): string[] =>
  [`/ip6/2001:db8:4:${name.charCodeAt(0).toString(16)}::/tcp/9001`]

/** A wire-native signed introduction (encode→decode round-tripped, exactly
 * what the gossip path delivers). `zeroSig` forges while keeping the shape. */
function makeIntro(
  signer: IdentityKeypair,
  subjectIdentityId: string,
  slotObserved: bigint,
  opts: { chainId?: string; zeroSig?: boolean } = {},
): IntroductionMsg {
  const chainId = opts.chainId ?? TEST_CHAIN
  const signature = signIntroduction(signer, {
    signerIdentityId: signer.identityId,
    subjectIdentityId,
    slotObserved,
    reachability: 'direct',
    chainId,
  })
  const record = Introduction.decode(
    Introduction.encode({
      signerIdentityId: signer.identityId,
      subjectIdentityId,
      slotObserved,
      reachability: 'direct',
      chainId,
      signature,
    }),
  ) as IntroductionMsg
  if (opts.zeroSig === true) record.signature = new Uint8Array(64)
  return record
}

// ---------------------------------------------------------------------------
// in-memory StorePort fake (AD-10 — no sockets, no disk; per-loop chains)
// ---------------------------------------------------------------------------

function makeStore(): StorePort & { blocks: Map<number, BlockMsg> } {
  const blocks = new Map<number, BlockMsg>()
  let state: Record<string, string> | null = null
  return {
    blocks,
    async open() {},
    async close() {},
    async commit(block: unknown) {
      const b = block as BlockMsg
      blocks.set(Number(b.slot), b)
    },
    async headSlot() {
      let head = -1
      for (const slot of blocks.keys()) head = Math.max(head, slot)
      return head
    },
    async getBlock(slot: number) {
      const b = blocks.get(slot)
      return b === undefined ? null : Block.encode(b)
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
// fake mesh net (generalized: arbitrary topology via `peersList`)
// ---------------------------------------------------------------------------

interface MeshNet {
  received: Map<TopicClass, ReceivedEnvelope[]>
  announcementSends: string[]
  introductionSends: string[]
  introductionsOut: IntroductionMsg[]
  peersList: MeshNet[]
  start(): Promise<void>
  stop(): Promise<void>
  sendBlock(block: unknown): Promise<void>
  sendTicket(ticket: unknown): Promise<void>
  sendTx(tx: unknown): Promise<void>
  peers(): Promise<string[]>
  sendAnnouncement(announcement: PeerAnnouncementMsg): Promise<void>
  sendIntroduction(introduction: IntroductionMsg): Promise<void>
}

function makeMeshNet(): MeshNet {
  const received = new Map<TopicClass, ReceivedEnvelope[]>([
    ['blocks', []],
    ['tickets', []],
    ['tx', []],
    ['peers', []],
    ['announcements', []],
    ['introductions', []],
  ])
  const net: MeshNet = {
    received,
    announcementSends: [],
    introductionSends: [],
    introductionsOut: [],
    peersList: [],
    async start() {},
    async stop() {},
    async sendBlock(_block: unknown) {},
    async sendTicket(_ticket: unknown) {},
    async sendTx(_tx: unknown) {},
    async peers() {
      return [] as string[]
    },
    async sendAnnouncement(announcement: PeerAnnouncementMsg) {
      net.announcementSends.push(`${announcement.identityId}:${announcement.slotStart}`)
      for (const p of net.peersList) {
        p.received.get('announcements')?.push({ sourcePeerId: announcement.identityId, payload: announcement })
      }
    },
    async sendIntroduction(introduction: IntroductionMsg) {
      const key = `${introduction.signerIdentityId}|${introduction.subjectIdentityId}`
      net.introductionSends.push(key)
      net.introductionsOut.push(introduction)
      for (const p of net.peersList) {
        p.received.get('introductions')?.push({ sourcePeerId: introduction.signerIdentityId, payload: introduction })
      }
    },
  }
  return net
}

/** Bounded poll (iterations, not wall-clock asserts — AD-3 discipline). */
async function waitFor(cond: () => boolean, maxPolls = 800): Promise<boolean> {
  for (let i = 0; i < maxPolls; i += 1) {
    if (cond()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return cond()
}

function loopOpts(
  identity: IdentityKeypair,
  store: StorePort & { blocks: Map<number, BlockMsg> },
  net: MeshNet,
  extra: Record<string, unknown> = {},
) {
  return {
    store,
    net,
    identity,
    rewardBaseUnits: REWARD_BASE_UNITS,
    maxSupplyDisplay: '21000000',
    mintId: MINT_ID,
    lookbackL: 50n,
    emitBlockApplied: () => {},
    tickMs: 5,
    chainId: TEST_CHAIN,
    announceAddresses: () => addrFor(identity.identityId),
    ...extra,
  }
}

// ---------------------------------------------------------------------------

describe('8.4 node loop — introductions produced, relayed once, gated', () => {
  it('PRODUCER_AND_RELAY_ONCE: C vouches A; B relays the pair exactly once; every sent intro verifies', async () => {
    // Line topology A—B—C: C only ever learns of A through B's gossip.
    const netA = makeMeshNet()
    const netB = makeMeshNet()
    const netC = makeMeshNet()
    netA.peersList = [netB]
    netB.peersList = [netA, netC]
    netC.peersList = [netB]

    const loops = [
      createNodeLoop(loopOpts(KEY_A, makeStore(), netA, { introduce: true })),
      createNodeLoop(loopOpts(KEY_B, makeStore(), netB, { introduce: true })),
      createNodeLoop(loopOpts(KEY_C, makeStore(), netC, { introduce: true })),
    ]
    try {
      // B relays C's vouch for A… and produces its own.
      const keyCA = `${KEY_C.identityId}|${KEY_A.identityId}`
      const keyBA = `${KEY_B.identityId}|${KEY_A.identityId}`
      expect(await waitFor(() => netB.introductionSends.includes(keyCA))).toBe(true)
      expect(await waitFor(() => netB.introductionSends.includes(keyBA))).toBe(true)

      // Let the mesh quiesce, then pin relay-once PER NODE: no node ever
      // sends the same (signer, subject) pair twice — producer and relay
      // share one dedup set.
      await waitFor(() => false, 20) // fixed settle window (bounded, AD-3)
      for (const net of [netA, netB, netC]) {
        expect(new Set(net.introductionSends).size).toBe(net.introductionSends.length)
      }

      // Every vouch C ever emitted verifies (the loop never signs junk):
      // signer is C, subjects are among the mesh, reachability pinned.
      const fromC = netC.introductionsOut.filter((intro) => intro.signerIdentityId === KEY_C.identityId)
      expect(fromC.length).toBeGreaterThan(0)
      for (const intro of fromC) {
        expect(intro.reachability).toBe('direct')
        expect([KEY_A.identityId, KEY_B.identityId]).toContain(intro.subjectIdentityId)
        expect(validateIntroduction(intro, { currentSlot: 1_000_000n, expectedChainId: TEST_CHAIN })).toEqual({
          ok: true,
        })
      }
    } finally {
      for (const loop of loops) loop.stop()
    }
  }, 60_000)

  it('FORGED_INTRO_NEVER_RELAYED: a junk-signature vouch never leaves the node', async () => {
    const store = makeStore()
    const net = makeMeshNet()
    // Pre-seed a forged C-vouches-B (shape-valid, zero signature) fresh at
    // the loop's slots — ONLY verification can stop it.
    net.received.get('introductions')?.push({
      sourcePeerId: KEY_C.identityId,
      payload: makeIntro(KEY_C, KEY_B.identityId, 0n, { zeroSig: true }),
    })
    const introCallbacks: string[] = []
    const loop = createNodeLoop(
      loopOpts(KEY_A, store, net, {
        introduce: true,
        onGossipedIntroduction: (intro: IntroductionMsg) => {
          introCallbacks.push(`${intro.signerIdentityId}|${intro.subjectIdentityId}`)
        },
      }),
    )
    try {
      expect(await waitFor(() => store.blocks.size >= 3)).toBe(true) // loop is alive
      await waitFor(() => false, 10) // a few more windows to be sure
      // Nothing was relayed at all: A knows no other identity (producer
      // idle) and the forgery never passes the gate (relay silent)…
      expect(net.introductionSends).toEqual([])
      // …and the book-feed callback stayed silent too.
      expect(introCallbacks).toEqual([])
    } finally {
      loop.stop()
    }
  }, 30_000)

  it('INTRO_OFF: without `introduce` the loop is pre-8.4 — not even valid vouches relay', async () => {
    const netA = makeMeshNet()
    const netB = makeMeshNet()
    netA.peersList = [netB]
    netB.peersList = [netA]
    // A VALID C-vouch sits in both inboxes…
    const validVouch = makeIntro(KEY_C, KEY_A.identityId, 0n)
    netA.received.get('introductions')?.push({ sourcePeerId: KEY_C.identityId, payload: validVouch })
    netB.received.get('introductions')?.push({ sourcePeerId: KEY_C.identityId, payload: validVouch })

    const storeA = makeStore()
    const storeB = makeStore()
    const loopA = createNodeLoop(loopOpts(KEY_A, storeA, netA)) // chainId on, introduce OFF
    const loopB = createNodeLoop(loopOpts(KEY_B, storeB, netB))
    try {
      // Announcements still flow (the 8.3 behavior is untouched)…
      expect(await waitFor(() => netA.announcementSends.length > 0 && netB.announcementSends.length > 0)).toBe(true)
      expect(storeA.blocks.size + storeB.blocks.size).toBeGreaterThan(0)
      // …but the introduction leg never runs: zero sends on both nets.
      expect(netA.introductionSends).toEqual([])
      expect(netB.introductionSends).toEqual([])
    } finally {
      loopA.stop()
      loopB.stop()
    }
  }, 30_000)

  it('HINT_E2E_BOOK: gossiped records + vouches through the callbacks make a hint dial-eligible', async () => {
    // Star: leaves A, C, D, E each peer ONLY the book node B.
    const netA = makeMeshNet()
    const netB = makeMeshNet()
    const netC = makeMeshNet()
    const netD = makeMeshNet()
    const netE = makeMeshNet()
    netA.peersList = [netB]
    netC.peersList = [netB]
    netD.peersList = [netB]
    netE.peersList = [netB]
    netB.peersList = [netA, netC, netD, netE]

    const book = createAddressBook()
    let lastSlot = 0n
    const ingestAnn = (record: PeerAnnouncementMsg, slot: bigint): void => {
      lastSlot = slot
      book.ingestAnnouncement(record, { currentSlot: slot, expectedChainId: TEST_CHAIN, sourceClass: 'hint' })
    }
    const ingestIntro = (intro: IntroductionMsg, slot: bigint): void => {
      lastSlot = slot
      book.ingestIntroduction(intro, { currentSlot: slot, expectedChainId: TEST_CHAIN })
    }

    const loops = [
      createNodeLoop(loopOpts(KEY_A, makeStore(), netA, { introduce: true })),
      createNodeLoop(
        loopOpts(KEY_B, makeStore(), netB, {
          introduce: true,
          onGossipedAnnouncement: ingestAnn,
          onGossipedIntroduction: ingestIntro,
        }),
      ),
      createNodeLoop(loopOpts(KEY_C, makeStore(), netC, { introduce: true })),
      createNodeLoop(loopOpts(KEY_D, makeStore(), netD, { introduce: true })),
      createNodeLoop(loopOpts(KEY_E, makeStore(), netE, { introduce: true })),
    ]
    try {
      // A (hint-grade at B) becomes dial-eligible after three DISTINCT
      // vouches — the whole 8.4 chain over one mesh, zero block dependency.
      expect(await waitFor(() => book.dialEligible(lastSlot).some((t) => t.identityId === KEY_A.identityId))).toBe(
        true,
      )
      const entry = book.entries().find((e) => e.identityId === KEY_A.identityId)
      expect(entry?.sourceClass).toBe('hint')
      expect(entry?.multiaddrs).toEqual(addrFor(KEY_A.identityId))
      // Exactly the three leaves vouched. B's own vouch never leaks back:
      // its relays return as STALE copies (same slotObserved) and die at
      // the loop's dedup gate before the callback.
      expect([...(entry?.introductionSigners ?? [])].sort()).toEqual(
        [KEY_C.identityId, KEY_D.identityId, KEY_E.identityId].sort(),
      )
    } finally {
      for (const loop of loops) loop.stop()
    }
  }, 60_000)

  it('ADAPTER_ROUNDTRIP: sendIntroduction lands decoded on the peer, source identity intact', async () => {
    const a: NetAdapter = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/intro-a',
      protocolIdentityId: KEY_A.identityId,
    })
    const b: NetAdapter = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/intro-b',
      protocolIdentityId: KEY_B.identityId,
    })
    await a.start()
    await b.start()
    try {
      await b.dial('/memory/intro-a')
      const intro = makeIntro(KEY_A, KEY_C.identityId, 3n)

      // first-publish subscribe race: bounded retry (the 5.2 pattern).
      for (let i = 0; ; i += 1) {
        try {
          await a.sendIntroduction(intro)
          break
        } catch (err) {
          if (i >= 400) throw err
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }

      expect(await waitFor(() => (b.received.get('introductions')?.length ?? 0) >= 1)).toBe(true)
      const env = b.received.get('introductions')?.[0]
      expect(env?.sourcePeerId).toBe(KEY_A.identityId)
      const payload = env?.payload as IntroductionMsg
      expect(payload.signerIdentityId).toBe(KEY_A.identityId)
      expect(payload.subjectIdentityId).toBe(KEY_C.identityId)
      expect(payload.slotObserved).toBe(3n)
      expect(Introduction.encode(payload)).toEqual(Introduction.encode(intro))

      // the envelope is its own proto message (AD-12): payload + source wire.
      const wire = IntroductionEnvelope.encode({ introduction: intro, sourcePeerId: KEY_A.identityId })
      expect(IntroductionEnvelope.decode(wire).introduction?.subjectIdentityId).toBe(KEY_C.identityId)
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 30_000)
})
