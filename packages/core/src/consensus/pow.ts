/**
 * `core/consensus` PoW seam (E1 spike — difficulty / target adjustment).
 *
 * The canonical-encoding + PoW-check seam the tracer's mining loop (3.2) and
 * the block-hash math build on (AD-6/AD-12):
 *
 *   - `canonicalBlockBytes(block)` — the BE fixed-width digest encoding of a
 *     `Block`: ALL fields EXCEPT `hash` (a hash cannot include itself), in
 *     proto field order. The full canonical encoding of the block is
 *     `canonicalBlockBytes ‖ hash`, so the block hash = `sha256(canonical
 *     bytes)` and the PoW check re-hashes the EXACT same bytes.
 *   - `powCheck(block)` — true iff `sha256(canonical bytes)` has
 *     ≥ `POW_TARGET_LEADING_ZERO_BITS` leading zero bits (the fixed-at-launch
 *     target, N=16 — see the epic Notes Decision).
 *
 * Per-attempt hashing is `node:crypto` sha256 + a plain integer counter only
 * (AD-6): no `big.js`, no pure-JS keccak, no protons `encode` — the varint
 * WIRE form (pinned by the golden vector) is a distinct serialization; this
 * hand-built BE fixed-width form is the AD-12 digest canonical.
 */
import { createHash } from 'node:crypto'

// The generated `Block` field-set type, via the stable re-export layer (the
// proto codec namespace is `succinctcoin.*`; `Block` is a bare named export
// here). Only the TYPE is needed — this module reads fields and never calls
// the protons codecs (AD-12: the digest canonical is hand-built).
import type { Block } from '../proto/index.js'

/**
 * Fixed-at-launch PoW target: ≥ 16 leading zero bits in
 * `sha256(canonicalBlockBytes)` (1/65536 expected attempts).
 *
 * Chosen by the E1 spike: measured on the build machine ~1.9M hashes/s at
 * the canonical block size, so a pass is reached in ≈5 ms here (tens of ms
 * on commodity hardware) — "≥1 hash per slot on commodity hardware" stays
 * trivially true, while 2^16 is a genuine (not no-op) search space. The
 * draw (AD-7), not the PoW, selects the winner, so there is no economic
 * pressure on difficulty: NO retargeting exists in this spike (and none may
 * be added without a protocol version bump — AD-7/AD-12).
 */
export const POW_TARGET_LEADING_ZERO_BITS = 16

/** PoW / canonical-encoding programming error. */
export class PowError extends Error {
  readonly code = 'SC-POW-1' as const
  constructor(message: string) {
    super(message)
    this.name = 'PowError'
  }
}

/** Encode one `unsigned` int64 field as 8-byte big-endian (AD-12 digest form). */
function u64be(v: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  try {
    view.setBigUint64(0, v, false) // big-endian
  } catch {
    // A proto int64 outside [0, 2^64) is a programming error, not data.
    throw new PowError(`SC-POW-1: integer field ${v} is outside the u64be range`)
  }
  return buf
}

/**
 * The AD-12 digest canonical encoding of a `Block` — the exact byte set the
 * block hash (3.2) and the PoW check both hash:
 *
 *   `u64be(slot) ‖ parentHash(32) ‖ utf8(winnerIdentityId) ‖ winnerTicket ‖
 *    u64be(nonce) ‖ u64be(txCount)`
 *
 * proto field order (AD-12: `protocol.proto` owns field order); integers are
 * big-endian fixed-width; `winnerIdentityId` is the utf8 of its 32-byte hex
 * string (spine convention: IDs travel as 32-byte hex); `winnerTicket` is the
 * ticket's canonical bytes verbatim (AD-7). The `hash` field is EXCLUDED —
 * the block hash cannot include itself; the full canonical encoding is
 * `canonicalBlockBytes(block) ‖ hash`.
 *
 * The counter is a field of these bytes (AD-6): the `nonce` field holds the
 * counter's BE fixed-width form, so the canonical bytes change per attempt
 * and the counter round-trips through them (COUNTER_ROUNDTRIP).
 *
 * @throws {PowError} `SC-POW-1` if a field is outside the fixed-width form
 *   (slot/txCount/nonce out of the u64be range, or a malformed nonce field).
 */
export function canonicalBlockBytes(block: Block): Uint8Array {
  const parts: Uint8Array[] = [
    u64be(block.slot),
    block.parentHash,
    new TextEncoder().encode(block.winnerIdentityId),
    block.winnerTicket,
  ]
  // The `nonce` field carries the counter in BE fixed-width form (AD-6).
  // It is stored on the wire as `bytes`; the canonical digest form re-encodes
  // it as an 8-byte u64be (the AD-12 digest canonical the golden-vector
  // comment defers to this epic — this is where it lands). A malformed field
  // (empty, or >8 bytes — leading zero bytes are a valid counter) is a
  // programming error, not data: reject it rather than silently re-encode a
  // different counter.
  const nonce = block.nonce
  if (nonce.length === 0) {
    throw new PowError('SC-POW-1: block nonce field is empty (counter must be present, AD-6)')
  }
  if (nonce.length > 8) {
    throw new PowError(
      `SC-POW-1: block nonce field is ${nonce.length} bytes; the digest form is 8-byte u64be`,
    )
  }
  parts.push(u64be(beBytesToBig(nonce)))
  parts.push(u64be(block.txCount))

  const out = new Uint8Array(
    parts.reduce((n, p) => n + p.length, 0),
  )
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Read a ≤8-byte big-endian byte string as a BigInt (the counter field). */
function beBytesToBig(buf: Uint8Array): bigint {
  let v = 0n
  for (let i = 0; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i])
  return v
}

/**
 * Count the leading zero bits of a digest (MSB-first). A 32-byte sha256
 * digest yields 0..256.
 */
export function leadingZeroBits(buf: Uint8Array): number {
  let bits = 0
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]
    if (byte === 0) {
      bits += 8
      continue
    }
    for (let b = 7; b >= 0; b--) {
      if (byte & (1 << b)) return bits
      bits++
    }
  }
  return bits
}

/** sha256 of the block's canonical bytes — the block hash (3.2) input. */
export function blockDigest(block: Block): Uint8Array {
  return new Uint8Array(createHash('sha256').update(canonicalBlockBytes(block)).digest())
}

/**
 * The PoW check (AD-6): re-hash the block's canonical bytes and accept iff
 * the digest has ≥ `POW_TARGET_LEADING_ZERO_BITS` leading zero bits.
 *
 * For a well-formed block the check returns a boolean — a reject is not an
 * error, it is the normal 65535/65536 outcome. (It is not total over every
 * `Block`: a malformed canonical field — empty / >8-byte nonce, or an
 * out-of-range slot / txCount — throws `SC-POW-1` from `canonicalBlockBytes`;
 * the tracer (3.2) always builds well-formed blocks, so this is a programming
 * error, not a data path.) The block hash itself is the same digest; the
 * tracer (3.2) stores it in `block.hash`.
 */
export function powCheck(block: Block): boolean {
  return leadingZeroBits(blockDigest(block)) >= POW_TARGET_LEADING_ZERO_BITS
}
