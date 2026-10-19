/**
 * `core/net/address-policy` — the IPv6-only addressing policy (ticket 9.1,
 * spec constraint 2026-10-18: "IPv6-only with no dual-stack fallback").
 *
 * Field rationale (`change-ipv6-invitation-join`): middleboxes in real LANs
 * drop the IPv4 multicast mDNS is built on, and a join path that needs
 * multicast to survive every firewall is not a join path. One address family
 * end to end: global IPv6 unicast (2000::/3) over TCP is the ONLY shape this
 * network announces, dials, or ingests. IPv4-only peers are not supported —
 * the parked community-relay tier is their future path, and every rejection
 * says so.
 *
 * THE RULES (pinned):
 *  - ACCEPT: a multiaddr containing at least one `/ip6` component whose bytes
 *    are global unicast (2000::/3 — includes the documentation range
 *    2001:db8::/32 used by every test fixture), with any trailing components
 *    (`/tcp/N`, `/p2p/<id>`, `/p2p-circuit/...`).
 *  - REJECT (any hit): an `/ip4` component; a non-global `/ip6` — loopback
 *    `::1`, unspecified `::`, link-local `fe80::/10` (and any `ip6zone`),
 *    ULA `fc00::/7`, multicast `ff00::/8`; an unparseable string; no `/ip6`
 *    component at all (dns/uni/etc. are not addresses this network routes).
 *
 * Pure — zero deps beyond the multiaddr parser, no clock/net/fs (AD-3/AD-10).
 * The memory transport is policy-free by design: `/memory/...` fixtures are
 * test scaffolding, not addressing (enforced at each tcp call site instead).
 */
import { multiaddr } from '@multiformats/multiaddr'

// Multiaddr component codes (multicodec): ip4=4, ip6=41, ip6zone=42.
const CODE_IP4 = 4
const CODE_IP6 = 41
const CODE_IP6ZONE = 42

/**
 * Is this IPv6 text global unicast — 2000::/3 (RFC 4291 top-3-bits rule)?
 * Expands `::` compression and embedded IPv4: an embedded v4 inside a global
 * address (`2001:db8::1.2.3.4`) is a legitimate global address and ACCEPTS;
 * the deprecated v4-mapped/v4-compat forms (`::ffff:1.2.3.4`, `::1.2.3.4`)
 * REJECT — their first hextet is zero, outside 2000::/3 (a leading `::` is
 * caught directly below; the mapped form also dies on the WHATWG-normalized
 * text the parser hands us). Rejects zones (`%eth0`) and any malformed text.
 * Pure string math — the multiaddr parser already guaranteed well-formedness
 * upstream, this only scopes it.
 */
function ip6IsGlobalUnicast(text: string): boolean {
  if (text.includes('%')) return false // scoped address — link-local semantics
  let head = text
  let tail = ''
  const dd = text.indexOf('::')
  if (dd !== -1) {
    // A LEADING "::" means the first hextet is zero — loopback, unspecified,
    // v4-compat… none of them can be in 2000::/3. (Review finding 9.1-1:
    // without this, the tail's first group was judged as "first".)
    if (dd === 0) return false
    if (text.indexOf('::', dd + 1) !== -1) return false // double "::" is junk
    head = text.slice(0, dd)
    tail = text.slice(dd + 2)
  }
  const hextets: number[] = []
  for (const part of [...(head === '' ? [] : head.split(':')), ...(tail === '' ? [] : tail.split(':'))]) {
    if (part === '') return false // ":x" / "x:" fragments outside "::"
    if (part.includes('.')) {
      // embedded IPv4 — two hextets from the octets
      const oct = part.split('.')
      if (oct.length !== 4 || !oct.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255))
        return false
      hextets.push((Number(oct[0]) << 8) | Number(oct[1]))
      hextets.push((Number(oct[2]) << 8) | Number(oct[3]))
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false
      hextets.push(Number.parseInt(part, 16))
    }
  }
  const total = dd === -1 ? hextets.length : hextets.length + 1
  if (dd === -1 ? total !== 8 : total > 8) return false
  const first = hextets[0] ?? 0 // unreachable-empty: "" and "::" died above
  return (first & 0xe000) === 0x2000
}

