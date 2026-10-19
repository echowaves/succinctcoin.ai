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
  filterPolicyAddresses,
  isGlobalIp6Multiaddr,
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

// 9.5 — the probe-only loopback allowance: DEFAULT OFF, and even when set it
// admits EXACTLY ::1. These two rows are the "must not weaken the shipped
// policy" pin for the two-device proof.
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
