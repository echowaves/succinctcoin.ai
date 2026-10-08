/**
 * Story 4.2 matrix — the identity keypair + ticket signature (E2,
 * AD-11 / AD-12).
 *
 *   SIG_KEYPAIR_DERIVE      — deterministic seed → keypair: two calls
 *                             with the same seed yield the identical
 *                             `identityId` + byte-identical `publicKey`;
 *                             `identityId` is exactly 64 hex chars AND
 *                             `identityId === hex(publicKey)`; a
 *                             different seed → a different `identityId`;
 *                             a 31- or 33-byte seed → THROWS
 *                             `IdentityError` `SC-IDENTITY-2`.
 *   SIG_ROUNDTRIP_GOLDEN    — the pinned AD-12 golden vector: the fixed
 *                             seed + the fixed ticket (windowIndex = 7,
 *                             challenge = 32×0x01, nonceCommitment =
 *                             32×0x02) produce the PINNED 64-byte
 *                             signature, and
 *                             `verifyTicketSignature` returns `true`.
 *   SIG_TAMPER_REJECT       — the golden signature with (a) a different
 *                             `windowIndex`, (b) a different
 *                             `challenge`, (c) a different
 *                             `nonceCommitment`, (d) a signature from a
 *                             DIFFERENT identity's key, or (e) a
 *                             truncated / one-byte-flipped signature →
 *                             `false` (the digest binds all four fields;
 *                             a foreign key cannot sign for this
 *                             identityId).
 *   SIG_REPLAY_REJECT       — the winner's PUBLIC ticket (all four
 *                             fields public) presented without the
 *                             winner's private key: (a) an empty
 *                             signature, (b) a signature produced by a
 *                             DIFFERENT identity key over the same four
 *                             fields, (c) the winner's GENUINE signature
 *                             → (a) `false`; (b) `false` — possession of
 *                             the public ticket is NOT enough to forge a
 *                             valid signature (the epic-3 residual
 *                             replay is closed); (c) `true`.
 *   SIG_VERIFY_FROM_PUBLIC_DATA — (a) verify using ONLY the
 *                             `identityId` string (no keypair object)
 *                             for the genuine signature → `true` (the
 *                             public key is reconstructed from
 *                             `identityId` ALONE — no secret needed);
 *                             (b) a malformed `identityId` (36 hex
 *                             chars / non-hex / a valid-length but
 *                             invalid Ed25519 key) → `false` (never a
 *                             throw). Also: `signTicket` is
 *                             deterministic — the same keypair + fields
 *                             → byte-identical signature across two
 *                             calls.
 *
 * Imports ONLY from the ROOT barrel (`../src/index.js`) — the AD-12
 * digest and the Ed25519 crypto are NEVER re-implemented here (AD-11:
 * the core owns the key material + the signature seam). Test-only: the
 * hex/bytes helpers below CONSTRUCT test inputs (pinned constants),
 * they do not re-implement the digest or the scheme.
 */
import { describe, expect, it } from 'vitest'

import {
  IdentityError,
  deriveIdentityKeypair,
  signTicket,
  verifyTicketSignature,
} from '../src/index.js'
import type { IdentityKeypair, TicketFields } from '../src/index.js'

// ---------------------------------------------------------------------------
// the pinned AD-12 golden vector inputs (D-matrix)
// ---------------------------------------------------------------------------

/** The golden seed: 32 bytes, 0x00..0x1f. */
const GOLDEN_SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i))

/** The golden ticket fields (AD-12): windowIndex = 7; challenge = 32×0x01; nonceCommitment = 32×0x02. */
const GOLDEN_FIELDS: TicketFields = {
  windowIndex: 7,
  challenge: new Uint8Array(32).fill(0x01),
  nonceCommitment: new Uint8Array(32).fill(0x02),
}

