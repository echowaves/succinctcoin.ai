/**
 * `core/net/address-policy` — the addressing policy: direct IPv6-only + the
 * relay-hop law (ticket 9.1, spec constraint 2026-10-18 "IPv6-only with no
 * dual-stack fallback", amended 2026-10-21 for CAP-8's hop exception).
 *
 * Field rationale (`change-ipv6-invitation-join`): middleboxes in real LANs
 * drop the IPv4 multicast mDNS is built on, and a join path that needs
 * multicast to survive every firewall is not a join path. One address family
 * for DIRECT addresses: global IPv6 unicast (2000::/3) over TCP is the ONLY
 * shape this network announces or dials directly. IPv4-only peers are never
 * served DIRECTLY — the relay tier reaches them THROUGH a volunteer relay,
 * whose hop is a global /ip6 and, since the 2026-10-21 amendment, may also
 * be a global /ip4; every rejection says so.
 *
 * THE RULES (pinned):
 *  - DIRECT ADDRESSES — ACCEPT: a multiaddr containing at least one `/ip6`
 *    component whose bytes are global unicast (2000::/3 — includes the
 *    documentation range 2001:db8::/32 used by every test fixture), with any
 *    trailing components (`/tcp/N`, `/p2p/<id>`, `/p2p-circuit/...`). REJECT
 *    (any hit): an `/ip4` component; a non-global `/ip6` — loopback `::1`,
 *    unspecified `::`, link-local `fe80::/10` (and any `ip6zone`), ULA
 *    `fc00::/7`, multicast `ff00::/8`; an unparseable string; no `/ip6`
 *    component at all (dns/uni/etc. are not addresses this network routes).
 *    This is {@link isGlobalIp6Multiaddr}, byte-identical since 9.1 — the
 *    IPv4-only peer is never SERVED as a direct address, only THROUGH a hop.
 *  - HOP LAW (amendment 2026-10-21, epic 11): a CIRCUIT-SHAPED address —
 *    everything before the first `p2p-circuit` is the HEAD, everything after
 *    the TAIL — is addressable iff the head carries EXACTLY ONE IP component
 *    (a `/ip4` or `/ip6`, global-scope) and the tail carries NO IP/zone
 *    components at all. A circuit address is only ever as public as its hop:
 *    global scope means NOT RFC1918, NOT CGNAT `100.64.0.0/10`, NOT loopback,
 *    NOT link-local, NOT `0.0.0.0/8`, NOT multicast/reserved `>= 224.0.0.0/4`
 *    (v4); the v6 side reuses the global-unicast math above. Any `ip6zone`
 *    rejects. {@link isGlobalHopMultiaddr} judges the hop alone,
 *    {@link isRelayHopCircuitMultiaddr} the whole circuit shape, and
 *    {@link isAddressableMultiaddr} is the combined law (direct OR circuit)
 *    every ingest/consensus boundary consumes. A multi-hop all-`/ip6` chain
 *    (no v4 anywhere) stays accepted through the DIRECT rule above — no
 *    accept→reject flip anywhere in this widening.
 *  - NETWORK GROUPING: {@link hopNetworkKey} keys an address on its FIRST IP
 *    component — `"6:h0:h1:h2:h3"` (the /64 math of {@link ip6Slash64}) or
 *    `"4:a.b.c.0"` (per-/24) — so the book's diversity floor counts a relay
 *    /24 like a /64. Non-global first IP → null (defensive).
 *  - DIAL-SIDE LAWS (story 11.2, epic 11): the ADAPTER consumes two purpose
 *    built predicates instead of the record law. A relay SEED is a direct
 *    endpoint to hold through — {@link isRelaySeedMultiaddr} (pure) wants a
 *    parseable address with no zone, no `p2p-circuit`, a `/p2p` component and
 *    a FIRST IP of global scope (either family); {@link
 *    isDialableSeedMultiaddr} adds the dev-flag loopback-family first IP
 *    (`127/8` OR `::1`). A dial TARGET obeys {@link
 *    isDialableTargetMultiaddr}: circuit-shaped addresses take the hop law
 *    (or all-loopback-family hops under the flag), direct addresses stay
 *    EXACTLY {@link isDialableMultiaddr}. Neither law is ever consulted by
 *    ingest/consensus, and announce construction keeps
 *    `filterDialableAddresses` byte-identically.
 *
 * Pure — zero deps beyond the multiaddr parser, no clock/net/fs (AD-3/AD-10).
 * The memory transport is policy-free by design: `/memory/...` fixtures are
 * test scaffolding, not addressing (enforced at each tcp call site instead).
 */
