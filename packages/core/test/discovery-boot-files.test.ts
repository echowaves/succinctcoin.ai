/**
 * Ticket 8.5 (T1) — boot-file rungs: artifact/hints codec (atomic, bounded,
 * never-throw), `defaultLanBookPath`, and the `runBootLadder` orchestrator.
 * Deterministic throughout: tmp dirs only, caller-supplied slots (AD-3), a
 * dial SPY instead of a network.
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_ARTIFACT_RECORDS,
  createAddressBook,
  defaultLanBookPath,
  deriveIdentityKeypair,
  readAnnouncementFile,
  runBootLadder,
  signPeerAnnouncement,
  validatePeerAnnouncement,
  writeAnnouncementFile,
  writeAnnouncementsFromMessages,
} from '../src/index.js'

const TEST_CHAIN = 'succinctcoin-test'

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

/** A valid signed announcement message (valid at slots 0..100). */
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
  // Untyped literal (the proto-literal widening trap of 8.4).
  return {
    ...fields,
    signature: signPeerAnnouncement(keypair, fields),
    keypair,
  }
}

/** An announcement signed for a DIFFERENT chain (chain-mismatch rejects). */
function wrongChainMessage(i: number) {
  const keypair = deriveIdentityKeypair(seedFor(i))
  const fields = {
    identityId: keypair.identityId,
    multiaddrs: [`/ip6/2001:db8:7:${i.toString(16)}::/tcp/4001`],
    observedExternalAddr: undefined,
    slotStart: 0n,
    slotEnd: 100n,
    chainId: 'other-chain',
  }
  return { ...fields, signature: signPeerAnnouncement(keypair, fields) }
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sc-boot-'))
}

