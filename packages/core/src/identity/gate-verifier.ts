/**
 * `core/identity` — the offline gate-credential verifier (4.1, R3 / AD-4).
 *
 * The `GateVerifier` PORT already exists in `src/ports.ts` (epic 1 —
 * `GateCredential { gateId, blob }`, `GateVerification { valid, identityId,
 * attestedUntilWindow }`, `verify(cred, windowIndex) → Promise<
 * GateVerification>`). This module is the DETERMINISTIC OFFLINE
 * IMPLEMENTATION of that exact port (D1 — the seam is untouched; this is
 * the implementation), plus the OFFLINE GATE-STANDIN ISSUER the harness /
 * sim uses to mint valid credentials (D4).
 *
 * The verifier reads ONLY `cred.gateId` (the registry key — AD-4 permits
 * `gateId`, never the blob fields outside the verifier) and re-derives the
 * blob's offline MAC itself (D3):
 *
 *   blob = utf8(gateId) ‖ utf8(identityId) ‖ u64be(attestedUntilWindow) ‖
 *          sha256("SC-GATE-CRED/1" ‖ utf8(gateId) ‖ utf8(identityId) ‖
 *                 u64be(attestedUntilWindow))
 *
 * Acceptance (ALL must hold):
 *   1. `cred.gateId ∈ acceptedGates` (must-hold (c): gates enter only by
 *      protocol upgrade — the registry is the caller's, e.g. the validated
 *      `genesis.gates`; never auto-valid);
 *   2. the blob is well-formed (≥ 40 bytes: identityId ≥ 0 + 8 u64be +
 *      32-byte MAC) and its embedded MAC matches the recomputation;
 *   3. `identityId` is exactly 64 hex chars (32-byte hex, the spine id
 *      convention);
 *   4. the blob's `gateId` equals `cred.gateId` (the MAC binds both, but
 *      the check is explicit);
 *   5. `windowIndex <= attestedUntilWindow` — CHAIN TIME only (AD-3:
 *      never the wall clock).
 *
 * A reject is a NORMAL `{ valid: false, identityId: "",
 * attestedUntilWindow: 0 }` — NEVER an error for a rejected credential
 * (the same "reject = normal false, not error" convention as
 * `verifyDraw`). No network call, no `Math.random`, no wall clock
 * anywhere (AD-4 offline, AD-3). No `big.js` (AD-5) — only `node:crypto`
 * sha256 + integers.
 */
import { createHash } from 'node:crypto'
import type { GateCredential, GateVerification, GateVerifier } from '../ports.js'

/** The pinned offline-credential domain tag (AD-12 style versioned tag). */
const CRED_DOMAIN = new TextEncoder().encode('SC-GATE-CRED/1')

/** Spine identity convention: 32-byte hex, 64 hex chars, lowercase. */
const HEX_ID_64 = /^[0-9a-f]{64}$/

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Identity / gate-credential programming error. */
export class GateError extends Error {
  readonly code = 'SC-IDENTITY-1' as const
  constructor(message: string) {
    super(message)
    this.name = 'GateError'
  }
}

/** The canonical reject result (D3: a normal value, not an error). */
const REJECT: GateVerification = {
  valid: false,
  identityId: '',
  attestedUntilWindow: 0,
}

// ---------------------------------------------------------------------------
// byte helpers (the established `pow.ts` / `draw.ts` pattern, kept local so
// the module is self-contained)
// ---------------------------------------------------------------------------

/** sha256 over arbitrary parts (node:crypto — the only crypto used, AD-4). */
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

/** Read a byte string as a big-endian integer (MSB first). */
function bytesToBig(buf: Uint8Array): bigint {
  let v = 0n
  for (let i = 0; i < buf.length; i += 1) v = (v << 8n) | BigInt(buf[i])
  return v
}

/**
 * Encode one value as 8-byte big-endian (AD-12 digest form). A value
 * outside `[0, 2^64)` is a programming error, not data (the `pow.ts`
 * / `draw.ts` u64be convention).
 */
