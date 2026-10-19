/**
 * Post-9.5 — `describeIpv6` (the pure renderer hint): one sentence per IPv6
 * situation, most-hopeful first. Rows pinned: global ⇒ "wait for the window";
 * overlay wins over link-local (Tailscale false hope gets its own row);
 * link-local-only ⇒ "no global IPv6"; nothing ⇒ "enable IPv6". Loopback /
 * other counts never change the sentence (a lone ::1 is not a situation).
 */
import { describe, expect, it } from 'vitest'

import { describeIpv6 } from '../src/renderer/ipv6-hint.js'
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
