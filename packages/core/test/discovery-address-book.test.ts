/**
 * discovery-address-book.test.ts — ticket 8.4 matrix, part 2: the identity-
 * keyed address book with source classes (block > log > dns > hint), the
 * three-introductions promotion table, slot-parameterized expiry, quarantine-
 * after-3-failed-dials, reorg retraction via block provenance, and the size
 * cap with deterministic worst-eviction. Verify-before-connect is STRUCTURAL:
 * every row feeds hostile data through the public ingest and pins that it
 * cannot reach `dialEligible`.
 *
 *   BLOCK_FRESH            block-grade entry is eligible while fresh (0 vouches).
 *   PROMOTION_TABLE        log >= 1, dns/hint >= 3 DISTINCT-signer vouches.
 *   SAME_SIGNER_THRICE     one signer cannot mint three vouches.
 *   FUTURE_VOUCH           only slotObserved <= query-slot vouches count.
 *   REPLACE_NEWEST_WINS    newer slotEnd replaces; older is an ok:true no-op.
 *   TIE_CLASS_WINS         equal slotEnd: higher class replaces, equal keeps.
 *   REPLACE_PRESERVES      firstSeenSlot / vouches / failure state survive.
 *   QUARANTINE             3 failures → ineligible until cur > slot+Q; a
 *                          success resets.
 *   EXPIRY                 eligibility and pruning are caller-slot functions.
 *   RETRACT_ROWS           retractBlock removes exactly current-provenance
 *                          entries; unknown hash / second call are no-ops.
 *   NO_OLDER_FALLBACK      retracted replacement does not resurrect the
 *                          older record it superseded.
 *   PARKED_INTROS          vouches for unknown subjects merge on arrival.
 *   CAP_EVICT              size cap evicts the (class, slotEnd)-worst entry.
 *   ORDER_DETERMINISTIC    dialEligible is sorted by identityId hex.
 *   CONTRACT_THROWS        provenance misuse throws (programming error).
 *   POISON_NEVER_ENTERS    fast-check junk: nothing unverified reaches the
 *                          book, whatever the sequence (property).
 *   REPLACE_MONOTONIC      fast-check: entry.slotEnd is the max ingested.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import {
  ADDRESS_SOURCE_CLASSES,
  DIAL_FAILURES_TO_QUARANTINE,
  DEFAULT_QUARANTINE_SLOTS,
  MAX_BOOK_ENTRIES,
  MAX_VOUCHES_PER_SUBJECT,
  createAddressBook,
  deriveIdentityKeypair,
  signIntroduction,
  signPeerAnnouncement,
} from '../src/index.js'
import type { AddressSourceClass, BookIngestContext } from '../src/index.js'

// ---------------------------------------------------------------------------
// fixtures — deterministic keypairs; no RNG, no clocks (AD-3)
// ---------------------------------------------------------------------------

const TEST_CHAIN = 'succinctcoin-test'
const KEYPAIRS = [0x11, 0x12, 0x13, 0x14, 0x15].map((b) => deriveIdentityKeypair(new Uint8Array(32).fill(b)))
const [A, B, C, D, E] = KEYPAIRS

const HASH_1 = 'a1'.repeat(32)
const HASH_2 = 'b2'.repeat(32)
const HASH_3 = 'c3'.repeat(32)
const HASH_4 = 'd4'.repeat(32)

let addrSeq = 1
function annFor(
  kp: (typeof KEYPAIRS)[number],
  over: { slotStart?: number; slotEnd?: number; chainId?: string } = {},
) {
  const fields = {
    identityId: kp.identityId,
    multiaddrs: [`/ip4/10.9.${Math.floor(addrSeq / 250)}.${addrSeq++}/tcp/4001`],
    slotStart: 0,
    slotEnd: 100,
    chainId: TEST_CHAIN,
    ...over,
  }
  return { ...fields, signature: signPeerAnnouncement(kp, fields) }
}

function introFor(signer: (typeof KEYPAIRS)[number], subjectIdentityId: string, slotObserved: number) {
  const fields = {
    signerIdentityId: signer.identityId,
    subjectIdentityId,
    slotObserved,
    reachability: 'direct' as const,
    chainId: TEST_CHAIN,
  }
  return { ...fields, signature: signIntroduction(signer, fields) }
}

function blockCtx(blockHashHex: string, currentSlot = 5): BookIngestContext {
  return { currentSlot, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex, slot: BigInt(currentSlot) } }
}

function classCtx(sourceClass: Exclude<AddressSourceClass, 'block'>, currentSlot = 5): BookIngestContext {
  return { currentSlot, expectedChainId: TEST_CHAIN, sourceClass }
}

// ---------------------------------------------------------------------------

describe('8.4 — address book: classes, introductions, expiry, retraction', () => {
  it('BLOCK_FRESH: a block-grade entry is dial-eligible while fresh (no vouches)', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(book.size()).toBe(1)
    expect(book.dialEligible(5).map((t) => t.identityId)).toEqual([A.identityId])
    const [entry] = book.entries()
    expect(entry?.blockRef).toEqual({ blockHashHex: HASH_1, slot: 5n })
    expect(entry?.firstSeenSlot).toBe(5n)
    expect(entry?.sourceClass).toBe('block')
    expect(book.dialEligible(101).length).toBe(0) // expired at slotEnd+1
  })

  it('PROMOTION_TABLE: log needs 1 vouch, dns/hint need 3 DISTINCT signers', () => {
    const table: Array<[Exclude<AddressSourceClass, 'block'>, number]> = [
      ['log', 1],
      ['dns', 3],
      ['hint', 3],
    ]
    expect(ADDRESS_SOURCE_CLASSES).toEqual(['block', 'log', 'dns', 'hint'])
    for (const [klass, required] of table) {
      const book = createAddressBook()
      expect(book.ingestAnnouncement(annFor(A), classCtx(klass))).toEqual({ ok: true })
      expect(book.dialEligible(5), klass).toEqual([]) // no vouches yet
      const signers = [B, C, D]
      for (let n = 0; n < signers.length; n += 1) {
        const signer = signers[n] as (typeof KEYPAIRS)[number]
        expect(book.ingestIntroduction(introFor(signer, A.identityId, 4), { currentSlot: 5, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
        // Promotion happens EXACTLY at the threshold, never before.
        expect(book.dialEligible(5), `${klass} at ${n + 1}/${required}`).toEqual(
          n + 1 >= required ? [{ identityId: A.identityId, multiaddrs: book.entries()[0]?.multiaddrs ?? [], observedExternalAddr: undefined, sourceClass: klass }] : [],
        )
        if (n + 1 >= required) break // further vouches would only re-confirm
      }
    }
  })

  it('SAME_SIGNER_THRICE: three vouches from one signer never promote a hint', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), classCtx('hint'))).toEqual({ ok: true })
    for (const slot of [1, 2, 3]) {
      expect(book.ingestIntroduction(introFor(B, A.identityId, slot), { currentSlot: 5, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
    }
    expect(book.dialEligible(5)).toEqual([])
    expect(book.entries()[0]?.introductionSigners).toEqual([B.identityId])
  })

  it('FUTURE_VOUCH: only vouches with slotObserved <= query slot count', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), classCtx('log'))).toEqual({ ok: true })
    // Valid at ingest time (currentSlot 50 >= slotObserved 50)…
    expect(book.ingestIntroduction(introFor(B, A.identityId, 50), { currentSlot: 50, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
    // …but a query at slot 10 must not count it…
    expect(book.dialEligible(10)).toEqual([])
    // …while a query at 50 does.
    expect(book.dialEligible(50).map((t) => t.identityId)).toEqual([A.identityId])
  })

  it('REPLACE_NEWEST_WINS: newer slotEnd replaces, older is an ok:true no-op', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 100 }), blockCtx(HASH_1))).toEqual({ ok: true })
    const before = book.entries()[0]

    // Older record: valid observation, not an improvement — no-op, NOT an error.
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 90 }), blockCtx(HASH_2))).toEqual({ ok: true })
    expect(book.size()).toBe(1)
    expect(book.entries()[0]?.slotEnd).toBe(100n)
    expect(book.entries()[0]?.blockRef?.blockHashHex).toBe(HASH_1)

    // Newer record replaces (new provenance, new addresses).
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 120 }), blockCtx(HASH_2))).toEqual({ ok: true })
    const after = book.entries()[0]
    expect(after?.slotEnd).toBe(120n)
    expect(after?.blockRef?.blockHashHex).toBe(HASH_2)
    expect(after?.multiaddrs).not.toEqual(before?.multiaddrs)
  })

  it('TIE_CLASS_WINS: equal slotEnd — higher class replaces, equal class keeps held', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), classCtx('hint'))).toEqual({ ok: true })
    const hintAddrs = book.entries()[0]?.multiaddrs

    expect(book.ingestAnnouncement(annFor(A), classCtx('dns'))).toEqual({ ok: true })
    expect(book.entries()[0]?.sourceClass).toBe('dns') // dns > hint at equal slotEnd

    expect(book.ingestAnnouncement(annFor(A), classCtx('log'))).toEqual({ ok: true })
    expect(book.entries()[0]?.sourceClass).toBe('log') // log > dns

    const logAddrs = book.entries()[0]?.multiaddrs
    expect(book.ingestAnnouncement(annFor(A), classCtx('log'))).toEqual({ ok: true })
    expect(book.entries()[0]?.multiaddrs).toEqual(logAddrs) // equal class keeps held
    expect(hintAddrs?.length).toBe(1)
  })

  it('REPLACE_PRESERVES: firstSeenSlot, vouches, and failure state survive replacement', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), classCtx('hint', 5))).toEqual({ ok: true })
    expect(book.ingestIntroduction(introFor(B, A.identityId, 4), { currentSlot: 5, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
    book.recordDialFailure(A.identityId, 6)

    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 200 }), classCtx('hint', 7))).toEqual({ ok: true })
    const e = book.entries()[0]
    expect(e?.firstSeenSlot).toBe(5n) // identities persist across rotation
    expect(e?.introductionSigners).toEqual([B.identityId])
    expect(e?.failedDials).toBe(1)
  })

  it('QUARANTINE: 3 failures quarantine until cur > slot+Q; success resets', () => {
    const book = createAddressBook({ quarantineSlots: 4n })
    expect(book.ingestAnnouncement(annFor(A), blockCtx(HASH_1, 5))).toEqual({ ok: true })
    expect(DIAL_FAILURES_TO_QUARANTINE).toBe(3)
    expect(DEFAULT_QUARANTINE_SLOTS).toBe(32n)

    for (const slot of [9, 10, 11]) book.recordDialFailure(A.identityId, slot)
    // Quarantined from slot 11 until 11+4 = 15 (inclusive), then eligible again.
    expect(book.entries()[0]?.quarantineUntilSlot).toBe(15n)
    expect(book.dialEligible(11)).toEqual([])
    expect(book.dialEligible(15)).toEqual([]) // rule: cur <= until is ineligible
    expect(book.dialEligible(16).map((t) => t.identityId)).toEqual([A.identityId])

    // A success clears both the counter and any quarantine. (The counter
    // counts from zero here because the expired window already reset it.)
    book.recordDialFailure(A.identityId, 20)
    book.recordDialFailure(A.identityId, 20)
    expect(book.entries()[0]?.failedDials).toBe(2)
    book.recordDialSuccess(A.identityId)
    expect(book.entries()[0]?.failedDials).toBe(0)
    expect(book.entries()[0]?.quarantineUntilSlot).toBeUndefined()

    // QUARANTINE EXPIRY resets the counter too (frozen rule): after the
    // window closes, ONE new failure must not re-mint a full quarantine.
    for (const slot of [30, 31, 32]) book.recordDialFailure(A.identityId, slot)
    expect(book.entries()[0]?.quarantineUntilSlot).toBe(36n) // 32 + Q(4)
    expect(book.dialEligible(37).map((t) => t.identityId)).toEqual([A.identityId])
    book.recordDialFailure(A.identityId, 38) // expiry reset → counter is 1
    expect(book.entries()[0]?.failedDials).toBe(1)
    expect(book.entries()[0]?.quarantineUntilSlot).toBeUndefined()
    expect(book.dialEligible(38).map((t) => t.identityId)).toEqual([A.identityId])

    // Unknown ids are no-ops, never throws.
    book.recordDialFailure('f'.repeat(64), 1)
    book.recordDialSuccess('f'.repeat(64))
  })

  it('EXPIRY: eligibility drops at slotEnd+1; pruneExpired removes and counts', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 10 }), blockCtx(HASH_1, 5))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(B, { slotEnd: 20 }), blockCtx(HASH_1, 5))).toEqual({ ok: true })
    expect(book.dialEligible(10).length).toBe(2)
    expect(book.dialEligible(11).map((t) => t.identityId)).toEqual([B.identityId])
    expect(book.pruneExpired(11)).toBe(1)
    expect(book.size()).toBe(1)
    expect(book.pruneExpired(21)).toBe(1)
    expect(book.size()).toBe(0)
  })

  it('RETRACT_ROWS: retractBlock removes exactly current-provenance entries', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(B), blockCtx(HASH_2))).toEqual({ ok: true })

    expect(book.retractBlock(HASH_2)).toBe(1)
    expect(book.size()).toBe(1)
    expect(book.entries()[0]?.identityId).toBe(A.identityId) // A (block 1) untouched
    expect(book.retractBlock(HASH_2)).toBe(0) // second call is a no-op
    expect(book.retractBlock('f'.repeat(64))).toBe(0) // unknown hash is a no-op
  })

  it('NO_OLDER_FALLBACK: retracting the replacing block drops the entry entirely', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 50 }), blockCtx(HASH_1))).toEqual({ ok: true })
    // A fresher record from a different block supersedes (and detaches HASH_1).
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 60 }), blockCtx(HASH_2))).toEqual({ ok: true })
    expect(book.retractBlock(HASH_2)).toBe(1)
    // The retracted entry does NOT fall back to the older HASH_1 record —
    // documented cost of key-by-block over replay-from-head.
    expect(book.size()).toBe(0)
    expect(book.dialEligible(5)).toEqual([])
  })

  it('PARKED_INTROS: vouches for unknown subjects merge when the record arrives', () => {
    const book = createAddressBook()
    // Three vouches arrive BEFORE any record for the subject.
    for (const signer of [B, C, D]) {
      expect(book.ingestIntroduction(introFor(signer, E.identityId, 4), { currentSlot: 5, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
    }
    expect(book.size()).toBe(0) // parked, not entries
    expect(book.dialEligible(5)).toEqual([])
    // The record arrives hint-grade — the parked vouches merge immediately.
    expect(book.ingestAnnouncement(annFor(E), classCtx('hint'))).toEqual({ ok: true })
    expect([...(book.entries()[0]?.introductionSigners ?? [])].sort()).toEqual(
      [B.identityId, C.identityId, D.identityId].sort(),
    )
    expect(book.dialEligible(5).map((t) => t.identityId)).toEqual([E.identityId])
  })

  it('VOUCH_CAP: per-subject vouches are bounded, keeping the freshest', () => {
    expect(MAX_VOUCHES_PER_SUBJECT).toBe(16)
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), classCtx('hint'))).toEqual({ ok: true })
    // 17 DISTINCT signers, oldest first (slotObserved = n + 1).
    const flood = Array.from({ length: MAX_VOUCHES_PER_SUBJECT + 1 }, (_, n) =>
      deriveIdentityKeypair(new Uint8Array(32).fill(0x20 + n)),
    )
    for (const [n, signer] of flood.entries()) {
      expect(book.ingestIntroduction(introFor(signer, A.identityId, n + 1), { currentSlot: 50, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
    }
    const signers = book.entries()[0]?.introductionSigners ?? []
    expect(signers).toHaveLength(MAX_VOUCHES_PER_SUBJECT)
    // The OLDEST vouch (slotObserved 1) is the one that got evicted.
    expect(signers).not.toContain((flood[0] as (typeof KEYPAIRS)[number]).identityId)
  })

  it('CAP_EVICT: the size cap evicts the (class, slotEnd)-worst entry', () => {
    expect(MAX_BOOK_ENTRIES).toBe(64)
    const book = createAddressBook({ maxEntries: 3 })
    expect(book.ingestAnnouncement(annFor(A, { slotEnd: 300 }), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(B, { slotEnd: 200 }), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(C, { slotEnd: 100 }), blockCtx(HASH_1))).toEqual({ ok: true })
    // Fourth fresh entry evicts exactly the worst: equal class, oldest slotEnd (C).
    expect(book.ingestAnnouncement(annFor(D, { slotEnd: 400 }), blockCtx(HASH_2))).toEqual({ ok: true })
    expect(book.size()).toBe(3)
    const ids = book.entries().map((e) => e.identityId)
    expect(ids).not.toContain(C.identityId)
    expect(new Set(ids)).toEqual(new Set([A.identityId, B.identityId, D.identityId]))
  })

  it('ORDER_DETERMINISTIC: dialEligible is sorted by identityId hex', () => {
    const book = createAddressBook()
    for (const kp of [E, A, D, B, C]) {
      expect(book.ingestAnnouncement(annFor(kp), blockCtx(HASH_1))).toEqual({ ok: true })
    }
    const ids = book.dialEligible(5).map((t) => t.identityId)
    expect(ids).toEqual([...ids].sort())
  })

  it('CONTRACT_THROWS: provenance misuse is a programming error, not hostile input', () => {
    const book = createAddressBook()
    // block-grade without the reorg key…
    expect(() =>
      book.ingestAnnouncement(annFor(A), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block' }),
    ).toThrow(/blockRef/)
    // …hint-grade claiming one…
    expect(() =>
      book.ingestAnnouncement(annFor(A), {
        currentSlot: 5,
        expectedChainId: TEST_CHAIN,
        sourceClass: 'hint',
        blockRef: { blockHashHex: HASH_1, slot: 5n },
      }),
    ).toThrow(/must not carry a blockRef/)
    // …and a non-hex block hash.
    expect(() =>
      book.ingestAnnouncement(annFor(A), {
        currentSlot: 5,
        expectedChainId: TEST_CHAIN,
        sourceClass: 'block',
        blockRef: { blockHashHex: 'nothex', slot: 5n },
      }),
    ).toThrow(/32-byte hex/)
    expect(book.size()).toBe(0)
  })

  it('POISON_NEVER_ENTERS: junk through either ingest never reaches the book (property)', () => {
    const junkArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.record({ identityId: fc.string() }),
      // A well-shaped announcement from the WRONG network.
      fc.integer({ min: 100, max: 200 }).map((n) => annFor(A, { slotEnd: n, chainId: 'other-chain' })),
      // A well-shaped introduction for a random subject (never valid: unsigned).
      fc.record({
        signerIdentityId: fc.constant(A.identityId),
        subjectIdentityId: fc.constant(B.identityId),
        slotObserved: fc.integer({ min: 0, max: 5 }),
        reachability: fc.constant('direct' as const),
        chainId: fc.constant(TEST_CHAIN),
        signature: fc.constant(new Uint8Array(64)),
      }),
    )
    fc.assert(
      fc.property(fc.array(junkArb, { maxLength: 25 }), (records) => {
        const book = createAddressBook()
        for (const record of records) {
          expect(book.ingestAnnouncement(record, blockCtx(HASH_1)).ok).toBe(false)
          expect(book.ingestIntroduction(record, { currentSlot: 5, expectedChainId: TEST_CHAIN }).ok).toBe(false)
        }
        expect(book.size()).toBe(0)
        expect(book.dialEligible(5)).toEqual([])
      }),
      { numRuns: 60 },
    )
  })

  it('REPLACE_MONOTONIC: the held slotEnd is the maximum ingested (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 20 }), (deltas) => {
        const book = createAddressBook()
        for (const d of deltas) {
          expect(book.ingestAnnouncement(annFor(A, { slotEnd: 100 + d }), classCtx('hint', 50)).ok).toBe(true)
        }
        expect(book.entries()[0]?.slotEnd).toBe(100n + BigInt(Math.max(...deltas)))
      }),
      { numRuns: 60 },
    )
  })
})
