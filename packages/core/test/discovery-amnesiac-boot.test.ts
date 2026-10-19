/**
 * Ticket 8.5 (T5) — the AMNESIAC BOOT PROOF (CAP-7 R4; design §"Amnesiac
 * Boot Proof"): a WIPED node armed with exactly ONE block-grade record — an
 * announcement blob lifted from an APPLIED block of the healthy mesh and
 * dropped into its artifact file — reaches ≥K dialEligible peers spanning
 * ≥3 distinct /64s within a BOUNDED slot budget.
 *
 * Headless over the REAL memory transport (AD-10): seven healthy loops run
 * a ring mesh (chainId + announceAddresses + introduce), each announcing a
 * FAKE `/ip6/...` address; the wiped node's dial is SIMULATED — the ladder
 * hands it the fake multiaddr from the record and the simulated dial map
 * resolves it to the author's `/memory/...` address (the "simulated dial
 * outcomes per simulated-book pattern" the ticket pins). No sockets, no
 * wall-clock asserts: bounded polls + a head-slot budget (AD-3).
 *
 * The book fills through the SHIPPED rungs only: rung 3 (artifact) opens
 * ONE connection; live gossiped announcements land hint-grade via 8.4's
 * `onGossipedAnnouncement`; introductions arriving on the wire add vouchs
 * (`onGossipedIntroduction`) until entries promote to dialEligible. Zero
 * hardwired peers anywhere in the wiped node's wiring (R1).
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  Block,
  MINT_ID,
  PeerAnnouncement,
  createAddressBook,
  createNetAdapter,
  deriveIdentityKeypair,
  fromDisplay,
  runBootLadder,
  writeAnnouncementFile,
} from '../src/index.js'
// The loop seam is package-internal (root barrel pins); deep import is the
// established test precedent (discovery-introduction-loop.test.ts).
import { createNodeLoop } from '../src/consensus/index.js'
import type {
  Block as BlockMsg,
  IdentityKeypair,
  NetAdapter,
  StorePort,
} from '../src/index.js'

const TEST_CHAIN = 'succinctcoin-test'
const REWARD_BASE_UNITS = fromDisplay('12.5')

// ---------------------------------------------------------------------------
// proof constants (the ticket's "k and slot budget" unknowns — test truth)
// ---------------------------------------------------------------------------
const K_PEERS = 3 // ≥K dialEligible identities
const K_NETS = 3 // spanning ≥K distinct /64s
const MAX_BOOT_SLOTS = 60 // bounded slot budget (AD-3: not wall clock)

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

/** The healthy mesh: 7 nodes, fake /ip6 announces across FIVE distinct
 * /24s (two pairs deliberately SHARE a /64 so the count is not vacuous). */
interface PeerSpec {
  key: IdentityKeypair
  memAddr: string
  announceAddr: string
}
const PEERS: PeerSpec[] = [
  { ip: '2001:db8:7::1' },
  { ip: '2001:db8:7::2' }, // same /64 as the first — shared-network pair
  { ip: '2001:db8:107::3' },
  { ip: '2001:db8:107::4' }, // same /64 again
  { ip: '2001:db8:207::5' },
  { ip: '2001:db8:307::6' },
  { ip: '2001:db8:407::7' },
].map((spec, i) => ({
  key: deriveIdentityKeypair(seedFor(10 + i)),
  memAddr: `/memory/amn-${i}`,
  announceAddr: `/ip6/${spec.ip}/tcp/4001`,
}))

// The simulated dial map (design's "simulated dial outcomes"): the fake
// announced /ip6 address -> the author's real memory-transport address.
const ADDR_MAP = new Map(PEERS.map((p) => [p.announceAddr, p.memAddr]))

/** `/64` prefix of a fake multiaddr — first four hextets of the /ip6
 * component, `::`-expansion normalized (9.1: IPv6-only diversity metric). */
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