// Pinned by the implementation (D-matrix): seed 00..1f → this
// identityId (64 hex = the hex of the 32-byte Ed25519 public key); the
// golden ticket → this 64-byte Ed25519 signature. Regenerate ONLY by
// changing the scheme (a protocol change) — never hand-edit.
const GOLDEN_IDENTITY_ID =
  '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8'
const GOLDEN_SIGNATURE_HEX =
  '64660f3b591f68d6fd133ecea649e70295d53585a8d8d4e0ebe9931025ef408cde2f4484a61e95a52bfca2624b98df82c3e6d2c4ea5073ac44853d8921ae9905'

// ---------------------------------------------------------------------------
// input-construction helpers (test-only; the digest + crypto are imported,
// never re-implemented)
// ---------------------------------------------------------------------------

/** Bytes → lowercase hex (constructing an expected constant, not a digest). */
const toHex = (buf: Uint8Array): string =>
  Buffer.from(buf.subarray()).toString('hex')

/** Hex → bytes (constructing a pinned constant, not a digest). */
const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h, 'hex'))

/** Byte-wise equality (assertion helper). */
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength &&
  Array.from(a).every((v, i) => v === b[i])

/** A 32-byte seed filled with one byte value (a "different seed"). */
const seedFilled = (v: number): Uint8Array => new Uint8Array(32).fill(v)

/** Derive the golden keypair (deterministic — the same keypair every run). */
const goldenKeypair = (): IdentityKeypair =>
  deriveIdentityKeypair(GOLDEN_SEED)

const GOLDEN_SIGNATURE = fromHex(GOLDEN_SIGNATURE_HEX)

// ---------------------------------------------------------------------------
// SIG_KEYPAIR_DERIVE
// ---------------------------------------------------------------------------

describe('SIG_KEYPAIR_DERIVE — deterministic seed → Ed25519 keypair (D2/D3)', () => {
  it('same seed → identical identityId + byte-identical publicKey; identityId = hex(publicKey), 64 hex chars; different seed → different identityId; 31- or 33-byte seed → IdentityError SC-IDENTITY-2', () => {
    const a = deriveIdentityKeypair(GOLDEN_SEED)
    const b = deriveIdentityKeypair(GOLDEN_SEED)

    // Deterministic: both calls → identical identityId + byte-identical
    // publicKey (no RNG — AD-3/AD-10).
    expect(a.identityId).toBe(b.identityId)
    expect(eqBytes(a.publicKey, b.publicKey)).toBe(true)
    expect(eqBytes(a.secret, b.secret)).toBe(true)

    // D2: identityId is exactly 64 hex chars AND identityId = hex(publicKey).
    expect(a.identityId).toMatch(/^[0-9a-f]{64}$/)
    expect(a.identityId).toBe(toHex(a.publicKey))
    expect(a.publicKey.byteLength).toBe(32)

    // A different seed → a different identityId (and key material).
    const other = deriveIdentityKeypair(seedFilled(0x42))
    expect(other.identityId).not.toBe(a.identityId)
    expect(eqBytes(other.publicKey, a.publicKey)).toBe(false)

    // 31- or 33-byte seed → THROWS IdentityError SC-IDENTITY-2 (a
    // programming error — the ONLY throw path in the module).
    for (const len of [31, 33]) {
      const bad = new Uint8Array(len)
      let thrown: unknown
      try {
        deriveIdentityKeypair(bad)
      } catch (e) {
        thrown = e
      }
      expect(thrown, `seed of ${len} bytes must throw`).toBeInstanceOf(
        IdentityError,
      )
      expect((thrown as IdentityError).code).toBe('SC-IDENTITY-2')
    }
  })
})

// ---------------------------------------------------------------------------
// SIG_ROUNDTRIP_GOLDEN
// ---------------------------------------------------------------------------

