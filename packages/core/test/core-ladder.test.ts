/**
 * Ticket 8.5 (T3) — the createCore discovery wiring: boot with a LAN hints
 * file + an artifact file feeds the core-owned address book (hint-grade),
 * dials ONLY valid non-self artifact targets, and delivers the what-worked
 * report to the host sink. Fake ports throughout (the `core-surface`
 * pattern); the ladder is fire-and-forget, so rows poll BOUNDED.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FileChainStore,
  createCore,
  deriveIdentityKeypair,
  encodeInvite,
  loadGenesis,
  parseInvite,
  signPeerAnnouncement,
  writeAnnouncementsFromMessages,
} from '../src/index.js'
import type { CorePorts, LadderReport } from '../src/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')
// The core boots from the REAL genesis — the ladder validates against THAT
// chainId, so test records must be signed for it (top-level await: ESM).
const TEST_CHAIN = (await loadGenesis(GENESIS_PATH)).chainId

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

/** A valid signed announcement message (valid at slots 0..100 — the fake
 * store's head is 5, inside every window). */
function announcementMessage(i: number, addrs?: string[]) {
  const keypair = deriveIdentityKeypair(seedFor(i))
  const fields = {
    identityId: keypair.identityId,
    multiaddrs: addrs ?? [`/ip6/2001:db8:${i.toString(16)}:5::/tcp/4001`],
    observedExternalAddr: undefined,
    slotStart: 0n,
    slotEnd: 100n,
    chainId: TEST_CHAIN,
  }
  return { ...fields, signature: signPeerAnnouncement(keypair, fields), keypair }
}

// The REAL store on a tmp dir (the 8.4 harness lesson: boot commits genesis
// and the ladder reads headSlot — a fake with an inconsistent head makes
// mineAndApply throw inside the swallowed first window).
function makePorts(dir: string, netExtra: Partial<{ dial(addr: string): Promise<void> }> = {}): CorePorts {
  return {
    genesisPath: GENESIS_PATH,
    net: {
      async start() {},
      async stop() {},
      async sendBlock() {},
      async sendTicket() {},
      async sendTx() {},
      async peers() {
        return []
      },
      ...netExtra,
    },
    store: new FileChainStore(join(dir, 'chain')),
    clock: { slotIndex: () => 0, lastBlockHash: () => '0'.repeat(64) },
    gate: {
      async verify() {
        return { valid: true, identityId: 'i', attestedUntilWindow: 1 }
      },
    },
    uiSink: { sink() {} },
  } as CorePorts
}

/** Bounded poll (iterations — the house pattern, never a wall-clock assert). */
async function until(cond: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('bounded poll exhausted')
}

describe('8.5 T3 — createCore boot ladder wiring', () => {
  it('no discovery ports: boots clean; addressBook exists after start, undefined before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-ladder-'))
    const core = createCore(makePorts(dir))
    expect(core.addressBook).toBeUndefined()
    await core.start()
    expect(core.addressBook).toBeDefined()
    expect(core.addressBook?.size()).toBe(0)
    await core.stop()
  })

  it('hints + artifact files: report flows, hints land hint-grade, only valid targets dialed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-ladder-'))
    const hintsPath = join(dir, 'lan.json')
    const artifactPath = join(dir, 'artifact.json')

    const hintPeer = announcementMessage(2, ['/ip6/2001:db8:a05:505::/tcp/4001'])
    const selfRecord = announcementMessage(1) // same identity → excluded
    const artifactPeer = announcementMessage(3, ['/ip6/2001:db8:a1e:1e03::/tcp/4001'])
    await writeAnnouncementsFromMessages(hintsPath, [hintPeer])
    await writeAnnouncementsFromMessages(artifactPath, [selfRecord, artifactPeer])

    const dialed: string[] = []
    let report: LadderReport | null = null
    const ports = makePorts(dir, {
      dial: async (addr) => {
        dialed.push(addr)
      },
    })
    ports.discovery = {
      hintsFilePath: hintsPath,
      artifactFilePath: artifactPath,
      announceAddresses: () => ['/ip6/2001:db8:a00:9::/tcp/4000'],
      onLadderReport: (r) => {
        report = r
      },
    }
    // The core's OWN identity (seed 1) — the record of seed 1 in the
    // artifact is self and must be excluded from dialing.
    ports.identity = deriveIdentityKeypair(seedFor(1))

    const core = createCore(ports)
    await core.start() // the ladder fires fire-and-forget inside start()
    await until(() => report !== null)

    expect(report).not.toBeNull()
    const r = report as unknown as LadderReport
    expect(r.hints).toEqual({ found: true, ingested: 1, skipped: 0 })
    expect(r.artifact.found).toBe(true)
    expect(r.artifact.targets).toBe(1) // self excluded
    expect(dialed).toEqual(['/ip6/2001:db8:a1e:1e03::/tcp/4001'])

    // The core-owned book holds the LAN hint — stored, NOT dial-eligible.
    const book = core.addressBook
    expect(book).toBeDefined()
    const entries = book!.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.identityId).toBe(hintPeer.keypair.identityId)
    expect(entries[0]?.sourceClass).toBe('hint')
    expect(book!.dialEligible(5n)).toEqual([])

    await core.stop()
  })

  it('absent files: zero-filled report, boot unaffected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-ladder-'))
    let report: LadderReport | null = null
    const ports = makePorts(dir)
    ports.discovery = {
      hintsFilePath: join(dir, 'missing-hints.json'),
      artifactFilePath: join(dir, 'missing-artifact.json'),
      onLadderReport: (r) => {
        report = r
      },
    }
    const core = createCore(ports)
    await core.start()
    await until(() => report !== null)
    const r = report as unknown as LadderReport
    expect(r.hints.found).toBe(false)
    expect(r.artifact.found).toBe(false)
    expect(r.mdns).toBe(true) // config truth passed at this seam
    expect(r.blocks).toBe(true)
    await core.stop()
  })

  it('dial-less net (bare NetPort): artifact targets counted, nothing dialed, no throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-ladder-'))
    const artifactPath = join(dir, 'artifact.json')
    await writeAnnouncementsFromMessages(artifactPath, [announcementMessage(4)])
    let report: LadderReport | null = null
    const ports = makePorts(dir)
    ports.discovery = { artifactFilePath: artifactPath, onLadderReport: (r) => (report = r) }
    const core = createCore(ports)
    await core.start()
    await until(() => report !== null)
    expect((report as unknown as LadderReport).artifact.targets).toBe(1)
    await core.stop()
  })
})

