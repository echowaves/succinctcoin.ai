/**
 * discovery-introduction.test.ts — ticket 8.4 matrix, part 1 (CAP-7 vouch
 * contract): the signed Introduction ("saw X online at slot s"), its PINNED
 * domain-separated digest (golden vector), sign/verify per the identity.ts
 * conventions, the pinned cross-domain rejection BOTH WAYS, and the PURE
 * validator's pinned reject reasons.
 *
 *   WIRE_ROUND_TRIP        encode → decode keeps every field; a decoded
 *                          record validates end-to-end (bigint slot, Buffer sig).
 *   GOLDEN_DIGEST_SIG      digest + signature byte-pinned for fixed seed
 *                          keypairs (deterministic per RFC 8032).
 *   VERIFY_ROWS            every field flip / short sig → false, never throws.
 *   SIGN_OVERRIDES_SIGNER  signIntroduction always signs AS the keypair.
 *   DOMAIN_BOTH_WAYS       an intro signature never verifies as an
 *                          announcement's and vice versa (AD-12 separation).
 *   VALIDATOR_ROWS         future-observation, chain-mismatch, every
 *                          malformed-* shape → the pinned reason.
 *   JUNK_NEVER_THROWS      hostile values all return {ok:false}.
 *   MODULE_PURE            no clock / timer / net surface (AD-3/AD-10).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  INTRODUCTION_DOMAIN,
  Introduction,
  IntroductionEnvelope,
  PEER_ANNOUNCEMENT_DOMAIN,
  REACHABILITY_CLASSES,
  deriveIdentityKeypair,
  introductionDigest,
  signIntroduction,
  signPeerAnnouncement,
  validateIntroduction,
  verifyIntroductionSignature,
  verifyPeerAnnouncementSignature,
} from '../src/index.js'
import type { IntroductionContext, IntroductionFields } from '../src/index.js'

// ---------------------------------------------------------------------------
// fixtures — deterministic keypairs (no RNG anywhere, AD-3)
// ---------------------------------------------------------------------------

const SIGNER = deriveIdentityKeypair(Uint8Array.from({ length: 32 }, (_, i) => i))
const SUBJECT = deriveIdentityKeypair(new Uint8Array(32).fill(0x42))
const OTHER = deriveIdentityKeypair(new Uint8Array(32).fill(0xbb))

const TEST_CHAIN = 'succinctcoin-test'
const CTX: IntroductionContext = { currentSlot: 10, expectedChainId: TEST_CHAIN }

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function fieldsAt(over: Partial<IntroductionFields> = {}): IntroductionFields {
  return {
    signerIdentityId: SIGNER.identityId,
    subjectIdentityId: SUBJECT.identityId,
    slotObserved: 7n,
    reachability: 'direct',
    chainId: TEST_CHAIN,
    ...over,
  }
}

function signedAt(over: Partial<IntroductionFields> = {}) {
  const fields = fieldsAt(over)
  return { ...fields, signature: signIntroduction(SIGNER, fields) }
}

/** A shape-valid announcement from the SAME keypair (cross-domain rows). */
const ANN_FIELDS = {
  identityId: SIGNER.identityId,
  multiaddrs: ['/ip6/2001:db8:cb00:7109::/tcp/4001'],
  slotStart: 0,
  slotEnd: 100,
  chainId: TEST_CHAIN,
}

// ---------------------------------------------------------------------------

