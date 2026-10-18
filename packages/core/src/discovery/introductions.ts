/**
 * `core/discovery/introductions` — the CAP-7 third-party vouch (ticket
 * 8.4): an `Introduction` is "saw identity X online at slot s", signed by
 * the SIGNER only; the digest binds signer AND subject, so a vouch can
 * never be minted for someone else's keypair and a hint-grade address book
 * entry becomes dial-eligible only after >= 3 of these from DISTINCT
 * signers (the three-introductions rule).
 *
 * Pinned digest layout (domain-separated from the announcement's — the
 * tag AND the field layout differ, so neither signature can verify as the
 * other, pinned both directions by `test/discovery-introduction.test.ts`):
 *
 *   sha256( utf8("succinctcoin/Introduction/v1\0")
 *         ‖ utf8(signerIdentityId)
 *         ‖ utf8(subjectIdentityId)
 *         ‖ u64be(slotObserved)
 *         ‖ utf8(reachability)
 *         ‖ utf8(chainId) )
 *
 * "Saw X online" means the SIGNER verified X's presence proof (an 8.2
 * announcement — its signature IS liveness) at `slotObserved`; plurality of
 * signers, not depth of one signer's history, gives the threshold meaning.
 *
 * Purity (AD-3/AD-10): NO clock, NO net, NO fs — the ONLY time rule is
 * `slotObserved > currentSlot` REJECTS (a claim about the future is a
 * rejection, not a prophecy). Introductions carry no slot range and do not
 * expire in MVP (eligibility monotonicity comes from counting only
 * `slotObserved <= currentSlot`; decay rides the book's quarantine — see
 * `address-book.ts`). Same reject-never-throw discipline as 8.2: hostile
 * wire data produces `{ok:false, reason}`, never an exception.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

import { signDigest } from '../identity/index.js'
import type { IdentityKeypair } from '../identity/index.js'

// ---------------------------------------------------------------------------
// byte helpers (the established self-contained-module pattern of
// `identity.ts` / `announcements.ts` — helpers stay local by convention)
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder()

/** The pinned domain-separation tag (digest first bytes; versioned). */
export const INTRODUCTION_DOMAIN = 'succinctcoin/Introduction/v1\0'

/** Pinned reachability classes (discovery-design.md; carried for dial-time
 * use — no eligibility rule consumes them in MVP). */
export const REACHABILITY_CLASSES = ['direct', 'via-relay', 'lan'] as const
export type IntroductionReachability = (typeof REACHABILITY_CLASSES)[number]

const MAX_CHAIN_ID_CHARS = 64

const HEX_ID_64 = /^[0-9a-f]{64}$/
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

/** The 12-byte SPKI DER prefix of an Ed25519 public key (identity.ts D2). */
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

