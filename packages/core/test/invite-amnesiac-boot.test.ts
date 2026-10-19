/**
 * Ticket 9.5 (T5) — the AMNESIAC INVITE BOOT PROOF: the epic's acceptance
 * row. A WIPED node with an EMPTY config — no artifact, no hints, no
 * bootstrap list — armed with exactly ONE verified invitation, reaches ≥K
 * dialEligible peers across ≥K distinct /64s within a bounded slot budget;
 * the follow-on crawl respects the book cap; EVERY book record carries a
 * reliability history and score (9.4). Plus the negative pair: same setup,
 * but when the invite's identity holds no recent ticket, ZERO dials happen.
 *
 * Headless over the REAL memory transport (AD-10), reusing 8.5's proven
 * mesh: seven healthy loops (ring, announce + introduce) with fake /ip6
 * announces; the wiped node's dial/request are SIMULATED through the address
 * map. Liveness is the REAL `createInviteLiveness` over the wiped node's own
 * (empty) store — the 9.2 empty-chain rule exercised end-to-end, not faked.
 * Bounded polls + head-slot budget; no wall-clock asserts (AD-3).
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  Block,
  MAX_BOOK_ENTRIES,
  MINT_ID,
  createAddressBook,
  createInviteLiveness,
  createNetAdapter,
  deriveIdentityKeypair,
  encodeInvite,
  fromDisplay,
  runBootLadder,
  runCrawl,
  servePeerBook,
  signPeerAnnouncement,
} from '../src/index.js'
import { createNodeLoop } from '../src/consensus/index.js'
import type { IdentityKeypair, NetAdapter, StorePort } from '../src/index.js'

const TEST_CHAIN = 'succinctcoin-test'
const REWARD_BASE_UNITS = fromDisplay('12.5')

// Proof constants — 8.5's pinned k/budget (the ticket: "reuse 8.5's").
const K_PEERS = 3
const K_NETS = 3
const MAX_BOOT_SLOTS = 60

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x50 + i)
}

interface PeerSpec {
  key: IdentityKeypair
  memAddr: string
  announceAddr: string
}
const PEERS: PeerSpec[] = [
  { ip: '2001:db8:9::1' },
  { ip: '2001:db8:9::2' }, // shared /64 — diversity count stays non-vacuous
  { ip: '2001:db8:109::3' },
  { ip: '2001:db8:109::4' },
  { ip: '2001:db8:209::5' },
  { ip: '2001:db8:309::6' },
  { ip: '2001:db8:409::7' },
].map((spec, i) => ({
  key: deriveIdentityKeypair(seedFor(10 + i)),
  memAddr: `/memory/inv-${i}`,
  announceAddr: `/ip6/${spec.ip}/tcp/4001`,
}))

const ADDR_MAP = new Map(PEERS.map((p) => [p.announceAddr, p.memAddr]))

function slash64(addr: string): string {
  const m = /^\/ip6\/([^/]+)\/tcp\//.exec(addr)
  if (m == null) return addr
  const [headRaw, tailRaw] = m[1].split('::')
  const hex = (s: string): string => Number.parseInt(s, 16).toString(16)
  const head = (headRaw ?? '').split(':').filter((g) => g !== '').map(hex)
  const tail = (tailRaw ?? '').split(':').filter((g) => g !== '').map(hex)
  const groups =
    m[1].indexOf('::') === -1
      ? head
      : [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail]
  return groups.slice(0, 4).join(':')
}

function makeStore(): StorePort & { blocks: Map<unknown, unknown>; headSlotNow(): number } {
  const blocks = new Map<number, unknown>()
  let state: Record<string, string> | null = null
  return {
    blocks,
    headSlotNow: () => {
      let head = -1
      for (const slot of blocks.keys()) head = Math.max(head, slot)
      return head
    },
    async open() {},
    async close() {},
    async commit(block: unknown) {
      blocks.set(Number((block as { slot: number | bigint }).slot), block)
    },
    async headSlot() {
      let head = -1
      for (const slot of blocks.keys()) head = Math.max(head, slot)
      return head
    },
    async getBlock(slot: number) {
      const b = blocks.get(slot) as Parameters<typeof Block.encode>[0] | undefined
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

async function waitFor(cond: () => boolean, maxPolls = 1200): Promise<boolean> {
  for (let i = 0; i < maxPolls; i += 1) {
    if (cond()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return cond()
}

function loopOpts(
  key: IdentityKeypair,
  store: StorePort & { headSlotNow(): number },
  net: NetAdapter,
  announceAddr: string,
  extra: Record<string, unknown> = {},
) {
  return {
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
    announceAddresses: () => [announceAddr],
    introduce: true,
    ...extra,
  }
}

/** The shipped ingest hooks (8.3/8.4 seams) pointed at ONE book — the same
 * trio createCore wires; mesh peers get it so their serve sources have truth. */
