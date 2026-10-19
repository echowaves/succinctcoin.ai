/**
 * `app/main/invite-diagnostics` — WHY does this node have no invite?
 * (post-9.5 user report: "No invite yet … it never gets the ipv6 address").
 *
 * The message is honest but incomplete: announcing requires a global IPv6
 * (`filterPolicyAddresses` over the adapter's listen addresses), and most
 * home machines simply have none — only `fe80::` link-local plus maybe a
 * VPN-overlay `fd00::`. This module classifies what the machine ACTUALLY
 * has so the panel can say which situation you are in. Policy stays owned
 * by the core (`classifyIp6Address` is the same top-bit math the announce
 * filter uses — diagnostics and policy cannot disagree, E7).
 *
 * PURE (AD-1): NO `electron` import; the interface table is passed IN (the
 * glue calls `os.networkInterfaces()`); the output is plain JSON — counts
 * only, no hostnames, no MACs, no key material (AD-11).
 */
import { classifyIp6Address } from '@succinctcoin/core'

/** One address row of an `os.networkInterfaces()`-shaped table (structural
 * subset — the real type is assignable to this, tests pass fixtures). */
export interface Ip6InterfaceEntry {
  address: string
  /** Node's `family` across versions: `'IPv6' | 'IPv4'` (or legacy 6 | 4). */
  family: string | number
}

/** The table shape (`os.networkInterfaces()` is assignable to it). */
export type Ip6InterfaceTable = Partial<
  Record<string, readonly Ip6InterfaceEntry[]>
>

/** What the machine has, per IPv6 class — the invite panel's whole data
 * need (plain JSON across IPC; counts, never addresses). */
export interface InviteDiagnostics {
  /** True iff at least one global (2000::/3) address exists — then the
   * panel can promise the invite is coming next announce window. */
  hasGlobal: boolean
  globalCount: number
  linkLocalCount: number
  uniqueLocalCount: number
  loopbackCount: number
  /** Anything unclassifiable (incl. zone-bearing text after stripping). */
  otherCount: number
}

function isV6Entry(entry: Ip6InterfaceEntry): boolean {
  return entry.family === 'IPv6' || entry.family === 6
}

/**
 * Classify every IPv6 address on the machine. Zone ids (`fe80::1%en0` —
 * what macOS returns for link-locals) are stripped before classification;
 * the core classifier deliberately rejects them (policy input is zoneless).
 */
export function inviteDiagnostics(
  interfaces: Ip6InterfaceTable,
): InviteDiagnostics {
  const counts = {
    global: 0,
    linkLocal: 0,
    uniqueLocal: 0,
    loopback: 0,
    other: 0,
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!isV6Entry(entry)) continue
      const [address] = entry.address.split('%')
      counts[classifyIp6Address(address ?? '')] += 1
    }
  }
  return {
    hasGlobal: counts.global > 0,
    globalCount: counts.global,
    linkLocalCount: counts.linkLocal,
    uniqueLocalCount: counts.uniqueLocal,
    loopbackCount: counts.loopback,
    otherCount: counts.other,
  }
}
