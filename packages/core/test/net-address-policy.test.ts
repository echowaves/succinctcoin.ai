/**
 * Ticket 9.1 (R1) — the IPv6-only address policy, tested as the pure module
 * it is (AD-10: no sockets, no electron). The predicate's ACCEPT/REJECT table
 * IS the spec constraint ("global /ip6 only; IPv4, link-local, loopback,
 * ULA, multicast rejected"), so this suite is its executable definition.
 */
import { describe, expect, it } from 'vitest'

import {
  assertDialable,
  classifyIp6Address,
  filterDialableAddresses,
  filterPolicyAddresses,
  hopNetworkKey,
  isAddressableMultiaddr,
  isDialableMultiaddr,
  isGlobalHopMultiaddr,
  isGlobalIp6Multiaddr,
  isRelayHopCircuitMultiaddr,
  ip6Slash64,
} from '../src/net/address-policy.js'

describe('9.1 — address policy: global /ip6 only', () => {
  it('ACCEPTS global unicast over tcp, with p2p and p2p-circuit tails', () => {
    for (const addr of [
      '/ip6/2001:db8::1/tcp/4001',
      '/ip6/2001:db8:1:2::5/tcp/9017/p2p/12D3KooWPeer',
      '/ip6/2001:db8:c0a8:1::/tcp/4001/p2p/12D3A/p2p-circuit/p2p/12D3B',
      '/ip6/2001:db8:85a3::8a2e:370:7334/tcp/4001', // compressed tail
      '/ip6/2001:0db8:85a3:0000:0000:8a2e:0370:7334/tcp/4001', // fully written out
      '/ip6/2002:102:304::/tcp/1', // 6to4 shape is still 2000::/3
      '/ip6/3fff::1/tcp/1', // top edge of 2000::/3
      '/ip6/2001:db8::1.2.3.4/tcp/1', // embedded v4 INSIDE a global addr is still global
    ]) {
      expect(isGlobalIp6Multiaddr(addr), addr).toBe(true)
    }
  })

  it('REJECTS every off-policy family (spec constraint 2026-10-18)', () => {
    for (const addr of [
      '/ip4/192.168.1.84/tcp/9017', // IPv4 endpoint
      '/ip4/0.0.0.0/tcp/0', // the retired bind
      '/ip6/4000::1/tcp/1', // one hextet past the 2000::/3 ceiling
      '/ip6/fe80::1/tcp/4001', // link-local
      '/ip6zone/en0/ip6/fe80::1/tcp/1', // canonical scoped form (CODE_IP6ZONE)
      '/ip6/fe80%25en0::1/tcp/4001', // zone via %25 — dies at the parser itself
      '/ip6/::1/tcp/4001', // loopback
      '/ip6/fd00::5/tcp/4001', // ULA fc00::/7
      '/ip6/ff02::fb/tcp/4001', // multicast
      '/ip6/::/tcp/0', // unspecified (a BIND, never an announce/dial target)
      '/ip6/::ffff:1.2.3.4/tcp/1', // v4-mapped — first hextet zero, not global
      '/ip6/::1.2.3.4/tcp/1', // v4-compat (review 9.1-1: leading "::" + dotted tail)
      '/ip6/2001:db8::1/tcp/4001/ip4/10.0.0.1', // v4 anywhere poisons it
      '/dns4/example.com/tcp/443/wss', // no ip6 component at all
      '/memory/app', // memory is fixtures, not addressing
      'garbage',
      '',
    ]) {
      expect(isGlobalIp6Multiaddr(addr), addr).toBe(false)
    }
  })

  it('filters lists in order (the announce/ingest helper)', () => {
    const list = [
      '/ip6/fe80::1/tcp/1',
      '/ip6/2001:db8::1/tcp/4001',
      '/ip4/10.0.0.1/tcp/2',
      '/ip6/2001:db8::2/tcp/4002',
    ]
    expect(filterPolicyAddresses(list)).toEqual([
      '/ip6/2001:db8::1/tcp/4001',
      '/ip6/2001:db8::2/tcp/4002',
    ])
  })

  it('assertDialable throws the pinned SC-NET-1 error naming the relay tier', () => {
    expect(() => assertDialable('/ip4/1.2.3.4/tcp/9')).toThrowError(/SC-NET-1/)
    try {
      assertDialable('/ip4/1.2.3.4/tcp/9')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('SC-NET-1')
      expect((e as Error).message).toMatch(/relay/)
    }
    expect(() => assertDialable('/ip6/2001:db8::9/tcp/9')).not.toThrow()
  })
})

