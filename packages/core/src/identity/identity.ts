/**
 * `core/identity` — the identity keypair + ticket signature (4.2, E2 /
 * AD-11 / AD-12).
 *
 * This module owns the AD-11 KEY MATERIAL that lives in the core: the
 * identity **keypair** (derived deterministically from a 32-byte seed —
 * no RNG, AD-3/AD-10) and the ticket **signature** sign/verify over the
 * EXACT AD-12 digest
 *
 *   `sha256(utf8(identityId) ‖ u64be(BigInt(windowIndex)) ‖ challenge ‖
 *          nonceCommitment)`
 *
 * (big-endian fixed-width `windowIndex`, AD-12). The scheme is
 * **Ed25519 via `node:crypto`** (D1): deterministic per RFC 8032 (the
 * nonce is derived from the key + message — NO RNG, offline, zero new
 * dependency, AD-6) and asymmetric, so a signature verifies from
 * PUBLIC data alone (D2 — the public key is reconstructed from
 * `identityId`; the secret never participates in verification). That is
 * what closes the **epic-3 residual replay**: an unselected node that
 * can read a winner's PUBLIC ticket off the chain cannot forge a valid
 * signature (it does not hold the winner's private key). 4.3 wires
 * `verifyTicketSignature` into block acceptance (additively, composing
 * with `verifyDraw`); 4.7 guards `secret` behind the AD-11 boundary.
 *
 * Reject convention (D5, like `verifyDraw` / the gate verifier):
 * `verifyTicketSignature` returns `false` for a malformed `identityId`,
 * a truncated / garbage signature, or any signature that does not
 * match — it wraps `node:crypto` in `try/catch → false` and NEVER
 * throws for a rejected ticket. The ONLY throw path is
 * `deriveIdentityKeypair` on a bad seed length (`IdentityError`
 * `SC-IDENTITY-2`, a programming error). No `big.js` (AD-5) — only
 * `node:crypto` + integers; the byte helpers are module-local (the
 * `pow.ts` / `draw.ts` / `gate-verifier.ts` pattern; the cross-module
 * DRY extraction is deferred, per 3.8).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'

/** Identity / ticket-signature programming error. */
export class IdentityError extends Error {
  readonly code = 'SC-IDENTITY-2' as const
  constructor(message: string) {
    super(message)
    this.name = 'IdentityError'
  }
}

/**
 * An identity keypair (AD-11: the key material that lives in the core).
 *
 * `identityId` = the hex of the 32-byte Ed25519 public key (64 hex
 * chars, the spine "IDs: 32-byte hex" convention and the 4.1
 * verifier's 64-hex check — D2). `publicKey` = the 32 raw public-key
 * bytes. `secret` = the PKCS#8 DER of the private key — a DISTINCT
 * field, never folded into `identityId` / `publicKey` (AD-11: the
 * public surface is `identityId` + `publicKey` + signed artifacts only;
 * 4.7 guards `secret` behind the core boundary).
 */
export interface IdentityKeypair {
  /** 32-byte hex identity id = `hex(publicKey)` (64 hex chars, D2). */
  identityId: string
  /** The raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array
  /** The PKCS#8 DER of the Ed25519 private key (the AD-11 secret). */
  secret: Uint8Array
}

/**
 * The ticket fields a signature binds (the EXACT AD-12 digest inputs —
 * the four `Ticket` fields minus `identityId`, which travels as the
 * verifier's separate argument).
 */
export interface TicketFields {
  /** The chain-time window the ticket is bound to (AD-3). */
  windowIndex: number | bigint
  /** The window challenge (32 bytes, AD-12). */
  challenge: Uint8Array
  /** The commitment to the PoW nonce (32 bytes, AD-7). */
  nonceCommitment: Uint8Array
}

/**
 * The 12-byte SPKI DER prefix of an Ed25519 public key:
 * `SEQUENCE(42){ SEQUENCE(5){ OID 1.3.101.112 }, BIT STRING(33){ 0
 * unused bits, 32 key bytes }}`. A 64-hex `identityId` is a valid
 * Ed25519 public key iff `SPKI_PREFIX ‖ hexToBytes(identityId)` imports
 * (D2 — verification reconstructs the key from public data alone).
 */
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