/** True when the string parses as a multiaddr at all (shape, not policy). */
export function parsesMultiaddr(addr: string): boolean {
  try {
    multiaddr(addr)
    return true
  } catch {
    return false
  }
}

/**
 * The policy predicate: `true` iff `addr` parses and every `/ip6` component
 * is global unicast, no `/ip4`/`ip6zone` appears anywhere, and at least one
 * `/ip6` component exists. Never throws — junk strings are simply `false`.
 */
export function isGlobalIp6Multiaddr(addr: string): boolean {
  let components: Array<{ code: number, value?: string }>
  try {
    // v13 API: getComponents() (the tuples API of older majors is gone).
    components = multiaddr(addr).getComponents()
  } catch {
    return false
  }
  let sawGlobalIp6 = false
  for (const component of components) {
    if (component.code === CODE_IP4 || component.code === CODE_IP6ZONE) return false
    if (component.code === CODE_IP6) {
      if (typeof component.value !== 'string' || !ip6IsGlobalUnicast(component.value))
        return false
      sawGlobalIp6 = true
    }
  }
  return sawGlobalIp6
}

/** Filter a list down to policy-valid addresses, preserving order. */
export function filterPolicyAddresses(addrs: readonly string[]): string[] {
  return addrs.filter(isGlobalIp6Multiaddr)
}

/** The pinned rejection shape (conventions: `{ code: 'SC-<DOMAIN>-<n>' }`). */
const POLICY_ERROR_CODE = 'SC-NET-1'

/**
 * Throw unless `addr` passes {@link isGlobalIp6Multiaddr}. Call sites are the
 * tcp boundaries only (adapter dial, bootstrap wiring) — the message names
 * the parked relay tier so an IPv4-only operator learns the actual path.
 *
 * The ONE documented exception (9.5, probe-only): with the environment
 * variable {@link ALLOW_LOOPBACK_ENV} explicitly set to `1`, a pure-`::1`
 * address becomes DIALABLE — nothing else changes. Default-off; announce
 * policy never sees this function (loopback is still never announced); any
 * other rejected address (v4, ULA, link-local, junk) still throws with the
 * flag set. Shipped nodes never set the variable; two-machine and loopback
 * PROOFS opt in on the probe command line only.
 */
export function assertDialable(addr: string): void {
  if (!isGlobalIp6Multiaddr(addr)) {
    if (loopbackAllowEnabled() && isLoopbackIp6Multiaddr(addr)) return
    throw Object.assign(
      new Error(
        `${POLICY_ERROR_CODE}: this network is IPv6-only (global unicast over TCP); ` +
          `"${addr}" is not dialable. IPv4-only peers need the community relay tier (parked).`,
      ),
      { code: POLICY_ERROR_CODE },
    )
  }
}

/** The explicit test-flag name (documented in README + probe headers). */
export const ALLOW_LOOPBACK_ENV = 'SUCCINCTCOIN_ALLOW_LOOPBACK'

function loopbackAllowEnabled(): boolean {
  try {
    return process.env[ALLOW_LOOPBACK_ENV] === '1'
  } catch {
    return false
  }
}

/** True iff `addr` parses, carries no `/ip4`/`ip6zone`, and EVERY `/ip6`
 * component is exactly `::1` (any compression: `0:0:0:0:0:0:0:1`, `::0:1`).
 * Strictly the loopback — a global or v4-mapped component anywhere fails. */
