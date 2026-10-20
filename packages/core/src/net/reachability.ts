/**
 * `core/net/reachability` — AutoNAT reachability TRUTH (epic 10, ticket 10.1).
 *
 * The problem this module pins: on the pinned stack (libp2p 3.3.11 +
 * `@libp2p/autonat-v2`), a failed probe removes only OBSERVED addresses —
 * bound LISTEN addresses stay advertised forever, so an inbound-blocked node
 * would keep announcing a direct address nobody can dial. Honesty is applied
 * at TWO adapter points over one tracker: the libp2p `announceFilter` (which
 * `getMultiaddrs()` AND identify/identify-push go through — the wire truth)
 * and `listenAddresses()` (the app-facing view feeding invite/ladder).
 *
 * Evidence model (deliberately tiny):
 * - no evidence yet  → 'unknown' → announce EXACTLY today's set (fresh-boot
 *   behavior pinned; AutoNAT needs peers before it can speak);
 * - ANY address observed reachable → aggregate 'reachable';
 * - every evidenced address observed unreachable → 'unreachable'.
 * Evidence may cover any address AutoNAT observes (including observed addrs
 * never advertised): the aggregate is reachability truth about US, not a
 * mirror of the announce set — per-address suppression is what shapes what
 * peers see. Circuit addresses are NEVER suppressed: when the direct path is
 * proven dead, the relay path is the whole point (10.2 announces through it).
 */

/** What this node knows about being dialed back ('unknown' = no evidence). */
export type Reachability = 'unknown' | 'reachable' | 'unreachable'

/**
 * Canonical key for our own address. Identical transport addresses reach the
 * tracker under different spellings depending on who reports them: AutoNAT
 * events carry the raw listen address, while libp2p's announce filter (and
 * `getMultiaddrs()`) see it encapsulated with `/p2p/<self>`. Strip the
 * trailing peer part so both sides agree (10.1 review F1).
 */
export function normalizeAddressKey(addrText: string): string {
  const parts = addrText.split('/')
  // `/ip6/2001:db8::5/tcp/4001/p2p/QmSelf` → parts[len-2] === 'p2p'
  if (parts.length >= 2 && parts[parts.length - 2] === 'p2p') {
    return parts.slice(0, -2).join('/')
  }
  return addrText
}

/**
 * May this address be presented to peers right now? Circuit addresses always
 * (a relay path is how you reach an unreachable peer — dropping it on a bad
 * direct probe would destroy the fallback); direct addresses only while their
 * evidence isn't `false` (unknown stays in — optimistic default).
 */
export function isHonestAddressText(
  addrText: string,
  seen: ReadonlyMap<string, boolean>,
): boolean {
  return isCircuitAddressText(addrText) || seen.get(normalizeAddressKey(addrText)) !== false
}

/** Mutable per-address evidence log (the adapter owns one per started node). */
export interface ReachabilityTracker {
  /** Record one probe verdict for one address text (normalized; latest wins). */
  observe(addrText: string, reachable: boolean): void
  /** What is known about ONE address (normalized). */
  state(addrText: string): Reachability
  /** The aggregate truth across all evidenced addresses. */
  aggregate(): Reachability
  /** Read-only evidence view for the honesty filter. */
  view(): ReadonlyMap<string, boolean>
}

export function createReachabilityTracker(): ReachabilityTracker {
  const seen = new Map<string, boolean>()
  return {
    observe(addrText, reachable) {
      seen.set(normalizeAddressKey(addrText), reachable)
    },
    state(addrText) {
      const v = seen.get(normalizeAddressKey(addrText))
      return v === undefined ? 'unknown' : v ? 'reachable' : 'unreachable'
    },
    aggregate() {
      if (seen.size === 0) return 'unknown'
      for (const v of seen.values()) if (v) return 'reachable'
      return 'unreachable'
    },
    view() {
      return seen
    },
  }
}

/**
 * True iff the address text carries a `/p2p-circuit` component. String-level
 * on purpose (this module must stay dependency-free); the addressing policy
 * (`address-policy.ts`) owns the real structural rules for circuit hops.
 */
export function isCircuitAddressText(text: string): boolean {
  return text.split('/').includes('p2p-circuit')
}

/**
 * The honest advertised set (string form; see {@link isHonestAddressText}).
 * Unknown evidence passes untouched — a fresh boot with no probe peers yet
 * is byte-identical to pre-10.1 behavior.
 */
export function filterHonestAddresses(
  addresses: readonly string[],
  seen: ReadonlyMap<string, boolean>,
): string[] {
  return addresses.filter((addr) => isHonestAddressText(addr, seen))
}

/**
 * Config resolution, pure so the AD-10 pin is testable without building a
 * node: AutoNAT runs on REAL transports only — memory NEVER registers it,
 * not even when asked. tcp defaults ON; `autoNat: false` opts out.
 */
export function autoNatEnabledFor(
  transport: 'memory' | 'tcp',
  override: boolean | undefined,
): boolean {
  if (transport !== 'tcp') return false
  return override !== false
}
