/**
 * Story 4.6 matrix — re-attestation every K windows + lapse = lose
 * eligibility (R4 / must-hold (d)).
 *
 * The re-attestation seams (src/identity/reattestation.ts) make an identity
 * re-attest every `K` chain-time windows: its ticket is valid only while the
 * current window is at or below the 4.1 `GateVerifier`'s
 * `attestedUntilWindow`; an identity that LAPSes stops producing valid
 * tickets and loses eligibility within `K` windows of its last attestation
 * (a compromised gate's fake IDs die within `K` of the gate being fixed).
 * Re-attestation EXTENDS `attestedUntilWindow`. `K` is the genesis parameter
 * `reattestationK` (chain-time, AD-3 — never the wall clock).
 *
 * This file covers the plan's five I/O-matrix rows, importing from the ROOT
 * barrel only — the draw and the verifier are NEVER re-implemented here:
 *
 *   REATT_ELEGIBLE_THROUGH_DEADLINE — `isEligibleAtWindow` over
 *                                     `attestedUntilWindow = 10n`: the
 *                                     boundary is INCLUSIVE — eligible
 *                                     THROUGH the deadline (`0n → true`,
 *                                     `10n → true`) and LAPSES at `T + 1`
 *                                     (`11n → false`).
 *   REATT_REATTES_TODDLE            — a credential attested to `10n`,
 *                                     `K = 5n`: at `11n` (lapsed) call
 *                                     `reattestationWindow(11n, 5n)` → new
 *                                     deadline `16n`; the identity regains
 *                                     eligibility — `isEligibleAtWindow(16n,
 *                                     11n) = true` (re-attesting at the
 *                                     first lapsed window re-establishes
 *                                     eligibility for the next `K` windows;
 *                                     the new deadline strictly exceeds the
 *                                     old one).
 *   REATT_LAPSED_STOPS              — a credential attested to `10n`,
 *                                     `K = 5n`, NO re-attestation:
 *                                     eligibility at `11n`, `15n`, `20n` is
 *                                     `false` throughout — once lapsed,
 *                                     without re-attestation the identity
 *                                     never regains eligibility (must-hold
 *                                     (d): "a lapsed identity stops
 *                                     producing valid tickets within `K`
 *                                     windows and loses eligibility").
 *   REATT_SEAM_COMPOSES_VERIFIER    — the IMPORTED `verifier.verify(cred, w)`
 *                                     (4.1) for a credential attested to
 *                                     `10n` at `w = 10` (valid) and
 *                                     `w = 11` (lapsed);
 *                                     `verifyReattestation` (the 4.6 seam)
 *                                     at the same windows composes with the
 *                                     verifier (never re-implements it):
 *                                     at `w = 10` → verifier
 *                                     `{ valid: true, attestedUntilWindow:
 *                                     10 }` AND the seam
 *                                     `{ valid: true, attestedUntilWindow:
 *                                     10n }`; at `w = 11` → the verifier
 *                                     REJECTS (the normal `{ valid: false }`)
 *                                     AND the seam → `{ valid: false,
 *                                     attestedUntilWindow: 0n }` (a reject
 *                                     is a normal value, not an error — the
 *                                     4.1 convention); the seam's
 *                                     `attestedUntilWindow` is the `bigint`
 *                                     form of the verifier's number.
 *   REATT_CADENCE_FROM_GENESIS      — `reattestationWindow(1000n, 100n)`
 *                                     (the genesis `reattestationK`) →
 *                                     `1100n`: the cadence uses the genesis
 *                                     `K` (chain-time, AD-3); the new
 *                                     deadline STRICTLY exceeds the previous
 *                                     one (re-attestation extends, never
 *                                     shrinks); re-attesting at the first
 *                                     lapsed window `1001n` →
 *                                     `reattestationWindow(1001n, 100n) =
 *                                     1101n` → `isEligibleAtWindow(1101n,
 *                                     1001n) = true` (continuous
 *                                     eligibility is maintained by
 *                                     re-attesting at/before the lapse —
 *                                     the deadline is a monotonic
 *                                     extension).
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — a fixed 64-hex
 * identity, the accepted `"biometric"` gate, credentials minted by the
 * IMPORTED `issueGateCredential` (4.1), the verifier from the IMPORTED
 * `createOfflineGateVerifier` (4.1), small `K = 5n` + the genesis
 * `reattestationK = 100` (read from the validated `config/genesis.json`) —
 * every outcome is fully deterministic (reproducible across runs).
 * AD-4 discipline: the credential is read ONLY through the 4.1 verifier —
 * this file never parses a blob; the seam composes with `verifier.verify`,
 * never re-implements the check. AD-5 discipline: all window math is over
 * `bigint` chain-time integers — no float, no `big.js`.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  IdentityError,
  createOfflineGateVerifier,
  isEligibleAtWindow,
  issueGateCredential,
  loadGenesis,
  reattestationWindow,
  verifyReattestation,
} from '../src/index.js'
import type { GateVerifier } from '../src/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
// test/ -> core/ -> packages/ -> repo root, then config/genesis.json — the
// single source of the genesis `reattestationK` (D5: `K` is the validated
// genesis integer ≥ 1, not a protocol-logic choice).
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')

// ---------------------------------------------------------------------------
// the shared deterministic fixture (AD-3: no RNG, no wall clock)
// ---------------------------------------------------------------------------

/** The pinned spine-convention identity id: 64 lowercase hex chars. */
const ID = '0'.repeat(62) + 'aa'

