/**
 * `core/discovery/witness` — the WB-2 reachability witness (ticket 13.2,
 * spec-scinvite-v2): a `ReachabilityWitness` is "address Y of peer X was
 * reachable for ME", signed by the WITNESSING identity — the attestation a
 * `scinvite:v2` backup candidate carries (13.5 mints with them, 13.4 keeps
 * received ones). Any node may witness any address it reached; the
 * signature makes the claim attributable, and the per-target issuance cap
 * is what keeps an honest node from ever being an unbounded signing oracle.
 *
 * Pinned digest layout (domain-separated from BOTH other discovery
 * signatures — the tag AND the field layout differ, and
 * `test/discovery-witness.test.ts` pins the separation both ways):
 *
 *   sha256( utf8("succinctcoin/ReachabilityWitness/v1\0")
 *         ‖ utf8(targetIdentityId)
 *         ‖ utf8(address)
 *         ‖ utf8(chainId)
 *         ‖ u64be(firstSeenSlot)
 *         ‖ u64be(expirySlot) )
 *
 * The SIGNER is deliberately NOT in the bytes — it is bound by the pubkey
 * the verifier rebuilds from `signerIdentityId`: swapping the signer id
 * fails Ed25519 (the WRONG_SIGNER rule), and two digests differing only in
 * signer are EQUAL by design. The five digested fields are exactly the
 * ticket-pinned set; a witness structurally satisfies `InviteWitnessInput`.
 *
 * Slot bounds are HALF-OPEN `[firstSeenSlot, expirySlot)` — deliberately
 * unlike the announcements' closed interval (pinned by the ticket): a
 * witness is live exactly while `firstSeen <= current < expiry`.
 *
 * Purity (AD-3/AD-10): NO clock, NO net, NO fs — every time judgement runs
 * on a CALLER-SUPPLIED slot, and the same reject-never-throw discipline as
 * 8.2/8.4: hostile wire data produces `{ok:false, reason}`, never an
 * exception. The address is an OBSERVATION, not a dial request — no
 * multiaddr parsing or addressing policy lives here (the diversity and
 * direct-first laws are 13.3's); the k-of-n/signer-distinctness rules are
 * NOT this module's either.
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
export const REACHABILITY_WITNESS_DOMAIN = 'succinctcoin/ReachabilityWitness/v1\0'

/** Default witness lifetime: 3× the 32-slot liveness lookback
 * (`DEFAULT_TICKET_LOOKBACK_SLOTS`) — a witness outlives three full
 * liveness windows (resolves the ticket's expiry-length unknown). */
export const DEFAULT_WITNESS_EXPIRY_SLOTS = 96

/** Issuance-rate window in slots (round-counted bucket, no clocks). */
export const WITNESS_ISSUANCE_WINDOW_SLOTS = 32n

/** Per-target issuance cap inside ONE window — matches `MAX_MULTIADDRS`:
 * more than that many witnesses for one target per window is a flood, not
 * witnessing. Counted per (target, `currentSlot / windowSlots` bucket). */
export const MAX_ISSUANCES_PER_TARGET_WINDOW = 8

/** Live witnesses retained per target in the store — mirrors
 * `MAX_VOUCHES_PER_SUBJECT`: one signer cannot grow a target's map without
 * limit; eviction keeps the FRESHEST expiries. */
export const MAX_WITNESSES_PER_TARGET = 16

/** Address-field shape bound (same ceiling as an announcement multiaddr);
 * it is an observation string, so only SHAPE is checked — never policy. */
const MAX_ADDRESS_CHARS = 160
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
 * into `malformed-witness`).
 */
function coerceSlot(v: number | bigint): bigint {
  const b = typeof v === 'bigint' ? v : Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (b === null || b < 0n || b >= 1n << 64n) {
    throw new RangeError(`witnessDigest: slot ${String(v)} is not a u64 slot`)
  }
  return b
}

/** The address field as SHAPE: a bounded printable token (no whitespace or
 * control characters). Blank fails — empty evidence signs nothing. */
function isAddressShape(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_ADDRESS_CHARS &&
    !/[\s\x00-\x1f\x7f]/.test(v)
  )
}

// ---------------------------------------------------------------------------
// the fields + digest
// ---------------------------------------------------------------------------