/**
 * The 16-byte PKCS#8 DER prefix of an Ed25519 private key:
 * `SEQUENCE(46){ INTEGER 0, SEQUENCE(5){ OID 1.3.101.112 }, OCTET
 * STRING(34){ 32 seed bytes }}`. The keypair is `PKCS8_PREFIX ‖ seed`
 * (D3 — deterministic, no RNG).
 */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
])

/** Spine identity convention: 32-byte hex, 64 hex chars, lowercase. */
const HEX_ID_64 = /^[0-9a-f]{64}$/

const TEXT_ENCODER = new TextEncoder()

// ---------------------------------------------------------------------------
// byte helpers (the established `pow.ts` / `draw.ts` / `gate-verifier.ts`
// pattern, kept local so the module is self-contained — NO big.js, AD-5)
// ---------------------------------------------------------------------------

/** sha256 over arbitrary parts (node:crypto — the only crypto used). */
function sha256(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return new Uint8Array(createHash('sha256').update(concat(parts)).digest())
}

/** Concatenate byte parts into one fresh `Uint8Array` (no aliasing). */
function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Encode one value as 8-byte big-endian (the AD-12 digest form). */
function u64be(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) {
    throw new IdentityError(
      `SC-IDENTITY-2: windowIndex ${v} is outside the u64be range`,
    )
  }
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, v, false) // big-endian
  return buf
}

/** Bytes → lowercase hex. */
function bytesToHex(buf: Uint8Array): string {
  let out = ''
  for (let i = 0; i < buf.byteLength; i += 1) {
    out += buf[i].toString(16).padStart(2, '0')
  }
  return out
}

