/**
 * `core/identity` — the re-attestation lifecycle (4.6, R4 / must-hold (d):
 * "re-attestation every K windows; lapse = lose eligibility").
 *
 * An identity's gate credential is valid only up to its
 * `attestedUntilWindow` (the 4.1 `GateVerifier`'s deadline — the credential
 * is read ONLY through `verifier.verify`, AD-4). To keep being eligible, an
 * identity must RE-ATTEST before the deadline: re-attesting at chain-window
 * `W` extends the deadline to `W + K`, where `K` is the genesis parameter
 * `reattestationK` (validated ≥ 1 — a parameter received, not protocol
 * logic). An identity that LAPSes (`currentWindow > attestedUntilWindow`) is
 * INELIGIBLE: it stops producing valid tickets and loses eligibility within
 * `K` windows of its last attestation — a compromised gate's fake IDs die
 * within `K` of the gate being fixed (must-hold (d)).
 *
 * This module is the PURE re-attestation seam (D1) — two pure functions +
 * one composing seam:
 *
 *   `isEligibleAtWindow(attestedUntilWindow, currentWindow)` — the PURE
 *   lapse gate (D2): `true` iff `0n ≤ currentWindow ≤ attestedUntilWindow`.
 *   The boundary is INCLUSIVE: a credential attested to window `T` is valid
 *   THROUGH `T` (the 4.1 verifier's own `windowIndex <= attestedUntilWindow`
 *   check) and LAPSES at `T + 1`.
 *
 *   `reattestationWindow(currentWindow, reattestationK)` — the PURE cadence
 *   (D3): re-attesting at chain-window `W` sets the new deadline to `W + K`.
 *   Re-attesting ON SCHEDULE (at the current deadline `D` or just after)
 *   EXTENDS the deadline to `D + K`; re-attesting EARLY (well before `D`)
 *   yields `W + K` that can be ≤ `D`, so a caller that wants a
 *   guaranteed-monotonic deadline applies `max(oldDeadline, W + K)`. The pure
 *   function returns the raw `W + K`.
 *
 *   `verifyReattestation(verifier, cred, windowIndex)` — the seam that
 *   COMPOSES with the 4.1 verifier (D4, the 4.3 `acceptBlockWinner`
 *   pattern): it runs `verifier.verify` (the ONLY credential reader, AD-4)
 *   and adds no blob parsing, MAC check, or registry check — those all stay
 *   in `gate-verifier.ts`. A lapsed / invalid credential is the NORMAL
 *   `{ valid: false, attestedUntilWindow: 0n }` (the 4.1 / `verifyDraw`
 *   reject convention) — never an error.
 *
 * It does NOT change the `GateVerifier` (4.1), the keypair (4.2), the
 * acceptance seam (4.3), the cap (4.4), the uptime derivation (4.5), the
 * draw (3.3, AD-7), the sim (4.8 wires the cadence + lapse gate into the
 * sim's per-window eligibility), or the proto (no field added).
 *
 * Chain-time only (AD-3): every input is a chain-time window index or
 * cadence — `bigint` integers, no RNG, no wall clock, no `Math.random`.
 * No float, no `big.js` (AD-5): all window math is over `bigint`; this
 * module imports no `big.js` (only `./identity.js` for the error class and
 * the port types from `../ports.js`).
 *
 * Guards (D6): `reattestationK < 0n`, `attestedUntilWindow < 0n`, or
 * `currentWindow < 0n` is a PROGRAMMING ERROR (a negative window / cadence
 * would silently corrupt the eligibility check) → throw `IdentityError`
 * `SC-IDENTITY-2` (the identity-domain error, imported from `./identity.js`
 * — the class is imported, never re-implemented). `verifyReattestation`
 * itself never throws for a lapsed / invalid credential: it propagates the
 * verifier's normal reject as `{ valid: false, attestedUntilWindow: 0n }`.
 */
import { IdentityError } from './identity.js'
import type { GateCredential, GateVerifier } from '../ports.js'

/**
 * The result of the re-attestation seam (D1/D4): the verifier's verdict +
 * the deadline surfaced as a `bigint` chain-time window.
 */
