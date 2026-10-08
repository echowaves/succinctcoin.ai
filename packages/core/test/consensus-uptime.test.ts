/**
 * CONSENSUS UPTIME — the uptime-weight derivation matrix (4.5, R2: "uptime
 * = valid tickets over a lookback of L windows, ramping from zero").
 *
 * `computeUptimeWeight` (src/consensus/uptime.ts) is a PURE derivation of an
 * identity's draw weight from its ticket history: the COUNT of distinct
 * valid windows in `[currentWindow − L, currentWindow − 1]` (the `L` windows
 * strictly before the current one), as a `bigint` in `[0, L]` — the exact
 * form `drawWindow`'s `weights` input takes (AD-7). This file covers the
 * plan's five I/O-matrix rows, importing from the ROOT barrel only:
 *
 *   UPTIME_VALID_IN_LOOKBACK      an identity valid in ALL `L` prior windows
 *                                 (`[0,1,2,3,4]`, `currentWindow = 5`,
 *                                 `L = 5`) → weight `5n` (= `L`, the max —
 *                                 a fully-up identity gets the maximum
 *                                 weight).
 *   UPTIME_RAMP_FROM_ZERO         a NEW identity ramps from zero:
 *                                 `currentWindow = 0` (no prior windows) →
 *                                 `0n`; `currentWindow = 1` with
 *                                 `validWindows = [0]` → `1n`;
 *                                 `currentWindow = 2` with `validWindows =
 *                                 [0,1]` → `2n` (no inflation from claiming
 *                                 a long lookback — it grows as the identity
 *                                 earns valid tickets).
 *   UPTIME_DOWNTIME_REDUCES       an identity valid in `[0,1,2]` with a GAP
 *                                 (no ticket at 3 or 4), `currentWindow =
 *                                 5`, `L = 5` → weight `3n` (< `L`) —
 *                                 downtime within the lookback REDUCES the
 *                                 weight below the full-uptime max.
 *   UPTIME_LOOKBACK_FORGETS_OLD   an identity valid at `[0,1, 50,51]`
 *                                 (old + recent), `currentWindow = 53`,
 *                                 `L = 5` → only the last `L` windows
 *                                 (`[48,52]`) count: weight = `{50,51}` =
 *                                 `2n`; the OLD tickets at `[0,1]` are
 *                                 EXCLUDED (the lookback is a MOVING window
 *                                 that forgets older history).
 *   UPTIME_WEIGHT_IS_DRAW_INPUT   two identities at `currentWindow = 5`,
 *                                 `L = 5`: A valid in `[0,1,2,3,4]` (→
 *                                 weight `5n`), B valid in `[2,4]` (→ weight
 *                                 `2n`); the COMPUTED weights + conformed
 *                                 tickets are fed to the IMPORTED
 *                                 `drawWindow` (AD-7, never re-implemented)
 *                                 → each computed weight is a non-negative
 *                                 integer (bigint) in `[0, L]`; the
 *                                 higher-uptime identity has the strictly
 *                                 higher weight (`5n > 2n` — win odds track
 *                                 uptime); the weights passed to
 *                                 `drawWindow` are EXACTLY the derived
 *                                 uptime weights; no float (AD-5) — the
 *                                 weight is the integer count, not
 *                                 `validCount / L`.
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock anywhere — a fixed
 * `L = 5n`, fixed per-identity 32-byte `nonceCommitment`s (pinned `sha256`
 * of public data), and a fixed window challenge (a pinned `sha256` of public
 * data) make every outcome fully deterministic (reproducible across
 * runs/engines). AD-7 discipline: `drawWindow` (and `DrawError`) are
 * IMPORTED from the ROOT barrel — the `c^W` formula is NEVER re-implemented
 * in this file, and `computeUptimeWeight` only COUNTS valid windows, it
 * does not select a winner. AD-5 discipline: the weights under test are
 * `bigint` counts — no `number` division anywhere in this fixture.
 *
 * Test hygiene (AD-10): no store, no sockets, no new runtime deps — the
 * derivation is pure over the passed window indices, so the outcomes are
 * fully deterministic.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DrawError,
  computeUptimeWeight,
  deriveWindowChallenge,
  drawWindow,
} from '../src/index.js'
import type { DrawTicket } from '../src/index.js'

// ---------------------------------------------------------------------------
// fixed deterministic fixture (AD-3: no RNG, no wall clock)
// ---------------------------------------------------------------------------

/** The crisp test lookback (the plan's fixture value; genesis carries 50). */
const L = 5n

/** 64-hex identity ids (spine convention), distinct per identity. */
const ID_A = '0'.repeat(62) + 'aa'
const ID_B = '0'.repeat(62) + 'bb'