function ingestHooks(book: ReturnType<typeof createAddressBook>) {
  return {
    onAnnouncements: (records: readonly unknown[], ctx: { blockHashHex: string; slot: bigint }) => {
      for (const rec of records) {
        book.ingestAnnouncement(rec, {
          currentSlot: ctx.slot,
          expectedChainId: TEST_CHAIN,
          sourceClass: 'block',
          blockRef: { blockHashHex: ctx.blockHashHex, slot: ctx.slot },
        })
      }
    },
    onGossipedAnnouncement: (rec: unknown, slot: bigint) => {
      book.ingestAnnouncement(rec, { currentSlot: slot, expectedChainId: TEST_CHAIN, sourceClass: 'hint' })
    },
    onGossipedIntroduction: (intro: unknown, slot: bigint) => {
      book.ingestIntroduction(intro, { currentSlot: slot, expectedChainId: TEST_CHAIN })
    },
  }
}

describe('9.5 T5 — Amnesiac Invite Boot Proof (memory transport, bounded, headless)', () => {
  it(
    'wiped node + ONE invitation => >=3 eligible over >=3 /64s; crawl capped; every record scored',
    { timeout: 180_000 },
    async () => {
      // --- Phase 1: the healthy ring mesh, each peer serving its own book.
      const nets: NetAdapter[] = []
      const stores = PEERS.map(() => makeStore())
      const books = PEERS.map(() => createAddressBook())
      const loops: { stop(): void }[] = []
      for (const peer of PEERS) {
        const net = createNetAdapter({
          transport: 'memory',
          listenAddress: peer.memAddr,
          protocolIdentityId: peer.key.identityId,
        })
        await net.start()
        nets.push(net)
      }
      for (let i = 0; i < nets.length; i += 1) await nets[i]!.dial(PEERS[(i + 1) % nets.length]!.memAddr)
      for (let i = 0; i < nets.length; i += 1) {
        // The peer-book source is the SHIPPED serve policy — what createCore
        // registers at start(), wired here per mesh peer.
        const i2 = i
        nets[i]!.setPeerBookSource((limit) =>
          Promise.resolve(
            servePeerBook({
              book: books[i2]!,
              currentSlot: BigInt(Math.max(0, stores[i2]!.headSlotNow())),
              expectedChainId: TEST_CHAIN,
              limit,
              witnessSigner: PEERS[i2]!.key,
            }),
          ),
        )
        loops.push(createNodeLoop(loopOpts(PEERS[i]!.key, stores[i]!, nets[i]!, PEERS[i]!.announceAddr, ingestHooks(books[i]!))))
      }

      // --- Phase 2: ONE invitation from a healthy peer, written to invite.txt.
      const inviter = PEERS[0]!
      const inviteFields = {
        identityId: inviter.key.identityId,
        multiaddrs: [inviter.announceAddr],
        slotStart: 0,
        slotEnd: 10_000, // generous: the proof must not hinge on expiry timing
        chainId: TEST_CHAIN,
      }
      const invite = encodeInvite({
        ...inviteFields,
        signature: signPeerAnnouncement(inviter.key, inviteFields),
      })

      // --- Phase 3: the WIPED node. Empty config: NO artifact, NO hints,
      // NO bootstrap — just the invite file. Liveness is the REAL getter
      // over the wiped (empty) store: the empty-chain rule decides allow-all.
      const dir = await mkdtemp(join(tmpdir(), 'sc-invboot-'))
      const invitePath = join(dir, 'invite.txt')
      await writeFile(invitePath, `${invite}\n`, 'utf8')

      const wipedKey = deriveIdentityKeypair(seedFor(42))
      const wipedStore = makeStore()
      const wipedNet = createNetAdapter({
        transport: 'memory',
        listenAddress: '/memory/inv-wiped',
        protocolIdentityId: wipedKey.identityId,
      })
      await wipedNet.start()
      nets.push(wipedNet)

      const book = createAddressBook({ selfIdentityId: wipedKey.identityId })
      const ladderDials: string[] = []
      const dialViaMap = async (addr: string): Promise<boolean> => {
        const mem = ADDR_MAP.get(addr)
        if (mem === undefined) return false
        try {
          await wipedNet.dial(mem)
          return true
        } catch {
          return false
        }
      }

      // Liveness BEFORE the wiped loop mines anything: head -1 ⇒ no real
      // winners ⇒ allow-all (9.2's rule, computed by the shipped factory).
      const liveness = await createInviteLiveness(wipedStore, await wipedStore.headSlot())
      const report = await runBootLadder({
        chainId: TEST_CHAIN,
        currentSlot: 0n,
        inviteFilePath: invitePath,
        book,
        selfIdentityId: wipedKey.identityId,
        hadRecentTicket: liveness,
        dial: async (addr) => {
          ladderDials.push(addr)
          return dialViaMap(addr)
        },
      })
      expect(report.invites).toEqual({ found: true, verified: 1, rejected: 0 })
      expect(ladderDials).toEqual([inviter.announceAddr]) // the ONE connection
      expect(book.dialEligible(0n).map((t) => t.identityId)).toContain(inviter.key.identityId)

      // --- Phase 4: join the mesh (gossip seams fill block-grade exactly as
      // in 8.5) and run the CORE's follow-on crawl once K is reached.
      loops.push(
        createNodeLoop(
          loopOpts(wipedKey, wipedStore, wipedNet, '/ip6/2001:db8:b09:709::/tcp/4001', ingestHooks(book)),
        ),
      )
      const reached = await waitFor(() => {
        const eligible = book.dialEligible(BigInt(Math.max(0, wipedStore.headSlotNow())))
        const netsSeen = new Set(eligible.flatMap((e) => e.multiaddrs.map(slash64)))
        return eligible.length >= K_PEERS && netsSeen.size >= K_NETS
      })
      const headAtProof = wipedStore.headSlotNow()
      expect(reached).toBe(true)
      expect(headAtProof).toBeLessThanOrEqual(MAX_BOOT_SLOTS)

      const crawlReport = await runCrawl(
        {
          book,
          expectedChainId: TEST_CHAIN,
          currentSlot: () => BigInt(Math.max(0, wipedStore.headSlotNow())),
          dial: async (address) => {
            // Crawl semantics: resolve = dialed OK; throw = failed dial.
            if (!(await dialViaMap(address))) throw new Error(`no route to ${address}`)
          },
          request: async (address, limit) => {
            const mem = ADDR_MAP.get(address)
            if (mem === undefined) throw new Error(`no route to ${address}`)
            return wipedNet.requestPeerBook(mem, limit)
          },
        },
        book
          .dialEligible(BigInt(Math.max(0, wipedStore.headSlotNow())))
          .flatMap((t) => t.multiaddrs.map((address) => ({ address, identityId: t.identityId }))),
      )

      // Crawl settled honestly and NEVER exceeded the cap (R4 bounds).
      expect(['quiet', 'cap', 'stopped']).toContain(crawlReport.stoppedBy)
      expect(book.size()).toBeLessThanOrEqual(MAX_BOOK_ENTRIES)
      expect(crawlReport.served).toBeGreaterThanOrEqual(1) // real round trips happened

      // 9.4 invariant on the WHOLE book: every record carries a history and
      // scores in [0,1]; the crawl fed the validity sink somewhere.
      const entries = book.entries()
      let anySourced = false
      for (const e of entries) {
        expect(e.history).toBeDefined()
        expect(e.history.seenSlots.length).toBeGreaterThanOrEqual(1)
        const s = book.score(e.identityId)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
        if (e.history.sourcedTotal > 0) anySourced = true
      }
      expect(anySourced).toBe(true) // non-vacuous: crawl-sourced data landed

      for (const loop of loops) loop.stop()
      for (const net of nets) await net.stop()
    },
  )

  it('SQUATTER PAIR: no recent ticket => zero dials, empty book', async () => {
    // Same invite shape — but the chain's recent winners do NOT include the
    // inviter (exactly what createInviteLiveness returns once real tickets
    // exist and the identity lacks one). No mesh needed: the ladder is the
    // seam under test.
    const squatter = deriveIdentityKeypair(seedFor(77))
    const fields = {
      identityId: squatter.identityId,
      multiaddrs: ['/ip6/2001:db8:f00d:1::/tcp/4001'],
      slotStart: 0,
      slotEnd: 10_000,
      chainId: TEST_CHAIN,
    }
    const dir = await mkdtemp(join(tmpdir(), 'sc-invboot-neg-'))
    const invitePath = join(dir, 'invite.txt')
    await writeFile(invitePath, `${encodeInvite({ ...fields, signature: signPeerAnnouncement(squatter, fields) })}\n`, 'utf8')

    const book = createAddressBook()
    const dialed: string[] = []
    const report = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 5n,
      inviteFilePath: invitePath,
      book,
      hadRecentTicket: () => false, // a real-ticket chain says: no ticket here
      dial: async (addr) => {
        dialed.push(addr)
        return true
      },
    })
    expect(report.invites).toEqual({ found: true, verified: 0, rejected: 1 })
    expect(dialed).toEqual([]) // ZERO dials — verify-before-connect holds
    expect(book.size()).toBe(0)
  })
})
