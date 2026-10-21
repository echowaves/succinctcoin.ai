/**
 * Post-9.5 — `describeIpv6` (the pure renderer hint): one sentence per IPv6
 * situation, most-hopeful first. Rows pinned: global ⇒ "wait for the window";
 * overlay wins over link-local (Tailscale false hope gets its own row);
 * link-local-only ⇒ "no global IPv6"; nothing ⇒ "enable IPv6". Loopback /
 * other counts never change the sentence (a lone ::1 is not a situation).
 */
import { describe, expect, it } from 'vitest'

import {
  describeCircuitInvite,
  describeIpv6,
  describeLoopbackInvite,
} from '../src/renderer/ipv6-hint.js'
import type { InviteDiagnostics } from '../src/renderer/ipv6-hint.js'

const d = (over: Partial<InviteDiagnostics>): InviteDiagnostics => ({
  hasGlobal: false,
  globalCount: 0,
  linkLocalCount: 0,
  uniqueLocalCount: 0,
  loopbackCount: 1, // every machine has ::1 — never decisive
  otherCount: 0,
  ...over,
})

describe('post-9.5 — describeIpv6 (the why-no-invite sentence)', () => {
  it('HINT_GLOBAL: a global address means wait, not fix', () => {
    expect(describeIpv6(d({ hasGlobal: true, globalCount: 1 }))).toMatch(
      /next announce window/i,
    )
  })

  it('HINT_OVERLAY_WINS: fd00:: outranks the link-local row', () => {
    const s = describeIpv6(d({ uniqueLocalCount: 2, linkLocalCount: 3 }))
    expect(s).toMatch(/fd00/)
    expect(s).not.toMatch(/link-local/)
  })

  it('HINT_LINK_LOCAL: the reported machine (fe80:: only)', () => {
    expect(describeIpv6(d({ linkLocalCount: 2 }))).toMatch(/link-local/)
  })

  it('HINT_OTHER: unclassifiable addresses never claim "no interfaces" (F1)', () => {
    const s = describeIpv6(d({ otherCount: 2 }))
    expect(s).toMatch(/none usable/)
    expect(s).not.toMatch(/No active IPv6 interfaces/)
  })

  it('HINT_NONE: no IPv6 interfaces at all', () => {
    expect(describeIpv6(d({}))).toMatch(/enable IPv6 first/i)
  })
})

// Dev-only announce allowance: an invite beside a machine with NO global
// IPv6 is only possible under SUCCINCTCOIN_ALLOW_LOOPBACK — the panel must
// say the invite is loopback-local. With a global, it stays silent (the
// normal shipped case never sees this warning).
describe('dev-only announce allowance — describeLoopbackInvite', () => {
  it('SILENT_WITH_GLOBAL: the honest default ships no warning', () => {
    expect(describeLoopbackInvite(d({ hasGlobal: true, globalCount: 1 }))).toBeNull()
  })

  it('WARNS_WITHOUT_GLOBAL: covers BOTH honest readings — dev loopback and stale', () => {
    const s = describeLoopbackInvite(d({ linkLocalCount: 2 }))
    expect(s).not.toBeNull()
    expect(s).toMatch(/no global IPv6/)
    expect(s).toMatch(/only on this machine/) // dev invite: local-only truth
    expect(s).toMatch(/stale/) // older invite: the other honest reading
    expect(s).toMatch(/SUCCINCTCOIN_ALLOW_LOOPBACK/)
  })
})

// Ticket 7: an invite whose address runs through /p2p-circuit RIDES A RELAY —
// the panel must say so (distinct from the loopback warning: a circuit is
// healthy, it just costs a hop). The hint is a decoded-bytes scan (thin-client
// rule: no core import), so these rows encode invite-shaped payloads directly.
describe('ticket 7 — describeCircuitInvite (the rides-a-relay hint)', () => {
  const enc = (body: string): string =>
    'scinvite:v1:' + Buffer.from(body, 'utf8').toString('base64url')

  it('CIRCUIT: a /p2p-circuit address ⇒ the honest ride-a-relay sentence', () => {
    const s = describeCircuitInvite(
      enc('/ip6/2001:db8::9/tcp/1/p2p/RELAY/p2p-circuit/p2p/FRIEND'),
    )
    expect(s).not.toBeNull()
    expect(s).toMatch(/rides a relay/)
    expect(s).toMatch(/NAT/)
  })

  it('DIRECT_SILENT: a plain direct invite stays quiet (the shipped default)', () => {
    expect(describeCircuitInvite(enc('/ip6/2001:db8::5/tcp/4001/p2p/FRIEND'))).toBeNull()
  })

  it('MALFORMED: junk, wrong prefix, or oversize ⇒ null — the parser judges, never the hint', () => {
    expect(describeCircuitInvite('')).toBeNull()
    expect(describeCircuitInvite('scinvite:v1:!!!not base64!!!')).toBeNull()
    expect(describeCircuitInvite('something else entirely')).toBeNull()
    expect(describeCircuitInvite('scinvite:v1:' + 'A'.repeat(5000))).toBeNull()
  })
})