describe('SIG_ROUNDTRIP_GOLDEN — the pinned AD-12 golden vector (D4)', () => {
  it('signTicket over the golden inputs → the pinned 64-byte signature; verifyTicketSignature → true', () => {
    const keypair = goldenKeypair()

    // The derived identityId is the pinned golden identityId (D2).
    expect(keypair.identityId).toBe(GOLDEN_IDENTITY_ID)

    // The signature is the PINNED 64-byte golden vector (byte-identical,
    // deterministic — RFC 8032, no RNG).
    const signature = signTicket(keypair, GOLDEN_FIELDS)
    expect(signature.byteLength).toBe(64)
    expect(toHex(signature)).toBe(GOLDEN_SIGNATURE_HEX)

    // The AD-12 golden round-trip: verify → true.
    expect(
      verifyTicketSignature(keypair.identityId, GOLDEN_FIELDS, signature),
    ).toBe(true)
    expect(
      verifyTicketSignature(GOLDEN_IDENTITY_ID, GOLDEN_FIELDS, GOLDEN_SIGNATURE),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SIG_TAMPER_REJECT
// ---------------------------------------------------------------------------

describe('SIG_TAMPER_REJECT — a tampered ticket fails verification (D4/D5)', () => {
  it('a different windowIndex / challenge / nonceCommitment, a foreign-key signature, or a truncated / one-byte-flipped signature → false', () => {
    const keypair = goldenKeypair()

    // (a) a different windowIndex (the digest binds it, u64be).
    expect(
      verifyTicketSignature(
        keypair.identityId,
        { ...GOLDEN_FIELDS, windowIndex: 8 },
        GOLDEN_SIGNATURE,
      ),
    ).toBe(false)
    // A bigint windowIndex with the same value is the SAME digest — the
    // field is bound as u64be, not by JS type (sanity: still true).
    expect(
      verifyTicketSignature(
        keypair.identityId,
        { ...GOLDEN_FIELDS, windowIndex: 7n },
        GOLDEN_SIGNATURE,
      ),
    ).toBe(true)

    // (b) a different challenge (one byte flipped).
    const flippedChallenge = new Uint8Array(GOLDEN_FIELDS.challenge)
    flippedChallenge[0] ^= 0xff
    expect(
      verifyTicketSignature(
        keypair.identityId,
        { ...GOLDEN_FIELDS, challenge: flippedChallenge },
        GOLDEN_SIGNATURE,
      ),
    ).toBe(false)

    // (c) a different nonceCommitment (one byte flipped).
    const flippedCommitment = new Uint8Array(GOLDEN_FIELDS.nonceCommitment)
    flippedCommitment[31] ^= 0xff
    expect(
      verifyTicketSignature(
        keypair.identityId,
        { ...GOLDEN_FIELDS, nonceCommitment: flippedCommitment },
        GOLDEN_SIGNATURE,
      ),
    ).toBe(false)

    // (d) a signature made by a DIFFERENT identity's key over the same
    //     four fields — a foreign key cannot sign for this identityId.
    const foreign = deriveIdentityKeypair(seedFilled(0x42))
    const foreignSig = signTicket(foreign, GOLDEN_FIELDS)
    expect(
      verifyTicketSignature(keypair.identityId, GOLDEN_FIELDS, foreignSig),
    ).toBe(false)

    // (e) a truncated / one-byte-flipped signature.
    expect(
      verifyTicketSignature(
        keypair.identityId,
        GOLDEN_FIELDS,
        GOLDEN_SIGNATURE.subarray(0, 63),
      ),
    ).toBe(false)
    const flipped = new Uint8Array(GOLDEN_SIGNATURE)
    flipped[0] ^= 0xff
    expect(
      verifyTicketSignature(keypair.identityId, GOLDEN_FIELDS, flipped),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SIG_REPLAY_REJECT
// ---------------------------------------------------------------------------

describe('SIG_REPLAY_REJECT — the epic-3 residual replay is closed (D1/D5)', () => {
  it('an unselected node holding only the winner\'s PUBLIC ticket cannot forge a valid signature: empty / foreign → false; only the genuine private key → true', () => {
    const keypair = goldenKeypair()

    // The winner's PUBLIC ticket: all four fields are public (they are
    // what the chain carries). The attacker holds none of the keypair
    // object — only these four fields.
    const publicTicket = {
      identityId: keypair.identityId,
      windowIndex: GOLDEN_FIELDS.windowIndex,
      challenge: GOLDEN_FIELDS.challenge,
      nonceCommitment: GOLDEN_FIELDS.nonceCommitment,
    }

    // (a) an empty signature → false (a normal reject, never a throw).
    expect(
      verifyTicketSignature(
        publicTicket.identityId,
        {
          windowIndex: publicTicket.windowIndex,
          challenge: publicTicket.challenge,
          nonceCommitment: publicTicket.nonceCommitment,
        },
        new Uint8Array(0),
      ),
    ).toBe(false)

    // (b) a signature produced by a DIFFERENT identity key over the SAME
    //     four fields (the attacker can mint their own keypair — but it
    //     is not the winner's) → false: possession of the public ticket
    //     is NOT enough to forge a valid signature (the epic-3 residual
    //     replay is closed).
    const attacker = deriveIdentityKeypair(seedFilled(0x99))
    const forged = signTicket(attacker, {
      windowIndex: publicTicket.windowIndex,
      challenge: publicTicket.challenge,
      nonceCommitment: publicTicket.nonceCommitment,
    })
    expect(
      verifyTicketSignature(
        publicTicket.identityId,
        {
          windowIndex: publicTicket.windowIndex,
          challenge: publicTicket.challenge,
          nonceCommitment: publicTicket.nonceCommitment,
        },
        forged,
      ),
    ).toBe(false)

    // (c) the winner's GENUINE signature (sanity) → true: only the
    //     genuine private key verifies.
    expect(
      verifyTicketSignature(
        publicTicket.identityId,
        {
          windowIndex: publicTicket.windowIndex,
          challenge: publicTicket.challenge,
          nonceCommitment: publicTicket.nonceCommitment,
        },
        GOLDEN_SIGNATURE,
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SIG_VERIFY_FROM_PUBLIC_DATA
// ---------------------------------------------------------------------------

describe('SIG_VERIFY_FROM_PUBLIC_DATA — public-data verification + deterministic sign (D2/D5)', () => {
  it('verify with ONLY the identityId string → true; a malformed identityId (36 hex / non-hex / valid-length invalid key) → false, never a throw; signTicket is byte-deterministic across two calls', () => {
    // (a) verify using ONLY the identityId string (no keypair object) for
    //     the genuine signature → true: the public key is reconstructed
    //     from identityId ALONE (no secret needed — this is what makes
    //     4.3's acceptance path possible).
    expect(
      verifyTicketSignature(GOLDEN_IDENTITY_ID, GOLDEN_FIELDS, GOLDEN_SIGNATURE),
    ).toBe(true)

    // (b) a malformed identityId → false (NEVER a throw — a reject is a
    //     normal false, D5).
    //     36 hex chars (not 64):
    expect(
      verifyTicketSignature(
        '00'.repeat(18),
        GOLDEN_FIELDS,
        GOLDEN_SIGNATURE,
      ),
    ).toBe(false)
    //     non-hex (a 64-char string with non-hex chars):
    expect(
      verifyTicketSignature(
        'g'.repeat(64),
        GOLDEN_FIELDS,
        GOLDEN_SIGNATURE,
      ),
    ).toBe(false)
    //     valid-length but invalid Ed25519 key (32×0x00 — a 64-hex string
    //     that is not the golden public key):
    expect(
      verifyTicketSignature(
        '00'.repeat(32),
        GOLDEN_FIELDS,
        GOLDEN_SIGNATURE,
      ),
    ).toBe(false)

    // signTicket is DETERMINISTIC: the same keypair + fields →
    // byte-identical signature across two calls (RFC 8032, no RNG).
    const keypair = goldenKeypair()
    expect(eqBytes(
      signTicket(keypair, GOLDEN_FIELDS),
      signTicket(keypair, GOLDEN_FIELDS),
    )).toBe(true)
  })
})
