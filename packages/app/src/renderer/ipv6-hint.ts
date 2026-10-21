/**
 * `app/renderer/ipv6-hint` — the one-sentence "why no invite yet?" (post-9.5
 * user report). PURE and React-free (the 6.3 rule: headless-testable module,
 * thin components); renders the bridge's diagnostics counts into plain
 * English. No timers, no core imports — the shape below is a structural
 * MIRROR of `main/invite-diagnostics.ts`'s `InviteDiagnostics`, exactly like
 * the mirrored `InviteRejectReason` above (thin-client rule AD-1).
 */

/** Mirror of the bridge's diagnostics payload (counts only, AD-11). */
export interface InviteDiagnostics {
  hasGlobal: boolean
  globalCount: number
  linkLocalCount: number
  uniqueLocalCount: number
  loopbackCount: number
  otherCount: number
}

/**
 * The honest sentence for the "no invite yet" state, most-hopeful first:
 * a global address means WAIT (announce re-reads interfaces every window —
 * no restart needed); an overlay `fd00::` gets its own row because VPN
 * IPv6 is the classic false hope (reachable by friends? no.); link-local
 * only is the plain "your network has no IPv6" case. Since 11.3 the three
 * no-global rows also name the honest SECOND path: a relay hop (global
 * IPv6 is no longer the only way to reach the network — an invite can run
 * `/ip4/…` or `/ip6/…` through `/p2p-circuit`).
 */
export function describeIpv6(d: InviteDiagnostics): string {
  if (d.hasGlobal)
    return 'Global IPv6 detected — your invite appears at the next announce window (no restart needed).'
  if (d.uniqueLocalCount > 0)
    return 'Only private/overlay IPv6 found (e.g. a VPN mesh fd00:: address) — friends on the internet cannot reach it, so it is never announced. Enable real IPv6 (2xxx:) on your router/ISP, or reach the network through a relay hop — pin a dual-stack relay in SUCCINCTCOIN_RELAY_SEEDS; your invite then runs /ip4/… or /ip6/… through /p2p-circuit.'
  if (d.linkLocalCount > 0)
    return 'Only link-local (fe80::) addresses found — this machine has no global IPv6. Check the router/ISP IPv6 setting; a VPN/Tailscale IPv6 does not count. Or reach the network through a relay hop — pin a dual-stack relay in SUCCINCTCOIN_RELAY_SEEDS; your invite then runs /ip4/… or /ip6/… through /p2p-circuit.'
  if (d.otherCount > 0)
    return 'IPv6 addresses present but none usable (no global, link-local, or private class) — an unusual setup; check this machine\'s IPv6 configuration.'
  return 'No active IPv6 interfaces on this machine — enable IPv6 first, or reach the network through a relay hop: pin a dual-stack relay in SUCCINCTCOIN_RELAY_SEEDS and your invite runs /ip4/… or /ip6/… through /p2p-circuit.'
}

/**
 * The honest warning for the OPPOSITE state: an invite EXISTS while the
 * machine has NO global IPv6 right now. Two truths reach this state: a
 * dev-mode invite minted under `SUCCINCTCOIN_ALLOW_LOOPBACK=1` (its address
 * is `::1` — real, but it dials the FRIEND's own machine), or an invite
 * minted earlier while a global address existed that has since dropped —
 * stale either way. The warning must cover BOTH readings honestly; shown
 * beside the invite textarea whenever the paired diagnostics say so (pure
 * fn; the panel already fetches both in one snapshot).
 */
export function describeLoopbackInvite(d: InviteDiagnostics): string | null {
  if (d.hasGlobal) return null
  return (
    'Friends cannot reach this invite right now: this machine has no global IPv6. '
    + 'A dev-mode invite (SUCCINCTCOIN_ALLOW_LOOPBACK) works only on this machine, '
    + 'and an older invite may simply be stale — regenerate once a global address is back.'
  )
}

/** Same text-stage cap the core's parser applies (never decode megabytes). */
const MAX_INVITE_TEXT_LEN = 4096

/**
 * Ticket 7 — does this invite RIDE A RELAY? An address carrying
 * `/p2p-circuit` is a circuit: the node behind it is reached THROUGH a
 * relay, not directly (the auto-relay tier's visible signature). Honest and
 * distinct from the loopback warning above — nothing is wrong here, the
 * connection just costs an extra hop.
 *
 * Thin-client rule (AD-1): NO core import — the invite body is base64url of
 * a protobuf whose addresses are plain UTF-8 strings, so a decoded-bytes
 * substring scan answers the question without the codec. Anything that fails
 * to decode is simply "not recognizable" ⇒ null (the real parser in main
 * gives the verdict on join). Pure, sync, never throws.
 */
export function describeCircuitInvite(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('scinvite:v1:') || trimmed.length > MAX_INVITE_TEXT_LEN) {
    return null
  }
  let decoded: string
  try {
    const body = trimmed.slice('scinvite:v1:'.length)
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/')
    decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  } catch {
    return null // malformed text is the parser's problem, not the hint's
  }
  if (!decoded.includes('/p2p-circuit')) return null
  return (
    'This invite rides a relay (its address runs through /p2p-circuit): the node '
    + 'is reached via a third-party hop rather than directly — normal for peers '
    + 'behind NAT, expect slightly higher latency.'
  )
}
