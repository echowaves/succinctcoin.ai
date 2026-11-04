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

  it('HINT_RELAY_PATH (11.3): the no-global rows name the honest second path', () => {
    for (const [what, s] of [
      ['overlay', describeIpv6(d({ uniqueLocalCount: 2 }))],
      ['link-local', describeIpv6(d({ linkLocalCount: 2 }))],
      ['none', describeIpv6(d({}))],
    ] as const) {
      expect(s, what).toMatch(/relay hop/i)
      expect(s, what).toMatch(/SUCCINCTCOIN_RELAY_SEEDS/)
      expect(s, what).toMatch(/\/p2p-circuit/) // the invite shape it produces
    }
    // The hopeful global row stays about WAITING — no relay lecture there.
    expect(describeIpv6(d({ hasGlobal: true, globalCount: 1 }))).not.toMatch(/relay hop/i)
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

// Ticket 13.1 (WB-1): `scinvite:v2:` carries the v1 record inside an
// InviteBundle plus candidate addresses. The hint stays thin-client (no
// core import), so these rows hand-roll the two wire fields they need —
// field 1 = primary, field 2 = candidates (length-delimited). The scan is
// PRIMARY-ONLY: candidates are unverified until 13.3 and never earn a hint.
describe('ticket 13.1 — describeCircuitInvite speaks scinvite:v2', () => {
  const varint = (n: number): Buffer => {
    const out: number[] = []
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80)
      n >>>= 7
    }
    out.push(n)
    return Buffer.from(out)
  }
  const strField = (field: number, s: string): Buffer =>
    Buffer.concat([varint(field * 8 + 2), varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')])
  const msgField = (field: number, m: Buffer): Buffer =>
    Buffer.concat([varint(field * 8 + 2), varint(m.length), m])
  const primary = (addr: string): Buffer =>
    Buffer.concat([strField(1, 'ab'.repeat(32)), strField(2, addr)])
  const v2 = (primaryAddr: string | null, candidateAddr?: string): string => {
    const parts: Buffer[] = []
    if (primaryAddr !== null) parts.push(msgField(1, primary(primaryAddr)))
    if (candidateAddr !== undefined) parts.push(msgField(2, strField(1, candidateAddr)))
    return 'scinvite:v2:' + Buffer.concat(parts).toString('base64url')
  }

  it('V2_CIRCUIT: a /p2p-circuit PRIMARY ⇒ the ride-a-relay sentence', () => {
    const s = describeCircuitInvite(
      v2('/ip6/2001:db8::9/tcp/1/p2p/RELAY/p2p-circuit/p2p/FRIEND'),
    )
    expect(s).not.toBeNull()
    expect(s).toMatch(/rides a relay/)
  })

  it('V2_DIRECT_SILENT: only the PRIMARY is scanned — a circuit CANDIDATE stays quiet', () => {
    expect(
      describeCircuitInvite(
        v2('/ip6/2001:db8::5/tcp/4001/p2p/FRIEND', '/ip6/2001:db8::9/tcp/1/p2p/R/p2p-circuit'),
      ),
    ).toBeNull()
  })

  it('V2_UPPERCASE: the paste-tolerant prefix still hints (the parser accepts it too)', () => {
    const text = v2('/ip6/2001:db8::9/tcp/1/p2p/RELAY/p2p-circuit/p2p/FRIEND')
    expect(describeCircuitInvite('SCINVITE:V2:' + text.slice('scinvite:v2:'.length))).not.toBeNull()
  })

  it('V2_MALFORMED: junk body or a bundle without a primary ⇒ null', () => {
    expect(describeCircuitInvite('scinvite:v2:!!!not base64!!!')).toBeNull()
    expect(describeCircuitInvite(v2(null, '/ip6/2001:db8::9/tcp/1/p2p/R/p2p-circuit'))).toBeNull()
  })
})
