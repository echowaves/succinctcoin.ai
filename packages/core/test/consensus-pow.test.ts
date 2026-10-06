/**
 * CONSENSUS POW — the canonical-encoding + PoW-check seam (E1 spike, AD-6/12).
 *
 * Pins the AD-12 DIGEST canonical form (BE fixed-width, proto field order,
 * `hash` EXCLUDED — a hash cannot include itself), the fixed-at-launch target
 * (N=16 leading zero bits), and proves the target is trivially reachable on
 * this hardware (a bounded-budget mine loop finds a passing nonce).
 *
 * The pinned block reuses the GOLDEN VECTOR's (test/golden-vector.test.ts)
 * identity id + ticket (built here from its proto parts) and its
 * parent/slot/txCount. The nonce field differs on purpose: the golden
 * vector's block nonce is a 32-byte commitment (the WIRE form, `bytes`),
 * whereas the PoW seam's counter is an 8-byte BE fixed-width field (the AD-12
 * DIGEST form, AD-6) — so the two pins share every field EXCEPT the nonce
 * shape. The counter round-trips through the `u64be(nonce)` field of the
 * canonical bytes (COUNTER_ROUNDTRIP).
 *
 * The CANONICAL_HEX / digest / pass-nonce constants below are the pinned
 * literals (computed from the field values above). Regenerate ONLY by
 * changing the pinned field values (a protocol change) — never hand-edit the
 * hex.
 *
 * Matrix: CANONICAL_HEX, POW_PASS, POW_REJECT, COUNTER_ROUNDTRIP.
 */
import { describe, expect, it } from 'vitest'

import {
  POW_TARGET_LEADING_ZERO_BITS,
  PowError,
  blockDigest,
  canonicalBlockBytes,
  leadingZeroBits,
  powCheck,
} from '../src/consensus/pow.js'
import type { Block } from '../src/index.js'

// Pinned block field values (deterministic). The identity id + ticket reuse
// the GOLDEN VECTOR's (test/golden-vector.test.ts) deterministic values so the
// digest pin and the wire pin derive from the same fixed block. The ticket is
// built from its proto PARTS (not a long hex literal) so the canonical size
// stays exactly 322B — a hand-typed ticket hex is easy to get wrong.
const IDENTITY_ID =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
// Golden Ticket field values: identityId (32B hex), windowIndex=7,
// challenge=0x00..0x1f (32B), nonceCommitment=0x5a×32, signature=0x7e×64.
const TICKET = Uint8Array.from(
  Buffer.concat([
    Buffer.from('0a40', 'hex'),
    Buffer.from(IDENTITY_ID, 'utf8'), // field 1: identityId
    Buffer.from('1007', 'hex'), // field 2: windowIndex = 7
    Buffer.from('1a20', 'hex'),
    Uint8Array.from(Array.from({ length: 32 }, (_, i) => i)), // field 3: challenge
    Buffer.from('2220', 'hex'),
    new Uint8Array(32).fill(0x5a), // field 4: nonceCommitment
    Buffer.from('2a40', 'hex'),
    new Uint8Array(64).fill(0x7e), // field 5: signature
  ]),
) // 202 bytes

// The golden parentHash is 0x01..0x20 (32 bytes).
const PARENT_HEX =
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'

// The fixed block's counter (a plain integer, AD-6), held in BE fixed-width
// form in the `nonce` field. 7 = 0x7 → 8-byte u64be 0000000000000007.
const FIXED_NONCE = 7

// Pinned digest canonical hex for the fixed block (322 bytes). BE fixed-width,
// proto field order, `hash` excluded — the exact byte set powCheck/blockDigest
// hash. Layout: u64be(42) ‖ parent(32) ‖ utf8(id, 64) ‖ ticket(202) ‖
//   u64be(7) ‖ u64be(3).
const CANONICAL_HEX =
  '000000000000002a0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20303031313232333334343535363637373838393961616262636364646565666630303131323233333434353536363737383839396161626263636464656566660a403030313132323333343435353636373738383939616162626363646465656666303031313232333334343535363637373838393961616262636364646565666610071a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f22205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a2a407e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e00000000000000070000000000000003'
