/**
 * Peer reliability scoring (Epic 9.4 — R4).
 *
 * A LOCAL-ONLY reliability score in [0,1] per known peer, computed from
 * observed behaviour: dial outcomes, slot-to-slot stability, the validity
 * of data sourced from the peer, independent corroboration, and dial
 * latency. It orders things — crawl order, serve order, eviction order —
 * and NOTHING ELSE.
 *
 * The hard invariant (the ticket): reliability is never trust. Score is
 * NEVER an input to eligibility or validation — `dialEligible`,
 * `validateIntroduction`, and every signature verification read the trust
 * class, not this number. A zero-score block-grade record stays dialable;
 * a max-score hint never becomes dialable. Property rows in the suite pin
 * both directions.
 *
 * Pure: all inputs are plain numbers; no clock, no I/O, no store.
 */

/** Dial-outcome EWMA smoothing factor (pinned; 0 < α ≤ 1). */
export const SCORE_EWMA_ALPHA = 0.3;
/** Distinct-slot stability window: this many recent slots count fully. */
export const STABILITY_WINDOW_SLOTS = 24;
/** Validity sub-score with no sourced data yet (no evidence either way). */
export const VALIDITY_NEUTRAL = 0.5;
/** Independent vouches at (or above) which the corroboration sub is 1. */
export const CORROBORATION_CAP = 4;
/** Dial-latency EWMA cap: at or above this, the latency sub-score is 0. */
export const LATENCY_CAP_MS = 5000;

/** Signal weights — a positive weighted sum, so score is monotone in
 *  every signal. Pinned to sum to exactly 1 (test-enforced). */
export const WEIGHT_DIAL = 0.35;
export const WEIGHT_VALIDITY = 0.25;
export const WEIGHT_STABILITY = 0.2;
export const WEIGHT_LATENCY = 0.1;
export const WEIGHT_CORROBORATION = 0.1;

/** What this module reads: the local, per-peer observed history. */
export interface PeerHistory {
  /** Dial-outcome EWMA (success=1, failure=0); absent = no dial yet. */
  readonly dialEwma?: number;
  /** Dial-latency EWMA in ms; absent = no timing sample yet. */
  readonly latencyEwmaMs?: number;
  /** Distinct recent slots in which this identity held a valid record. */
  readonly seenSlots: readonly bigint[];
  /** Records SOURCED FROM this peer that verified. */
  readonly sourcedValid: number;
  /** Records SOURCED FROM this peer in total. */
  readonly sourcedTotal: number;
  /** Independent vouches (introduction signers + block provenance). */
  readonly corroborations: number;
}

/** One EWMA step: `α·sample + (1−α)·prev`, or `sample` with no prior. */
export function ewmaUpdate(
  prev: number | undefined,
  sample: number,
  alpha: number = SCORE_EWMA_ALPHA,
): number {
  if (prev === undefined) return sample;
  return alpha * sample + (1 - alpha) * prev;
}

/** An empty history: optimistic on contact (no failures yet), neutral on
 *  validity, nothing seen or corroborated. */
export function emptyPeerHistory(): PeerHistory {
  return {
    seenSlots: [],
    sourcedValid: 0,
    sourcedTotal: 0,
    corroborations: 0,
  };
}

/**
 * Combine a history into a reliability score in [0,1]. Every sub-score is
 * in [0,1] and the weights are positive constants summing to 1, so the
 * result is monotone non-decreasing in each signal (property-tested).
 */
export function scorePeer(h: PeerHistory): number {
  // No dial yet ⇒ optimistic start: a peer has not failed anything yet.
  const dial = h.dialEwma ?? 1;
  const stability = Math.min(1, h.seenSlots.length / STABILITY_WINDOW_SLOTS);
  const validity =
    h.sourcedTotal > 0 ? h.sourcedValid / h.sourcedTotal : VALIDITY_NEUTRAL;
  const corroboration = Math.min(1, h.corroborations / CORROBORATION_CAP);
  // No latency sample ⇒ optimistic, consistent with the dial start.
  const latency =
    h.latencyEwmaMs === undefined
      ? 1
      : 1 - Math.min(1, Math.max(0, h.latencyEwmaMs) / LATENCY_CAP_MS);
  return (
    WEIGHT_DIAL * dial +
    WEIGHT_VALIDITY * validity +
    WEIGHT_STABILITY * stability +
    WEIGHT_LATENCY * latency +
    WEIGHT_CORROBORATION * corroboration
  );
}
