/**
 * `core/net/auto-relay` — the zero-config reachability POLICY (auto-relay
 * story; reverses the 10.3 "relay serving is opt-in" decision).
 *
 * The operator-facing goal: no environment variables, no seed lists, works on
 * every node, and an unreachable node still ends up with a globally dialable
 * address (`<relay>/p2p-circuit/p2p/<self>`). Nothing here creates an address
 * out of nothing — the hop is hosted by whichever peers are themselves
 * reachable, so this module's job is to decide, from reachability truth alone:
 *
 * 1. **Serve?** A node whose inbound is PROVEN dead must not advertise a hop
 *    it cannot serve (`'unreachable'` ⇒ no). `'unknown'` serves: the probe has
 *    simply not spoken yet, and refusing to serve while unknown would starve
 *    every fresh boot of relay capacity.
 * 2. **Hold?** Only when direct addressing is PROVEN dead (`'unreachable'`).
 *    That is the ladder rule verbatim — rung 3 starts where rung 1 leaves off:
 *    while `'unknown'` the node still announces its direct addresses (an
 *    optimistic boot that works for every reachable machine), and holding on
 *    evidence-free startup would have every fresh node burn three strangers'
 *    reservations for nothing. The probe answers within seconds of having
 *    peers, and joining requires an invite — so a hidden node has candidates
 *    to probe through the moment it joins, and its circuit address appears as
 *    soon as the probe proves the direct path dead.
 * 3. **Whom to ask?** Only peers we hold a DIRECT connection to. A link that
 *    itself rides a relay, or that we never dialed, proves nothing about their
 *    reachability. Selection is deterministic (sorted peer id) so two nodes
 *    with the same view pick the same relays, and it excludes ourselves.
 *
 * Pure: no libp2p, no env, no clock (AD-3/AD-10). The adapter supplies
 * reachability (`reachability()`), the app glue resolves the mode from env.
 */
import type { Reachability } from './reachability.js'

/** `'auto'` — serve/hold without operator config; `'explicit-only'` — today's
 * shipped behavior (nothing automatic; seeds and `relayRole` only). */
export type AutoRelayMode = 'auto' | 'explicit-only'

/** How many auto-discovered relays to hold at once. Small on purpose: each
 * hold is one stranger's capacity, and one working hop is enough — the rest
 * is redundancy against a relay going away. */
export const MAX_AUTO_RELAYS = 3

/** May this node serve hops to others right now? */
export function autoServeEnabled(mode: AutoRelayMode, reach: Reachability): boolean {
  if (mode !== 'auto') return false
  return reach !== 'unreachable'
}

/** Should this node hold circuits through discovered relays right now? */
export function autoHoldWanted(mode: AutoRelayMode, reach: Reachability): boolean {
  if (mode !== 'auto') return false
  return reach === 'unreachable'
}

/** One relay candidate as the adapter sees it. `direct` = we hold a direct
 * (non-relayed) connection to this peer. */
export interface RelayCandidate {
  peerId: string
  direct: boolean
}

/**
 * Deterministic candidate pick: direct-connected only, self excluded, deduped,
 * sorted by peer id, capped at `max`. No scoring — hop-capability filtering
 * happens where protocols are read (the adapter), and a refused or unusable
 * circuit is handled by the existing bounded hold episode trying the next one.
 */
export function pickRelayCandidates(
  candidates: readonly RelayCandidate[],
  opts: { selfPeerId?: string; max?: number } = {},
): string[] {
  const max = opts.max ?? MAX_AUTO_RELAYS
  const seen = new Set<string>()
  for (const c of candidates) {
    if (!c.direct) continue
    if (opts.selfPeerId !== undefined && c.peerId === opts.selfPeerId) continue
    seen.add(c.peerId)
  }
  return [...seen].sort().slice(0, max)
}
