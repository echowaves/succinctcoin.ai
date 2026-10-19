/**
 * peerbook-serve.test.ts — ticket 9.3: the SERVE POLICY (which records leave
 * the book, byte-true, with self-signed witnesses). Pure over a real book.
 *
 *   FRESHNESS_ORDER    slotEnd desc, identityId ties asc; limit truncates.
 *   HINT_EXCLUDED      hint-grade never serves (amplification guard).
 *   SELF_NEVER_SERVES  the book's self-exclusion flows through.
 *   BYTE_TRUE          served records carry the ORIGINAL signature bytes
 *                      (a server can never re-sign another peer).
 *   WITNESSES          one self-signed Introduction per served record,
 *                      verifying against the signer; no signer ⇒ none.
 *   LIMIT_FLOOR        limit < 1 serves nothing.
 */
import { describe, expect, it } from 'vitest'

import {
  createAddressBook,
  deriveIdentityKeypair,
  servePeerBook,
  signIntroduction,
  signPeerAnnouncement,
  verifyIntroductionSignature,
} from '../src/index.js'

const TEST_CHAIN = 'succinctcoin-test'
const KEYPAIRS = [0x21, 0x22, 0x23, 0x24].map((b) => deriveIdentityKeypair(new Uint8Array(32).fill(b)))
const [A, B, C, D] = KEYPAIRS

let addrSeq = 1
function annFor(kp: (typeof KEYPAIRS)[number], slotEnd: number) {
  const fields = {
    identityId: kp.identityId,
    multiaddrs: [`/ip6/2001:db8:5:${(addrSeq++).toString(16)}::/tcp/4001`],
    slotStart: 0,
    slotEnd,
    chainId: TEST_CHAIN,
  }
  return { ...fields, signature: signPeerAnnouncement(kp, fields) }
}

describe('9.3 — servePeerBook policy', () => {
  it('FRESHNESS_ORDER + HINT_EXCLUDED + limit', () => {
    const book = createAddressBook()
    // A(block, end 50), B(invite, end 90), C(block, end 70), D(hint+3 vouches…
    // hint needs 3 vouches to be ELIGIBLE — even eligible, it must not serve.
    expect(book.ingestAnnouncement(annFor(A, 50), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex: 'a1'.repeat(32), slot: 5n } })).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(B, 90), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'invite' })).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(C, 70), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex: 'c3'.repeat(32), slot: 5n } })).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(D, 99), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'hint' })).toEqual({ ok: true })
    // Make D ELIGIBLE (3 distinct vouches) — so its exclusion below is the
    // CLASS rule, not an eligibility accident.
    for (const v of [A, B, C]) {
      const fields = {
        signerIdentityId: v.identityId,
        subjectIdentityId: D.identityId,
        slotObserved: 4,
        reachability: 'direct' as const,
        chainId: TEST_CHAIN,
      }
      expect(
        book.ingestIntroduction({ ...fields, signature: signIntroduction(v, fields) }, {
          currentSlot: 5,
          expectedChainId: TEST_CHAIN,
        }),
      ).toEqual({ ok: true })
    }
    expect(book.dialEligible(5).map((t) => t.identityId)).toContain(D.identityId)

    const served = servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit: 10 })
    expect(served.records.map((r) => r.identityId)).toEqual([B.identityId, C.identityId, A.identityId]) // end 90, 70, 50 — hint (99) excluded

    const limited = servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit: 2 })
    expect(limited.records.map((r) => r.identityId)).toEqual([B.identityId, C.identityId])

    expect(servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit: 0 }).records).toEqual([])
  })

  it('BYTE_TRUE records + SELF never served + WITNESSES verify', () => {
    const self = KEYPAIRS[0]
    const book = createAddressBook({ selfIdentityId: self.identityId })
    const rec = annFor(B, 90)
    expect(book.ingestAnnouncement(rec, { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'invite' })).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(self, 80), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex: 'd1'.repeat(32), slot: 5n } })).toEqual({ ok: true }) // self — ignored

    const served = servePeerBook({ book, currentSlot: 7n, expectedChainId: TEST_CHAIN, limit: 5, witnessSigner: B })
    expect(served.records).toHaveLength(1)
    expect(served.records[0]!.identityId).toBe(B.identityId)
    // The ORIGINAL signature bytes (the fixture's), not a re-signature.
    expect(Buffer.from(served.records[0]!.signature)).toEqual(Buffer.from(rec.signature))

    expect(served.witnesses).toHaveLength(1)
    const w = served.witnesses[0]!
    expect(w.signerIdentityId).toBe(B.identityId)
    expect(w.subjectIdentityId).toBe(B.identityId)
    expect(w.slotObserved).toBe(7n)
    expect(verifyIntroductionSignature({ ...w, reachability: w.reachability as 'direct' }, w.signature)).toBe(true)

    // No signer ⇒ records without witnesses (honest, not fatal).
    expect(servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit: 5 }).witnesses).toEqual([])
  })
})

describe('9.4 — serve order follows local reliability', () => {
  it('SCORE_ORDER: the reliable older record serves first; equal histories keep freshness order', () => {
    const book = createAddressBook()
    // A(block, end 50) vs C(block, end 70): pre-9.4 the fresher C led.
    expect(book.ingestAnnouncement(annFor(A, 50), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex: 'a1'.repeat(32), slot: 5n } })).toEqual({ ok: true })
    expect(book.ingestAnnouncement(annFor(C, 70), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex: 'c3'.repeat(32), slot: 5n } })).toEqual({ ok: true })
    // Equal (empty) histories → the 9.3 freshness order is UNTOUCHED.
    expect(servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit: 10 }).records.map((r) => r.identityId)).toEqual([C.identityId, A.identityId])

    // Reliability evidence flips the order: A's sourced data held up, C's did not.
    book.recordSourcedData(A.identityId, 20, 20)
    book.recordSourcedData(C.identityId, 0, 20)
    const served = servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit: 10 })
    expect(served.records.map((r) => r.identityId)).toEqual([A.identityId, C.identityId])
  })
})
