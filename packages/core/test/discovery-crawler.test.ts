/**
 * discovery-crawler.test.ts — ticket 9.3: the bounded BFS crawl over a
 * SYNTHETIC 150-node star (pure fakes for dial/request — depth labels,
 * concurrency, the cap, and poison rows are all OBSERVED, not assumed).
 * Memory-transport reality rides in `peerbook-transport.test.ts`; this file
 * pins the MACHINE.
 *
 *   MESH_150_CAP       one seed → book fills to EXACTLY 100 ('cap'); depth
 *                      never exceeds 3 (L4 addresses never dialed); observed
 *                      concurrency reaches exactly 8 and never exceeds it;
 *                      every address is dialed at most ONCE (the budget).
 *   POISON_NO_WITNESS  a served record WITHOUT a witness: stored (hint),
 *                      NEVER dialed; its unique child never discovered.
 *   QUIET              small mesh drains to quiet; every peer crawled once.
 *   STOPPED            cooperative stop before any dequeue.
 *   FAILURE_BUDGET     a failing dial is tried exactly once and lands in the
 *                      book's quarantine ledger (failedDials = 1).
 */
import { describe, expect, it } from 'vitest'

import {
  CRAWL_CONCURRENCY,
  createAddressBook,
  deriveIdentityKeypair,
  runCrawl,
  signIntroduction,
  signPeerAnnouncement,
} from '../src/index.js'
import type { CrawlerDeps, PeerBookServed } from '../src/index.js'

const TEST_CHAIN = 'succinctcoin-test'

interface FakeNode {
  i: number
  kp: ReturnType<typeof deriveIdentityKeypair>
  addr: string
  record: PeerBookServed['records'][number]
  children: FakeNode[]
}

/** Deterministic keypair per index; addresses spread across EIGHT /64s so
 * the diversity floor never binds here (it has book-level rows of its own). */
function makeNode(i: number): FakeNode {
  const seed = new Uint8Array(32)
  seed[0] = 0x10 + (i % 200)
  seed[31] = i % 251
  const kp = deriveIdentityKeypair(seed)
  const fields = {
    identityId: kp.identityId,
    multiaddrs: [`/ip6/2001:db8:${(i % 8).toString(16)}:${i.toString(16)}::/tcp/4001`],
    slotStart: 0n,
    slotEnd: 100n,
    chainId: TEST_CHAIN,
  }
  const record = { ...fields, signature: new Uint8Array(signPeerAnnouncement(kp, fields)) } as unknown as PeerBookServed['records'][number]
  return { i, kp, addr: fields.multiaddrs[0]!, record, children: [] }
}

interface MeshOptions {
  /** Served records whose subject gets NO witness (poison rows). */
  unvouched?: Set<string>
  /** Addresses whose dial rejects. */
  failingDials?: Set<string>
  /** Raw override: when set for an address, its response verbatim. */
  rawServe?: (address: string, limit: number) => PeerBookServed | undefined
}

/**
 * Layered star: door(1) → L2(40) → L3(60) → L4(50). L4 is reachable only
 * THROUGH an L3 response — depth 4, never dialable under the budget. The
 * options object is read LIVE by the fake handlers, so tests may mutate
 * `mesh.opts` and node children after building.
 */
function buildMesh(opts: MeshOptions = {}) {
  const door = makeNode(0)
  const l2 = Array.from({ length: 40 }, (_, k) => makeNode(k + 1))
  const l3 = Array.from({ length: 60 }, (_, k) => makeNode(k + 41))
  const l4 = Array.from({ length: 50 }, (_, k) => makeNode(k + 101))
  l2.forEach((n, k) => n.children.push(...l3.slice(Math.floor((k * 60) / 40), Math.floor(((k + 1) * 60) / 40))))
  l3.forEach((n, k) => {
    if (k % 3 === 0) n.children.push(l4[Math.floor(k / 3)]!) // L4 under every third L3
  })
  door.children.push(...l2)

  const byAddr = new Map<string, FakeNode>()
  for (const n of [door, ...l2, ...l3, ...l4]) byAddr.set(n.addr, n)

  const dialed: string[] = []
  const attemptsPerAddress = new Map<string, number>()
  let active = 0
  let peak = 0

  const deps: CrawlerDeps = {
    async request(address, limit) {
      const responder = byAddr.get(address)
      if (responder === undefined) throw new Error(`unknown peer ${address}`)
      await new Promise((r) => setTimeout(r, 1)) // overlap workers (scheduling only)
      const raw = opts.rawServe?.(address, limit)
      if (raw !== undefined) return raw
      const served = responder.children.slice(0, limit)
      const witnesses = served
        .filter((c) => !(opts.unvouched?.has(c.addr) ?? false))
        .map((c) => {
          const fields = {
            signerIdentityId: responder.kp.identityId,
            subjectIdentityId: c.kp.identityId,
            slotObserved: 5n,
            reachability: 'direct' as const,
            chainId: TEST_CHAIN,
          }
          return { ...fields, signature: new Uint8Array(signIntroduction(responder.kp, fields)) }
        })
      return { records: served.map((c) => c.record), witnesses: witnesses as unknown as PeerBookServed['witnesses'] }
    },
    async dial(address) {
      attemptsPerAddress.set(address, (attemptsPerAddress.get(address) ?? 0) + 1)
      dialed.push(address)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1)) // hold the slot briefly
      active -= 1
      if (opts.failingDials?.has(address)) throw new Error(`dial refused ${address}`)
    },
    book: createAddressBook(),
    expectedChainId: TEST_CHAIN,
    currentSlot: () => 5n,
  }

  return { door, l2, l3, l4, deps, opts, dialed, attemptsPerAddress, peak: () => peak }
}