export function isLoopbackIp6Multiaddr(addr: string): boolean {
  let components: Array<{ code: number, value?: string }>
  try {
    components = multiaddr(addr).getComponents()
  } catch {
    return false
  }
  let sawLoopback = false
  for (const component of components) {
    if (component.code === CODE_IP4 || component.code === CODE_IP6ZONE) return false
    if (component.code === CODE_IP6) {
      const h = typeof component.value === 'string' ? expandHextets(component.value) : null
      if (h === null || h.length !== 8 || h[7] !== 1 || h.slice(0, 7).some((x) => x !== 0))
        return false
      sawLoopback = true
    }
  }
  return sawLoopback
}
/**
 * The class of a RAW IPv6 text address (a host interface address, NOT a
 * multiaddr) — the same top-bit knowledge as `ip6IsGlobalUnicast`, owned
 * HERE so policy and diagnostics never disagree (post-9.5: the app's invite
 * panel explains WHY it has no invite by classifying what the machine has).
 * Zone ids are NOT handled here (strip `%en0` before calling); malformed or
 * zone-bearing input classifies as `'other'` — this never throws.
 */
export type Ip6AddressClass =
  | 'global' // 2000::/3 — the only announceable class
  | 'linkLocal' // fe80::/10 — every interface has one; reachable nobody
  | 'uniqueLocal' // fc00::/7 — VPN/mesh overlays (Tailscale's fd00::)
  | 'loopback' // ::1 — the dev-flag-only dial class (9.5)
  | 'other'
export function classifyIp6Address(text: string): Ip6AddressClass {
  const h = expandHextets(text)
  if (h === null || h.length !== 8) return 'other'
  const first = h[0] as number
  if (first >= 0x2000 && first <= 0x3fff) return 'global'
  if (first >= 0xfe80 && first <= 0xfebf) return 'linkLocal'
  if (first >= 0xfc00 && first <= 0xfdff) return 'uniqueLocal'
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'loopback'
  return 'other'
}

/** Expand IPv6 text to EXACTLY 8 hextets (zero-filling `::`), or null. The
 * same string math {@link ip6IsGlobalUnicast} runs, kept separate so each
 * stays one job; embedded v4 counts as two hextets. */
function expandHextets(text: string): number[] | null {
  if (text.includes('%')) return null
  let head = text
  let tail = ''
  const dd = text.indexOf('::')
  if (dd !== -1) {
    if (dd === 0) {
      // Leading "::" — the head is empty, but the TAIL still carries groups
      // (`::1` → tail "1"). Dropping it here once turned `::1` into all-zero.
      head = ''
      tail = text.slice(dd + 2)
    } else if (text.indexOf('::', dd + 1) !== -1) return null
    else {
      head = text.slice(0, dd)
      tail = text.slice(dd + 2)
    }
  }
  const parse = (part: string): number[] | null => {
    if (part.includes('.')) {
      const oct = part.split('.')
      if (oct.length !== 4 || !oct.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255))
        return null
      return [(Number(oct[0]) << 8) | Number(oct[1]), (Number(oct[2]) << 8) | Number(oct[3])]
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    return [Number.parseInt(part, 16)]
  }
  const groups = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    for (const part of s.split(':')) {
      if (part === '') return null
      const h = parse(part)
      if (h === null) return null
      out.push(...h)
    }
    return out
  }
  const hs = groups(head)
  const ts = groups(tail)
  if (hs === null || ts === null) return null
  if (dd === -1) return hs.length === 8 ? hs : null
  const fill = 8 - hs.length - ts.length
  if (fill < 0) return null
  return [...hs, ...new Array<number>(fill).fill(0), ...ts]
}

/**
 * The address's /64 group key (9.3 diversity floor): the first four hextets
 * of the FIRST `/ip6` component, rendered canonically lowercase as
 * `"h0:h1:h2:h3"`. Null when the string has no parseable global /ip6 (junk
 * addresses group as null — the caller decides; the book only stores
 * policy-valid ones, so null is a defensive path). Pure.
 */
export function ip6Slash64(addr: string): string | null {
  let components: Array<{ code: number, value?: string }>
  try {
    components = multiaddr(addr).getComponents()
  } catch {
    return null
  }
  for (const component of components) {
    if (component.code !== CODE_IP6 || typeof component.value !== 'string') continue
    if (!ip6IsGlobalUnicast(component.value)) continue
    const h = expandHextets(component.value)
    if (h === null) return null
    return h
      .slice(0, 4)
      .map((x) => x.toString(16))
      .join(':')
  }
  return null
}