// sha256 of the pinned canonical bytes — the fixed block's digest (lzb=0,
// so the fixed block is a natural POW_REJECT).
const FIXED_DIGEST_HEX =
  'e69bd9a4d161e4d59d533d5892baddd5ebab960a3f732afe0eec53d28775d679'

// A mined nonce for the SAME block whose digest has ≥ N leading zero bits
// (lzb=16). Discovered by a bounded mine loop (see TRIVIALLY_REACHABLE);
// pinned so the POW_PASS assertion is deterministic.
const PASS_NONCE = 76735
const PASS_DIGEST_HEX =
  '0000f2b6053f35d3d1562fe3245d63a0e3e47e3e7c6c9e17939dce6f3bffda57'

// --- helpers ---
const hex = (buf: Uint8Array): string => Buffer.from(buf).toString('hex')
const fromHex = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(h, 'hex'))
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && Array.from(a).every((v, i) => v === b[i])

/** A plain integer counter in its BE fixed-width (u64be) nonce-field form. */
const beCounter = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false)
  return b
}

/**
 * Build the pinned block with a chosen counter (all other fields fixed).
 *
 * The spike works from RAW FIELDS (AD-12: the digest canonical is hand-built,
 * distinct from the protons varint wire form) — so the Block is constructed
 * directly from its field values rather than decoded from wire bytes. The
 * field set is the golden block's (slot 42 / parent 0x01..0x20 / id / ticket /
 * txCount 3); only the counter field is varied. `hash` is a placeholder
 * (0x99×32) — canonicalBlockBytes/powCheck never read it (AD-6: the digest
 * excludes the hash field).
 */
function fixedBlock(nonceCounter: number): Block {
  return {
    slot: 42n,
    parentHash: fromHex(PARENT_HEX),
    winnerIdentityId: IDENTITY_ID,
    winnerTicket: TICKET,
    nonce: beCounter(nonceCounter),
    hash: new Uint8Array(32).fill(0x99),
    txCount: 3n,
  }
}

