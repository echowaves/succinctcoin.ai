/**
 * Post-9.5 user-report follow-up — `inviteDiagnostics` (the "why no invite
 * yet?" data): the pure classifier over an `os.networkInterfaces()`-shaped
 * table. Rows pinned:
 *
 *   DIAG_GLOBAL      a global address flips `hasGlobal` (panel promises the
 *                    next announce window);
 *   DIAG_LINK_LOCAL  the user's actual machine: fe80:: only (+ ::1) — no
 *                    global, and the link-local row is what the panel shows;
 *   DIAG_OVERLAY     Tailscale-class fd00:: present but no global — called
 *                    out separately (the classic false hope);
 *   DIAG_V4_ONLY     an IPv4-only machine counts zero of everything v6;
 *   DIAG_ZONE        macOS zone ids (`fe80::1%en0`) classify, not 'other';
 *   DIAG_FAMILY      legacy numeric `family: 6` entries count too.
 */
import { describe, expect, it } from 'vitest'

import { inviteDiagnostics } from '../src/main/invite-diagnostics.js'
import type { Ip6InterfaceTable } from '../src/main/invite-diagnostics.js'

const v6 = (...addresses: string[]): Ip6InterfaceTable => ({
  en0: addresses.map((address) => ({ address, family: 'IPv6' })),
})

describe('post-9.5 — inviteDiagnostics (the why-no-invite data)', () => {
  it('DIAG_GLOBAL: one global address flips hasGlobal (all counts pinned)', () => {
    const d = inviteDiagnostics(v6('2001:db8::5', 'fe80::1%en0'))
    expect(d).toEqual({
      hasGlobal: true,
      globalCount: 1,
      linkLocalCount: 1,
      uniqueLocalCount: 0,
      loopbackCount: 0,
      otherCount: 0,
    })
  })

  it('DIAG_LINK_LOCAL: the reported machine — fe80 + ::1 only ⇒ no global', () => {
    const d = inviteDiagnostics({
      lo0: [
        { address: '::1', family: 'IPv6' },
        { address: 'fe80::1%lo0', family: 'IPv6' },
      ],
      en0: [
        { address: '192.168.1.10', family: 'IPv4' },
        { address: 'fe80::ec:b7dc:d381:1291%en0', family: 'IPv6' },
      ],
    })
    expect(d.hasGlobal).toBe(false)
    expect(d.linkLocalCount).toBe(2)
    expect(d.loopbackCount).toBe(1)
    expect(d.otherCount).toBe(0)
  })

  it('DIAG_OVERLAY: fd00:: (VPN mesh) is unique-local, never hope', () => {
    const d = inviteDiagnostics(v6('fd7e:1234:abcd::9'))
    expect(d.hasGlobal).toBe(false)
    expect(d.uniqueLocalCount).toBe(1)
  })

  it('DIAG_V4_ONLY: an IPv4-only machine counts zero v6', () => {
    const d = inviteDiagnostics({
      en0: [{ address: '10.0.0.5', family: 'IPv4' }],
    })
    expect(d).toEqual({
      hasGlobal: false,
      globalCount: 0,
      linkLocalCount: 0,
      uniqueLocalCount: 0,
      loopbackCount: 0,
      otherCount: 0,
    })
  })

  it('DIAG_ZONE + DIAG_FAMILY: %zone strips before classify (any class); numeric family works', () => {
    const d = inviteDiagnostics({
      utun3: [
        { address: 'fe80::ce81:b1c:bd2c:69e%utun3', family: 6 },
        // strip-before-classify must hold for the hasGlobal path too (F3):
        { address: '2001:db8::7%en0', family: 'IPv6' },
      ],
    })
    expect(d.linkLocalCount).toBe(1)
    expect(d.hasGlobal).toBe(true)
    expect(d.otherCount).toBe(0)
  })

  it('DIAG_EMPTY: an empty table is all-zero, never a throw', () => {
    expect(inviteDiagnostics({}).hasGlobal).toBe(false)
  })
})