/** Domain-separation prefix of the per-identity commitment (AD-12 style). */
const COMMIT_DOMAIN = new TextEncoder().encode('SC-UPTIME-COMMIT/1')

/** A FIXED 32-byte parent hash with pinned (non-zero) bytes (any fixed bytes). */
const PARENT_HASH: Uint8Array<ArrayBuffer> = (() => {
  const p = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) p[i] = (i * 7 + 3) & 0xff
  return p
})()

/** The FIXED window the whole matrix runs under (a chain-time slot). */
const SLOT = 5n

/**
 * The window challenge `deriveWindowChallenge(parentHash, slot)` (AD-12 —
 * IMPORTED, never re-derived): a pinned 32-byte sha256 of public data.
 */
const CHALLENGE: Uint8Array<ArrayBuffer> = (() => {
  const c = new Uint8Array(deriveWindowChallenge(PARENT_HASH, SLOT))
  return c as Uint8Array<ArrayBuffer>
})()

/**
 * The per-identity 32-byte `nonceCommitment` (the sim's `syntheticTicket`
 * pattern): `sha256("SC-UPTIME-COMMIT/1" ‖ utf8(identityId) ‖ u64be(SLOT)
 * ‖ PARENT_HASH)` — 32 bytes, a PINNED sha256 of public data (no RNG / wall
 * clock), distinct per identity.
 */
function commitmentFor(identityId: string): Uint8Array<ArrayBuffer> {
  const idBytes = new TextEncoder().encode(identityId)
  const slotPart = new Uint8Array(8)
  new DataView(slotPart.buffer).setBigUint64(0, SLOT, false) // u64be, AD-12
  const digest = createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(idBytes)
    .update(slotPart)
    .update(PARENT_HASH)
    .digest()
  // Copy into a fresh 32-byte buffer (the draw consumes any Uint8Array).
  const out = new Uint8Array(32)
  out.set(digest)
  return out as Uint8Array<ArrayBuffer>
}

/** Identity A's conformed draw ticket (AD-7 input: the two draw fields only). */
const TICKET_A: DrawTicket = { identityId: ID_A, nonceCommitment: commitmentFor(ID_A) }
/** Identity B's conformed draw ticket. */
const TICKET_B: DrawTicket = { identityId: ID_B, nonceCommitment: commitmentFor(ID_B) }

// ---------------------------------------------------------------------------
// matrix rows
// ---------------------------------------------------------------------------