export interface ReattestationResult {
  /** `true` only while the credential is valid AND un-lapsed at the window. */
  valid: boolean
  /**
   * The credential's deadline as a `bigint` (the `bigint` form of the
   * verifier's `number` `attestedUntilWindow`); `0n` on a reject.
   */
  attestedUntilWindow: bigint
}

// ---------------------------------------------------------------------------
// D1/D2 — the pure lapse gate (chain-time, AD-3)
// ---------------------------------------------------------------------------

/**
 * The PURE lapse gate (D2): `true` iff the identity's credential is still
 * valid at `currentWindow`, i.e. `0n ≤ currentWindow ≤ attestedUntilWindow`.
 *
 * The boundary is INCLUSIVE: a credential attested to window `T` is valid
 * THROUGH `T` (the 4.1 verifier's own `windowIndex <= attestedUntilWindow`
 * check) and LAPSES at `T + 1`. A lapsed identity (`currentWindow >
 * attestedUntilWindow`) → `false` — it loses eligibility (must-hold (d):
 * "valid only while the current window ≤ attestedUntilWindow").
 *
 * Pure and chain-time (AD-3): two `bigint` window indices, no RNG, no wall
 * clock — the same inputs always yield the same verdict, on every node.
 *
 * @param attestedUntilWindow — the credential's deadline (the 4.1
 *   verifier's `attestedUntilWindow`), a chain-time window index.
 * @param currentWindow — the chain-time window to check eligibility at.
 *
 * @returns `true` iff `0n ≤ currentWindow ≤ attestedUntilWindow`.
 *
 * @throws {IdentityError} `SC-IDENTITY-2` if `attestedUntilWindow < 0n` or
 *   `currentWindow < 0n` (a programming error — a negative window would
 *   silently corrupt the eligibility check).
 */
export function isEligibleAtWindow(
  attestedUntilWindow: bigint,
  currentWindow: bigint,
): boolean {
  if (attestedUntilWindow < 0n) {
    throw new IdentityError(
      `SC-IDENTITY-2: attestedUntilWindow ${attestedUntilWindow} is negative`,
    )
  }
  if (currentWindow < 0n) {
    throw new IdentityError(
      `SC-IDENTITY-2: currentWindow ${currentWindow} is negative`,
    )
  }
  // Inclusive through the deadline (D2): valid at `T`, lapsed at `T + 1`.
  return currentWindow <= attestedUntilWindow
}

// ---------------------------------------------------------------------------
// D1/D3 — the pure cadence (chain-time, AD-3)
// ---------------------------------------------------------------------------

/**
 * The PURE cadence (D3): re-attesting at chain-window `currentWindow`
 * extends the deadline to `currentWindow + reattestationK`. The identity is
 * then eligible for the next `K` windows (chain-time — AD-3, never a wall
 * clock or a timer). Re-attestation is a monotonic EXTENSION: re-attesting
 * on time (at or before the deadline) always yields a new deadline strictly
 * beyond the old one — it never shrinks the deadline.
 *
 * `reattestationK` is the genesis parameter `reattestationK` (validated ≥ 1
 * by the genesis seam, 1.6) — a parameter the function RECEIVES, not
 * protocol-logic.
 *
 * The deadline EXTENDS (never shrinks) when the identity re-attests **on
 * schedule** (at or after its current deadline `D`, so `W + K > D`). An
 * identity that re-attests **early** (well before `D`) gets `W + K` that can
 * be ≤ `D`; a caller that must guarantee a monotonic deadline applies
 * `max(oldDeadline, W + K)` (4.8's sim wiring). This pure function returns
 * the raw `W + K` (D3 — the frozen cadence formula).
 *
 * Pure: two `bigint` chain-time integers → one `bigint`, no RNG, no wall
 * clock — deterministic on every node.
 *
 * @param currentWindow — the chain-time window at which the identity
 *   re-attests.
 * @param reattestationK — the cadence `K` in windows (genesis
 *   `reattestationK`, an integer ≥ 1).
 *
 * @returns the new deadline: `currentWindow + reattestationK`.
 *
 * @throws {IdentityError} `SC-IDENTITY-2` if `reattestationK < 0n` or
 *   `currentWindow < 0n` (a programming error — a negative cadence / window
 *   would silently corrupt the eligibility check).
 */