/** The small crisp cadence for the boundary rows (the plan's fixture value). */
const K = 5n

/** The credential's deadline for the pure rows (attested to window 10). */
const DEADLINE = 10n

describe('4.6 re-attestation every K windows + lapse (R4 / must-hold (d)) — frozen matrix', () => {
  // The accepted-gate registry + the genesis cadence `K`, straight from the
  // validated genesis config (D2/D5). "biometric" is a real accepted gate.
  const genesis = loadGenesis(GENESIS_PATH)

  it('REATT_ELEGIBLE_THROUGH_DEADLINE: eligible THROUGH the deadline (inclusive), lapses at T + 1', () => {
    // `0n` — a fresh window, well before the deadline → eligible.
    expect(isEligibleAtWindow(DEADLINE, 0n)).toBe(true)
    // In the middle of the valid range → eligible.
    expect(isEligibleAtWindow(DEADLINE, 5n)).toBe(true)
    // AT the deadline (`currentWindow === attestedUntilWindow`) → still
    // eligible — the boundary is INCLUSIVE (the 4.1 verifier's own
    // `windowIndex <= attestedUntilWindow` check, D2).
    expect(isEligibleAtWindow(DEADLINE, 10n)).toBe(true)
    // ONE past the deadline (`T + 1`) → LAPSED: ineligible (must-hold (d):
    // "valid only while the current window ≤ attestedUntilWindow").
    expect(isEligibleAtWindow(DEADLINE, 11n)).toBe(false)
    // Far past → still lapsed (no expiry-of-the-expiry).
    expect(isEligibleAtWindow(DEADLINE, 1000n)).toBe(false)

    // Guards (D6): a negative window / deadline is a programming error →
    // `IdentityError` `SC-IDENTITY-2` (never a silent corruption of the
    // eligibility check).
    expect(() => isEligibleAtWindow(-1n, 0n)).toThrow(IdentityError)
    expect(() => isEligibleAtWindow(DEADLINE, -1n)).toThrow(IdentityError)
    expect(() => isEligibleAtWindow(-1n, 0n)).toThrow(/SC-IDENTITY-2/)
    // A negative deadline can never make a window eligible: the guard throws
    // BEFORE any comparison.
    expect(() => isEligibleAtWindow(-100n, -200n)).toThrow(IdentityError)
  })

  it('REATT_REATTES_TODDLE: re-attesting at the first lapsed window extends the deadline and regains eligibility', async () => {
    const { gates } = await genesis
    const verifier = createOfflineGateVerifier({ acceptedGates: gates })
    // A credential attested to window `10n` (minted by the IMPORTED 4.1
    // issuer — the only credential mint used here).
    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: DEADLINE,
    })

    // At `11n` the identity has LAPSED — the 4.1 verifier rejects (the
    // normal `{ valid: false }`, chain-time, AD-3).
    expect(await verifier.verify(cred, 11)).toEqual({
      valid: false,
      identityId: '',
      attestedUntilWindow: 0,
    })
    expect(isEligibleAtWindow(DEADLINE, 11n)).toBe(false)

    // The identity RE-ATTESTS at the first lapsed window `11n`: the PURE
    // cadence extends the deadline to `11n + K = 16n` (D3 — the new
    // deadline STRICTLY exceeds the old `10n`: re-attestation extends,
    // never shrinks).
    const newDeadline = reattestationWindow(11n, K)
    expect(newDeadline).toBe(16n)
    expect(newDeadline > DEADLINE).toBe(true)

    // The identity REGAINS eligibility at `11n` under the new deadline —
    // eligible for the next `K` windows (`11n` through `16n`).
    expect(isEligibleAtWindow(newDeadline, 11n)).toBe(true)
    expect(isEligibleAtWindow(newDeadline, 16n)).toBe(true)
    expect(isEligibleAtWindow(newDeadline, 17n)).toBe(false)

    // The re-attested credential (a fresh mint attested to `16n`) verifies
    // through the IMPORTED seam: the seam composes with the verifier and
    // surfaces the extended deadline as a `bigint`.
    const reattested = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: newDeadline,
    })
    expect(await verifyReattestation(verifier, reattested, 11)).toEqual({
      valid: true,
      attestedUntilWindow: 16n,
    })
  })

  it('REATT_LAPSED_STOPS: without re-attestation a lapsed identity stays ineligible (loses eligibility)', async () => {
    const { gates } = await genesis
    const verifier = createOfflineGateVerifier({ acceptedGates: gates })
    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: DEADLINE,
    })

    // Last eligible window: AT the deadline → valid (the verifier AND the
    // pure gate agree, both inclusive through the deadline).
    expect(await verifier.verify(cred, 10)).toEqual({
      valid: true,
      identityId: ID,
      attestedUntilWindow: 10,
    })
    expect(isEligibleAtWindow(DEADLINE, 10n)).toBe(true)

    // NO re-attestation: the identity stops producing valid tickets within
    // `K` windows — at `11n` (one past), `15n` (`K` windows past), and
    // `20n` (far past) it is INELIGIBLE and STAYS ineligible — once lapsed,
    // without re-attestation the identity never regains eligibility
    // (must-hold (d)). The verifier rejects (a normal value) and the pure
    // gate agrees at every lapsed window.
    for (const w of [11, 15, 20]) {
      expect(await verifier.verify(cred, w), `verifier at ${w}`).toEqual({
        valid: false,
        identityId: '',
        attestedUntilWindow: 0,
      })
      expect(isEligibleAtWindow(DEADLINE, BigInt(w)), `gate at ${w}n`).toBe(false)
      expect(
        await verifyReattestation(verifier, cred, w),
        `seam at ${w}`,
      ).toEqual({ valid: false, attestedUntilWindow: 0n })
    }
  })

  it('REATT_SEAM_COMPOSES_VERIFIER: the seam reads the credential only through the 4.1 verifier (AD-4)', async () => {
    const { gates } = await genesis
    const verifier = createOfflineGateVerifier({ acceptedGates: gates })
    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: DEADLINE,
    })

    // At `w = 10` (valid): the IMPORTED 4.1 verifier accepts with the
    // NUMBER deadline `10`, and the 4.6 seam — which composes with the
    // verifier (never re-implements the check) — reports valid with the
    // BIGINT form of that same deadline.
    const v10 = await verifier.verify(cred, 10)
    expect(v10).toEqual({ valid: true, identityId: ID, attestedUntilWindow: 10 })
    const s10 = await verifyReattestation(verifier, cred, 10)
    expect(s10).toEqual({ valid: true, attestedUntilWindow: 10n })
    // The seam's deadline is the `bigint` form of the verifier's number —
    // exactly, no precision drift (AD-5: `bigint` chain-time, no float).
    expect(typeof s10.attestedUntilWindow).toBe('bigint')
    expect(s10.attestedUntilWindow).toBe(BigInt(v10.attestedUntilWindow))

    // At `w = 11` (lapsed): the verifier REJECTS (the normal
    // `{ valid: false }` — a reject is a normal value, not an error, the
    // 4.1 convention) and the seam propagates that reject as the normal
    // `{ valid: false, attestedUntilWindow: 0n }` — it never throws for a
    // lapsed credential (the 4.1 / `verifyDraw` convention).
    const v11 = await verifier.verify(cred, 11)
    expect(v11.valid).toBe(false)
    const s11 = await verifyReattestation(verifier, cred, 11)
    expect(s11).toEqual({ valid: false, attestedUntilWindow: 0n })

    // A non-accepted gate (must-hold (c)) is rejected the same way: the
    // seam composes with the verifier's registry check, it adds none of
    // its own credential logic (AD-4: no blob parsing, no MAC check, no
    // registry check in 4.6).
    const rogue = issueGateCredential({
      gateId: 'rogue-gate',
      identityId: ID,
      attestedUntilWindow: DEADLINE,
    })
    expect(await verifyReattestation(verifier, rogue, 5)).toEqual({
      valid: false,
      attestedUntilWindow: 0n,
    })

    // A MALFORMED verifier result (a non-conforming `GateVerifier` returning
    // `valid: true` with a non-integer / negative deadline) is an INVALID
    // verifier result → the NORMAL reject, NEVER a throw (frozen AC-4 / D1:
    // "a lapse OR an invalid verifier result → the normal reject"; AD-4
    // anticipates a future real gate adapter, so the seam must not rely on
    // the offline verifier's well-formedness).
    const malformed = (deadline: number): GateVerifier => ({
      verify: async () => ({ valid: true, identityId: ID, attestedUntilWindow: deadline }),
    })
    for (const bad of [NaN, -1, 10.5, Infinity]) {
      expect(
        await verifyReattestation(malformed(bad), { gateId: 'biometric', blob: new Uint8Array(1) }, 10),
        `malformed deadline ${String(bad)}`,
      ).toEqual({ valid: false, attestedUntilWindow: 0n })
    }
    // A malformed WINDOW (negative) with a valid deadline is likewise a
    // normal reject, not a throw.
    expect(
      await verifyReattestation(malformed(10), { gateId: 'biometric', blob: new Uint8Array(1) }, -1),
      'malformed window',
    ).toEqual({ valid: false, attestedUntilWindow: 0n })
  })

  it('REATT_CADENCE_FROM_GENESIS: the cadence uses the genesis reattestationK (chain-time, AD-3)', async () => {
    // The genesis `K` — the validated integer ≥ 1 from `config/genesis.json`
    // (D5: `K` is a genesis parameter, not protocol logic). The plan pins
    // it at `100`; assert that so a drift in the config is loud.
    const { reattestationK } = await genesis
    expect(reattestationK).toBe(100)
    const K_GENESIS = BigInt(reattestationK)

    // `reattestationWindow(1000n, 100n)` (the genesis `K`): re-attesting at
    // window `1000n` extends the deadline to `1000n + 100n = 1100n`.
    const newDeadline = reattestationWindow(1000n, K_GENESIS)
    expect(newDeadline).toBe(1100n)
    // The new deadline STRICTLY exceeds the previous `1000n` —
    // re-attestation is a monotonic EXTENSION, never a contraction
    // (NEVER shrink).
    expect(newDeadline > 1000n).toBe(true)

    // Eligibility continuity: a credential attested to `1000n` lapses at
    // `1001n` (the first lapsed window) — but re-attesting AT the first
    // lapsed window re-establishes eligibility continuously: the new
    // deadline `reattestationWindow(1001n, 100n) = 1101n` covers the
    // re-attestation window itself.
    expect(isEligibleAtWindow(1000n, 1001n)).toBe(false) // lapsed
    const continuousDeadline = reattestationWindow(1001n, K_GENESIS)
    expect(continuousDeadline).toBe(1101n)
    expect(isEligibleAtWindow(continuousDeadline, 1001n)).toBe(true)

    // The cadence is PURE and chain-time (AD-3): the same inputs always
    // yield the same deadline — deterministic on every node.
    expect(reattestationWindow(1000n, K_GENESIS)).toBe(
      reattestationWindow(1000n, K_GENESIS),
    )

    // The pure cadence is the raw `W + K` (D3). It EXTENDS the deadline when
    // re-attesting on schedule (at/after the old deadline), but an EARLY
    // re-attest (well before the deadline) can yield `W + K` ≤ the old
    // deadline — a caller that must guarantee a monotonic deadline applies
    // `max(oldDeadline, W + K)` (4.8's sim wiring). Documented here so the
    // contract is explicit: `reattestationWindow(2n, 5n) = 7n < 10n` (old
    // deadline 10n), while on-schedule `reattestationWindow(1000n, 100n) =
    // 1100n > 1000n`.
    expect(reattestationWindow(2n, 5n)).toBe(7n) // early: 7n < 10n (old deadline)
    expect(reattestationWindow(1000n, K_GENESIS)).toBe(1100n) // on schedule: extends

    // Guards (D6): a negative cadence / window is a programming error →
    // `IdentityError` `SC-IDENTITY-2`.
    expect(() => reattestationWindow(1000n, -1n)).toThrow(IdentityError)
    expect(() => reattestationWindow(1000n, -1n)).toThrow(/SC-IDENTITY-2/)
    expect(() => reattestationWindow(-1n, K_GENESIS)).toThrow(IdentityError)
    // `K = 0n` is legal per the guard (the genesis validates ≥ 1) but
    // yields no extension — the cadence is exactly `W + K`.
    expect(reattestationWindow(1000n, 0n)).toBe(1000n)
  })
})