describe('uptime-weight derivation (4.5, R2)', () => {
  it('UPTIME_VALID_IN_LOOKBACK: an identity valid in ALL L prior windows ([0,1,2,3,4], currentWindow = 5, L = 5) → weight = the count of valid tickets in the last L windows = 5n (= L, full uptime — a fully-up identity gets the maximum weight)', () => {
    const w = computeUptimeWeight([0n, 1n, 2n, 3n, 4n], 5n, L)
    expect(w).toBe(5n)
    // The weight is a bigint in [0, L] — the full-uptime max.
    expect(typeof w).toBe('bigint')
    expect(w <= L && w >= 0n).toBe(true)
  })

  it('UPTIME_RAMP_FROM_ZERO: a NEW identity ramps from zero — currentWindow = 0 (no prior windows) → 0n; currentWindow = 1 with validWindows = [0] → 1n; currentWindow = 2 with validWindows = [0,1] → 2n (no inflation from claiming a long lookback — it grows as it earns valid tickets)', () => {
    // A fresh identity at window 0: NO prior valid windows → weight 0.
    // (A brand-new identity cannot claim a lookback it has not earned.)
    expect(computeUptimeWeight([], 0n, L)).toBe(0n)
    // After ONE valid window (window 0), at window 1 the weight is 1.
    expect(computeUptimeWeight([0n], 1n, L)).toBe(1n)
    // After TWO valid windows ([0,1]), at window 2 the weight is 2 — the
    // ramp 0 → 1 → 2 continues until it reaches L.
    expect(computeUptimeWeight([0n, 1n], 2n, L)).toBe(2n)
    // Even with a "long lookback" claimed by history, a fresh identity at
    // window 0 has nothing prior: weight 0 regardless of L.
    expect(computeUptimeWeight([], 0n, 50n)).toBe(0n)
    // Guard (D7): a negative lookback or window is a programming error (a
    // bad weight would silently fork the draw) → DrawError SC-CONSENSUS-2.
    expect(() => computeUptimeWeight([0n], 5n, -1n)).toThrow(DrawError)
    expect(() => computeUptimeWeight([0n], 5n, -1n)).toThrow('SC-CONSENSUS-2')
    expect(() => computeUptimeWeight([0n], -1n, L)).toThrow(DrawError)
    expect(() => computeUptimeWeight([0n], -1n, L)).toThrow('SC-CONSENSUS-2')
  })

  it('UPTIME_DOWNTIME_REDUCES: an identity valid in [0,1,2] with a GAP (no ticket at 3 or 4), currentWindow = 5, L = 5 → weight = the distinct valid windows in [0,4] = 3n (< L) — downtime within the lookback reduces the weight below the full-uptime max', () => {
    const w = computeUptimeWeight([0n, 1n, 2n], 5n, L)
    expect(w).toBe(3n)
    expect(w < L).toBe(true)
    // Duplicate input indices are counted ONCE (D5 — robust to duplicates):
    // [0,1,2,2] carries the same distinct windows as [0,1,2].
    expect(computeUptimeWeight([0n, 1n, 2n, 2n], 5n, L)).toBe(3n)
  })

  it('UPTIME_LOOKBACK_FORGETS_OLD: an identity valid at [0,1, 50,51] (old + recent), currentWindow = 53, L = 5 → only the last L windows ([48,52]) count: weight = {50,51} = 2n; the OLD tickets at [0,1] are EXCLUDED (the lookback is a MOVING window that forgets older history)', () => {
    const w = computeUptimeWeight([0n, 1n, 50n, 51n], 53n, L)
    expect(w).toBe(2n)
    // The old windows alone (no recent ones) count for NOTHING once the
    // lookback has moved past them.
    expect(computeUptimeWeight([0n, 1n], 53n, L)).toBe(0n)
    // Boundary: a valid ticket at exactly currentWindow − L (window 48) is
    // still IN the lookback; one at currentWindow − L − 1 (window 47) is not.
    expect(computeUptimeWeight([48n], 53n, L)).toBe(1n)
    expect(computeUptimeWeight([47n], 53n, L)).toBe(0n)
  })

  it('UPTIME_WEIGHT_IS_DRAW_INPUT: A valid in [0,1,2,3,4] (→ 5n) and B valid in [2,4] (→ 2n) at currentWindow = 5, L = 5 → feed the COMPUTED weights + conformed tickets to the IMPORTED drawWindow (AD-7) — each computed weight is a non-negative integer (bigint) in [0, L]; the higher-uptime identity has the strictly higher weight (5n > 2n); the weights passed to drawWindow are EXACTLY the derived uptime weights; no float (AD-5) — the weight is the integer count, not validCount / L', () => {
    const wA = computeUptimeWeight([0n, 1n, 2n, 3n, 4n], 5n, L)
    const wB = computeUptimeWeight([2n, 4n], 5n, L)

    // Each computed weight: a non-negative integer (bigint) in [0, L].
    expect(typeof wA).toBe('bigint')
    expect(typeof wB).toBe('bigint')
    expect(wA >= 0n && wA <= L).toBe(true)
    expect(wB >= 0n && wB <= L).toBe(true)
    // The higher-uptime identity has the STRICTLY higher weight — win odds
    // track uptime.
    expect(wA).toBe(5n)
    expect(wB).toBe(2n)
    expect(wA > wB).toBe(true)

    // Feed the EXACTLY derived weights (no re-derivation, no float — the
    // weights array is the integer counts themselves) to the IMPORTED
    // drawWindow (AD-7 — never re-implemented) with the conformed tickets.
    const tickets: DrawTicket[] = [TICKET_A, TICKET_B]
    const weights = [wA, wB]
    const draw = drawWindow(tickets, CHALLENGE, weights)

    // The draw consumes the derived weights verbatim: the winner's reported
    // `uptime` is its derived weight — EXACTLY what was passed (the
    // per-identity draw weight is derived from the ticket history, AD-7).
    expect(draw.uptime === weights[draw.index]).toBe(true)
    expect(draw.winnerIdentityId === tickets[draw.index].identityId).toBe(true)
    // The winner is one of the two identities (the draw selected among them
    // using the uptime-derived weights — which identity wins is the draw's
    // job, not the derivation's).
    expect(draw.winnerIdentityId === ID_A || draw.winnerIdentityId === ID_B).toBe(
      true,
    )
    // Deterministic re-run: the SAME inputs reproduce the SAME winner (AD-3 —
    // the weight is a pure count; the draw is the one pinned draw).
    const drawAgain = drawWindow(tickets, CHALLENGE, weights)
    expect(drawAgain.winnerIdentityId).toBe(draw.winnerIdentityId)
    expect(drawAgain.uptime).toBe(draw.uptime)
  })
})