// 9.5 — the loopback allowance: DEFAULT OFF, and even when set it admits
// EXACTLY ::1. These rows are the "must not weaken the shipped policy" pin.
// The dev-only ANNOUNCE allowance extends the same flag to the announce /
// bootstrap sides via isDialableMultiaddr + filterDialableAddresses — the
// boolean twin of assertDialable — so the boundary rows below pin the SAME
// law on both spellings (one machine, real join flow over ::1). Record
// VALIDATION consumes the flag only through the non-consensus context
// (`allowLoopbackAddresses`); those boundaries are pinned in
// discovery-announcement.test.ts.
describe('9.5 — SUCCINCTCOIN_ALLOW_LOOPBACK (explicit test flag)', () => {
  const GLOBAL = '/ip6/2001:db8::9/tcp/9'
  const LOOPBACKS = ['/ip6/::1/tcp/9', '/ip6/0:0:0:0:0:0:0:1/tcp/9', '/ip6/::0:1/tcp/9']

  it('DEFAULT (flag unset): every loopback form throws SC-NET-1', () => {
    const had = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    delete process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    try {
      for (const addr of LOOPBACKS) expect(() => assertDialable(addr)).toThrowError(/SC-NET-1/)
    } finally {
      if (had !== undefined) process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = had
    }
  })

  it('FLAG SET: ::1 dials; EVERY other rejection still throws', () => {
    const had = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = '1'
    try {
      for (const addr of LOOPBACKS) expect(() => assertDialable(addr)).not.toThrow()
      expect(() => assertDialable(GLOBAL)).not.toThrow() // globals unaffected
      // The flag is EXACTLY ::1 — nothing else slips through:
      for (const addr of [
        '/ip4/1.2.3.4/tcp/9',
        '/ip6/::2/tcp/9', // neighbouring loopback-ish zero address
        '/ip6/fe80::1/tcp/9', // link-local
        '/ip6/fd00::1/tcp/9', // ULA
        '/ip6/::ffff:1.2.3.4/tcp/9', // v4-mapped
        '/ip6/fe80::1/tcp/42', // link-local ending in :1 — near-miss, still rejected
      ])
        expect(() => assertDialable(addr)).toThrowError(/SC-NET-1/)
    } finally {
      if (had === undefined) delete process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
      else process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = had
    }
  })

  it('isDialableMultiaddr is the boolean TWIN of assertDialable (flag unset)', () => {
    const had = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    delete process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    try {
      expect(isDialableMultiaddr(GLOBAL)).toBe(true)
      for (const addr of LOOPBACKS) expect(isDialableMultiaddr(addr)).toBe(false)
      // Identical verdicts to the throwing twin, everywhere:
      for (const addr of [GLOBAL, ...LOOPBACKS, '/ip4/1.2.3.4/tcp/9', 'garbage']) {
        let throws = false
        try {
          assertDialable(addr)
        } catch {
          throws = true
        }
        expect(isDialableMultiaddr(addr), addr).toBe(!throws)
      }
    } finally {
      if (had !== undefined) process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = had
    }
  })

  it('announce allowance (FLAG SET): ::1 passes the twin + filter; nothing else does', () => {
    const had = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = '1'
    try {
      for (const addr of LOOPBACKS) expect(isDialableMultiaddr(addr)).toBe(true)
      // ONLY pure loopback — the strict families stay rejected WITH the flag:
      for (const addr of [
        '/ip4/1.2.3.4/tcp/9',
        '/ip6/::2/tcp/9',
        '/ip6/fe80::1/tcp/9',
        '/ip6/fd00::1/tcp/9',
        '/ip6/::ffff:1.2.3.4/tcp/9',
        '/ip6zone/en0/ip6/fe80::1/tcp/1',
        '/ip6zone/en0/ip6/::1/tcp/1', // zone-scoped loopback is NOT the bare ::1
        'garbage',
      ])
        expect(isDialableMultiaddr(addr), addr).toBe(false)
      // The list filter the announce/bootstrap seams consume: order kept,
      // global + loopback survive, junk dies.
      expect(
        filterDialableAddresses([
          '/ip6/fe80::1/tcp/1',
          GLOBAL,
          '/ip6/::1/tcp/4001/p2p/PeerA',
          '/ip4/10.0.0.1/tcp/2',
        ]),
      ).toEqual([GLOBAL, '/ip6/::1/tcp/4001/p2p/PeerA'])
    } finally {
      if (had === undefined) delete process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
      else process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = had
    }
  })

  it('filterDialableAddresses DEFAULT (flag unset) equals filterPolicyAddresses', () => {
    const had = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    delete process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    try {
      const list = ['/ip6/::1/tcp/1', '/ip6/2001:db8::1/tcp/1', '/ip4/1.2.3.4/tcp/1']
      expect(filterDialableAddresses(list)).toEqual(filterPolicyAddresses(list))
      expect(filterDialableAddresses(list)).toEqual(['/ip6/2001:db8::1/tcp/1'])
    } finally {
      if (had !== undefined) process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = had
    }
  })
})

