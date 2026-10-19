/**
 * peer-score.test.ts — ticket 9.4: the pure reliability score.
 *
 *   EWMA_VECTORS       hand-computed EWMA steps (α pinned, first-sample rule).
 *   HAND_COMPUTED      a full history scores to an exact hand value.
 *   DEFAULTS           empty history = optimistic dial/latency, neutral validity.
 *   WEIGHTS_SUM        named weights are exactly 1.
 *   RANGE              fast-check: every history scores inside [0,1].
 *   MONOTONE           fast-check: raising ONE signal never lowers the score.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import {
  CORROBORATION_CAP,
  LATENCY_CAP_MS,
  SCORE_EWMA_ALPHA,
  STABILITY_WINDOW_SLOTS,
  VALIDITY_NEUTRAL,
  WEIGHT_CORROBORATION,
  WEIGHT_DIAL,
  WEIGHT_LATENCY,
  WEIGHT_STABILITY,
  WEIGHT_VALIDITY,
  emptyPeerHistory,
  ewmaUpdate,
  scorePeer,
} from '../src/index.js'
import type { PeerHistory } from '../src/index.js'

function history(over: Partial<PeerHistory> = {}): PeerHistory {
  return { ...emptyPeerHistory(), ...over }
}

describe('9.4 — ewmaUpdate', () => {
  it('EWMA_VECTORS: first sample wins; α-pinned steps, hand-computed', () => {
    expect(ewmaUpdate(undefined, 1)).toBe(1) // optimistic first success
    expect(ewmaUpdate(1, 0)).toBeCloseTo(0.7, 12) // 0.3·0 + 0.7·1
    expect(ewmaUpdate(ewmaUpdate(undefined, 1), 0)).toBeCloseTo(0.7, 12)
    expect(ewmaUpdate(0.7, 0)).toBeCloseTo(0.49, 12) // second failure
    expect(ewmaUpdate(0, 1)).toBeCloseTo(0.3, 12) // recovery starts fast
    expect(SCORE_EWMA_ALPHA).toBe(0.3)
  })
})

describe('9.4 — scorePeer', () => {
  it('WEIGHTS_SUM: the named weights sum to exactly 1', () => {
    expect(WEIGHT_DIAL + WEIGHT_VALIDITY + WEIGHT_STABILITY + WEIGHT_LATENCY + WEIGHT_CORROBORATION).toBeCloseTo(1, 12)
  })

  it('DEFAULTS: empty history is optimistic on contact, neutral on validity', () => {
    // 0.35·1 (no dial yet) + 0.25·0.5 (no data) + 0 + 0.1·1 (no latency) + 0
    expect(scorePeer(emptyPeerHistory())).toBeCloseTo(0.35 + 0.125 + 0.1, 12)
    expect(VALIDITY_NEUTRAL).toBe(0.5)
  })

  it('HAND_COMPUTED: a full history scores to its exact hand value', () => {
    const s = scorePeer(
      history({
        dialEwma: 1,
        latencyEwmaMs: 2500, // exactly half the cap → latency sub 0.5
        seenSlots: Array.from({ length: 12 }, (_, k) => BigInt(k)), // 12/24 = 0.5
        sourcedValid: 3,
        sourcedTotal: 4, // 0.75
        corroborations: 2, // 2/4 = 0.5
      }),
    )
    // 0.35·1 + 0.25·0.75 + 0.2·0.5 + 0.1·0.5 + 0.1·0.5
    expect(s).toBeCloseTo(0.35 + 0.1875 + 0.1 + 0.05 + 0.05, 12)
    // Caps clamp: latency at/above the cap scores 0 on that signal…
    expect(scorePeer(history({ latencyEwmaMs: LATENCY_CAP_MS }))).toBeLessThan(
      scorePeer(history({ latencyEwmaMs: 0 })),
    )
    // …and stability/corroboration saturate at their windows.
    const saturated = history({
      seenSlots: Array.from({ length: STABILITY_WINDOW_SLOTS }, (_, k) => BigInt(k)),
      corroborations: CORROBORATION_CAP,
    })
    expect(scorePeer(saturated)).toBeCloseTo(
      scorePeer(
        history({
          seenSlots: Array.from({ length: STABILITY_WINDOW_SLOTS * 2 }, (_, k) => BigInt(k)),
          corroborations: 1_000_000,
        }),
      ),
      12,
    )
  })

  // Shared history arbitrary — every field inside its legal domain.
  const validityArb = fc
    .record({ valid: fc.integer({ min: 0, max: 50 }), total: fc.integer({ min: 0, max: 50 }) })
    .map(({ valid, total }) => ({ valid: Math.min(valid, total), total }))
  const historyArb = (over: Partial<PeerHistory> = {}) =>
    fc.tuple(
      fc.oneof(fc.constant(undefined), fc.double({ min: 0, max: 1, noNaN: true })),
      fc.oneof(fc.constant(undefined), fc.double({ min: 0, max: 20_000, noNaN: true })),
      fc.integer({ min: 0, max: 40 }),
      validityArb,
      fc.integer({ min: 0, max: 12 }),
    ).map(([dialEwma, latencyEwmaMs, seenCount, v, corroborations]) => ({
      dialEwma: over.dialEwma ?? dialEwma,
      latencyEwmaMs: over.latencyEwmaMs ?? latencyEwmaMs,
      seenSlots: Array.from({ length: seenCount }, (_, k) => BigInt(k)),
      sourcedValid: over.sourcedTotal !== undefined ? over.sourcedValid ?? 0 : v.valid,
      sourcedTotal: over.sourcedTotal !== undefined ? over.sourcedTotal : v.total,
      corroborations: over.corroborations ?? corroborations,
    }))

  it('RANGE (property): every legal history scores inside [0,1]', () => {
    fc.assert(
      fc.property(historyArb(), (h) => {
        const s = scorePeer(history(h))
        return s >= 0 && s <= 1
      }),
      { numRuns: 400 },
    )
  })

  it('MONOTONE (property): raising ONE signal never lowers the score', () => {
    fc.assert(
      fc.property(historyArb(), fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 20 }), (h, bump, extra) => {
        const base = history(h)
        const lo = scorePeer(base)
        // dial EWMA up (an absent EWMA already scores as the optimistic 1)
        if (scorePeer(history({ ...base, dialEwma: Math.min(1, (base.dialEwma ?? 1) + bump) })) < lo - 1e-12) return false
        // latency down (latency signal = 1 − ms/cap, so LOWER is better)
        if (scorePeer(history({ ...base, latencyEwmaMs: Math.max(0, (base.latencyEwmaMs ?? 0) - bump * LATENCY_CAP_MS) })) < lo - 1e-12) return false
        // more seen slots
        const more = history({ ...base, seenSlots: [...base.seenSlots, ...Array.from({ length: extra }, (_, k) => BigInt(1000 + k))] })
        if (scorePeer(more) < lo - 1e-12) return false
        // more valid data at the same total (valid ≤ total preserved)
        const upValid = history({ ...base, sourcedValid: Math.min(base.sourcedTotal, base.sourcedValid + extra), sourcedTotal: base.sourcedTotal })
        if (scorePeer(upValid) < lo - 1e-12) return false
        // more corroboration
        if (scorePeer(history({ ...base, corroborations: base.corroborations + extra })) < lo - 1e-12) return false
        return true
      }),
      { numRuns: 400 },
    )
  })
})
