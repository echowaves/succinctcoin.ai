/**
 * `core/discovery/announcements` — the CAP-7 signed self-announcement
 * (ticket 8.2): the record whose Ed25519 signature IS the liveness proof
 * (the sybil cost of presence is the cost of mining). This module is the
 * ONE contract slice 8.3 (announcements in blocks) and 8.4 (the address
 * book) both consume: the AD-12 canonical digest, sign/verify over it, and
 * a PURE validator that turns untrusted wire records into `{ok}` /
 * `{ok:false, reason}` — never a throw on hostile input (the ticket's
 * reject-never-throw discipline, `identity.ts` D5).
 *
 * Pinned digest layout (domain-separated; BE fixed-width per AD-12; the
 * golden vector in `test/discovery-announcement.test.ts` pins the bytes):
 *
 *   sha256( utf8("succinctcoin/PeerAnnouncement/v1\0")
 *         ‖ utf8(identityId)
 *         ‖ sha256( ‖(u32be(byteLen) ‖ utf8(addr)) for each SORTED multiaddr )
 *         ‖ u256-observed-part  =  sha256(0x00)                      absent
 *                               |  sha256(0x01 ‖ utf8(observedAddr)) present
 *         ‖ u64be(slotStart) ‖ u64be(slotEnd)
 *         ‖ utf8(chainId) )
 *
 * Sorting makes the digest order-canonical on the wire list; duplicates are
 * rejected as a shape error instead of being silently deduped. The domain
 * tag keeps this signature unusable as any other message's signature.
 *
 * Purity (AD-3/AD-10): NO clock, NO net, NO fs — freshness is judged
 * against a CALLER-SUPPLIED current slot, so the validator is property-
 * testable and no peer ever needs a wall clock. Verification reconstructs
 * the public key from `identityId` alone (D2 — SPKI prefix ‖ raw bytes).
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

import { signDigest } from '../identity/index.js'
import type { IdentityKeypair } from '../identity/index.js'
// 9.1 addressing policy (amended 2026-10-21 for the relay-hop law) — direct
// module import (not the net barrel): this file must not drag libp2p into
// pure-validator consumers.
import {
  isAddressableMultiaddr,
  isLoopbackIp6Multiaddr,
  parsesMultiaddr,
} from '../net/address-policy.js'

// ---------------------------------------------------------------------------
// byte helpers (the established self-contained-module pattern of
// `identity.ts` / `gate-verifier.ts` — helpers stay local by convention)
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder()

/** The pinned domain-separation tag (digest first bytes; versioned). */
export const PEER_ANNOUNCEMENT_DOMAIN = 'succinctcoin/PeerAnnouncement/v1\0'

/** Shape limits (block-size budget defense — discovery-design.md). */
/** Per-record multiaddr ceiling (a record with more is invalid — pinned). */
export const MAX_MULTIADDRS = 8
const MAX_MULTIADDR_CHARS = 160
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

/** Encode one unsigned value as 4-byte big-endian (length prefixes). */
function u32be(v: number): Uint8Array {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, v, false)
  return buf
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// ---------------------------------------------------------------------------
// the fields + digest
// ---------------------------------------------------------------------------

/**
 * The announcement fields a signature binds — everything but `signature`
 * itself. Slots are chain-time integers (AD-3); `number` is the repo-wide
 * slot type (node-loop, applyBlock).
 */
export interface PeerAnnouncementFields {
  /** 32-byte hex identity id of the announcing peer. */
  identityId: string
  /** Reachability addresses (multiaddr strings), 1–8 entries. */
  multiaddrs: string[]
  /** NAT-visible external address, when observed. */
  observedExternalAddr?: string | undefined
  /**
   * First valid chain-time slot (inclusive). `bigint` is accepted because
   * protons DECODES proto int64 as bigint — a wire-decoded record flows
   * into this contract unchanged (8.3's applyBlock path).
   */
  slotStart: number | bigint
  /** Last valid chain-time slot (inclusive, >= slotStart). */
  slotEnd: number | bigint
  /** Network scope (genesis `chainId`). */
  chainId: string
}

/** The full signed record (the proto `PeerAnnouncement` wire shape). */
export interface SignedPeerAnnouncement extends PeerAnnouncementFields {
  /** 64-byte Ed25519 signature over the pinned digest. */
  signature: Uint8Array
}

/**
 * Coerce a slot value into its u64 bigint form (identity.ts `coerceWindow`
 * pattern): safe non-negative integers or bigints in `[0, 2^64)`; anything
 * else throws `RangeError` (the validator turns that into `malformed-slot`).
 */
function coerceSlot(v: number | bigint): bigint {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (b === null || b < 0n || b >= 1n << 64n) {
    throw new RangeError(`peerAnnouncementDigest: slot ${String(v)} is not a u64 slot`)
  }
  return b
}