function sha256(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return new Uint8Array(createHash('sha256').update(concat(parts)).digest())
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Encode one unsigned value as 8-byte big-endian (AD-12 digest form). */
function u64be(v: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, v, false)
  return buf
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Coerce a slot value into its u64 bigint form (announcements.ts
 * `coerceSlot` pattern): safe non-negative integers or bigints in
 * `[0, 2^64)`; anything else throws `RangeError` (the validator turns that
 * into `malformed-slot`).
 */
function coerceSlot(v: number | bigint): bigint {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (b === null || b < 0n || b >= 1n << 64n) {
    throw new RangeError(`introductionDigest: slot ${String(v)} is not a u64 slot`)
  }
  return b
}

// ---------------------------------------------------------------------------
// the fields + digest
// ---------------------------------------------------------------------------

/**
 * The introduction fields a signature binds — everything but `signature`
 * itself. Slots are chain-time (AD-3); `bigint` is accepted because protons
 * DECODES proto int64 as bigint (wire records flow in unchanged).
 */
export interface IntroductionFields {
  /** 32-byte hex identity id of the introducing peer (the signer). */
  signerIdentityId: string
  /** 32-byte hex identity id of the introduced peer. */
  subjectIdentityId: string
  /** Chain-time slot the signer observed the subject live at. */
  slotObserved: number | bigint
  /** Observed reachability class (pinned set above). */
  reachability: IntroductionReachability
  /** Network scope (genesis `chainId`). */
  chainId: string
}

/** The full signed record (the proto `Introduction` wire shape). */
export interface SignedIntroduction extends IntroductionFields {
  /** 64-byte Ed25519 signature over the pinned digest. */
  signature: Uint8Array
}

/**
 * The EXACT pinned digest over introduction fields (see the module header).
 * Assumes shape-valid inputs (`validateIntroduction` checks first;
 * `signIntroduction` signs what it built) — a bad slot throws `RangeError`
 * by construction, never silently truncates.
 */
export function introductionDigest(fields: IntroductionFields): Uint8Array {
  const slotObserved = coerceSlot(fields.slotObserved)
  return sha256([
    TEXT_ENCODER.encode(INTRODUCTION_DOMAIN),
    TEXT_ENCODER.encode(fields.signerIdentityId),
    TEXT_ENCODER.encode(fields.subjectIdentityId),
    u64be(slotObserved),
    TEXT_ENCODER.encode(fields.reachability),
    TEXT_ENCODER.encode(fields.chainId),
  ])
}

// ---------------------------------------------------------------------------
// sign / verify (the announcements.ts D1/D2 pattern)
// ---------------------------------------------------------------------------

/**
 * Sign an introduction with the install's keypair. The SIGNER is always the
 * keypair's own identity — a caller cannot vouch through someone else's key
 * via this seam. Deterministic per RFC 8032.
 */
export function signIntroduction(
  keypair: IdentityKeypair,
  fields: IntroductionFields,
): Uint8Array {
  const digest = introductionDigest({ ...fields, signerIdentityId: keypair.identityId })
  // AD-11: signing goes through identity.ts — the ONE key-material reader
  // (4.7 single-reader invariant); discovery never touches it directly.
  return signDigest(keypair, digest)
}

/** Verify from PUBLIC data alone (D2); malformed inputs are `false`, never throws. */
export function verifyIntroductionSignature(
  fields: IntroductionFields,
  signature: Uint8Array,
): boolean {
  if (!HEX_ID_64.test(fields.signerIdentityId) || signature.byteLength !== 64) return false
  let digest: Uint8Array
  try {
    digest = introductionDigest(fields)
  } catch {
    return false // a bad slot shape rejects, it does not throw (D5)
  }
  try {
    const spki = new Uint8Array(SPKI_PREFIX.length + 32)
    spki.set(SPKI_PREFIX, 0)
    spki.set(hexToBytes(fields.signerIdentityId), SPKI_PREFIX.length)
    const publicKey = createPublicKey({
      key: Buffer.from(spki),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(digest), publicKey, Buffer.from(signature))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// the pure validator (the address book + node loop both call THIS)
// ---------------------------------------------------------------------------

/** Every pinned reject reason (pinned — tests + metrics key on these). */
export type IntroductionRejectReason =
  | 'malformed-signer'
  | 'malformed-subject'
  | 'self-introduction'
  | 'malformed-slot'
  | 'malformed-reachability'
  | 'malformed-chain-id'
  | 'malformed-signature'
  | 'chain-mismatch'
  | 'bad-signature'
  | 'future-observation'

export type IntroductionValidation = { ok: true } | { ok: false; reason: IntroductionRejectReason }

/** Context for validation — ALL time/network inputs are caller-supplied (AD-3). */
export interface IntroductionContext {
  /**
   * The validator's current chain-time slot. A safe integer / bigint is a
   * CALLER precondition — anything else is a programming error and throws
   * loudly, unlike record-level junk, which the validator never lets throw.
   */
  currentSlot: number | bigint
  /** This network's genesis `chainId` — vouches from other chains die here. */
  expectedChainId: string
}

/**
 * Validate an UNTRUSTED introduction end-to-end: shape (including the
 * no-self-vouch rule) → chain → signature → time (the pinned 8.2 order;
 * chain first so a wrong-network flood never pays Ed25519). The time rule
 * is one-directional: `slotObserved > currentSlot` rejects as
 * `future-observation` — an observation claim about the future is a
 * rejection, not a prophecy. Pure — no clock, no I/O.
 */
export function validateIntroduction(
  record: unknown,
  ctx: IntroductionContext,
): IntroductionValidation {
  if (typeof record !== 'object' || record === null) return fail('malformed-signer')
  const r = record as Record<string, unknown>

  if (typeof r.signerIdentityId !== 'string' || !HEX_ID_64.test(r.signerIdentityId))
    return fail('malformed-signer')
  if (typeof r.subjectIdentityId !== 'string' || !HEX_ID_64.test(r.subjectIdentityId))
    return fail('malformed-subject')
  // A self-vouch carries zero independence — accepting it would let a
  // subject mint one of its own three required introductions from thin air.
  if (r.subjectIdentityId === r.signerIdentityId) return fail('self-introduction')

  let slotObserved: bigint
  try {
    slotObserved = coerceSlot(r.slotObserved as number | bigint)
  } catch {
    return fail('malformed-slot')
  }

  if (
    typeof r.reachability !== 'string' ||
    !(REACHABILITY_CLASSES as readonly string[]).includes(r.reachability)
  )
    return fail('malformed-reachability')

  if (
    typeof r.chainId !== 'string' ||
    r.chainId.length === 0 ||
    r.chainId.length > MAX_CHAIN_ID_CHARS ||
    !PRINTABLE_ASCII.test(r.chainId)
  )
    return fail('malformed-chain-id')

  const signature = r.signature as Uint8Array | undefined
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64)
    return fail('malformed-signature')

  if (r.chainId !== ctx.expectedChainId) return fail('chain-mismatch')

  const fields: IntroductionFields = {
    signerIdentityId: r.signerIdentityId,
    subjectIdentityId: r.subjectIdentityId,
    slotObserved,
    reachability: r.reachability as IntroductionReachability,
    chainId: r.chainId,
  }
  if (!verifyIntroductionSignature(fields, signature)) return fail('bad-signature')

  if (slotObserved > BigInt(ctx.currentSlot)) return fail('future-observation')
  return { ok: true }
}

function fail(reason: IntroductionRejectReason): IntroductionValidation {
  return { ok: false, reason }
}