export function reattestationWindow(
  currentWindow: bigint,
  reattestationK: bigint,
): bigint {
  if (reattestationK < 0n) {
    throw new IdentityError(
      `SC-IDENTITY-2: reattestationK ${reattestationK} is negative`,
    )
  }
  if (currentWindow < 0n) {
    throw new IdentityError(
      `SC-IDENTITY-2: currentWindow ${currentWindow} is negative`,
    )
  }
  return currentWindow + reattestationK
}

// ---------------------------------------------------------------------------
// D1/D4 — the seam that composes with the 4.1 verifier
// ---------------------------------------------------------------------------

/** The canonical reject (D4: a normal value, not an error — 4.1 / verifyDraw). */
const REJECT: ReattestationResult = {
  valid: false,
  attestedUntilWindow: 0n,
}

/**
 * The re-attestation seam (D1/D4): the SINGLE place this story reads a
 * credential — and it does so ONLY through `verifier.verify` (the 4.1
 * `GateVerifier` implementation — the ONLY credential reader, AD-4). No
 * blob parsing, no MAC check, no registry check (those all stay in
 * `gate-verifier.ts`, 4.1).
 *
 *   - a LAPSED (rejected) credential, OR a valid result carrying a
 *     MALFORMED deadline / window (NaN / non-integer / negative — a
 *     non-conforming `GateVerifier`) → the NORMAL
 *     `{ valid: false, attestedUntilWindow: 0n }` — never an error (D1/AC-4:
 *     "a lapse OR an invalid verifier result → the normal reject"; a reject
 *     is a normal value, and `verifyReattestation` never throws for
 *     credential data);
 *   - a VALID verifier result → `{ valid: isEligibleAtWindow(
 *     BigInt(result.attestedUntilWindow), BigInt(windowIndex)),
 *     attestedUntilWindow: BigInt(result.attestedUntilWindow) }` — the pure
 *     lapse gate (D2) applied to the verifier's deadline, surfaced as a
 *     `bigint` chain-time window.
 *
 * Composes, never re-implements (D4 — the 4.3 `acceptBlockWinner` pattern):
 * the 4.1 verifier already enforces `windowIndex <= attestedUntilWindow`
 * (chain-time, AD-3) and the accepted-gate registry (must-hold (c)); this
 * seam adds the pure lapse-gate check on the deadline it reads back.
 *
 * @param verifier — the 4.1 `GateVerifier` (the only credential reader).
 * @param cred — the identity's gate credential (opaque outside the verifier).
 * @param windowIndex — the chain-time window to check at (AD-3).
 *
 * @returns the seam result: the verifier's verdict with the deadline as a
 *   `bigint` (`0n` on a reject).
 */
export async function verifyReattestation(
  verifier: GateVerifier,
  cred: GateCredential,
  windowIndex: number,
): Promise<ReattestationResult> {
  // The ONLY credential read (AD-4) — through the 4.1 verifier, which
  // never throws for a rejected credential (a reject is a normal value).
  const result = await verifier.verify(cred, windowIndex)
  if (!result.valid) {
    // Lapsed (or invalid) — the NORMAL reject (D4), never an error.
    return REJECT
  }
  // A valid result: its deadline + the window must be FINITE NON-NEGATIVE
  // INTEGERS (chain-time, AD-3). A non-conforming `GateVerifier` that
  // returns `valid: true` with a malformed deadline / window (NaN /
  // non-integer / negative) is an INVALID verifier result → the NORMAL
  // reject (D1/AC-4: "a lapse OR an invalid verifier result → the normal
  // reject", never an error) — `verifyReattestation` never throws for
  // credential data. (The shipped 4.1 verifier only returns `valid: true`
  // with a finite non-negative integer, so this only bites a future real
  // gate adapter — AD-4 anticipates one.)
  if (
    !Number.isInteger(result.attestedUntilWindow) ||
    result.attestedUntilWindow < 0 ||
    !Number.isInteger(windowIndex) ||
    windowIndex < 0
  ) {
    return REJECT
  }
  // A valid result: re-assert the pure lapse gate (D2) on the verifier's
  // deadline and surface it as a `bigint` chain-time window.
  const deadline = BigInt(result.attestedUntilWindow)
  return {
    valid: isEligibleAtWindow(deadline, BigInt(windowIndex)),
    attestedUntilWindow: deadline,
  }
}