describe('post-9.5 — classifyIp6Address (diagnostics share policy math)', () => {
  it('CLASSIFY_VECTORS: every class at its boundaries, malformed never throws', () => {
    // Global 2000::/3 boundaries:
    expect(classifyIp6Address('2001:db8::1')).toBe('global')
    expect(classifyIp6Address('2000::')).toBe('global')
    expect(classifyIp6Address('3fff::1')).toBe('global')
    expect(classifyIp6Address('4000::1')).toBe('other') // just past /3
    expect(classifyIp6Address('1fff::1')).toBe('other') // just before
    // Link-local fe80::/10 boundaries:
    expect(classifyIp6Address('fe80::1')).toBe('linkLocal')
    expect(classifyIp6Address('febf::ffff')).toBe('linkLocal')
    expect(classifyIp6Address('fec0::1')).toBe('other') // old site-local, gone
    // Unique-local fc00::/7 boundaries:
    expect(classifyIp6Address('fc00::1')).toBe('uniqueLocal')
    expect(classifyIp6Address('fd12:3456::78')).toBe('uniqueLocal')
    expect(classifyIp6Address('fe00::1')).toBe('other') // just past /7
    // Loopback (the 9.5 dev class) + compressed forms:
    expect(classifyIp6Address('::1')).toBe('loopback')
    expect(classifyIp6Address('0:0:0:0:0:0:0:1')).toBe('loopback')
    expect(classifyIp6Address('::2')).toBe('other') // neighbour is NOT loopback
    expect(classifyIp6Address('::')).toBe('other') // unspecified is not loopback
    // v4-mapped ::ffff:1.2.3.4 — first hextet 0xffff → other (never global):
    expect(classifyIp6Address('::ffff:1.2.3.4')).toBe('other')
    // Malformed / zone-bearing → 'other', NEVER a throw:
    for (const bad of ['', 'nope', 'fe80::1%en0', '::1::2', '12345::', '/ip6/::1'])
      expect(classifyIp6Address(bad)).toBe('other')
  })
})

