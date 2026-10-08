/**
 * `core/consensus` — the acceptance cap (4.4, R1: the enforceable form of
 * the registration design's "one valid ticket per identity per chain-window").
 *
 * The cap is a PURE pre-draw filter on a window's RAW accepted set: when
 * the set carries more than one ticket for the same `identityId`, the extra
 * tickets are DROPPED — the identity earns no extra eligibility (no extra
 * draw weight) from submitting multiple tickets, and the mining reward never
 * scales with identity count (combined with 3.6's fixed reward, which
 * credits the constant `rewardBaseUnits` to ONE winner, independent of
 * identity count — R1).
 *
 * The cap is a NEW standalone filter (D1/D3): it is applied UPSTREAM of the
 * draw, so the draw (`drawWindow`, epic 3, 3.3) always consumes a capped
 * (one-ticket-per-identity) set. It does NOT change `drawWindow` (epic 3
 * owns the draw — the cap is applied BEFORE it, never re-implemented it —
 * AD-7), does NOT change the 4.3 acceptance seam (`acceptBlockWinner` owns
 * the draw + signature gate — "one VALID ticket" is the cap composed with
 * that path: the survivor must verify the draw + signature), and does NOT
 * validate signatures itself.
 *
 * Determinism (AD-3, D2): keep-FIRST, input-order — when an `identityId`
 * appears multiple times, the first ticket (lowest input index) is kept and
 * the rest dropped. Input order is the accepted-set order (deterministic,
 * no RNG / no wall clock), so the cap is fully reproducible and matches the
 * rule "a second ticket from the same identity in the same window is
 * dropped." A real attack (same identity, different commitments, hoping for
 * multiple draw weights) is exactly the case the cap collapses to one.
 *
 * No `big.js` (AD-5): the cap is a de-dup over `identityId` STRINGS — no
 * math, no float, no float literal. The proto is unchanged (no field added;
 * 4.4 adds no proto).
 */
import type { Ticket as ProtoTicket } from '../proto/index.js'

/**
 * The raw per-window accepted set the cap filters: proto `Ticket`s + their
 * ALIGNED draw weights (the same-order contract `drawWindow` requires:
 * `weights[i]` is `tickets[i]`'s non-negative integer uptime weight).
 */
export interface AcceptedSet {
  /** The window's accepted proto `Ticket`s, in input (acceptance) order. */
  tickets: ReadonlyArray<ProtoTicket>
  /** The aligned draw weights, one per ticket, SAME order as `tickets`. */
  weights: ReadonlyArray<bigint>
}

/**
 * The capped accepted set: the same aligned pair, de-duplicated to at most
 * one ticket per `identityId`.
 */
export interface CappedSet {
  /** The surviving proto `Ticket`s (at most one per identity, input order). */
  tickets: ProtoTicket[]
  /** The aligned weights of the survivors (SAME order as `tickets`). */
  weights: bigint[]
}

/**
 * The acceptance cap (4.4, R1): at most ONE ticket per `identityId` per
 * window.
 *
 * Keeps the FIRST occurrence of each `identityId` (lowest input index) and
 * drops second/subsequent ones, keeping each kept ticket's ALIGNED weight
 * with it (D4: the weight is counted ONCE — a dropped duplicate contributes
 * no draw weight, so an identity's draw odds do not scale with its ticket
 * count in the window; the total draw-weight slots after the cap = the
 * number of DISTINCT identities).
 *
 * A pure function: it returns a NEW aligned set (never mutates the input)
 * and the result's `tickets[i]` / `weights[i]` stay aligned in input order
 * (the contract `drawWindow` requires). An all-distinct accepted set (the
 * epic-3 sim shape, one identity per node) is a NO-OP — same length, same
 * order, byte-identical tickets (D3/ADDITIVE: epic-3's accepted sets are
 * unaffected, so epic-3's `verify-draw` / `sim` / `e2e` suites stay green).
 *
 * The cap does NOT validate signatures (4.3's `acceptBlockWinner` owns the
 * draw + signature gate) and does NOT compute the draw (AD-7: the draw is
 * imported, never re-implemented) — it only de-duplicates the accepted set.
 */
export function applyAcceptanceCap(set: AcceptedSet): CappedSet {
  const tickets: ProtoTicket[] = []
  const weights: bigint[] = []
  const seen = new Set<string>()
  for (let i = 0; i < set.tickets.length; i++) {
    const t = set.tickets[i]
    if (seen.has(t.identityId)) continue // 2nd/subsequent ticket: dropped
    seen.add(t.identityId)
    tickets.push(t)
    weights.push(set.weights[i])
  }
  return { tickets, weights }
}