function u64be(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) {
    throw new GateError(
      `SC-IDENTITY-1: attestedUntilWindow ${v} is outside the u64be range`,
    )
  }
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, v, false) // big-endian
  return buf
}

/** Constant-time-ish byte compare (a MAC mismatch must be a plain reject). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

// ---------------------------------------------------------------------------
// field validation (shared by issuer and verifier — one canonical shape)
// ---------------------------------------------------------------------------

/** A spine identity id: exactly 64 hex chars (32-byte hex convention). */
function isHexId64(id: string): boolean {
  return HEX_ID_64.test(id)
}

/**
 * Coerce + validate the attested-until window into its u64be range.
 * A `number` must be a finite integer in `[0, 2^64)`; a `bigint` must be
 * in `[0, 2^64)`. A fractional or non-finite window is a programming
 * error (the window index is a chain-time integer, AD-3) — throw, never
 * silently truncate.
 */
function coerceWindow(value: number | bigint): bigint {
  let v: bigint
  if (typeof value === 'bigint') {
    v = value
  } else if (!Number.isInteger(value)) {
    throw new GateError(
      `SC-IDENTITY-1: attestedUntilWindow ${value} is not an integer`,
    )
  } else {
    v = BigInt(value)
  }
  if (v < 0n || v >= 1n << 64n) {
    throw new GateError(
      `SC-IDENTITY-1: attestedUntilWindow ${value} is outside the u64be range`,
    )
  }
  return v
}

// ---------------------------------------------------------------------------
// D3 — the deterministic canonical blob (issuer and verifier share it)
// ---------------------------------------------------------------------------

/**
 * Build the canonical blob:
 * `utf8(gateId) ‖ utf8(identityId) ‖ u64be(attestedUntilWindow) ‖ MAC`,
 * where `MAC = sha256("SC-GATE-CRED/1" ‖ utf8(gateId) ‖ utf8(identityId) ‖
 * u64be(attestedUntilWindow))` — the offline "signature" (AD-4: a
 * deterministic check only, no network call).
 */
function buildBlob(gateId: string, identityId: string, windowBig: bigint): Uint8Array {
  const gateIdBytes = TEXT_ENCODER.encode(gateId)
  const idBytes = TEXT_ENCODER.encode(identityId)
  const windowBytes = u64be(windowBig)
  const mac = sha256([CRED_DOMAIN, gateIdBytes, idBytes, windowBytes])
  return concat([gateIdBytes, idBytes, windowBytes, mac])
}

/**
 * Parse + verify a canonical blob. Returns `null` on ANY failure (wrong
 * shape, non-canonical `identityId`, mismatched MAC, or a blob `gateId`
 * that differs from `cred.gateId`) — a rejected credential is data, not
 * an error (D3).
 */
function parseBlob(
  blob: Uint8Array,
  gateId: string,
): { identityId: string; attestedUntil: bigint } | null {
  // Shape: <gateId> <identityId> <8-byte u64be window> <32-byte MAC>.
  // identityId may be empty (0 bytes) before the format check rejects it.
  if (blob.byteLength < 40) return null
  const macStart = blob.byteLength - 32
  const windowStart = macStart - 8
  const gateIdBytes = TEXT_ENCODER.encode(gateId)
  // The gateId prefix occupies its UTF-8 BYTE length, NOT its UTF-16
  // code-unit length: buildBlob emits utf8(gateId), so a non-ASCII gateId
  // (e.g. "gâté") has more bytes than code units and the field offsets
  // desync if we slice by `gateId.length`.
  const idStart = gateIdBytes.length
  if (windowStart < idStart) return null
  if (!bytesEqual(blob.subarray(0, idStart), gateIdBytes)) return null

  let identityId: string
  try {
    identityId = TEXT_DECODER.decode(blob.subarray(idStart, windowStart))
  } catch {
    return null // non-UTF-8 identity region — malformed
  }
  if (!isHexId64(identityId)) return null

  const attestedUntil = bytesToBig(blob.subarray(windowStart, macStart))
  const expected = sha256([
    CRED_DOMAIN,
    gateIdBytes,
    TEXT_ENCODER.encode(identityId),
    blob.subarray(windowStart, macStart),
  ])
  if (!bytesEqual(blob.subarray(macStart), expected)) return null

  return { identityId, attestedUntil }
}

