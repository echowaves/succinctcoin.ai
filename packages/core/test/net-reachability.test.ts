/**
 * 10.1 — reachability truth rows (`net/reachability.ts` + adapter wiring).
 *
 *   TRACKER_ROWS      evidence model: no evidence ⇒ 'unknown'; ANY reachable
 *                     ⇒ 'reachable'; all-unreachable ⇒ 'unreachable'; latest
 *                     verdict per address wins.
 *   FILTER_ROWS       honesty filter: unknown passes (= today's set pinned),
 *                     proven-unreachable direct drops, CIRCUIT never drops,
 *                     empty in ⇒ empty out.
 *   AUTONAT_ENABLED   pure config resolution — memory NEVER registers AutoNAT
 *                     (AD-10 pin), tcp defaults on, explicit false opts out.
 *   ADAPTER_INERT     memory adapter, no seam: reachability() 'unknown'
 *                     before AND after start; listenAddresses() unchanged
 *                     (byte-equal to the raw multiaddrs — pre-10.1 behavior).
 *   ADAPTER_SEAM      injected reachabilitySource drives honesty end-to-end
 *                     headless: report unreachable ⇒ address vanishes from
 *                     listenAddresses() + aggregate flips; reachable ⇒ back;
 *                     stop() unsubscribes (post-stop reports are inert) and a
 *                     restart re-probes from 'unknown'.
 */
import { describe, expect, it } from 'vitest'

import { createNetAdapter } from '../src/net/adapter.js'
import {
  autoNatEnabledFor,
  createReachabilityTracker,
  filterHonestAddresses,
  isCircuitAddressText,
  normalizeAddressKey,
} from '../src/net/reachability.js'

const DIRECT = '/ip6/2001:db8::5/tcp/4001/p2p/PeerA'
const CIRCUIT =
  '/ip6/2001:db8::9/tcp/4001/p2p/RelayX/p2p-circuit/p2p/PeerA'

describe('10.1 — reachability tracker (pure evidence model)', () => {
  it('TRACKER_ROWS: unknown default, any-reachable wins, latest verdict wins', () => {
    const t = createReachabilityTracker()
    expect(t.aggregate()).toBe('unknown') // no evidence yet
    expect(t.state(DIRECT)).toBe('unknown')
    t.observe(DIRECT, false)
    expect(t.state(DIRECT)).toBe('unreachable')
    expect(t.aggregate()).toBe('unreachable')
    t.observe(CIRCUIT, true)
    expect(t.aggregate()).toBe('reachable') // ANY reachable wins
    t.observe(CIRCUIT, false)
    expect(t.aggregate()).toBe('unreachable') // latest verdict per addr wins
  })

  it('NORMALIZE: raw listen addr and /p2p-encapsulated form are ONE key', () => {
    // AutoNAT events report `/ip6/…/tcp/N`; the announce filter sees the
    // same address with `/p2p/<self>` appended (review F1). One evidence
    // entry must serve both spellings.
    expect(normalizeAddressKey(DIRECT)).toBe('/ip6/2001:db8::5/tcp/4001')
    expect(normalizeAddressKey('/ip6/2001:db8::5/tcp/4001')).toBe(
      '/ip6/2001:db8::5/tcp/4001',
    )
    const t = createReachabilityTracker()
    t.observe('/ip6/2001:db8::5/tcp/4001', false) // raw form (AutoNAT)
    expect(t.state(DIRECT)).toBe('unreachable') // suffixed form agrees
    expect(filterHonestAddresses([DIRECT], t.view())).toEqual([])
  })

  it('AGGREGATE_SEMANTICS: evidence for a NON-advertised addr flips the '
     + 'aggregate but touches no announcement (documented, review F3)', () => {
    const t = createReachabilityTracker()
    // An OBSERVED address (never advertised) probes dead…
    t.observe('/ip6/2001:db8::99/tcp/9', false)
    expect(t.aggregate()).toBe('unreachable') // truth about US, not the announce set
    // …while the advertised direct addr has no evidence and stays announced.
    expect(filterHonestAddresses([DIRECT], t.view())).toEqual([DIRECT])
  })

  it('FILTER_ROWS: only PROVEN-unreachable direct addresses drop', () => {
    // Keys are NORMALIZED (what a tracker's view() actually contains —
    // AutoNAT reports raw listen addrs; see `normalizeAddressKey`).
    const seen = new Map<string, boolean>([
      [normalizeAddressKey(DIRECT), false],
      ['/ip6/2001:db8::7/tcp/1', true],
    ])
    // DIRECT proven dead; CIRCUIT reported-dead below but NEVER drops;
    // an unknown address passes (= fresh-boot behavior pinned).
    const all = [DIRECT, CIRCUIT, '/ip6/2001:db8::7/tcp/1', '/ip6/2001:db8::8/tcp/2']
    expect(filterHonestAddresses(all, seen)).toEqual([
      CIRCUIT,
      '/ip6/2001:db8::7/tcp/1',
      '/ip6/2001:db8::8/tcp/2',
    ])
    const circuitDead = new Map(seen).set(CIRCUIT, false)
    expect(filterHonestAddresses([CIRCUIT], circuitDead)).toEqual([CIRCUIT])
    expect(filterHonestAddresses([], seen)).toEqual([])
  })

  it('IS_CIRCUIT: component-level match only', () => {
    expect(isCircuitAddressText(CIRCUIT)).toBe(true)
    expect(isCircuitAddressText(DIRECT)).toBe(false)
    // A host literally named "p2p-circuit-x" is NOT the component:
    expect(isCircuitAddressText('/memory/p2p-circuit-x')).toBe(false)
  })

  it('AUTONAT_ENABLED: memory NEVER, tcp default-on / explicit-off', () => {
    expect(autoNatEnabledFor('tcp', undefined)).toBe(true)
    expect(autoNatEnabledFor('tcp', false)).toBe(false)
    expect(autoNatEnabledFor('tcp', true)).toBe(true)
    expect(autoNatEnabledFor('memory', undefined)).toBe(false)
    expect(autoNatEnabledFor('memory', true)).toBe(false) // AD-10 pin
  })
})