describe('10.2 — circuit addresses through the policy (R3: NO special case)', () => {
  it('CIRCUIT_ROWS: valid iff EVERY /ip6 hop is global — relay first among them', () => {
    // The general rule (≥1 global /ip6, no /ip4/ip6zone anywhere) is
    // strictly stronger than "first hop global": the WHOLE chain is judged,
    // so dial/announce/ingest inherit circuit acceptance from ONE predicate.
    expect(
      isGlobalIp6Multiaddr('/ip6/2001:db8::9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'),
    ).toBe(true)
    // Junk relay hops — every shape the tier must refuse:
    for (const bad of [
      '/ip4/1.2.3.4/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer', // v4 relay
      '/ip6/fe80::9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer', // link-local relay
      '/ip6/fd00::9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer', // ULA relay
      '/ip6/2001:db8::9%en0/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer', // zone
      '/ip6/2001:db8::9/tcp/4001/p2p/QmRelay/p2p-circuit/ip4/5.6.7.8/p2p/QmPeer', // v4 after circuit
      '/p2p/QmRelay/p2p-circuit/p2p/QmPeer', // peer-id-only: NO /ip6 at all
    ])
      expect(isGlobalIp6Multiaddr(bad)).toBe(false)
    // assertDialable agrees (same predicate, dial boundary):
    expect(() =>
      assertDialable('/ip6/2001:db8::9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'),
    ).not.toThrow()
    expect(() =>
      assertDialable('/ip6/fe80::9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'),
    ).toThrowError(/SC-NET-1/)
  })

  it('SLASH64: a relayed entry keys on the RELAY /64 (honest single point)', () => {
    expect(
      ip6Slash64('/ip6/2001:db8:99::5/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'),
    ).toBe('2001:db8:99:0')
    // The peer's own addressing after /p2p-circuit changes NOTHING: the
    // FIRST global /ip6 (the relay) wins, exactly as the book needs it.
    expect(
      ip6Slash64('/ip6/2001:db8:99::5/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer') ===
        ip6Slash64('/ip6/2001:db8:99::5/tcp/4001/p2p/QmRelay'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 11.1 — the HOP LAW (amendment 2026-10-21): a /p2p-circuit address is only
// ever as public as its hop — global scope in EITHER family. The tables below
// ARE the law; every boundary consumes these predicates.
// ---------------------------------------------------------------------------
describe('11.1 — relay-hop address policy (one predicate, every boundary)', () => {
  const V4_HOP = '/ip4/203.0.113.9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'
  const V6_HOP = '/ip6/2001:db8::1/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'

  it('HOP_ROWS: isGlobalHopMultiaddr — circuit-shaped with a global-scope FIRST IP', () => {
    // A v6 twin of the SAME /64 groups identically (family-tagged keys).
    expect(isGlobalHopMultiaddr(V4_HOP)).toBe(true)
    expect(isGlobalHopMultiaddr(V6_HOP)).toBe(true)
    // Any p2p-circuit with a global first IP passes the HOP predicate — even
    // shapes the strict CIRCUIT validator below rejects (multi-hop, tail IPs).
    // The hop predicate alone never decides acceptance; isAddressable does.
    expect(isGlobalHopMultiaddr('/ip4/203.0.113.9/tcp/4001/p2p/QmR/p2p-circuit/ip4/1.2.3.4/p2p/QmP')).toBe(true)
    expect(
      isGlobalHopMultiaddr(
        '/ip6/2001:db8::1/tcp/1/p2p/QmA/p2p-circuit/ip6/2001:db8::2/tcp/2/p2p/QmB/p2p-circuit/p2p/QmC',
      ),
    ).toBe(true)
    // No circuit, no hop story (direct addresses are the DIRECT law's job):
    for (const direct of ['/ip4/203.0.113.9/tcp/4001', '/ip6/2001:db8::1/tcp/4001'])
      expect(isGlobalHopMultiaddr(direct), direct).toBe(false)
    // TWO IPs before the first separator are junk, not a hop (frozen matrix):
    expect(isGlobalHopMultiaddr('/ip4/1.1.1.1/ip4/2.2.2.2/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(false)
    // ANY ip6zone rejects, head OR tail (frozen: "any ip6zone rejects"):
    expect(isGlobalHopMultiaddr('/ip4/203.0.113.9/tcp/1/p2p/QmR/p2p-circuit/ip6zone/en0/p2p/P')).toBe(false)
    // Every non-global hop family rejects (the frozen reject list):
    for (const hop of [
      '/ip4/10.0.0.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC1918 10/8
      '/ip4/172.16.0.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC1918 172.16/12
      '/ip4/192.168.1.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC1918 192.168/16
      '/ip4/100.64.0.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // CGNAT 100.64/10
      '/ip4/100.127.255.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // CGNAT top edge
      '/ip4/127.0.0.1/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // loopback
      '/ip4/169.254.1.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // link-local
      '/ip4/0.0.0.0/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // this-network/bind
      '/ip4/224.0.0.1/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // multicast
      '/ip4/240.0.0.1/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // reserved >= 224/4
      '/ip6/fd00::9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC4193 ULA
      '/ip6/fe80::9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // v6 link-local
      '/ip6zone/en0/ip4/203.0.113.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // ANY zone
      '/p2p/QmR/p2p-circuit/p2p/QmP', // no IP at all
      'garbage',
      '',
    ])
      expect(isGlobalHopMultiaddr(hop), hop).toBe(false)
    // CGNAT / 172.16 boundary arithmetic: just OUTSIDE still global.
    expect(isGlobalHopMultiaddr('/ip4/100.63.255.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(true)
    expect(isGlobalHopMultiaddr('/ip4/100.128.0.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(true)
    expect(isGlobalHopMultiaddr('/ip4/172.15.0.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(true)
    expect(isGlobalHopMultiaddr('/ip4/172.32.0.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(true)
    expect(isGlobalHopMultiaddr('/ip4/1.1.1.1/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(true)
    expect(isGlobalHopMultiaddr('/ip4/223.255.255.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(true)
  })

  it('CIRCUIT_ROWS: isRelayHopCircuitMultiaddr — one global hop, NO IP in the tail', () => {
    expect(isRelayHopCircuitMultiaddr(V4_HOP)).toBe(true)
    expect(isRelayHopCircuitMultiaddr(V6_HOP)).toBe(true) // v6-hop regression: still valid
    for (const bad of [
      '/ip4/203.0.113.9/tcp/4001/p2p/QmR/p2p-circuit/ip4/1.2.3.4/p2p/QmP', // IP in tail
      '/ip4/1.1.1.1/ip4/2.2.2.2/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // TWO IPs in head
      '/ip4/10.0.0.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // non-global hop
      '/ip6/fd00::9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC4193 hop
      '/ip6zone/en0/ip4/203.0.113.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // zone
      '/p2p/QmR/p2p-circuit/p2p/QmP', // no IP at all
      // Multi-hop chained circuits are NOT this shape — they stay accepted
      // via the DIRECT all-/ip6 rule, never through here.
      '/ip6/2001:db8::1/tcp/1/p2p/QmA/p2p-circuit/ip6/2001:db8::2/tcp/2/p2p/QmB/p2p-circuit/p2p/QmC',
      // Direct addresses are the direct law's job — false by shape:
      '/ip4/203.0.113.9/tcp/4001',
      '/ip6/2001:db8::1/tcp/4001',
      'garbage',
    ])
      expect(isRelayHopCircuitMultiaddr(bad), bad).toBe(false)
  })

  it('COMBINED_ROWS: isAddressableMultiaddr = direct global /ip6 OR valid hop circuit', () => {
    // ACCEPT both families of the widened law:
    for (const ok of [
      '/ip6/2001:db8::1/tcp/4001', // direct v6 (unchanged)
      V6_HOP, // v6-hop circuit (unchanged verdict — passed via direct before)
      V4_HOP, // v4-hop circuit (NEW)
      '/ip4/203.0.113.9/tcp/4001/p2p/QmR/p2p-circuit', // tail may end AT the separator
      '/ip6/2001:db8::1/tcp/1/p2p/QmA/p2p-circuit/ip6/2001:db8::2/tcp/2/p2p/QmB/p2p-circuit/p2p/QmC', // multi-hop all-v6 — direct branch, NO accept→reject flip
    ])
      expect(isAddressableMultiaddr(ok), ok).toBe(true)
    // REJECT everything the strict law rejected, plus every hop violation:
    for (const bad of [
      '/ip4/203.0.113.9/tcp/4001', // DIRECT v4 stays rejected — always
      '/ip4/10.0.0.9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC1918 hop
      '/ip4/100.64.0.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // CGNAT hop
      '/ip4/127.0.0.1/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // loopback hop
      '/ip4/169.254.1.9/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // link-local hop
      '/ip4/0.0.0.0/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // unspecified hop
      '/ip4/224.0.0.1/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // multicast hop
      '/ip6/fd00::9/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP', // RFC4193 hop
      '/ip4/203.0.113.9/tcp/4001/p2p/QmR/p2p-circuit/ip4/1.2.3.4/p2p/QmP', // IP in tail
      '/ip4/1.1.1.1/ip4/2.2.2.2/tcp/1/p2p/QmR/p2p-circuit/p2p/QmP', // two IPs in head
      '/ip6zone/en0/ip6/fe80::1/tcp/1', // zone
      '/dns4/example.com/tcp/443/wss', // not an address this network routes
      '/memory/app',
      'garbage',
      '',
    ])
      expect(isAddressableMultiaddr(bad), bad).toBe(false)
  })

  it('NO FLIP: every 9.1/10.2 accepted shape still passes the direct predicate', () => {
    // The pinned widening guarantee: isGlobalIp6Multiaddr is byte-identical,
    // so anything accepted before is still accepted by the combined law.
    for (const addr of [
      '/ip6/2001:db8::1/tcp/4001',
      '/ip6/2001:db8:c0a8:1::/tcp/4001/p2p/12D3A/p2p-circuit/p2p/12D3B',
      '/ip6/2001:db8::9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer',
    ]) {
      expect(isGlobalIp6Multiaddr(addr), addr).toBe(true)
      expect(isAddressableMultiaddr(addr), addr).toBe(true)
    }
  })

  it('HOP_NETWORK_KEY: "6:<"/64>" and "4:a.b.c.0" group relays like networks', () => {
    expect(hopNetworkKey(V4_HOP)).toBe('4:203.0.113.0')
    // Same relay /24, different hosts/ports → ONE group (the book floor's pin):
    expect(
      hopNetworkKey('/ip4/203.0.113.77/tcp/9/p2p/QmOther/p2p-circuit/p2p/QmSelf'),
    ).toBe('4:203.0.113.0')
    // Different /24 → different group:
    expect(
      hopNetworkKey('/ip4/203.0.114.9/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmPeer'),
    ).toBe('4:203.0.114.0')
    // v6 reuses the existing /64 math, family-tagged (never collides with v4):
    expect(hopNetworkKey(V6_HOP)).toBe('6:2001:db8:0:0')
    expect(hopNetworkKey('/ip6/2001:db8:99::5/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmP')).toBe(
      '6:2001:db8:99:0',
    )
    // The v6 key is exactly ip6Slash64 with the family tag:
    const slash = ip6Slash64(V6_HOP)
    expect(slash === null ? slash : `6:${slash}`).toBe(hopNetworkKey(V6_HOP))
    // Defensive nulls (the book groups these ungrouped, as today):
    for (const nulled of [
      '/ip4/10.0.0.1/tcp/1',
      '/ip6/fe80::1/tcp/1',
      '/dns4/example.com/tcp/1',
      '/p2p/QmR/p2p-circuit/p2p/QmP',
      '/ip6zone/en0/ip6/2001:db8::1/tcp/1',
      'garbage',
      '',
    ])
      expect(hopNetworkKey(nulled), nulled).toBeNull()
    // The FIRST IP decides, even off-policy later: a v4-hop circuit's tail IP
    // never re-keys it (the tail shape is the CIRCUIT validator's job).
    expect(
      hopNetworkKey('/ip4/203.0.113.9/tcp/4001/p2p/QmR/p2p-circuit/ip4/10.0.0.1/p2p/QmP'),
    ).toBe('4:203.0.113.0')
  })

  it('SC-NET-1 (11.1): the message now NAMES the hop rule; relay + code pins hold', () => {
    try {
      assertDialable('/ip4/1.2.3.4/tcp/9')
      expect.unreachable()
    } catch (e) {
      const err = e as Error & { code?: string }
      expect(err.code).toBe('SC-NET-1')
      expect(err.message).toMatch(/SC-NET-1/)
      expect(err.message).toMatch(/relay/i)
      expect(err.message).toMatch(/p2p-circuit/) // the hop rule is named
      expect(err.message).toMatch(/global-scope hop/)
    }
    // Dial law UNCHANGED: direct v6 dials, direct v4 never does. (Holding a
    // seed IS dialing a v4 hop — that switch is story 11.2's adapter work.)
    expect(() => assertDialable('/ip6/2001:db8::9/tcp/9')).not.toThrow()
    expect(() => assertDialable('/ip4/1.2.3.4/tcp/9')).toThrowError(/SC-NET-1/)
  })
})