import { multiaddr } from '@multiformats/multiaddr'

// Multiaddr component codes (multicodec): ip4=4, ip6=41, ip6zone=42, p2p=421,
// p2p-circuit=290 (no value — the separator of the circuit head from the tail).
const CODE_IP4 = 4
const CODE_IP6 = 41
const CODE_IP6ZONE = 42
const CODE_P2P = 421
const CODE_P2P_CIRCUIT = 290

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

/**
 * Is this IPv4 DOTTED-QUAD text global scope — the v4 twin of
 * {@link ip6IsGlobalUnicast}, for the relay-HOP law only (amendment
 * 2026-10-21). Rejects malformed text and every non-global family: RFC1918
 * (`10/8`, `172.16/12`, `192.168/16`), CGNAT `100.64.0.0/10`, loopback
 * `127/8`, link-local `169.254.0.0/16`, `0.0.0.0/8` (this-network/bind), and
 * multicast/reserved `>= 224.0.0.0/4`. Everything else — including TEST-NET
 * documentation ranges used by fixtures — is global scope: a hop only has to
 * be PUBLIC, it is dialed by anyone who can route to it. Pure string math;
 * the multiaddr parser already guaranteed quad well-formedness upstream.
 */
function ip4IsGlobalScope(text: string): boolean {
  const oct = text.split('.')
  if (oct.length !== 4 || !oct.every((o) => /^\d{1,3}$/.test(o))) return false
  const n = oct.map(Number)
  if (n.some((x) => x > 255)) return false
  const [a, b] = n as [number, number, number, number]
  if (a === 0 || a === 127 || a >= 224) return false // this-net / loopback / mcast+reserved
  if (a === 10) return false // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918
  if (a === 192 && b === 168) return false // RFC1918
  if (a === 169 && b === 254) return false // link-local
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64.0.0/10
  return true
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
 * The ONE documented exception (9.5, extended by the dev-only announce
 * allowance): with the environment variable {@link ALLOW_LOOPBACK_ENV}
 * explicitly set to `1`, a pure-`::1` address becomes DIALABLE — and via
 * {@link isDialableMultiaddr} it follows the SAME law on the announce,
 * ingest (announcement validation) and bootstrap sides, so one machine can
 * run the real join flow over loopback. Default-off; any other rejected
 * address (v4, ULA, link-local, junk) still throws with the flag set, and
 * shipped nodes never set the variable — a loopback record is rejected by
 * every unflagged node, so it cannot reach a real network.
 */
export function assertDialable(addr: string): void {
  if (!isDialableMultiaddr(addr)) throw dialPolicyError(addr)
}

/**
 * The pinned SC-NET-1 rejection, built in ONE place so {@link assertDialable}
 * and the 11.2 target twin ({@link assertDialableTarget}) can never drift
 * apart on code or message.
 */
function dialPolicyError(addr: string): Error & { code: string } {
  return Object.assign(
    new Error(
      `${POLICY_ERROR_CODE}: direct addresses must be global IPv6 unicast over TCP; ` +
        `a /p2p-circuit target needs one global-scope hop (/ip4 or /ip6) before its ` +
        `separator (loopback-family hops only with SUCCINCTCOIN_ALLOW_LOOPBACK=1). ` +
        `"${addr}" is not dialable. IPv4-only peers are served through a dual-stack ` +
        'relay (SUCCINCTCOIN_RELAY_SEEDS) on their side.',
    ),
    { code: POLICY_ERROR_CODE },
  )
}

/**
 * The BOOLEAN twin of {@link assertDialable} — policy-global, or pure-`::1`
 * under the dev flag. Drives the DIAL-side surfaces: announce construction
 * and bootstrap filtering (the post-9.5 "DEV-ONLY ANNOUNCE ALLOWANCE", built
 * for machines with no global IPv6 at all): with `SUCCINCTCOIN_ALLOW_LOOPBACK=1`
 * a node may ANNOUNCE its `::1` listener and bootstrap entries survive the
 * list filter — so two app instances on ONE machine run the real join flow.
 * Default off (per-call env read); with the flag unset this is exactly
 * {@link isGlobalIp6Multiaddr}. Nothing about `fe80::`, ULA, `/ip4` or zones
 * ever changes. RECORD VALIDATION is deliberately NOT wired to this env
 * directly — it is context-gated (`AnnouncementContext.allowLoopbackAddresses`,
 * strict in every consensus path) so flagged nodes can never fork unflagged
 * ones over chain data; see `loopbackAnnounceAllowed`.
 */
export function isDialableMultiaddr(addr: string): boolean {
  if (isGlobalIp6Multiaddr(addr)) return true
  return loopbackAllowEnabled() && isLoopbackIp6Multiaddr(addr)
}

/** {@link isDialableMultiaddr} as an order-preserving list filter — the
 * shape the announce construction and bootstrap wiring consume. */
export function filterDialableAddresses(addrs: readonly string[]): string[] {
  return addrs.filter(isDialableMultiaddr)
}

/** The explicit test-flag name (documented in README + probe headers). */
export const ALLOW_LOOPBACK_ENV = 'SUCCINCTCOIN_ALLOW_LOOPBACK'

/**
 * Resolve the dev-only ANNOUNCE-side allowance PER CALL (10.3 closeout).
 * NON-CONSENSUS ingest sites only (gossip receive, invite verify, address-
 * book ingest, boot-file load): they set `allowLoopbackAddresses` on the
 * validation context from this value. Consensus paths (block candidates,
 * block application, introductions production) must never consult it —
 * they validate strictly, so a `::1` record can never enter a block and
 * flagged/unflagged node mixes cannot diverge on chain data.
 */
export function loopbackAnnounceAllowed(): boolean {
  return loopbackAllowEnabled()
}

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

// ---------------------------------------------------------------------------
// Hop law (amendment 2026-10-21, epic 11): a `/p2p-circuit` address is only
// ever as public as its HOP — global scope in EITHER family. One module owns
// every boundary: `isAddressableMultiaddr` below is the combined law the
// announcement validator (and through it book ingest, invitation verify,
// boot files, candidates/apply-block/introductions) consumes.
// ---------------------------------------------------------------------------

/**
 * The network key of an address's FIRST IP component — the single point of
 * network a record claims: `"6:h0:h1:h2:h3"` for a global `/ip6` (the exact
 * /64 math of {@link ip6Slash64}), `"4:a.b.c.0"` for a global `/ip4` (per-
 * /24, so a relay's address space groups like a v6 /64 for the book's
 * diversity floor). Null when there is no IP component, an `ip6zone`
 * appears, or the first IP is not global scope — the caller decides what
 * null means (the book groups such entries ungrouped, defensively: records
 * reaching it are already policy-valid). Pure.
 */
export function hopNetworkKey(addr: string): string | null {
  let components: Array<{ code: number, value?: string }>
  try {
    components = multiaddr(addr).getComponents()
  } catch {
    return null
  }
  if (components.some((c) => c.code === CODE_IP6ZONE)) return null
  for (const component of components) {
    if (component.code === CODE_IP4 && typeof component.value === 'string')
      return ip4IsGlobalScope(component.value)
        ? `4:${component.value.split('.').slice(0, 3).join('.')}.0`
        : null
    if (component.code === CODE_IP6 && typeof component.value === 'string') {
      if (!ip6IsGlobalUnicast(component.value)) return null
      const h = expandHextets(component.value)
      if (h === null) return null
      return `6:${h
        .slice(0, 4)
        .map((x) => x.toString(16))
        .join(':')}`
    }
  }
  return null
}

/**
 * The HEAD rule of the hop law, shared by both hop predicates: the head —
 * everything before the FIRST `p2p-circuit` separator (absent separator:
 * everything) — carries EXACTLY ONE IP component and that component is
 * global scope (`/ip4` public per {@link ip4IsGlobalScope}, or global-unicast
 * `/ip6`), with no `ip6zone` anywhere in the head. Two IPs before the first
 * separator are junk: one address, one hop. Pure over parsed components.
 */
function hopHeadIsSingleGlobalIp(components: Array<{ code: number, value?: string }>): boolean {
  const sep = components.findIndex((c) => c.code === CODE_P2P_CIRCUIT)
  const head = sep === -1 ? components : components.slice(0, sep)
  let ipCount = 0
  for (const component of head) {
    if (component.code === CODE_IP6ZONE) return false
    if (component.code !== CODE_IP4 && component.code !== CODE_IP6) continue
    ipCount += 1
    if (ipCount > 1) return false
    if (typeof component.value !== 'string') return false
    const global =
      component.code === CODE_IP4
        ? ip4IsGlobalScope(component.value)
        : ip6IsGlobalUnicast(component.value)
    if (!global) return false
  }
  return ipCount === 1
}

/**
 * The HOP predicate, judged from the HEAD ALONE: true iff `addr` parses,
 * contains at least one `p2p-circuit`, and its head passes {@link
 * hopHeadIsSingleGlobalIp} — exactly one global-scope IP before the first
 * separator (two IPs in one head are junk, not a hop). Deliberately never
 * judges what comes AFTER the hop (multi-hop chains, tail addressing):
 * acceptance of a full circuit SHAPE is {@link isRelayHopCircuitMultiaddr};
 * nothing decides addressability from this predicate alone. Never throws;
 * junk is `false`.
 */
export function isGlobalHopMultiaddr(addr: string): boolean {
  let components: Array<{ code: number, value?: string }>
  try {
    components = multiaddr(addr).getComponents()
  } catch {
    return false
  }
  // ANY ip6zone rejects — head or tail (zones are link-local semantics,
  // never globally dialable; the frozen hop law admits no zone anywhere).
  if (components.some((c) => c.code === CODE_IP6ZONE)) return false
  if (!components.some((c) => c.code === CODE_P2P_CIRCUIT)) return false
  return hopHeadIsSingleGlobalIp(components)
}

/**
 * The full CIRCUIT validator of the hop law: the head passes {@link
 * hopHeadIsSingleGlobalIp} (exactly one global-scope IP before the FIRST
 * `p2p-circuit`), AND the tail after that separator carries no IP/zone
 * components — the dial ends at `/p2p/<id>`, it never re-addresses. Direct
 * (circuit-less) addresses are `false` here by shape; they stay governed by
 * {@link isGlobalIp6Multiaddr}.
 */
export function isRelayHopCircuitMultiaddr(addr: string): boolean {
  let components: Array<{ code: number, value?: string }>
  try {
    components = multiaddr(addr).getComponents()
  } catch {
    return false
  }
  const sep = components.findIndex((c) => c.code === CODE_P2P_CIRCUIT)
  if (sep === -1) return false
  if (components.slice(sep + 1).some((c) => c.code === CODE_IP4 || c.code === CODE_IP6 || c.code === CODE_IP6ZONE))
    return false
  return hopHeadIsSingleGlobalIp(components)
}

/**
 * The COMBINED addressing law (every ingest/consensus boundary consumes
 * THIS): `true` iff `addr` is a strict direct global-`/ip6` address
 * ({@link isGlobalIp6Multiaddr}, byte-identical rules — direct `/ip4` never
 * passes) OR a valid relay-hop circuit ({@link isRelayHopCircuitMultiaddr}
 * — a global-scope hop, either family). No environment reads: the loopback
 * dev allowance stays in {@link isDialableMultiaddr} (dial side) and the
 * validation CONTEXT (record side), exactly as before. Pure.
 */
export function isAddressableMultiaddr(addr: string): boolean {
  return isGlobalIp6Multiaddr(addr) || isRelayHopCircuitMultiaddr(addr)
}

// ---------------------------------------------------------------------------
// DIAL-side laws (story 11.2, epic 11): the two purposes for which the
// adapter opens a socket — HOLDING a relay seed (a direct endpoint to reserve
// through) and DIALING a target address (direct or circuit). Deliberately NOT
// the record law: ingest/consensus never consult these, `isDialableMultiaddr`
// / `filterDialableAddresses` (announce + bootstrap construction) stay
// byte-identical, and direct `/ip4` targets stay rejected WITH AND WITHOUT
// the dev flag. The flag extends both laws to loopback-family endpoints of
// EITHER family (`::1` AND `127/8`) on the dial side only — same per-call env
// read ({@link loopbackAnnounceAllowed} discipline), never ingest.
// ---------------------------------------------------------------------------

/** Parsed components or null (unparseable — shape, not policy). */
type Components = ReadonlyArray<{ code: number, value?: string }>

function parseComponents(addr: string): Components | null {
  try {
    // v13 API: getComponents() (the tuples API of older majors is gone).
    return multiaddr(addr).getComponents()
  } catch {
    return null
  }
}

/** Is this IPv4 dotted-quad text LOOPBACK family — `127.0.0.0/8`? Any host
 * part counts (`127.1.2.3` is loopback on every OS). Malformed text rejects.
 * Dial-side flag-gated laws ONLY — never record validation (10.3 gating). */
function ip4IsLoopback(text: string): boolean {
  const oct = text.split('.')
  if (oct.length !== 4 || !oct.every((o) => /^\d{1,3}$/.test(o))) return false
  return Number(oct[0]) === 127 && oct.every((o) => Number(o) <= 255)
}

/** Is this IPv6 text EXACTLY the loopback `::1` (any compression:
 * `0:0:0:0:0:0:0:1`, `::0:1`)? Zones reject — same strictness as
 * {@link isLoopbackIp6Multiaddr}'s per-component check. */
function ip6IsLoopback(text: string): boolean {
  const h = expandHextets(text)
  return h !== null && h.length === 8 && h[7] === 1 && h.slice(0, 7).every((x) => x === 0)
}

/** The FIRST IP component (either family) is GLOBAL scope; no IP at all, a
 * zone anywhere, or malformed text → false. Callers pre-check zones. */
function firstIpIsGlobalScope(components: Components): boolean {
  if (components.some((c) => c.code === CODE_IP6ZONE)) return false
  const first = components.find((c) => c.code === CODE_IP4 || c.code === CODE_IP6)
  if (first === undefined || typeof first.value !== 'string') return false
  return first.code === CODE_IP4
    ? ip4IsGlobalScope(first.value)
    : ip6IsGlobalUnicast(first.value)
}



/** At least one IP component and EVERY IP component (either family) is
 * loopback-family; any `ip6zone` → false. The flag branch of the target law:
 * a dev loopback circuit may re-address only within the loopback family. */
function allIpsLoopbackFamily(components: Components): boolean {
  let sawIp = false
  for (const component of components) {
    if (component.code === CODE_IP6ZONE) return false
    if (component.code !== CODE_IP4 && component.code !== CODE_IP6) continue
    if (typeof component.value !== 'string') return false
    const loopback =
      component.code === CODE_IP4 ? ip4IsLoopback(component.value) : ip6IsLoopback(component.value)
    if (!loopback) return false
    sawIp = true
  }
  return sawIp
}

/**
 * The PURE relay-SEED shape (no env reads): a seed is the direct endpoint of
 * a volunteer relay, held so others can dial US through it. Accepts iff the
 * string parses, carries NO `ip6zone` and NO `p2p-circuit` (a seed is dialed
 * DIRECTLY — a circuit inside one is junk), carries a `/p2p/<relayId>`
 * component (the hold must know which relay it reserves on), and its FIRST
 * IP component is global scope in EITHER family (`/ip4` public per {@link
 * ip4IsGlobalScope} — the 11.2 amendment — or global-unicast `/ip6`). Never
 * throws; junk is `false`. The record law never consumes this; neither does
 * announce construction — seeds are dial-side addressing only.
 */
export function isRelaySeedMultiaddr(addr: string): boolean {
  return seedShapeOk(addr, false)
}

/**
 * The env-aware SEED law the adapter's `holdSeed` pre-flight consumes: {@link
 * isRelaySeedMultiaddr} OR — under {@link ALLOW_LOOPBACK_ENV} set to `1`,
 * read per call — the same shape whose first IP is loopback-family (`::1` or
 * `127/8`) so ONE machine can run the whole hold/announce/invite flow over
 * loopback in either family. Default off; every other rejection (RFC1918,
 * CGNAT, link-local, ULA, zone, no `/p2p`, circuit-in-seed) stands WITH the
 * flag. Dial side ONLY — ingest never consults any seed law.
 */
export function isDialableSeedMultiaddr(addr: string): boolean {
  if (seedShapeOk(addr, false)) return true
  return loopbackAllowEnabled() && seedShapeOk(addr, true)
}

/** Seed shape shared by both seed predicates: parse, no zone, no circuit,
 * carries /p2p; the first IP must be global scope, or — when `loopbackOk` —
 * EVERY IP loopback-family (the dev branch admits a pure loopback endpoint,
 * never a loopback head hiding a public secondary IP — same discipline as
 * the target law's flag branch). */
function seedShapeOk(addr: string, loopbackOk: boolean): boolean {
  const components = parseComponents(addr)
  if (components === null) return false
  if (components.some((c) => c.code === CODE_IP6ZONE || c.code === CODE_P2P_CIRCUIT))
    return false
  if (!components.some((c) => c.code === CODE_P2P)) return false
  if (firstIpIsGlobalScope(components)) return true
  return loopbackOk && allIpsLoopbackFamily(components)
}

/**
 * The circuit-aware DIAL-TARGET law the adapter's `dial()` consumes. A
 * DIRECT (circuit-less) target is judged by EXACTLY {@link
 * isDialableMultiaddr} — global `/ip6`, pure `::1` under the flag, direct
 * `/ip4` never, WITH OR WITHOUT the flag. A CIRCUIT-shaped target dials when
 * ANY pre-existing law accepts it — NO accept→reject flip: the old direct
 * rule ({@link isGlobalIp6Multiaddr}, every `/ip6` global and no `/ip4`/zone
 * anywhere — covers multi-hop and tail-addressed all-v6 chains dialed before
 * this story), OR the new hop law ({@link isRelayHopCircuitMultiaddr}: one
 * global-scope hop, either family), OR — under the dev flag — every IP
 * component loopback-family (at least one, `::1` and/or `127/8`), the 9.5
 * loopback allowance extended to both families. Nothing else dials.
 */
export function isDialableTargetMultiaddr(addr: string): boolean {
  if (isDialableMultiaddr(addr)) return true // direct law, byte-identical verdicts
  if (isRelayHopCircuitMultiaddr(addr)) return true // hop law (global hop, either family)
  const components = parseComponents(addr)
  if (components === null) return false
  // The dev loopback branch is CIRCUIT-ONLY: a DIRECT loopback IPv4 never
  // dials, flag or no flag (the frozen direct law admits only `::1`).
  if (!components.some((c) => c.code === CODE_P2P_CIRCUIT)) return false
  return loopbackAllowEnabled() && allIpsLoopbackFamily(components)
}

/**
 * The ANNOUNCE law (11.2): what a node may put in its OWN signed records —
 * exactly the shapes every validator already accepts: the combined record
 * law ({@link isAddressableMultiaddr}: direct global `/ip6` OR a valid
 * relay-hop circuit, either family) OR, under {@link ALLOW_LOOPBACK_ENV},
 * the pure-`::1` forms the DEV-ONLY ANNOUNCE ALLOWANCE has admitted since
 * 9.5 (the same pair the validation CONTEXT consumes — strict, or global +
 * `::1` flagged; a `127/8` hop NEVER enters a record, flag or no flag).
 * Order-preserving {@link filterAnnounceAddresses} is the shape announce
 * construction and self-invite building consume, so a HELD v4-hop circuit
 * finally reaches gossip, books and invites (CAP-8 R3 flow-through) while
 * direct `/ip4` never does.
 */
export function isAnnounceableMultiaddr(addr: string): boolean {
  if (isAddressableMultiaddr(addr)) return true
  return loopbackAllowEnabled() && isLoopbackIp6Multiaddr(addr)
}

/** {@link isAnnounceableMultiaddr} as an order-preserving list filter. */
export function filterAnnounceAddresses(addrs: readonly string[]): string[] {
  return addrs.filter(isAnnounceableMultiaddr)
}

/** {@link isDialableTargetMultiaddr} as the pinned throw (same SC-NET-1 and
 * message as {@link assertDialable} — one error factory, {@link
 * dialPolicyError}, so the two gates cannot drift). */
export function assertDialableTarget(addr: string): void {
  if (!isDialableTargetMultiaddr(addr)) throw dialPolicyError(addr)
}
