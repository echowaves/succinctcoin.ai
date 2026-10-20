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
 * only is the plain "your network has no IPv6" case.
 */
export function describeIpv6(d: InviteDiagnostics): string {
  if (d.hasGlobal)
    return 'Global IPv6 detected — your invite appears at the next announce window (no restart needed).'
  if (d.uniqueLocalCount > 0)
    return 'Only private/overlay IPv6 found (e.g. a VPN mesh fd00:: address) — friends on the internet cannot reach it, so it is never announced. Enable real IPv6 (2xxx:) on your router/ISP.'
  if (d.linkLocalCount > 0)
    return 'Only link-local (fe80::) addresses found — this machine has no global IPv6. Check the router/ISP IPv6 setting; a VPN/Tailscale IPv6 does not count.'
  if (d.otherCount > 0)
    return 'IPv6 addresses present but none usable (no global, link-local, or private class) — an unusual setup; check this machine\'s IPv6 configuration.'
  return 'No active IPv6 interfaces on this machine — enable IPv6 first.'
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