/**
 * The witness fields a signature binds — everything but `signature` itself.
 * Slots are chain-time (AD-3); `bigint` is accepted because protons DECODES
 * proto int64 as bigint (wire records flow in unchanged).
 */
export interface WitnessFields {
  /** 32-byte hex identity id of the witnessed peer. */
  targetIdentityId: string
  /** The address the signer reached for the target (an observation). */
  address: string
  /** Network scope (genesis `chainId`). */
  chainId: string
  /** First valid chain-time slot (INCLUSIVE). */
  firstSeenSlot: number | bigint
  /** Expiry chain-time slot (EXCLUSIVE — half-open, see module header). */
  expirySlot: number | bigint
  /** 32-byte hex identity id of the witnessing peer — NOT digested; bound
   * by the pubkey that verifies (see module header). */
  signerIdentityId: string
}

/** The full signed witness (the proto `ReachabilityWitness` wire shape,
 * structurally compatible with `InviteWitnessInput`). */
export interface SignedWitness extends WitnessFields {
  /** 64-byte Ed25519 signature over the pinned digest. */
  signature: Uint8Array
}

/**
 * The EXACT pinned digest over the FIVE witness fields (see the module
 * header) — `signerIdentityId` is read off `fields` for shape symmetry but
 * NEVER enters the bytes; the pubkey binds the signer. Assumes shape-valid
 * inputs (`verifyWitness` checks first; `issueWitness` signs what it built)
 * — a bad slot throws `RangeError` by construction, never truncates.
 */
export function witnessDigest(fields: WitnessFields): Uint8Array {
  const firstSeenSlot = coerceSlot(fields.firstSeenSlot)
  const expirySlot = coerceSlot(fields.expirySlot)
  return sha256([
    TEXT_ENCODER.encode(REACHABILITY_WITNESS_DOMAIN),
    TEXT_ENCODER.encode(fields.targetIdentityId),
    TEXT_ENCODER.encode(fields.address),
    TEXT_ENCODER.encode(fields.chainId),
    u64be(firstSeenSlot),
    u64be(expirySlot),
  ])
}

// ---------------------------------------------------------------------------
// issue / verify (the announcements.ts D1/D2 pattern)
// ---------------------------------------------------------------------------

/**
 * Issue a witness with the install's keypair — the PURE primitive; policy
 * (kill switch, evidence, cap) lives in {@link createWitnessIssuer}. The
 * SIGNER is always the keypair's own identity — a caller cannot mint a
 * witness through someone else's key via this seam. Deterministic per
 * RFC 8032.
 */
export function issueWitness(keypair: IdentityKeypair, fields: WitnessFields): SignedWitness {
  const signed: WitnessFields = {
    ...fields,
    signerIdentityId: keypair.identityId, // the pin — the signer IS the keypair
  }
  // AD-11: signing goes through identity.ts — the ONE key-material reader
  // (4.7 single-reader invariant); discovery never touches it directly.
  return { ...signed, signature: signDigest(keypair, witnessDigest(signed)) }
}