// ---------------------------------------------------------------------------
// consistent in-memory store fake (the 8.4 harness lesson: getBlock MUST
// serve Block.encode(blocks.get(slot)) or the loop mines exactly one block)
// ---------------------------------------------------------------------------
function makeStore(): StorePort & { blocks: Map<number, BlockMsg>; headSlotNow(): number } {
  const blocks = new Map<number, BlockMsg>()
  let state: Record<string, string> | null = null
  const syncHead = (): number => {
    let head = -1
    for (const slot of blocks.keys()) head = Math.max(head, slot)
    return head
  }
  return {
    blocks,
    headSlotNow: syncHead,
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

/** Bounded poll (iterations — never a wall-clock assert). */
async function waitFor(cond: () => boolean, maxPolls = 1200): Promise<boolean> {
  for (let i = 0; i < maxPolls; i += 1) {
    if (cond()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return cond()
}

function loopOpts(
  key: IdentityKeypair,
  store: StorePort & { blocks: Map<number, BlockMsg>; headSlotNow(): number },
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

describe('8.5 T5 — Amnesiac Boot Proof (memory transport, bounded, headless)', () => {
  it('wiped node + ONE block-grade record => >=3 eligible peers over >=3 /64s within budget', { timeout: 120_000 }, async () => {
    // --- Phase 1: the healthy ring mesh (P0..P6, each dials its successor).
    const nets: NetAdapter[] = []
    const stores = PEERS.map(() => makeStore())
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
    for (let i = 0; i < nets.length; i += 1) {
      await nets[i]!.dial(PEERS[(i + 1) % nets.length]!.memAddr) // ring
    }
    for (let i = 0; i < nets.length; i += 1) {
      loops.push(
        createNodeLoop(loopOpts(PEERS[i]!.key, stores[i]!, nets[i]!, PEERS[i]!.announceAddr)),
      )
    }

    // Wait for an APPLIED block carrying at least one announcement anywhere
    // (bounded) — that is the block-grade artifact source.
    const found = await waitFor(() => {
      for (const store of stores) {
        for (const block of store.blocks.values()) {
          if ((block.announcements?.length ?? 0) > 0) return true
        }
      }
      return false
    })
    expect(found).toBe(true)

    // --- Phase 2: lift ONE announcement blob from an applied block.
    let blob: Uint8Array | null = null
    outer: for (const store of stores) {
      for (const block of store.blocks.values()) {
        const first = block.announcements?.[0]
        if (first !== undefined) {
          blob = first
          break outer
        }
      }
    }
    expect(blob).not.toBeNull()
    const record = PeerAnnouncement.decode(blob!)

    // --- Phase 3: the WIPED node. Fresh identity, fresh store, NO mesh
    // history; armed with exactly that one block-grade record in its
    // artifact file (the epic Notes MVP artifact).
    const dir = await mkdtemp(join(tmpdir(), 'sc-amnesiac-'))
    const artifactPath = join(dir, 'artifact.json')
    await writeAnnouncementFile(artifactPath, [blob!])

    const wipedKey = deriveIdentityKeypair(seedFor(42))
    const wipedStore = makeStore()
    const wipedNet = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/amn-wiped',
      protocolIdentityId: wipedKey.identityId,
    })
    await wipedNet.start()
    nets.push(wipedNet)

    const book = createAddressBook({ selfIdentityId: wipedKey.identityId })
    const dialed: string[] = []
    // The wiped node JOINS THE MESH (its loop): gossiped announcements
    // land hint-grade; introductions add vouchs — all through the real
    // 8.4 seams, feeding ONE address book.
    const wipedLoop = createNodeLoop(
      loopOpts(wipedKey, wipedStore, wipedNet, '/ip6/2001:db8:a09:709::/tcp/4001', {
        // RUNG 4 (the design's step 4 — "announcements from applied blocks",
        // shipped by 8.3): the post-commit handoff, block-grade with REAL
        // blockRefs — exactly what createCore wires. This is what makes the
        // amnesiac boot work at chain time: gossiped hints alone never reach
        // eligibility (and vouches for a LAGGING fresh chain are honestly
        // future-observation rejects until its own slots arrive).
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
          book.ingestAnnouncement(rec, {
            currentSlot: slot,
            expectedChainId: TEST_CHAIN,
            sourceClass: 'hint',
          })
        },
        onGossipedIntroduction: (intro: unknown, slot: bigint) => {
          book.ingestIntroduction(intro, { currentSlot: slot, expectedChainId: TEST_CHAIN })
        },
      }),
    )
    loops.push(wipedLoop)
    try {
      // Honest chain time: the validator rejects NOT-YET-VALID records, so
      // the wiped node validates its artifact only once its OWN mined
      // chain has reached the record's slotStart (parallel chains advance
      // together; bounded wait — the record is fresh off a mined block).
      const recStart = BigInt(record.slotStart as number | bigint)
      const caughtUp = await waitFor(() => wipedStore.headSlotNow() >= Number(recStart))
      expect(caughtUp).toBe(true)

      // The boot ladder (rung 3): validate the record, SIMULATED-dial its
      // author (fake /ip6 -> real /memory via the dial map). This is the
      // ONLY connection the wiped node ever initiates.
      const report = await runBootLadder({
        chainId: TEST_CHAIN,
        currentSlot: BigInt(wipedStore.headSlotNow()),
        artifactFilePath: artifactPath,
        selfIdentityId: wipedKey.identityId,
        dial: async (addr) => {
          dialed.push(addr)
          const mem = ADDR_MAP.get(addr)
          if (mem === undefined) return false
          try {
            await wipedNet.dial(mem)
            return true
          } catch {
            return false
          }
        },
      })
      expect(report.artifact.targets).toBe(1)
      expect(dialed).toEqual([record.multiaddrs[0]]) // dialed exactly the record's addr

      // --- The PROOF: >=K eligible across >=K distinct /64s, in budget.
      const reached = await waitFor(() => {
        const head = wipedStore.headSlotNow()
        const eligible = book.dialEligible(BigInt(head))
        const nets_ = new Set(eligible.flatMap((e) => e.multiaddrs.map(slash64)))
        return eligible.length >= K_PEERS && nets_.size >= K_NETS
      })
      const headAtProof = wipedStore.headSlotNow()
      const eligible = book.dialEligible(BigInt(headAtProof))
      const netsSeen = new Set(eligible.flatMap((e) => e.multiaddrs.map(slash64)))

      expect(reached).toBe(true)
      expect(headAtProof).toBeLessThanOrEqual(MAX_BOOT_SLOTS) // bounded (AD-3)
      expect(eligible.length).toBeGreaterThanOrEqual(K_PEERS)
      expect(netsSeen.size).toBeGreaterThanOrEqual(K_NETS)
      // Eligible entries are PUBLIC data only and never include ourselves.
      expect(eligible.some((e) => e.identityId === wipedKey.identityId)).toBe(false)
    } finally {
      for (const loop of loops) loop.stop()
      for (const net of nets) await net.stop()
    }
  })
})