describe('9.4 — crawl dequeue follows local reliability', () => {
  it('SCORE_ORDER: the more reliable seed dials first…', async () => {
    const m = buildMesh()
    const s1 = makeNode(201)
    const s2 = makeNode(202)
    // Both seeds are book entries with equal fresh histories…
    expect(m.deps.book.ingestAnnouncement(s1.record, { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'log' })).toEqual({ ok: true })
    expect(m.deps.book.ingestAnnouncement(s2.record, { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'log' })).toEqual({ ok: true })
    // …then s2 earns reliability: everything it ever served verified.
    m.deps.book.recordSourcedData(s2.kp.identityId, 9, 9)

    const report = await runCrawl(m.deps, [
      { address: s1.addr, identityId: s1.kp.identityId },
      { address: s2.addr, identityId: s2.kp.identityId },
    ])
    expect(report.stoppedBy).toBe('quiet')
    expect(m.dialed).toEqual([s2.addr, s1.addr]) // boosted seed first
  })

  it('TIES_KEEP_FIFO: equal histories crawl in exactly enqueue order', async () => {
    const m = buildMesh()
    const s3 = makeNode(203)
    const s4 = makeNode(204)
    const report = await runCrawl(m.deps, [
      { address: s3.addr, identityId: s3.kp.identityId },
      { address: s4.addr, identityId: s4.kp.identityId },
    ])
    expect(report.stoppedBy).toBe('quiet')
    expect(m.dialed).toEqual([s3.addr, s4.addr])
  })
})