describe('8.5 T1 — announcement file codec', () => {
  it('round-trips signed announcements (found, decodable, valid)', async () => {
    const dir = await freshDir()
    const path = join(dir, 'artifact.json')
    await writeAnnouncementsFromMessages(path, [announcementMessage(1), announcementMessage(2)])

    const read = await readAnnouncementFile(path)
    expect(read.found).toBe(true)
    expect(read.records).toHaveLength(2)
    expect(read.skipped).toBe(0)
    for (const record of read.records) {
      expect(
        validatePeerAnnouncement(record, { currentSlot: 50n, expectedChainId: TEST_CHAIN }),
      ).toEqual({ ok: true })
    }
  })

  it('writes atomically — no tmp litter, parents created', async () => {
    const dir = await freshDir()
    const path = join(dir, 'nested', 'deeper', 'book.json')
    await writeAnnouncementsFromMessages(path, [announcementMessage(3)])
    const names = await readdir(join(dir, 'nested', 'deeper'))
    expect(names).toEqual(['book.json']) // no .tmp-* residue
  })

  it('failure cleanup: a failed rename leaves no tmp residue', async () => {
    const dir = await freshDir()
    const path = join(dir, 'book.json')
    // A DIRECTORY at the target makes rename(file -> dir) fail (EISDIR).
    await mkdir(path)
    await expect(writeAnnouncementFile(path, [new Uint8Array([1, 2, 3])])).rejects.toThrow()
    const names = await readdir(dir)
    expect(names.filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('never throws: absent file / bad JSON / wrong version all fail soft', async () => {
    const dir = await freshDir()
    expect(await readAnnouncementFile(join(dir, 'nope.json'))).toEqual({
      found: false,
      records: [],
      skipped: 0,
    })
    const junkPath = join(dir, 'junk.json')
    await writeFile(junkPath, 'not json {{{', 'utf8')
    expect(await readAnnouncementFile(junkPath)).toMatchObject({ found: true, records: [] })
    const wrongVersion = join(dir, 'v2.json')
    await writeFile(wrongVersion, JSON.stringify({ version: 2, blobs: [] }), 'utf8')
    expect(await readAnnouncementFile(wrongVersion)).toMatchObject({ found: true, records: [] })
  })

  it('counts blob-level junk (bad hex, truncated wire bytes) but keeps the rest', async () => {
    const dir = await freshDir()
    const path = join(dir, 'mixed.json')
    const good = announcementMessage(4)
    await writeAnnouncementsFromMessages(path, [good])
    const env = JSON.parse(await readFile(path, 'utf8')) as { blobs: string[] }
    // 'zz' fails the hex shape; '0a0541' is a truncated length-delimited
    // field (declares 5 bytes, carries 1) — proto decode must throw.
    await writeFile(
      path,
      JSON.stringify({ version: 1, blobs: ['zz', '0a0541', ...env.blobs] }),
      'utf8',
    )

    const read = await readAnnouncementFile(path)
    expect(read.found).toBe(true)
    expect(read.records).toHaveLength(1)
    expect(read.skipped).toBe(2)
  })

  it('caps reads at MAX_ARTIFACT_RECORDS (overflow counted as skipped)', async () => {
    const dir = await freshDir()
    const path = join(dir, 'flood.json')
    const blobs = Array.from({ length: MAX_ARTIFACT_RECORDS + 3 }, (_, n) =>
      Buffer.alloc(24, n).toString('hex'),
    )
    await writeFile(path, JSON.stringify({ version: 1, blobs }), 'utf8')
    const read = await readAnnouncementFile(path)
    // Junk bytes may or may not decode — either way the kept count is capped.
    expect(read.records.length + read.skipped).toBe(blobs.length)
    expect(read.records.length).toBeLessThanOrEqual(MAX_ARTIFACT_RECORDS)
    expect(read.skipped).toBeGreaterThanOrEqual(3)
  })

  it('caps writes: over-cap is a programming-error throw', async () => {
    const dir = await freshDir()
    const path = join(dir, 'x.json')
    const blobs = Array.from({ length: MAX_ARTIFACT_RECORDS + 1 }, () => new Uint8Array([1]))
    await expect(writeAnnouncementFile(path, blobs)).rejects.toThrow(RangeError)
  })
})

describe('8.5 T1 — defaultLanBookPath (OS-appropriate, pure)', () => {
  it('honours the env override on any platform', () => {
    expect(defaultLanBookPath('linux', { SUCCINCTCOIN_LAN_BOOK: '/mnt/share/ab.json' })).toBe(
      '/mnt/share/ab.json',
    )
  })
  it('per-platform defaults under a shared root', () => {
    expect(defaultLanBookPath('darwin', {}, '/Users/Shared')).toBe(
      '/Users/Shared/succinctcoin/address-book.json'
    )
    expect(defaultLanBookPath('win32', {}, 'C:\\Users\\Public')).toBe(
      'C:\\Users\\Public\\succinctcoin\\address-book.json',
    )
    expect(defaultLanBookPath('linux', {}, '/srv')).toBe('/srv/succinctcoin/address-book.json')
  })
})

describe('8.5 T1 — runBootLadder (rungs 2 + 3, fail-soft)', () => {
  it('hints rung: stores HINT-GRADE, never dial-eligible without vouchs', async () => {
    const dir = await freshDir()
    const hintsPath = join(dir, 'lan.json')
    await writeAnnouncementsFromMessages(hintsPath, [
      announcementMessage(5, ['/ip6/2001:db8:a09:909::/tcp/4001']),
    ])

    const book = createAddressBook()
    const report = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      hintsFilePath: hintsPath,
      book,
      mdnsEnabled: true,
      blocksEnabled: true,
    })
    expect(report.mdns).toBe(true)
    expect(report.blocks).toBe(true)
    expect(report.hints).toEqual({ found: true, ingested: 1, skipped: 0 })

    const entries = book.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sourceClass).toBe('hint')
    // POISONED-HINT FAIL-SOFT: stored, but never dialable on its own word —
    // a hint needs 3 distinct vouchs; later slots keep it equally inert.
    expect(book.dialEligible(50n)).toEqual([])
    expect(book.dialEligible(60n)).toEqual([])
  })

  it('hints rung: own records count as skipped, not ingested (report agrees with the book)', async () => {
    const dir = await freshDir()
    const self = announcementMessage(6)
    const other = announcementMessage(7)
    const hintsPath = join(dir, 'lan.json')
    await writeAnnouncementsFromMessages(hintsPath, [self, other])

    const book = createAddressBook({ selfIdentityId: self.keypair.identityId })
    const report = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      hintsFilePath: hintsPath,
      book,
      selfIdentityId: self.keypair.identityId,
    })
    expect(report.hints).toEqual({ found: true, ingested: 1, skipped: 1 })
    expect(book.entries().map((e) => e.identityId)).toEqual([other.keypair.identityId])
  })

  it('hints rung: wrong-chain records are counted skips, good ones land', async () => {
    const dir = await freshDir()
    const hintsPath = join(dir, 'lan.json')
    await writeAnnouncementsFromMessages(hintsPath, [
      announcementMessage(6),
      wrongChainMessage(7),
    ])

    const book = createAddressBook()
    const report = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      hintsFilePath: hintsPath,
      book,
    })
    expect(report.hints.found).toBe(true)
    expect(report.hints.ingested).toBe(1)
    expect(report.hints.skipped).toBe(1)
    expect(book.entries()).toHaveLength(1)
  })

  it('hints rung: no book ⇒ found reported, everything skipped', async () => {
    const dir = await freshDir()
    const hintsPath = join(dir, 'lan.json')
    await writeAnnouncementsFromMessages(hintsPath, [announcementMessage(12)])
    const report = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      hintsFilePath: hintsPath,
    })
    expect(report.hints).toEqual({ found: true, ingested: 0, skipped: 1 })
  })

  it('artifact rung: validates at currentSlot, dials valid non-self targets only', async () => {
    const dir = await freshDir()
    const artifactPath = join(dir, 'artifact.json')
    const self = announcementMessage(8)
    await writeAnnouncementsFromMessages(artifactPath, [
      self,
      announcementMessage(9, ['/ip6/2001:db8:a14:1e01::/tcp/4001']),
    ])

    const dialed: string[] = []
    const report = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      artifactFilePath: artifactPath,
      selfIdentityId: self.keypair.identityId,
      dial: async (addr) => {
        dialed.push(addr)
        return true
      },
    })
    expect(report.artifact.found).toBe(true)
    expect(report.artifact.targets).toBe(1) // self excluded
    expect(dialed).toEqual(['/ip6/2001:db8:a14:1e01::/tcp/4001'])

    // The same file at a slot past expiry: zero targets, all skipped.
    const late = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 200n,
      artifactFilePath: artifactPath,
      dial: async () => true,
    })
    expect(late.artifact.targets).toBe(0)
    expect(late.artifact.skipped).toBe(2)
  })

  it('artifact rung: first successful address wins; throwing dial is fail-soft', async () => {
    const dir = await freshDir()
    const artifactPath = join(dir, 'artifact.json')
    await writeAnnouncementsFromMessages(artifactPath, [
      announcementMessage(11, ['/ip6/2001:db8:a00:1::/tcp/1', '/ip6/2001:db8:a00:2::/tcp/2']),
    ])

    const tried: string[] = []
    const ok = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      artifactFilePath: artifactPath,
      dial: async (addr) => {
        tried.push(addr)
        return addr.endsWith('/2') // first fails, second succeeds
      },
    })
    expect(tried).toEqual(['/ip6/2001:db8:a00:1::/tcp/1', '/ip6/2001:db8:a00:2::/tcp/2'])
    expect(ok.artifact.targets).toBe(1)

    const boom = await runBootLadder({
      chainId: TEST_CHAIN,
      currentSlot: 50n,
      artifactFilePath: artifactPath,
      dial: () => {
        throw new Error('dial exploded')
      },
    })
    expect(boom.artifact.targets).toBe(1) // counted, never thrown
  })

  it('no files wired: report is all-missing zeros and nothing throws', async () => {
    const report = await runBootLadder({ chainId: TEST_CHAIN, currentSlot: 0n })
    expect(report.hints).toEqual({ found: false, ingested: 0, skipped: 0 })
    expect(report.artifact).toEqual({ found: false, targets: 0, skipped: 0 })
    expect(report.mdns).toBe(false)
    expect(report.blocks).toBe(false)
  })
})