// ---------------------------------------------------------------------------
// D2 + D3 + D5 — the deterministic offline verifier
// ---------------------------------------------------------------------------

/**
 * The deterministic offline `GateVerifier` (D2): a factory taking the
 * ACCEPTED-GATE REGISTRY (must-hold (c) — the caller passes
 * `genesis.gates`; the registry is the single entry point for gates,
 * never auto-valid). The verifier reads ONLY `cred.gateId` outside the
 * blob (AD-4); the blob is interpreted here and nowhere else.
 *
 * `verify` never throws for a rejected credential — rejection is the
 * normal `{ valid: false, identityId: '', attestedUntilWindow: 0 }`
 * result.
 */
export function createOfflineGateVerifier(params: {
  acceptedGates: readonly string[]
}): GateVerifier {
  const accepted = new Set<string>(params.acceptedGates)
  return {
    async verify(cred: GateCredential, windowIndex: number): Promise<GateVerification> {
      // (c) — must-hold: a gate enters ONLY via the accepted registry.
      if (!accepted.has(cred.gateId)) return REJECT
      const parsed = parseBlob(cred.blob, cred.gateId)
      if (parsed === null) return REJECT
      // D5 — chain-time window check (AD-3, never the wall clock): a
      // credential is valid only at or before its attestedUntilWindow.
      // `windowIndex` is a chain-time integer; a non-finite, fractional,
      // or negative value is an invalid window → the normal reject, NOT a
      // throw (the "reject = normal false, not error" convention).
      if (!Number.isInteger(windowIndex) || windowIndex < 0) return REJECT
      if (BigInt(windowIndex) > parsed.attestedUntil) return REJECT
      return {
        valid: true,
        identityId: parsed.identityId,
        attestedUntilWindow: Number(parsed.attestedUntil),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// D4 — the offline gate-standin issuer (harness / sim credential mint)
// ---------------------------------------------------------------------------

/** Input to {@link issueGateCredential}. */
export interface IssueGateCredentialParams {
  /** The gate's registry id (an accepted-gates entry, e.g. "biometric"). */
  gateId: string
  /** The attested identity (exactly 64 hex chars, spine convention). */
  identityId: string
  /** The last chain-time window the credential attests (inclusive, AD-3). */
  attestedUntilWindow: number | bigint
}

/**
 * Mint an offline gate credential (D4 — the offline gate-standin the
 * harness / sim uses to mint valid credentials; AD-4's real gate is
 * external, the core owns the offline verifier + the credential shape).
 *
 * PURE and DETERMINISTIC: the same input always yields the same
 * `GateCredential` — no RNG, no clock, no I/O.
 *
 * @throws {GateError} `SC-IDENTITY-1` on a non-hex-64 `identityId`, a
 *   non-integer / out-of-u64-range `attestedUntilWindow`, or an empty
 *   `gateId` (programming errors — a minted credential is always
 *   well-formed, so the verifier's reject path is exercised only by
 *   tampering, not by the issuer).
 */
export function issueGateCredential(params: IssueGateCredentialParams): GateCredential {
  const { gateId, identityId } = params
  if (typeof gateId !== 'string' || gateId.length === 0) {
    throw new GateError('SC-IDENTITY-1: gateId must be a non-empty string')
  }
  if (!isHexId64(identityId)) {
    throw new GateError(
      `SC-IDENTITY-1: identityId must be exactly 64 hex chars (got ${identityId.length})`,
    )
  }
  const windowBig = coerceWindow(params.attestedUntilWindow)
  return { gateId, blob: buildBlob(gateId, identityId, windowBig) }
}