/** A multiaddr entry's canonical digest part: u32be(len) ‖ utf8(entry). */
function addrDigestPart(addrs: readonly string[]): Uint8Array {
  const sorted = [...addrs].sort()
  return sha256(
    sorted.map((a) => concat([u32be(TEXT_ENCODER.encode(a).byteLength), TEXT_ENCODER.encode(a)])),
  )
}

/**
 * The EXACT pinned digest over announcement fields (see the module header).
 * Assumes shape-valid inputs (`validatePeerAnnouncement` checks first;
 * `signPeerAnnouncement` signs what it built) — a non-integer/out-of-range
 * slot throws `RangeError` by construction, never silently truncates.
 */
export function peerAnnouncementDigest(fields: PeerAnnouncementFields): Uint8Array {
  const slotStart = coerceSlot(fields.slotStart)
  const slotEnd = coerceSlot(fields.slotEnd)
  // The observed part is EXACTLY 32 bytes (the pinned `u256` of the digest
  // spec): sha256 over a presence byte ‖ optional utf8 address. Only
  // `undefined` means absent — an empty string is a shape error the
  // validator rejects, never a second spelling of "absent".
  const observed = fields.observedExternalAddr
  const observedPart = sha256(
    observed === undefined
      ? [new Uint8Array([0])]
      : [new Uint8Array([1]), TEXT_ENCODER.encode(observed)],
  )
  return sha256([
    TEXT_ENCODER.encode(PEER_ANNOUNCEMENT_DOMAIN),
    TEXT_ENCODER.encode(fields.identityId),
    addrDigestPart(fields.multiaddrs),
    observedPart,
    u64be(slotStart),
    u64be(slotEnd),
    TEXT_ENCODER.encode(fields.chainId),
  ])
}

// ---------------------------------------------------------------------------
// sign / verify (the identity.ts D1/D2 pattern)
// ---------------------------------------------------------------------------

/**
 * Sign an announcement with the install's keypair (8.1 seeds make every
 * install distinct — the premise this signature is meaningful).
 * Deterministic per RFC 8032.
 */
export function signPeerAnnouncement(
  keypair: IdentityKeypair,
  fields: PeerAnnouncementFields,
): Uint8Array {
  // The identity binds to the SIGNER — a caller cannot announce as someone
  // else through this seam.
  const digest = peerAnnouncementDigest({ ...fields, identityId: keypair.identityId })
  // AD-11: signing goes through identity.ts — the ONE key-material reader
  // (4.7 single-reader invariant); discovery never touches it directly.
  return signDigest(keypair, digest)
}