describe('8.4 — Introduction wire + digest contract', () => {
  it('WIRE_ROUND_TRIP: encode → decode preserves every field; decoded record validates', () => {
    const record = signedAt()
    const bytes = Introduction.encode({ ...record, slotObserved: 7n })
    const back = Introduction.decode(bytes)
    expect(back.signerIdentityId).toBe(record.signerIdentityId)
    expect(back.subjectIdentityId).toBe(record.subjectIdentityId)
    // protons decodes proto int64 as bigint — the contract accepts it.
    expect(back.slotObserved).toBe(7n)
    expect(back.reachability).toBe('direct')
    expect(back.chainId).toBe(TEST_CHAIN)
    expect(Buffer.from(back.signature).equals(Buffer.from(record.signature))).toBe(true)
    // The 8.4 path: a wire-decoded record validates with no adapter layer.
    expect(validateIntroduction(back, CTX)).toEqual({ ok: true })

    // The envelope the net adapter frames introductions in round-trips too.
    const envBytes = IntroductionEnvelope.encode({ introduction: back, sourcePeerId: 'peer-1' })
    const envBack = IntroductionEnvelope.decode(envBytes)
    expect(envBack.sourcePeerId).toBe('peer-1')
    expect(envBack.introduction?.subjectIdentityId).toBe(record.subjectIdentityId)
    expect(
      validateIntroduction(envBack.introduction, { currentSlot: 10n, expectedChainId: TEST_CHAIN }),
    ).toEqual({ ok: true })
  })

  it('GOLDEN_DIGEST_SIG: digest + signature are byte-pinned (domain-separated AD-12 layout)', () => {
    // Pinned at build (2026-10-18) from signer seed bytes 0x00..0x1f,
    // subject seed fill(0x42), slotObserved 7, reachability 'direct',
    // chain succinctcoin-test. Any digest-layout or domain-tag change
    // breaks this row.
    expect(SIGNER.identityId).toBe('03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8')
    expect(SUBJECT.identityId).toBe('2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12')
    expect(hex(introductionDigest(fieldsAt()))).toBe(
      '58a442a3e843de4f31dae7c31e079dd3f66104247c77ef24aaecc7eb619d9138',
    )
    expect(hex(signIntroduction(SIGNER, fieldsAt()))).toBe(
      'b02fcc5bb17cfeb4c1b0a53188b6e2ffe9dd7291759b61ef5b934f6212793554' +
        '60ed1b25457e5fda249102e71de0834c69ba3d591dfd68ebb910bd4eddd40f0b',
    )
  })

  it('VERIFY_ROWS: every tamper of a signed vouch fails verification, never throws', () => {
    const record = signedAt()
    expect(verifyIntroductionSignature(record, record.signature)).toBe(true)

    const flipped = new Uint8Array(record.signature)
    flipped[0] = (flipped[0] ?? 0) ^ 0x01
    expect(verifyIntroductionSignature(fieldsAt(), flipped)).toBe(false)

    // Every bound field is load-bearing.
    expect(verifyIntroductionSignature(fieldsAt({ signerIdentityId: OTHER.identityId }), record.signature)).toBe(false)
    expect(verifyIntroductionSignature(fieldsAt({ subjectIdentityId: OTHER.identityId }), record.signature)).toBe(false)
    expect(verifyIntroductionSignature(fieldsAt({ slotObserved: 8n }), record.signature)).toBe(false)
    expect(verifyIntroductionSignature(fieldsAt({ reachability: 'lan' }), record.signature)).toBe(false)
    expect(verifyIntroductionSignature(fieldsAt({ chainId: 'other-chain' }), record.signature)).toBe(false)

    // Short / non-64 signatures reject without throwing; a bad slot shape too.
    expect(verifyIntroductionSignature(fieldsAt(), record.signature.slice(0, 63))).toBe(false)
    expect(verifyIntroductionSignature({ ...fieldsAt(), slotObserved: -1n }, record.signature)).toBe(false)
    // A non-hex signer id rejects before any key parsing is attempted.
    expect(verifyIntroductionSignature({ ...fieldsAt(), signerIdentityId: 'zz' }, record.signature)).toBe(false)
  })

  it('SIGN_OVERRIDES_SIGNER: signIntroduction always signs as the keypair identity', () => {
    // Asking to vouch through someone else's key is not a thing this seam
    // offers — the signer field is replaced, so the result only verifies
    // under the keypair's OWN identity.
    const fields = fieldsAt({ signerIdentityId: OTHER.identityId })
    const sig = signIntroduction(SIGNER, fields)
    expect(verifyIntroductionSignature(fields, sig)).toBe(false)
    expect(verifyIntroductionSignature({ ...fields, signerIdentityId: SIGNER.identityId }, sig)).toBe(true)
  })

  it('DOMAIN_BOTH_WAYS: intro and announcement signatures never cross-verify (AD-12)', () => {
    // Distinct domain tag AND distinct field layout — pinned in both
    // directions so neither message type can be replayed as the other.
    expect(INTRODUCTION_DOMAIN).not.toBe(PEER_ANNOUNCEMENT_DOMAIN)

    const intro = signedAt()
    expect(verifyPeerAnnouncementSignature(ANN_FIELDS, intro.signature)).toBe(false)

    const annSig = signPeerAnnouncement(SIGNER, ANN_FIELDS)
    expect(verifyIntroductionSignature(fieldsAt(), annSig)).toBe(false)
  })

  it('REACHABILITY_CLASSES: pinned set; every class signs/validates', () => {
    expect(REACHABILITY_CLASSES).toEqual(['direct', 'via-relay', 'lan'])
    for (const reachability of REACHABILITY_CLASSES) {
      const record = signedAt({ reachability })
      expect(validateIntroduction(record, CTX)).toEqual({ ok: true })
    }
  })

  it('VALIDATOR_ROWS: each hostile shape maps to its pinned reason', () => {
    const rows: Array<[string, unknown, string]> = [
      ['ok', signedAt(), 'ok'],
      ['future-observation', signedAt({ slotObserved: 11n }), 'future-observation'],
      ['chain-mismatch', signedAt({ chainId: 'other-chain' }), 'chain-mismatch'],
      ['malformed-signer', signedAt({ signerIdentityId: 'deadbeef' }), 'malformed-signer'],
      ['malformed-subject', signedAt({ subjectIdentityId: 'x'.repeat(64) }), 'malformed-subject'],
      // A self-vouch is shape-valid and correctly SIGNED — it just carries
      // zero independence, so the threshold could never trust it.
      ['self-introduction', signedAt({ subjectIdentityId: SIGNER.identityId }), 'self-introduction'],
      // Bad slots cannot even be signed (signIntroduction throws by
      // construction), so these arrive as shape-hostile wire records.
      ['malformed-slot-float', { ...signedAt(), slotObserved: 1.5 }, 'malformed-slot'],
      ['malformed-slot-negative', { ...signedAt(), slotObserved: -1n }, 'malformed-slot'],
      ['malformed-reachability', signedAt({ reachability: 'carrier-pigeon' as never }), 'malformed-reachability'],
      ['malformed-chain-id-empty', signedAt({ chainId: '' }), 'malformed-chain-id'],
      ['malformed-chain-id-long', signedAt({ chainId: 'c'.repeat(65) }), 'malformed-chain-id'],
    ]
    for (const [name, record, reason] of rows) {
      const verdict = validateIntroduction(record, CTX)
      expect(verdict.ok, name).toBe(reason === 'ok')
      if (!verdict.ok) expect((verdict as { reason: string }).reason, name).toBe(reason)
    }

    // Truncated signature is malformed (shape), not bad-signature (crypto).
    const truncated = { ...signedAt(), signature: new Uint8Array(63) }
    expect(validateIntroduction(truncated, CTX)).toEqual({ ok: false, reason: 'malformed-signature' })

    // Wrong-key signature over otherwise-valid fields → bad-signature.
    const record = signedAt()
    expect(validateIntroduction({ ...record, signerIdentityId: OTHER.identityId }, CTX)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })

    // Chain check precedes signature work: a wrong-chain record with an
    // all-zero (shape-valid) signature reports chain-mismatch, not
    // bad-signature — a wrong-network flood never pays Ed25519.
    expect(validateIntroduction({ ...signedAt(), chainId: 'other-chain', signature: new Uint8Array(64) }, CTX)).toEqual(
      { ok: false, reason: 'chain-mismatch' },
    )
  })

  it('JUNK_NEVER_THROWS: hostile wire values produce {ok:false}, never an exception', () => {
    const junk: unknown[] = [
      null,
      undefined,
      0,
      '',
      'introduction',
      [],
      {},
      { signerIdentityId: SIGNER.identityId },
      { ...fieldsAt(), signature: 'not-bytes' },
      { ...fieldsAt(), slotObserved: {}, signature: new Uint8Array(64) },
    ]
    for (const value of junk) {
      const result = validateIntroduction(value, CTX)
      expect(result.ok, JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(
        false,
      )
    }
  })

  it('MODULE_PURE: no clock / timer / net surface in the introduction module (AD-3/AD-10)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'discovery', 'introductions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(src).not.toMatch(/\bDate\b/)
    expect(src).not.toMatch(/setTimeout|setInterval|performance\.now/)
    expect(src).not.toMatch(/node:(net|http|https|dgram|fs)|libp2p|createSocket/)
  })
})