describe('9.2 — createCore invitation wiring', () => {
  it('boot with invite.txt: invite-grade ingest + dial + report; pre-start surface is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-invite-'))
    const invitePath = join(dir, 'invite.txt')
    const peer = announcementMessage(5, ['/ip6/2001:db8:a05:5::/tcp/4001'])
    await writeFile(invitePath, `# a friend\n${encodeInvite(peer)}\n`, 'utf8')

    const dialed: string[] = []
    let report: LadderReport | null = null
    const ports = makePorts(dir, {
      dial: async (addr) => {
        dialed.push(addr)
      },
    })
    ports.discovery = { inviteFilePath: invitePath, onLadderReport: (r) => (report = r) }
    const core = createCore(ports)

    // Pre-start surface: no invite to render; applyInvite rejects SC-CORE-1.
    expect(core.getInvite()).toBeNull()
    await expect(core.applyInvite('scinvite:v1:x')).rejects.toMatchObject({ code: 'SC-CORE-1' })

    await core.start() // fresh chain = tracer-only blocks ⇒ social-trust allow
    await until(() => report !== null)
    const r = report as unknown as LadderReport
    expect(r.invites).toEqual({ found: true, verified: 1, rejected: 0 })
    expect(dialed).toEqual(['/ip6/2001:db8:a05:5::/tcp/4001'])
    const entries = core.addressBook!.entries()
    expect(entries.map((e) => [e.identityId, e.sourceClass])).toEqual([
      [peer.keypair.identityId, 'invite'],
    ])
    await core.stop()
  })

  it('getInvite renders the self-announcement; applyInvite is STRICT once real winners exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-invite-'))
    const dialed: string[] = []
    const ports = makePorts(dir, { dial: async (a) => void dialed.push(a) })
    ports.identity = deriveIdentityKeypair(seedFor(1))
    ports.discovery = { announceAddresses: () => ['/ip6/2001:db8:a00:9::/tcp/4000'] }
    const core = createCore(ports)
    await core.start()
    await core.startMining()

    // The self-invite appears once the first announce window publishes.
    await until(() => core.getInvite() !== null)
    const invite = core.getInvite() as string
    const parsed = parseInvite(invite)
    expect(parsed.ok).toBe(true)
    expect((parsed as { record: { identityId: string } }).record.identityId).toBe(
      ports.identity!.identityId,
    )

    // Mining committed real winners ⇒ liveness is decidable ⇒ STRICT: an
    // honest-looking invite for a ticket-less identity rejects, never dials.
    const squatter = announcementMessage(7, ['/ip6/2001:db8:a07:7::/tcp/4001'])
    const rejected = await core.applyInvite(encodeInvite(squatter))
    expect(rejected).toEqual({ ok: false, reason: 'no-recent-ticket' })
    expect(
      core.addressBook!.entries().some((e) => e.identityId === squatter.keypair.identityId),
    ).toBe(false)

    // The winner identity itself (this node) passes liveness — and the book
    // self-excludes it. Crucially the RUNTIME path must not DIAL our own
    // address either (9.2 review finding 1: dial loop must honour self).
    const self = await core.applyInvite(invite)
    expect(self).toEqual({ ok: true, identityId: ports.identity!.identityId })
    await new Promise((r) => setTimeout(r, 30)) // let any fire-and-forget dial land
    expect(dialed).not.toContain('/ip6/2001:db8:a00:9::/tcp/4000')
    expect(
      core.addressBook!.entries().some((e) => e.identityId === ports.identity!.identityId),
    ).toBe(false)

    await core.stop()
  })

  it('runtime applyInvite (remote, empty chain): invite-grade ingest + dial', async () => {
    // Fresh tracer-only chain ⇒ social-trust allow (the join-from-scratch case).
    const dir = await mkdtemp(join(tmpdir(), 'sc-core-invite-'))
    const dialed: string[] = []
    const ports = makePorts(dir, { dial: async (a) => void dialed.push(a) })
    ports.identity = deriveIdentityKeypair(seedFor(1)) // self = seed 1
    const core = createCore(ports)
    await core.start()

    const remote = announcementMessage(6, [
      '/ip6/2001:db8:a06:6::/tcp/4001',
      '/ip6/2001:db8:a06:7::/tcp/4002',
    ])
    const res = await core.applyInvite(encodeInvite(remote))
    expect(res).toEqual({ ok: true, identityId: remote.keypair.identityId })

    const entry = core.addressBook!
      .entries()
      .find((e) => e.identityId === remote.keypair.identityId)
    expect(entry?.sourceClass).toBe('invite')
    await until(() => dialed.length > 0) // first-success dial, fire-and-forget
    expect(dialed[0]).toBe('/ip6/2001:db8:a06:6::/tcp/4001')

    await core.stop()
  })
})