/** Verify from PUBLIC data alone (D2); malformed inputs are `false`, never throws. */
export function verifyPeerAnnouncementSignature(
  fields: PeerAnnouncementFields,
  signature: Uint8Array,
): boolean {
  if (!HEX_ID_64.test(fields.identityId) || signature.byteLength !== 64) return false
  let digest: Uint8Array
  try {
    digest = peerAnnouncementDigest(fields)
  } catch {
    return false // a bad slot shape rejects, it does not throw (D5)
  }
  try {
    const spki = new Uint8Array(SPKI_PREFIX.length + 32)
    spki.set(SPKI_PREFIX, 0)
    spki.set(hexToBytes(fields.identityId), SPKI_PREFIX.length)
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
// the pure validator (8.3 applyBlock + 8.4 address book both call THIS)
// ---------------------------------------------------------------------------

/** Every pinned reject reason (pinned — tests + 8.4 metrics key on these). */
export type AnnouncementRejectReason =
  | 'malformed-identity'
  | 'malformed-multiaddr'
  | 'too-many-multiaddrs'
  | 'malformed-observed-addr'
  | 'malformed-slot'
  | 'malformed-chain-id'
  | 'malformed-signature'
  | 'unsupported-address'
  | 'chain-mismatch'
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired'

export type AnnouncementValidation = { ok: true } | { ok: false; reason: AnnouncementRejectReason }

/** Context for validation — ALL time/network inputs are caller-supplied (AD-3). */
export interface AnnouncementContext {
  /**
   * The validator's current chain-time slot (a node head slot or a block's
   * own slot — `bigint` is the proto int64 form). A safe integer / bigint
   * is a CALLER precondition — anything else is a programming error and
   * throws loudly, unlike record-level junk, which the validator itself
   * never lets throw.
   */
  currentSlot: number | bigint
  /** This network's genesis `chainId` — records from other chains die here. */
  expectedChainId: string
  /**
   * DEV-ONLY (10.3 closeout): accept pure-`::1` addresses in the policy
   * layer, exactly as the dial side does under `SUCCINCTCOIN_ALLOW_LOOPBACK`
   * — for LOCAL dev meshes on machines with no global IPv6. NEVER set this
   * in a consensus context (block candidates, block application, introduc-
   * tions production): those validate STRICTLY always, so loopback records
   * can never enter a block and no honest node can diverge on chain data.
   * Callers resolve the env flag once per ingest (`loopbackAnnounceAllowed`)
   * and pass it in; the validator itself never reads the environment.
   */
  allowLoopbackAddresses?: boolean
}

/** A multiaddr entry as a SHAPE (genesis rule + no whitespace/control, bounded). */
function isMultiaddrShape(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 1 &&
    v.length <= MAX_MULTIADDR_CHARS &&
    v.startsWith('/') &&
    !/[\s\x00-\x1f\x7f]/.test(v)
  )
}

/**
 * Validate an UNTRUSTED announcement record end-to-end: shape → chain →
 * signature → slot freshness (signature before expiry is the pinned cost
 * order; chain first so a wrong-network flood never pays Ed25519). Pure —
 * no clock, no I/O. `record` may be ANY decoded value (proto-decoded wire
 * data); nothing about it is trusted until checked.
 */
export function validatePeerAnnouncement(
  record: unknown,
  ctx: AnnouncementContext,
): AnnouncementValidation {
  if (typeof record !== 'object' || record === null) return fail('malformed-identity')
  const r = record as Record<string, unknown>

  if (typeof r.identityId !== 'string' || !HEX_ID_64.test(r.identityId))
    return fail('malformed-identity')

  if (!Array.isArray(r.multiaddrs) || r.multiaddrs.length === 0)
    return fail('malformed-multiaddr')
  if (r.multiaddrs.length > MAX_MULTIADDRS) return fail('too-many-multiaddrs')
  if (!r.multiaddrs.every(isMultiaddrShape)) return fail('malformed-multiaddr')
  const seen = new Set<string>(r.multiaddrs as string[])
  if (seen.size !== r.multiaddrs.length) return fail('malformed-multiaddr') // no dupes

  if (r.observedExternalAddr !== undefined && !isMultiaddrShape(r.observedExternalAddr))
    return fail('malformed-observed-addr')

  // Parseability is still shape: a ≤160-char string that does not parse as a
  // multiaddr at all is malformed, not merely off-policy. Each field keeps
  // its own malformed reason (observed addr has a dedicated one).
  if (!(r.multiaddrs as string[]).every(parsesMultiaddr)) return fail('malformed-multiaddr')
  if (r.observedExternalAddr !== undefined && !parsesMultiaddr(r.observedExternalAddr as string))
    return fail('malformed-observed-addr')

  // Addressing law (9.1, amended 2026-10-21 with the relay-hop rule): every
  // address a record carries must be dialable on THIS network — direct `/ip4`
  // or link-local announcements are rejected whole (deterministic for block
  // validation; nodes only ever announce policy-valid addrs, so mixed records
  // are junk). A CIRCUIT address is judged by the hop law: exactly one
  // global-scope IP hop (either family) before the first p2p-circuit, no IP
  // in the tail — so an IPv4-only node's `/ip4/<relay>/…/p2p-circuit/…`
  // invite verifies at EVERY boundary, block data included, while a direct
  // v4 or a private/CGNAT/loopback/link-local/mcast hop never does.
  // STRICT by default. The ONLY relaxation is the explicit dev-only context
  // flag (10.3 closeout) — a PURE predicate (addressable, or exactly-`::1`
  // with no zone): the ctx IS the whole authority, the validator never reads
  // the environment even indirectly. Consensus contexts never set it, so what
  // enters a BLOCK is always strictly global-or-global-hop — a flagged dev
  // node's `::1` records live in gossip/books/invites locally and can never
  // fork an unflagged peer over chain data.
  const addrPolicyOk =
    ctx.allowLoopbackAddresses === true
      ? (addr: string): boolean =>
          isAddressableMultiaddr(addr) || isLoopbackIp6Multiaddr(addr)
      : isAddressableMultiaddr
  if (!(r.multiaddrs as string[]).every(addrPolicyOk)) return fail('unsupported-address')
  if (
    r.observedExternalAddr !== undefined &&
    !addrPolicyOk(r.observedExternalAddr as string)
  )
    return fail('unsupported-address')

  // Slots: number OR bigint (protons decodes proto int64 as bigint — wire
  // records flow in unchanged). u64-coercible, and end >= start.
  let slotStart: bigint
  let slotEnd: bigint
  try {
    slotStart = coerceSlot(r.slotStart as number | bigint)
    slotEnd = coerceSlot(r.slotEnd as number | bigint)
  } catch {
    return fail('malformed-slot')
  }
  if (slotEnd < slotStart) return fail('malformed-slot')

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

  const fields: PeerAnnouncementFields = {
    identityId: r.identityId,
    multiaddrs: [...(r.multiaddrs as string[])],
    observedExternalAddr: r.observedExternalAddr as string | undefined,
    slotStart,
    slotEnd,
    chainId: r.chainId as string,
  }
  if (!verifyPeerAnnouncementSignature(fields, signature)) return fail('bad-signature')

  if (slotEnd < BigInt(ctx.currentSlot)) return fail('expired')
  if (slotStart > BigInt(ctx.currentSlot)) return fail('not-yet-valid')
  return { ok: true }
}

function fail(reason: AnnouncementRejectReason): AnnouncementValidation {
  return { ok: false, reason }
}