describe('10.1 — adapter honesty wiring (memory transport, headless)', () => {
  it('ADAPTER_INERT: unknown before/after start; listenAddresses unchanged', async () => {
    const a = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/reach-inert',
      protocolIdentityId: 'aa'.repeat(32),
    })
    expect(a.reachability()).toBe('unknown') // no SC-NET-1 before start
    await a.start()
    try {
      expect(a.reachability()).toBe('unknown') // memory never probes
      // EXACT set (review F4): the one bound listen address, encapsulated
      // with the transport peer id — nothing dropped, nothing invented.
      expect(a.listenAddresses()).toEqual([
        expect.stringMatching(/^\/memory\/reach-inert\/p2p\/.+$/),
      ])
    } finally {
      await a.stop()
    }
  })

  it('ADAPTER_SEAM: injected evidence drives listenAddresses + aggregate', async () => {
    let report: ((addr: string, reachable: boolean) => void) | null = null
    let unsubbed = 0
    const a = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/reach-seam',
      protocolIdentityId: 'bb'.repeat(32),
      reachabilitySource: (cb) => {
        report = cb
        return () => {
          unsubbed += 1
        }
      },
    })
    // Typed seam handle (review F6): one narrowing point instead of casts.
    const send = (addr: string, reachable: boolean): void => {
      if (report === null) throw new Error('seam not subscribed')
      report(addr, reachable)
    }
    await a.start()
    let addr = ''
    try {
      addr = a.listenAddresses()[0] as string
      expect(a.reachability()).toBe('unknown') // seam subscribed, silent
      send(addr, false)
      expect(a.listenAddresses()).not.toContain(addr) // honesty!
      expect(a.reachability()).toBe('unreachable')
      send(addr, true)
      expect(a.listenAddresses()).toContain(addr) // evidence flipped back
      expect(a.reachability()).toBe('reachable')
      send(addr, false) // leave proven-dead: restart must clear it (F4)
    } finally {
      await a.stop()
    }
    expect(unsubbed).toBe(1) // stop() unsubscribed (no leak)
    // Post-stop reports never throw (the stale tracker just absorbs them):
    expect(() => {
      send('/memory/reach-seam', false)
    }).not.toThrow()
    await a.start()
    try {
      expect(a.reachability()).toBe('unknown') // fresh evidence per node
      // The proven-dead address is BACK (fresh tracker). Compare WITHOUT the
      // peer part: identity regenerates per node, so the suffix differs.
      expect(
        a.listenAddresses().some((x) => x.startsWith(`${normalizeAddressKey(addr)}/p2p/`)),
      ).toBe(true)
      expect(unsubbed).toBe(1) // restart re-subscribed (still only one unsub)
    } finally {
      await a.stop()
    }
    expect(unsubbed).toBe(2) // second stop() unsubscribed too (no leak)
  })
})