/** Verify from PUBLIC data alone (D2); malformed inputs are `false`, never throws. */
export function verifyWitnessSignature(fields: WitnessFields, signature: Uint8Array): boolean {
  if (!HEX_ID_64.test(fields.signerIdentityId) || signature.byteLength !== 64) return false
  let digest: Uint8Array
  try {
    digest = witnessDigest(fields)
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
// the pure validator (13.4's receiver and the store both call THIS)
// ---------------------------------------------------------------------------

/** Every pinned reject reason (pinned — tests + metrics key on these). */
export type WitnessRejectReason =
  | 'malformed-witness'
  | 'chain-mismatch'
  | 'not-yet-valid'
  | 'expired'
  | 'bad-signature'

export type WitnessValidation = { ok: true } | { ok: false; reason: WitnessRejectReason }

/** Context for validation — ALL time/network inputs are caller-supplied (AD-3). */
export interface WitnessContext {
  /**
   * The validator's current chain-time slot. A safe integer / bigint is a
   * CALLER precondition — anything else is a programming error and throws
   * loudly, unlike record-level junk, which the validator never lets throw.
   */
  currentSlot: number | bigint
  /** This network's genesis `chainId` — witnesses from other chains die here. */
  expectedChainId: string
}

/**
 * Validate an UNTRUSTED witness end-to-end with the PINNED cost order:
 * shape → chain-mismatch → HALF-OPEN slot window → Ed25519 LAST (the
 * witness mirror of the SIG_BEFORE_EXPIRY pinning discipline — a
 * wrong-chain or out-of-window flood never pays the signature cost). The
 * window is `[firstSeenSlot, expirySlot)`: `current < firstSeen` rejects
 * `not-yet-valid`, `current >= expiry` rejects `expired`. Pure — no clock,
 * no I/O.
 */
export function verifyWitness(witness: unknown, ctx: WitnessContext): WitnessValidation {
  if (typeof witness !== 'object' || witness === null) return fail('malformed-witness')
  const w = witness as Record<string, unknown>

  if (typeof w.targetIdentityId !== 'string' || !HEX_ID_64.test(w.targetIdentityId))
    return fail('malformed-witness')
  if (typeof w.signerIdentityId !== 'string' || !HEX_ID_64.test(w.signerIdentityId))
    return fail('malformed-witness')
  if (!isAddressShape(w.address)) return fail('malformed-witness')

  if (
    typeof w.chainId !== 'string' ||
    w.chainId.length === 0 ||
    w.chainId.length > MAX_CHAIN_ID_CHARS ||
    !PRINTABLE_ASCII.test(w.chainId)
  )
    return fail('malformed-witness')

  let firstSeenSlot: bigint
  let expirySlot: bigint
  try {
    firstSeenSlot = coerceSlot(w.firstSeenSlot as number | bigint)
    expirySlot = coerceSlot(w.expirySlot as number | bigint)
  } catch {
    return fail('malformed-witness')
  }

  const signature = w.signature as Uint8Array | undefined
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64)
    return fail('malformed-witness')

  if (w.chainId !== ctx.expectedChainId) return fail('chain-mismatch')

  const current = BigInt(ctx.currentSlot)
  if (current < firstSeenSlot) return fail('not-yet-valid')
  if (current >= expirySlot) return fail('expired') // half-open [first, expiry)

  const fields: WitnessFields = {
    targetIdentityId: w.targetIdentityId,
    address: w.address as string,
    chainId: w.chainId as string,
    firstSeenSlot,
    expirySlot,
    signerIdentityId: w.signerIdentityId,
  }
  if (!verifyWitnessSignature(fields, signature)) return fail('bad-signature')
  return { ok: true }
}

function fail(reason: WitnessRejectReason): WitnessValidation {
  return { ok: false, reason }
}

// ---------------------------------------------------------------------------
// the stateful issuer (policy over the pure primitive)
// ---------------------------------------------------------------------------

/** The evidence one issuance is built from — what the signer observed. */
export interface WitnessEvidence {
  targetIdentityId: string
  address: string
}

/** Every pinned issuance decline reason (pinned — tests + metrics key on
 * these). A decline NEVER carries witness bytes. */
export type WitnessDeclineReason = 'issuance-disabled' | 'no-evidence' | 'issuance-cap-reached'

/** The result of one issuance attempt — a decline is `{ok:false, reason}`
 * with NO witness field anywhere. */
export type WitnessIssuance =
  | { ok: true; witness: SignedWitness }
  | { ok: false; reason: WitnessDeclineReason }

export interface WitnessIssuerOptions {
  /** The install's keypair — the ONLY signer this issuer ever uses. */
  keypair: IdentityKeypair
  /** Witnesses are minted scoped to THIS chain (the join network's genesis). */
  expectedChainId: string
  /** Witness lifetime in slots (default {@link DEFAULT_WITNESS_EXPIRY_SLOTS}). */
  expirySlots?: bigint
  /** Rate window in slots (default {@link WITNESS_ISSUANCE_WINDOW_SLOTS}). */
  windowSlots?: bigint
  /** Per-target cap per window (default {@link MAX_ISSUANCES_PER_TARGET_WINDOW}). */
  capPerWindow?: number
  /** Kill switch (default `true`) — off means NO signature is ever produced. */
  enabled?: boolean
}

export interface WitnessIssuer {
  /** One policy-gated issuance at `currentSlot` (a caller-supplied slot —
   * AD-3). Declines: kill switch → `issuance-disabled`; blank address or
   * non-hex target → `no-evidence`; per-target window cap → 
   * `issuance-cap-reached`. */
  issue(evidence: WitnessEvidence, currentSlot: number | bigint): WitnessIssuance
}

/**
 * Create a policy-gated witness issuer over the install's keypair — the
 * seam the node adapter constructs from its options (no wiring yet). The
 * rate discipline is round-counted: counts are keyed by target inside the
 * bucket `currentSlot / windowSlots` (integer division) — deterministic,
 * clock-free, and a burst cannot spill into the next bucket.
 */
export function createWitnessIssuer(opts: WitnessIssuerOptions): WitnessIssuer {
  const expirySlots = opts.expirySlots ?? BigInt(DEFAULT_WITNESS_EXPIRY_SLOTS)
  const windowSlots = opts.windowSlots ?? WITNESS_ISSUANCE_WINDOW_SLOTS
  const capPerWindow = opts.capPerWindow ?? MAX_ISSUANCES_PER_TARGET_WINDOW
  const enabled = opts.enabled ?? true
  // Option junk is a programming error, not hostile input.
  if (expirySlots <= 0n || windowSlots <= 0n) {
    throw new Error('witness-issuer: expirySlots and windowSlots must be positive')
  }
  if (!Number.isSafeInteger(capPerWindow) || capPerWindow < 0) {
    throw new Error('witness-issuer: capPerWindow must be a non-negative integer')
  }

  /** The current rate bucket + per-target counts inside it (only the live
   * bucket is ever retained — a rolled bucket is cleared, never consulted). */
  let windowBucket: bigint | undefined
  const issuedPerTarget = new Map<string, number>()

  return {
    issue(evidence: WitnessEvidence, currentSlot: number | bigint): WitnessIssuance {
      if (!enabled) return decline('issuance-disabled')
      if (
        typeof evidence.targetIdentityId !== 'string' ||
        !HEX_ID_64.test(evidence.targetIdentityId) ||
        !isAddressShape(evidence.address)
      ) {
        return decline('no-evidence') // blank address / non-hex target signs nothing
      }
      const current = coerceSlot(currentSlot) // caller precondition, like ctx slots

      const bucket = current / windowSlots
      if (bucket !== windowBucket) {
        windowBucket = bucket
        issuedPerTarget.clear()
      }
      const held = issuedPerTarget.get(evidence.targetIdentityId) ?? 0
      if (held >= capPerWindow) return decline('issuance-cap-reached')

      const witness = issueWitness(opts.keypair, {
        targetIdentityId: evidence.targetIdentityId,
        address: evidence.address,
        chainId: opts.expectedChainId,
        firstSeenSlot: current,
        expirySlot: current + expirySlots,
        signerIdentityId: opts.keypair.identityId,
      })
      issuedPerTarget.set(evidence.targetIdentityId, held + 1)
      return { ok: true, witness }
    },
  }
}

function decline(reason: WitnessDeclineReason): WitnessIssuance {
  return { ok: false, reason }
}

// ---------------------------------------------------------------------------
// the local witness store (fresh witnesses kept for later minting/gossip)
// ---------------------------------------------------------------------------

export interface WitnessStoreOptions {
  /** Only witnesses scoped to THIS chain are admitted (verify-before-store). */
  expectedChainId: string
}

export interface WitnessStore {
  /** Verify-then-insert (the pinned validator runs internally — an expired,
   * forged, or wrong-chain witness CANNOT enter). Same (target, address,
   * signer) keeps the FRESHEST expiry; over {@link MAX_WITNESSES_PER_TARGET}
   * per target the oldest expiry is evicted. */
  add(witness: unknown, currentSlot: number | bigint): WitnessValidation
  /** Live witnesses for `targetIdentityId` AT `currentSlot` (half-open
   * window), sorted by (address, signerIdentityId); copy-on-read. */
  get(targetIdentityId: string, currentSlot: number | bigint): SignedWitness[]
  /** Drop every witness expired AT `currentSlot` (`expiry <= current`, the
   * half-open window's own rule); returns how many went. */
  pruneExpired(currentSlot: number | bigint): number
  /** Total stored (unexpired-but-unpruned included — reads filter). */
  size(): number
}

/**
 * Create an empty witness store. Pure state — every time-dependent behavior
 * is parameterized by `currentSlot` (AD-3). Not thread/lock relevant: one
 * per node process, like the loop. 13.4 fills it from gossip; 13.5 mints
 * invites from it — nobody wires it yet.
 */
export function createWitnessStore(opts: WitnessStoreOptions): WitnessStore {
  /** target identityId -> (address ‖ 0x00 ‖ signer) -> witness. One live
   * witness per signer per address per target — the dedupe key. */
  const byTarget = new Map<string, Map<string, SignedWitness>>()

  const keyOf = (w: SignedWitness): string => `${w.address}\u0000${w.signerIdentityId}`

  function snapshot(w: SignedWitness): SignedWitness {
    return { ...w, signature: w.signature.slice() } // copy on read
  }

  return {
    add(witness: unknown, currentSlot: number | bigint): WitnessValidation {
      const current = coerceSlot(currentSlot)
      const verdict = verifyWitness(witness, {
        currentSlot: current,
        expectedChainId: opts.expectedChainId,
      })
      if (!verdict.ok) return verdict

      // Validator-approved: normalise slots to bigint (the wire form) so
      // stored records are stable regardless of how the caller spelled them.
      // The signature is COPIED on write too (address-book's double-defense:
      // :574 slices on store, :410 slices on read) — a caller mutating the
      // bytes it passed must not retroactively corrupt what is stored.
      const w = witness as SignedWitness
      const stored: SignedWitness = {
        targetIdentityId: w.targetIdentityId,
        address: w.address,
        chainId: w.chainId,
        firstSeenSlot: BigInt(w.firstSeenSlot),
        expirySlot: BigInt(w.expirySlot),
        signerIdentityId: w.signerIdentityId,
        signature: w.signature.slice(),
      }

      let byKey = byTarget.get(stored.targetIdentityId)
      if (byKey === undefined) {
        byKey = new Map()
        byTarget.set(stored.targetIdentityId, byKey)
      }
      const key = keyOf(stored)
      const held = byKey.get(key)
      if (held !== undefined && BigInt(stored.expirySlot) <= BigInt(held.expirySlot)) {
        return { ok: true } // valid, just not fresher — the held witness wins
      }
      byKey.set(key, stored)

      // Per-target cap: evict the OLDEST expiry (key lexicographic
      // tie-break — deterministic), mirroring vouch eviction.
      while (byKey.size > MAX_WITNESSES_PER_TARGET) {
        let oldestKey: string | undefined
        let oldestExpiry: bigint | undefined
        for (const [k, v] of byKey) {
          const expiry = BigInt(v.expirySlot)
          if (
            oldestExpiry === undefined ||
            expiry < oldestExpiry ||
            (expiry === oldestExpiry && k < (oldestKey as string))
          ) {
            oldestKey = k
            oldestExpiry = expiry
          }
        }
        byKey.delete(oldestKey as string)
      }
      return { ok: true }
    },

    get(targetIdentityId: string, currentSlot: number | bigint): SignedWitness[] {
      const current = coerceSlot(currentSlot)
      const byKey = byTarget.get(targetIdentityId)
      if (byKey === undefined) return []
      return [...byKey.values()]
        .filter((w) => current >= BigInt(w.firstSeenSlot) && current < BigInt(w.expirySlot))
        .map(snapshot)
        .sort(
          (a, b) =>
            (a.address < b.address ? -1 : a.address > b.address ? 1 : 0) ||
            (a.signerIdentityId < b.signerIdentityId
              ? -1
              : a.signerIdentityId > b.signerIdentityId
                ? 1
                : 0),
        )
    },

    pruneExpired(currentSlot: number | bigint): number {
      const current = coerceSlot(currentSlot)
      let removed = 0
      for (const [target, byKey] of byTarget) {
        for (const [key, w] of byKey) {
          if (BigInt(w.expirySlot) <= current) {
            byKey.delete(key)
            removed += 1
          }
        }
        if (byKey.size === 0) byTarget.delete(target)
      }
      return removed
    },

    size(): number {
      let n = 0
      for (const byKey of byTarget.values()) n += byKey.size
      return n
    },
  }
}
