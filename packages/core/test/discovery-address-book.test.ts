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
 *   SELF_EXCLUDE           with selfIdentityId set, records describing this
 *                          node are accepted-but-ignored (never dial targets).
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
  STABILITY_WINDOW_SLOTS,
  createAddressBook,
  deriveIdentityKeypair,
  emptyPeerHistory,
  hopNetworkKey,
  ip6Slash64,
  scorePeer,
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
    multiaddrs: [`/ip6/2001:db8:${Math.floor(addrSeq / 250).toString(16)}:${(addrSeq++).toString(16)}::/tcp/4001`],
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

  it('INVITE_FRESH (9.2): a verified invitation is dial-eligible with zero vouches', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annFor(A), classCtx('invite'))).toEqual({ ok: true })
    // Eligible immediately — the door (sig + freshness + liveness) is the trust event.
    expect(book.dialEligible(5).map((t) => t.identityId)).toEqual([A.identityId])
    const [entry] = book.entries()
    expect(entry?.sourceClass).toBe('invite')
    // No blockRef: that field stays exactly block-provenance.
    expect(entry?.blockRef).toBeUndefined()
    // Freshness still applies — an expired invite entry is not eligible.
    expect(book.dialEligible(101)).toEqual([])
  })

  it('INVITE_BEATS_LOG (9.2): eviction ranks invite between block and log', () => {
    const small = createAddressBook({ maxEntries: 2 })
    expect(small.ingestAnnouncement(annFor(A), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(small.ingestAnnouncement(annFor(B), classCtx('invite'))).toEqual({ ok: true })
    // A hint cannot evict block or invite…
    expect(small.ingestAnnouncement(annFor(C), classCtx('hint'))).toEqual({ ok: true })
    expect(small.entries().map((e) => e.sourceClass).sort()).toEqual(['block', 'invite'])
    // …but an invite evicts a log-grade entry.
    const pair = createAddressBook({ maxEntries: 2 })
    expect(pair.ingestAnnouncement(annFor(B), classCtx('invite'))).toEqual({ ok: true })
    expect(pair.ingestAnnouncement(annFor(C), classCtx('hint'))).toEqual({ ok: true })
    expect(pair.ingestAnnouncement(annFor(D), classCtx('log'))).toEqual({ ok: true })
    const kept = pair.entries().map((e) => e.identityId)
    expect(kept).toContain(B.identityId) // invite survived the log
    expect(kept).not.toContain(C.identityId) // hint was the worst entry
  })

  it('SELF_EXCLUDE: records describing this node never enter a self-aware book', () => {
    const book = createAddressBook({ selfIdentityId: A.identityId })
    // Own announcement (e.g. anchored in a block this node itself applied):
    // valid, but accepted-and-ignored — the book is the dial surface.
    expect(book.ingestAnnouncement(annFor(A), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(book.ingestIntroduction(introFor(B, A.identityId, 4), { currentSlot: 5, expectedChainId: TEST_CHAIN })).toEqual({ ok: true }) // subject = self → ignored
    expect(book.ingestAnnouncement(annFor(B), blockCtx(HASH_2))).toEqual({ ok: true })
    expect(book.size()).toBe(1)
    expect(book.dialEligible(5).map((t) => t.identityId)).toEqual([B.identityId])
    // Without selfIdentityId the default behaviour is unchanged (8.4 rows).
    const plain = createAddressBook()
    expect(plain.ingestAnnouncement(annFor(A), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(plain.size()).toBe(1)
  })

  it('PROMOTION_TABLE: log needs 1 vouch, dns/hint need 3 DISTINCT signers', () => {
    const table: Array<[Exclude<AddressSourceClass, 'block'>, number]> = [
      ['log', 1],
      ['dns', 3],
      ['hint', 3],
    ]
    expect(ADDRESS_SOURCE_CLASSES).toEqual(['block', 'invite', 'log', 'dns', 'hint'])
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
    expect(MAX_BOOK_ENTRIES).toBe(100) // 9.3: spec fill target "up to 100 total"
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

// ---------------------------------------------------------------------------
// 9.3 — the slash-64 diversity FLOOR under capacity pressure: a crowded /64
// may only grow by evicting ITS OWN weakest, never a different-prefix seat.
// ---------------------------------------------------------------------------
describe('9.3 — /64 diversity floor (MAX_ENTRIES_PER_64 = 32)', () => {
  const GROUP_ADDRS = (h: number) => [`/ip6/2001:db8:f00d:1:${h.toString(16)}::/tcp/4001`] // /64 …:f00d:1 — h is the FIFTH hextet
  const kps = (n: number, base: number) => Array.from({ length: n }, (_, i) => deriveIdentityKeypair(new Uint8Array(32).fill(base + i)))

  function annAt(kp: (typeof KEYPAIRS)[number], slotEnd: number, addrs: string[]) {
    const fields = { identityId: kp.identityId, multiaddrs: addrs, slotStart: 0, slotEnd, chainId: TEST_CHAIN }
    return { ...fields, signature: signPeerAnnouncement(kp, fields) }
  }

  /** Book of 35 (cap 35): 32 in group f00d:1 (slotEnds 101..132), plus three
   * other-group entries at slotEnds 50 / 60 / 70. */
  function crowded() {
    const book = createAddressBook({ maxEntries: 35 })
    const ctx = classCtx('log')
    const group = kps(32, 0x70)
    const others = kps(3, 0xC0)
    group.forEach((kp, i) => expect(book.ingestAnnouncement(annAt(kp, 101 + i, GROUP_ADDRS(i + 1)), ctx)).toEqual({ ok: true }))
    others.forEach((kp, i) => expect(book.ingestAnnouncement(annAt(kp, 50 + i * 10, [`/ip6/2001:db8:cafe:${i + 1}::/tcp/4001`]), ctx)).toEqual({ ok: true }))
    expect(book.size()).toBe(35)
    return { book, group, others }
  }

  it('SAME_GROUP_VICTIM: a crowded /64 grows only by evicting its own weakest', () => {
    const { book, group, others } = crowded()
    // A fresh same-group record (slotEnd 120) that would WITHOUT the floor
    // evict the global weakest (other-group slotEnd 50).
    const [fresh] = kps(1, 0xD0)
    expect(book.ingestAnnouncement(annAt(fresh, 120, GROUP_ADDRS(99)), classCtx('log'))).toEqual({ ok: true })

    const ids = book.entries().map((e) => e.identityId)
    expect(ids).toContain(fresh.identityId) // installed… (the same-group weakest lost)
    expect(ids).not.toContain(group[0]!.identityId) // …its own group's weakest (slotEnd 101)
    expect(ids).toContain(others[0]!.identityId) // the global weakest SURVIVED — floor honored
    expect(book.size()).toBe(35)
    // The group never exceeded the ceiling.
    const groups = new Map<string, number>()
    for (const e of book.entries()) {
      const g = ip6Slash64(e.multiaddrs[0] ?? '')
      if (g !== null) groups.set(g, (groups.get(g) ?? 0) + 1)
    }
    expect(Math.max(...groups.values())).toBeLessThanOrEqual(32)
  })

  it('GROUP_LOSES_SEAT: a same-group challenger worse than its own group is dropped', () => {
    const { book, group, others } = crowded()
    const [weak] = kps(1, 0xD1)
    expect(book.ingestAnnouncement(annAt(weak, 90, GROUP_ADDRS(98)), classCtx('log'))).toEqual({ ok: true }) // weaker than every group member
    const ids = book.entries().map((e) => e.identityId)
    expect(ids).not.toContain(weak.identityId) // dropped, not installed…
    expect(ids).toContain(group[0]!.identityId) // nothing evicted…
    expect(others.every((kp) => ids.includes(kp.identityId))).toBe(true)
    expect(book.size()).toBe(35)
  })

  it('FLOOR_BELOW_CAP: a full /64 stays full even when the book has room (9.3 review)', () => {
    const book = createAddressBook({ maxEntries: 40 }) // plenty of room overall
    const ctx = classCtx('log')
    const group = kps(33, 0x90)
    group.slice(0, 32).forEach((kp, i) => expect(book.ingestAnnouncement(annAt(kp, 101 + i, GROUP_ADDRS(i + 1)), ctx)).toEqual({ ok: true }))
    expect(book.size()).toBe(32)
    // The 33rd same-group record — FRESHER than every member, no capacity
    // pressure — must still be dropped by the floor (9.3 review finding 7).
    expect(book.ingestAnnouncement(annAt(group[32]!, 500, GROUP_ADDRS(33)), ctx)).toEqual({ ok: true })
    expect(book.size()).toBe(32)
    expect(book.entries().some((e) => e.identityId === group[32]!.identityId)).toBe(false)
  })

  it('FLOOR_OPENS_DOOR: a different-/64 challenger may still evict the global weakest', () => {
    const { book, group, others } = crowded()
    // The global weakest is other-group slotEnd 50; a fresh-DIFFERENT-/64
    // challenger beats it, so the ordinary contest applies unchanged — the
    // floor only constrains challengers FROM the crowded group.
    const [fresh] = kps(1, 0xD2)
    expect(book.ingestAnnouncement(annAt(fresh, 105, ['/ip6/2001:db8:beef:1::/tcp/4001']), classCtx('log'))).toEqual({ ok: true })
    const ids = book.entries().map((e) => e.identityId)
    expect(ids).toContain(fresh.identityId)
    expect(ids).not.toContain(others[0]!.identityId) // the global weakest (other-group, 50) was evicted…
    expect(ids).toContain(group[0]!.identityId) // …every crowded-group member survived
    expect(book.size()).toBe(35)
  })
})

// ---------------------------------------------------------------------------
// 11.1 — the hop law at the book boundary (amendment 2026-10-21): block-
// grade ingest ACCEPTS a global-v4-hop circuit, and the diversity floor
// groups a relay's /24 exactly like a v6 /64.
// ---------------------------------------------------------------------------
describe('11.1 — v4-hop circuits in the book (block-grade ingest + /24 floor)', () => {
  const kps = (n: number, base: number) =>
    Array.from({ length: n }, (_, i) => deriveIdentityKeypair(new Uint8Array(32).fill(base + i)))
  function annAt(kp: (typeof KEYPAIRS)[number], slotEnd: number, addrs: string[]) {
    const fields = { identityId: kp.identityId, multiaddrs: addrs, slotStart: 0, slotEnd, chainId: TEST_CHAIN }
    return { ...fields, signature: signPeerAnnouncement(kp, fields) }
  }

  it('BLOCK_V4_HOP_INGESTS: a v4-hop circuit enters at block grade and dials', () => {
    const book = createAddressBook()
    const addr = `/ip4/203.0.113.9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/${A.identityId.slice(0, 8)}`
    expect(book.ingestAnnouncement(annAt(A, 100, [addr]), blockCtx(HASH_1))).toEqual({ ok: true })
    expect(book.size()).toBe(1)
    const [entry] = book.entries()
    expect(entry?.multiaddrs).toEqual([addr]) // stored verbatim
    expect(book.dialEligible(5).map((t) => t.identityId)).toEqual([A.identityId])
    // A NON-global hop still cannot enter — the validator inside ingest is
    // the same strict law (block ctx), so a CGNAT hop is rejected outright.
    const book2 = createAddressBook()
    const cgnat = `/ip4/100.64.0.9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/${B.identityId.slice(0, 8)}`
    expect(book2.ingestAnnouncement(annAt(B, 100, [cgnat]), blockCtx(HASH_2))).toEqual({
      ok: false,
      reason: 'unsupported-address',
    })
    expect(book2.size()).toBe(0)
    // Neither does a DIRECT v4 (the direct law is unchanged at this boundary):
    expect(book2.ingestAnnouncement(annAt(B, 100, ['/ip4/203.0.113.9/tcp/4001']), blockCtx(HASH_2))).toEqual({
      ok: false,
      reason: 'unsupported-address',
    })
    expect(book2.size()).toBe(0)
  })

  it('SLASH24_FLOOR: a crowded relay /24 binds exactly like a crowded /64', () => {
    // Same book shape as FLOOR_BELOW_CAP (9.3), one family swap: 32 records
    // in ONE relay /24 install, the 33rd — fresher than every member, no
    // capacity pressure — is dropped by the floor.
    const book = createAddressBook({ maxEntries: 40 })
    const ctx = classCtx('log')
    const group = kps(33, 0x30)
    group
      .slice(0, 32)
      .forEach((kp, i) =>
        expect(book.ingestAnnouncement(annAt(kp, 101 + i, [`/ip4/203.0.113.${i + 1}/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmSelf`]), ctx)).toEqual({ ok: true }),
      )
    expect(book.size()).toBe(32)
    expect(book.ingestAnnouncement(annAt(group[32]!, 500, ['/ip4/203.0.113.200/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmSelf']), ctx)).toEqual({ ok: true })
    expect(book.size()).toBe(32)
    expect(book.entries().some((e) => e.identityId === group[32]!.identityId)).toBe(false)
    // The group key is the /24, family-tagged — and a DIFFERENT /24 is a
    // different group (the floor binds per network, exactly like /64s):
    const groups = new Map<string, number>()
    for (const e of book.entries()) {
      const g = hopNetworkKey(e.multiaddrs[0] ?? '')
      expect(g).toBe('4:203.0.113.0')
      groups.set(g ?? 'null', (groups.get(g ?? 'null') ?? 0) + 1)
    }
    expect(groups.size).toBe(1)
    expect(hopNetworkKey('/ip4/203.0.114.1/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmSelf')).toBe('4:203.0.114.0')
  })

  it('MIXED_FAMILY_GROUPS: v6 /64 and v4 /24 keys never collide or cross-bind', () => {
    const book = createAddressBook({ maxEntries: 40 })
    const ctx = classCtx('log')
    // One v6 record and one v4-hop record whose raw group strings could
    // alias if the family tag were missing — they must coexist freely.
    expect(book.ingestAnnouncement(annAt(A, 100, ['/ip6/2001:db8::1/tcp/4001']), ctx)).toEqual({ ok: true })
    expect(
      book.ingestAnnouncement(
        annAt(B, 100, ['/ip4/203.0.113.9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmSelf']),
        ctx,
      ),
    ).toEqual({ ok: true })
    expect(book.size()).toBe(2)
    const keys = book.entries().map((e) => hopNetworkKey(e.multiaddrs[0] ?? ''))
    expect(new Set(keys).size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 9.4 — reliability scoring: an ORDERING signal, never eligibility
// ---------------------------------------------------------------------------

describe('9.4 — reliability score on the book', () => {
  const oneAddr = (tag: string) => [`/ip6/2001:db8:9${tag}:1::/tcp/4001`]
  function annAt(kp: (typeof KEYPAIRS)[number], slotEnd: number, addrs: string[]) {
    const fields = { identityId: kp.identityId, multiaddrs: addrs, slotStart: 0, slotEnd, chainId: TEST_CHAIN }
    return { ...fields, signature: signPeerAnnouncement(kp, fields) }
  }

  it('EVICT_WITHIN_CLASS_BY_SCORE: the flakier same-class entry loses its seat despite the NEWER slotEnd', () => {
    const book = createAddressBook({ maxEntries: 2 })
    expect(book.ingestAnnouncement(annAt(A, 90, oneAddr('a')), classCtx('log'))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annAt(B, 100, oneAddr('b')), classCtx('log'))).toEqual({ ok: true })
    // B is the FRESHER record — under the pre-9.4 (class, slotEnd) order it
    // would survive; reliability now sinks it below A.
    book.recordDialFailure(B.identityId, 6) // one failure: EWMA 0, no quarantine
    book.recordSourcedData(B.identityId, 0, 8) // everything B served was junk
    const [C2] = [C] as const
    expect(book.ingestAnnouncement(annAt(C2, 95, oneAddr('c')), classCtx('log'))).toEqual({ ok: true })
    const ids = book.entries().map((e) => e.identityId)
    expect(ids).toContain(A.identityId) // the reliable older entry kept its seat…
    expect(ids).toContain(C2.identityId)
    expect(ids).not.toContain(B.identityId) // …the flaky freshest one lost it
  })

  it('CLASS_TIER_IS_HARD: a max-score hint never outranks a log record for a seat', () => {
    const book = createAddressBook({ maxEntries: 2 })
    expect(book.ingestAnnouncement(annAt(A, 100, oneAddr('d1')), classCtx('hint'))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annAt(B, 90, oneAddr('d2')), classCtx('log'))).toEqual({ ok: true })
    // Max out the hint's reliability — trust class must still decide.
    book.recordDialSuccess(A.identityId, 1)
    book.recordSourcedData(A.identityId, 50, 50)
    expect(book.score(A.identityId)).toBeGreaterThan(book.score(B.identityId))
    expect(book.ingestAnnouncement(annAt(C, 95, oneAddr('d3')), classCtx('log'))).toEqual({ ok: true })
    const ids = book.entries().map((e) => e.identityId)
    expect(ids).not.toContain(A.identityId) // hint evicted despite the best score…
    expect(ids).toContain(B.identityId) // …the weaker log record survived
  })

  it('ELIGIBILITY_INVARIANT: zeroed and maxed scores leave dialEligible IDENTICAL', () => {
    const book = createAddressBook()
    expect(book.ingestAnnouncement(annAt(A, 100, oneAddr('1')), blockCtx('e1'.repeat(32)))).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annAt(B, 100, oneAddr('2')), classCtx('log'))).toEqual({ ok: true }) // un-promoted
    expect(book.ingestAnnouncement(annAt(C, 100, oneAddr('3')), classCtx('hint'))).toEqual({ ok: true }) // un-promoted
    const base = book.dialEligible(10).map((t) => t.identityId)
    expect(base).toEqual([A.identityId]) // class rules only — B/C need vouches

    // ZERO every history hard…
    for (const kp of [A, B, C]) {
      book.recordDialFailure(kp.identityId, 6)
      book.recordSourcedData(kp.identityId, 0, 99)
    }
    const zeroed = base.join()
    const scoreZero = book.score(C.identityId)
    expect(book.dialEligible(10).map((t) => t.identityId)).toEqual(base) // zero-score block record STAYS dialable
    // NUMERIC non-vacuity: A really is near-zero (dial 0, validity 0 — only
    // the optimistic latency default and one seen slot remain)…
    expect(book.score(A.identityId)).toBeLessThan(0.2)
    // …and a mild score-gate hidden in dialEligible could not hide here.
    expect(book.score(A.identityId)).toBeLessThan(scorePeer(emptyPeerHistory()))

    // …then MAX it (reliability only — no vouches, no class change). Six
    // successes drive the dial EWMA to 1−0.7⁶ ≈ 0.88 from the zeroed 0.
    for (const kp of [A, B, C]) {
      for (let k = 0; k < 6; k++) book.recordDialSuccess(kp.identityId, 1)
      book.recordSourcedData(kp.identityId, 99, 99)
    }
    expect(book.score(C.identityId)).toBeGreaterThan(scoreZero) // histories really moved (non-vacuity)
    // NUMERIC again: C climbs from ≈0.11 (zeroed) to ≈0.54 — a large,
    // asserted swing, while eligibility stays byte-identical below.
    expect(book.score(C.identityId) - scoreZero).toBeGreaterThan(0.4)
    expect(book.dialEligible(10).map((t) => t.identityId)).toEqual(base) // max-score hint NEVER becomes dialable
    expect(zeroed).toBe(base.join())
  })

  it('HISTORY_ROWS: seenSlots dedupe/window, sourced accumulation, latency EWMA, corroboration count, unknown id', () => {
    const book = createAddressBook()
    const addr = oneAddr('7')
    expect(book.ingestAnnouncement(annAt(A, 100, addr), blockCtx('f1'.repeat(32), 5))).toEqual({ ok: true })
    let e = book.entries().find((x) => x.identityId === A.identityId)!
    expect(e.history.seenSlots).toEqual([5n]) // install stamps the slot
    expect(e.history.corroborations).toBe(0) // independent signers only — not provenance

    // Re-ingest at the SAME slot dedupes; newer records at new slots extend.
    for (const [slot, end] of [[5, 200], [6, 300], [7, 400]] as const) {
      expect(book.ingestAnnouncement(annAt(A, end, addr), blockCtx('f1'.repeat(32), slot))).toEqual({ ok: true })
    }
    e = book.entries().find((x) => x.identityId === A.identityId)!
    expect(e.history.seenSlots).toEqual([5n, 6n, 7n])

    // Window: rotate through 33 more distinct slots — only the newest 24 stay.
    for (let slot = 8; slot <= 40; slot++) {
      expect(book.ingestAnnouncement(annAt(A, 1000 + slot, addr), blockCtx('f1'.repeat(32), slot))).toEqual({ ok: true })
    }
    e = book.entries().find((x) => x.identityId === A.identityId)!
    expect(e.history.seenSlots).toHaveLength(STABILITY_WINDOW_SLOTS)
    expect(e.history.seenSlots[0]).toBe(17n) // 40 − 24 + 1 — oldest evicted
    expect(e.history.seenSlots[STABILITY_WINDOW_SLOTS - 1]).toBe(40n)

    // Sourced data accumulates across sink calls.
    book.recordSourcedData(A.identityId, 2, 4)
    book.recordSourcedData(A.identityId, 3, 6)
    e = book.entries().find((x) => x.identityId === A.identityId)!
    expect([e.history.sourcedValid, e.history.sourcedTotal]).toEqual([5, 10])

    // Latency EWMA: first sample wins, then α-blend (0.3·300 + 0.7·100).
    book.recordDialSuccess(A.identityId, 100)
    book.recordDialSuccess(A.identityId, 300)
    e = book.entries().find((x) => x.identityId === A.identityId)!
    expect(e.history.latencyEwmaMs).toBeCloseTo(160, 12)

    // Distinct introduction signers add corroboration.
    const fields = { signerIdentityId: D.identityId, subjectIdentityId: A.identityId, slotObserved: 40, reachability: 'direct' as const, chainId: TEST_CHAIN }
    expect(book.ingestIntroduction({ ...fields, signature: signIntroduction(D, fields) }, { currentSlot: 40, expectedChainId: TEST_CHAIN })).toEqual({ ok: true })
    e = book.entries().find((x) => x.identityId === A.identityId)!
    expect(e.history.corroborations).toBe(1)

    // An unknown id scores as a fresh history.
    expect(book.score('ff'.repeat(32))).toBeCloseTo(scorePeer(emptyPeerHistory()), 12)
  })
})