/** Lowercase hex → bytes (the `identityId` string form ↔ raw key bytes). */
function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new IdentityError(`SC-IDENTITY-2: malformed hex: ${hex}`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Coerce + validate a `windowIndex` into its u64be range. A `number`
 * must be a finite non-negative integer; a `bigint` must be in
 * `[0, 2^64)` (the window index is a chain-time integer, AD-3 — a
 * fractional or non-finite value is a programming error, never
 * silently truncated).
 */
function coerceWindow(value: number | bigint): bigint {
  let v: bigint
  if (typeof value === 'bigint') {
    v = value
  } else if (!Number.isInteger(value)) {
    throw new IdentityError(
      `SC-IDENTITY-2: windowIndex ${value} is not an integer`,
    )
  } else {
    v = BigInt(value)
  }
  if (v < 0n || v >= 1n << 64n) {
    throw new IdentityError(
      `SC-IDENTITY-2: windowIndex ${value} is outside the u64be range`,
    )
  }
  return v
}

// ---------------------------------------------------------------------------
// D3 — the deterministic seed → keypair (no RNG: AD-3 / AD-10)
// ---------------------------------------------------------------------------

/**
 * Derive the identity keypair from a 32-byte seed (D3 — the
 * "deterministic test keypair": the SAME seed always yields the SAME
 * keypair, so the golden vector and a future sim are reproducible).
 *
 * The PKCS#8 DER is the 16-byte Ed25519 prefix ‖ `seed`; the public
 * key is derived via `crypto.createPublicKey` and read from the SPKI
 * DER (`subarray(12)` — the 32 raw key bytes). `identityId` = the hex
 * of those 32 bytes (D2).
 *
 * @throws {IdentityError} `SC-IDENTITY-2` if `seed` is not exactly 32
 *   bytes (a programming error — a keypair is always derived from a
 *   full 32-byte seed).
 */
export function deriveIdentityKeypair(seed: Uint8Array): IdentityKeypair {
  if (seed.byteLength !== 32) {
    throw new IdentityError(
      `SC-IDENTITY-2: identity seed must be exactly 32 bytes (got ${seed.byteLength})`,
    )
  }
  const der = new Uint8Array(PKCS8_PREFIX.length + seed.byteLength)
  der.set(PKCS8_PREFIX, 0)
  der.set(seed, PKCS8_PREFIX.length)
  const privateKey = createPrivateKey({
    key: Buffer.from(der),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  // The SPKI DER ends with the BIT STRING wrapper: the raw 32-byte
  // Ed25519 public key is the trailing 32 bytes (offset 12).
  const rawPublic = new Uint8Array(spki.subarray(12))
  if (rawPublic.byteLength !== 32) {
    throw new IdentityError(
      `SC-IDENTITY-2: expected a 32-byte Ed25519 public key (got ${rawPublic.byteLength})`,
    )
  }
  return {
    identityId: bytesToHex(rawPublic),
    publicKey: rawPublic,
    secret: der,
  }
}

// ---------------------------------------------------------------------------
// D4 — the EXACT AD-12 digest + sign/verify
// ---------------------------------------------------------------------------

/**
 * The EXACT AD-12 ticket digest (D4):
 *
 *   `sha256(utf8(identityId) ‖ u64be(BigInt(windowIndex)) ‖ challenge ‖
 *          nonceCommitment)`
 *
 * `identityId` is the hex string as UTF-8 (consistent with the proto
 * `string identityId` field); `windowIndex` is big-endian fixed-width
 * (AD-12); `challenge` + `nonceCommitment` are their raw bytes. Sign
 * and verify share this ONE implementation — the digest never drifts.
 *
 * @throws {IdentityError} `SC-IDENTITY-2` if `windowIndex` is not a
 *   finite non-negative integer in the u64be range (a programming
 *   error — the window index is a chain-time integer, AD-3).
 */
function ticketDigest(identityId: string, fields: TicketFields): Uint8Array {
  return sha256([
    TEXT_ENCODER.encode(identityId),
    u64be(coerceWindow(fields.windowIndex)),
    fields.challenge,
    fields.nonceCommitment,
  ])
}

/**
 * Sign a ticket: the 64-byte Ed25519 signature over the EXACT AD-12
 * digest, signed with `keypair.secret` (D1/D4). Deterministic per RFC
 * 8032 — the same keypair + fields always produce the SAME signature
 * (no RNG; the golden vector pins the bytes).
 *
 * @throws {IdentityError} `SC-IDENTITY-2` if `windowIndex` is
 *   non-integer / out of the u64be range (a programming error).
 */
export function signTicket(
  keypair: IdentityKeypair,
  fields: TicketFields,
): Uint8Array {
  const digest = ticketDigest(keypair.identityId, fields)
  const privateKey = createPrivateKey({
    key: Buffer.from(keypair.secret),
    format: 'der',
    type: 'pkcs8',
  })
  const signature = sign(null, Buffer.from(digest), privateKey)
  return new Uint8Array(signature)
}

/**
 * Verify a ticket signature from PUBLIC data alone (D2/D5): the public
 * key is reconstructed from `identityId` (SPKI DER = the 12-byte
 * Ed25519 prefix ‖ the 32 raw bytes), the AD-12 digest is recomputed,
 * and the signature is checked — the secret never participates (AD-11;
 * this is what makes 4.3's acceptance path possible).
 *
 * A reject is a NORMAL `false`, never a throw: a malformed
 * `identityId` (not 64 hex / not a valid Ed25519 public key), a
 * truncated or garbage signature, or a signature that simply does not
 * match all return `false` — `node:crypto` is wrapped in `try/catch →
 * false`. The ONLY throw path in this module is `deriveIdentityKeypair`
 * on a bad seed length.
 */
export function verifyTicketSignature(
  identityId: string,
  fields: TicketFields,
  signature: Uint8Array,
): boolean {
  if (!HEX_ID_64.test(identityId)) return false
  let digest: Uint8Array
  try {
    digest = ticketDigest(identityId, fields)
  } catch {
    // A malformed windowIndex is a programming error on the CALLER's
    // input — but a verify call must reject, not throw (D5).
    return false
  }
  try {
    const spki = new Uint8Array(SPKI_PREFIX.length + 32)
    spki.set(SPKI_PREFIX, 0)
    spki.set(hexToBytes(identityId), SPKI_PREFIX.length)
    const publicKey = createPublicKey({
      key: Buffer.from(spki),
      format: 'der',
      type: 'spki',
    })
    return verify(
      null,
      Buffer.from(digest),
      publicKey,
      Buffer.from(signature),
    )
  } catch {
    return false // a reject is a normal `false`, never a throw (D5)
  }
}