describe('CONSENSUS POW — canonical encoding + PoW seam (E1, AD-6/12)', () => {
  it('CANONICAL_HEX: canonicalBlockBytes = the exact pinned BE-fixed-width hex', () => {
    const block = fixedBlock(FIXED_NONCE)
    const bytes = canonicalBlockBytes(block)
    expect(hex(bytes)).toBe(CANONICAL_HEX)
    // BE fixed-width layout: 8 + 32 + 64 + 202 + 8 + 8 = 322 bytes.
    expect(bytes.byteLength).toBe(322)
  })

  it('POW_PASS: a block whose digest has ≥ N leading zero bits → powCheck true', () => {
    const block = fixedBlock(PASS_NONCE)
    // Pinned digest of the passing nonce (16 leading zero bits = 2 zero bytes
    // + a byte with its top nibble zero → bits 0-15 zero, bit 16 set).
    expect(hex(blockDigest(block))).toBe(PASS_DIGEST_HEX)
    expect(leadingZeroBits(blockDigest(block))).toBe(POW_TARGET_LEADING_ZERO_BITS)
    expect(powCheck(block)).toBe(true)
  })

  it('POW_REJECT: a block whose digest has < N leading zero bits → powCheck false', () => {
    const block = fixedBlock(FIXED_NONCE)
    expect(hex(blockDigest(block))).toBe(FIXED_DIGEST_HEX)
    expect(leadingZeroBits(blockDigest(block))).toBe(0)
    // A reject is a false return, never an exception.
    expect(() => powCheck(block)).not.toThrow()
    expect(powCheck(block)).toBe(false)
  })

  it('COUNTER_ROUNDTRIP: the counter round-trips through the u64be nonce field', () => {
    // The counter is the BE fixed-width `nonce` field of the canonical bytes.
    // Re-encoding the same counter reproduces the pinned canonical bytes.
    const block = fixedBlock(FIXED_NONCE)
    expect(eqBytes(canonicalBlockBytes(block), fromHex(CANONICAL_HEX))).toBe(true)
    // The u64be(nonce) field sits at offset 8+32+64+202 = 306, length 8.
    const nonceField = canonicalBlockBytes(block).subarray(306, 314)
    expect(hex(nonceField)).toBe('0000000000000007')
    // A different counter changes the canonical bytes (per-attempt input).
    const other = canonicalBlockBytes(fixedBlock(FIXED_NONCE + 1))
    expect(eqBytes(other, fromHex(CANONICAL_HEX))).toBe(false)
    expect(hex(other.subarray(306, 314))).toBe('0000000000000008')
  })

  it('TARGET: the consensus constant is N=16 leading zero bits', () => {
    expect(POW_TARGET_LEADING_ZERO_BITS).toBe(16)
    // 1/2^16 = 1/65536 expected attempts — a genuine (not no-op) search space.
    expect(2 ** POW_TARGET_LEADING_ZERO_BITS).toBe(65536)
  })

  it('TRIVIALLY_REACHABLE: a mine loop finds a passing nonce within a bounded budget', () => {
    // The draw (AD-7), not the PoW, selects the winner, so the target must be
    // trivially reachable on commodity hardware: ≥1 hash per slot. Here we
    // prove the per-attempt path reaches a pass well under a generous budget.
    // Budget = 10× the expected 65536 attempts (P[>10× mean] ≈ e^-10 ≈ 4.5e-5).
    const BUDGET = 655_360
    const base = fixedBlock(FIXED_NONCE)
    const parent = base.parentHash
    const ticket = base.winnerTicket
    const id = base.winnerIdentityId
    const slot = base.slot
    const txCount = base.txCount

    let attempts = 0
    let found = -1
    let counter = 0n
    while (attempts < BUDGET) {
      const b: (typeof base) = {
        slot,
        parentHash: parent,
        winnerIdentityId: id,
        winnerTicket: ticket,
        nonce: beCounter(Number(counter)),
        hash: base.hash,
        txCount,
      }
      if (powCheck(b)) {
        found = Number(counter)
        break
      }
      counter++
      attempts++
    }
    expect(attempts).toBeLessThan(BUDGET)
    expect(found).toBeGreaterThanOrEqual(0)
    // The found counter must reproduce a passing digest (self-consistency).
    const mined = fixedBlock(found)
    expect(powCheck(mined)).toBe(true)
  })

  it('SEAM: powCheck re-hashes the exact canonical bytes (blockDigest agreement)', () => {
    // The PoW check and the block-hash math hash the SAME bytes: powCheck is
    // just "that digest has ≥ N leading zeros" (AD-6). A digest with ≥ N bits
    // must make powCheck true; the digest is the single source.
    const pass = fixedBlock(PASS_NONCE)
    expect(hex(blockDigest(pass))).toBe(PASS_DIGEST_HEX)
    expect(leadingZeroBits(blockDigest(pass)) >= POW_TARGET_LEADING_ZERO_BITS).toBe(true)
    expect(powCheck(pass)).toBe(true)
  })

  it('GUARD: a malformed nonce field is a programming error (SC-POW-1), not a silent re-encode', () => {
    const base = fixedBlock(FIXED_NONCE)
    const empty: (typeof base) = { ...base, nonce: new Uint8Array(0) }
    expect(() => canonicalBlockBytes(empty)).toThrowError(PowError)
    const tooLong: (typeof base) = { ...base, nonce: new Uint8Array(9) }
    expect(() => canonicalBlockBytes(tooLong)).toThrowError(PowError)
  })
})