describe('9.3 — bounded BFS crawl (synthetic mesh)', () => {
  it('MESH_150_CAP: exactly 100 stored; depth ≤ 3; concurrency 8 observed; one dial per address', async () => {
    const m = buildMesh()
    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])

    expect(report.stoppedBy).toBe('cap')
    expect(m.deps.book.size()).toBe(100) // THE cap — exact
    expect(report.maxDepthReached).toBe(3)
    expect(report.maxConcurrency).toBe(CRAWL_CONCURRENCY) // non-vacuous: reached 8…
    expect(m.peak()).toBeLessThanOrEqual(CRAWL_CONCURRENCY) // …and never above

    // Depth-4 addresses appear in L3 responses but are NEVER dialed.
    const l4Addrs = new Set(m.l4.map((n) => n.addr))
    expect(m.dialed.some((a) => l4Addrs.has(a))).toBe(false)

    // The per-address dial budget: at most ONE attempt, ever.
    expect(Math.max(...m.attemptsPerAddress.values())).toBe(1)
  })

  it('POISON_NO_WITNESS: stored hint-grade, never dialed; its subtree undiscovered', async () => {
    const m = buildMesh()
    const poison = m.l2[5]!
    const orphan = makeNode(200) // known ONLY to the poison node
    poison.children.push(orphan)
    m.opts.unvouched = new Set([poison.addr])

    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])

    // Stored (ingest succeeded at hint grade)…
    const entry = m.deps.book.entries().find((e) => e.identityId === poison.kp.identityId)
    expect(entry?.sourceClass).toBe('hint')
    // …but NEVER dialed; the orphan never entered the book.
    expect(m.dialed).not.toContain(poison.addr)
    expect(m.deps.book.entries().some((e) => e.identityId === orphan.kp.identityId)).toBe(false)
    expect(report.uncorroborated).toBeGreaterThan(0)
  })

  it('QUIET: small mesh drains to quiet; every reachable peer crawled once', async () => {
    const m = buildMesh()
    m.door.children = [m.l2[0]!, m.l2[1]!]
    for (const n of m.l2) n.children = []
    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])
    expect(report.stoppedBy).toBe('quiet')
    expect(report.stored).toBe(2)
    expect(report.dialed).toBe(3) // door + both children
    expect(report.served).toBe(3)
    expect(report.uncorroborated).toBe(0)
  })

  it('STOPPED: cooperative stop before any dequeue', async () => {
    const m = buildMesh()
    m.deps.stopped = () => true
    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])
    expect(report.stoppedBy).toBe('stopped')
    expect(report.dialed).toBe(0)
  })

  it('FAILURE_BUDGET: a failing dial is tried once and recorded in the book', async () => {
    const m = buildMesh()
    const bad = m.l2[2]!
    m.door.children = [bad]
    bad.children = []
    m.opts.failingDials = new Set([bad.addr])

    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])

    expect(report.failed).toBe(1)
    expect(m.attemptsPerAddress.get(bad.addr)).toBe(1) // one attempt, ever
    const entry = m.deps.book.entries().find((e) => e.identityId === bad.kp.identityId)
    expect(entry?.failedDials).toBe(1) // the book's quarantine ledger counts it
  })

  it('MULTIADDR_ONE_CRAWL: two addresses of one peer — crawled once, no hang (9.3 review)', async () => {
    const m = buildMesh()
    const peer = makeNode(210)
    const secondAddr = '/ip6/2001:db8:d00d:2::/tcp/4001' // NOT in the mesh map
    const twoAddrs = [peer.addr, secondAddr]
    const fields = {
      identityId: peer.kp.identityId,
      multiaddrs: twoAddrs,
      slotStart: 0n,
      slotEnd: 100n,
      chainId: TEST_CHAIN,
    }
    const rec = { ...fields, signature: new Uint8Array(signPeerAnnouncement(peer.kp, fields)) }
    const witnessFields = {
      signerIdentityId: m.door.kp.identityId,
      subjectIdentityId: peer.kp.identityId,
      slotObserved: 5n,
      reachability: 'direct' as const,
      chainId: TEST_CHAIN,
    }
    const witness = { ...witnessFields, signature: new Uint8Array(signIntroduction(m.door.kp, witnessFields)) }
    m.opts.rawServe = (address) =>
      address === m.door.addr ? ({ records: [rec as never], witnesses: [witness as never] } as PeerBookServed) : undefined

    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])

    // THE HANG CASE (9.3 review finding 1): the stale second address must not
    // strand the pool — the run resolves regardless.
    expect(report.stoppedBy).toBe('quiet')
    const pairDials = m.dialed.filter((a) => twoAddrs.includes(a))
    expect(pairDials).toHaveLength(1) // ONE crawl for the identity…
    expect(Math.max(...m.attemptsPerAddress.values())).toBe(1) // …one attempt per address, ever
  })

  it('REJECTED_RECORD_NEVER_DIALED: ingest-invalid record with a witness is stored nothing, dialed nothing (9.3 review)', async () => {
    const m = buildMesh()
    const squatterAddr = '/ip6/2001:db8:dead:1::/tcp/4001'
    // A GARBAGE signature: the book rejects it — and the follow gate must
    // refuse it too, even though a well-formed witness accompanies it.
    const junk = {
      identityId: 'ee'.repeat(32),
      multiaddrs: [squatterAddr],
      slotStart: 0n,
      slotEnd: 100n,
      chainId: TEST_CHAIN,
      signature: new Uint8Array(64),
    }
    const witnessFields = {
      signerIdentityId: m.door.kp.identityId,
      subjectIdentityId: 'ee'.repeat(32),
      slotObserved: 5n,
      reachability: 'direct' as const,
      chainId: TEST_CHAIN,
    }
    const witness = { ...witnessFields, signature: new Uint8Array(signIntroduction(m.door.kp, witnessFields)) }
    m.opts.rawServe = (address) =>
      address === m.door.addr ? ({ records: [junk], witnesses: [witness as never] } as PeerBookServed) : undefined

    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])

    expect(report.stored).toBe(0)
    expect(m.dialed).not.toContain(squatterAddr) // never followed — ingest failure is final
    expect(m.deps.book.entries().some((e) => e.identityId === 'ee'.repeat(32))).toBe(false)
  })

  it('FORGED_WITNESS_NEVER_DIALED: witness with a bad signature stores the hint but opens no dial (9.3 review)', async () => {
    const m = buildMesh()
    const peer = makeNode(211)
    const forgedAddr = '/ip6/2001:db8:f00d:1::/tcp/4001'
    const fields = {
      identityId: peer.kp.identityId,
      multiaddrs: [forgedAddr],
      slotStart: 0n,
      slotEnd: 100n,
      chainId: TEST_CHAIN,
    }
    const rec = { ...fields, signature: new Uint8Array(signPeerAnnouncement(peer.kp, fields)) }
    // Claims the DOOR as signer — but signed by a stranger: verify fails.
    const stranger = makeNode(212)
    const witnessFields = {
      signerIdentityId: m.door.kp.identityId,
      subjectIdentityId: peer.kp.identityId,
      slotObserved: 5n,
      reachability: 'direct' as const,
      chainId: TEST_CHAIN,
    }
    const forged = { ...witnessFields, signature: new Uint8Array(signIntroduction(stranger.kp, witnessFields)) }
    m.opts.rawServe = (address) =>
      address === m.door.addr ? ({ records: [rec as never], witnesses: [forged as never] } as PeerBookServed) : undefined

    const report = await runCrawl(m.deps, [{ address: m.door.addr, identityId: m.door.kp.identityId }])

    expect(report.stored).toBe(1) // the record itself verifies — stored hint-grade
    expect(m.dialed).not.toContain(forgedAddr) // the forged vouch buys no dial
    expect(report.uncorroborated).toBe(1)
  })
})
