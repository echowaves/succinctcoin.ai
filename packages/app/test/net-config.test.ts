/**
 * Story 7.2 matrix — the PURE net-config seam under PLAIN NODE (AD-10: no
 * electron, no sockets; the seam has type-only core imports, so this suite
 * runs it directly). `defaultNetConfig(genesis, identityId)` is the ONE
 * origin of the app's boot-time net config (R1): the REAL stack — tcp,
 * ephemeral listen, mDNS on, bootstrap from genesis — and the isolated
 * in-memory transport is unreachable from it (test injection only).
 *
 *   NET_TCP_MDNS_LAN_ONLY      (AC1) a LAN-only genesis (`bootstrap: []`,
 *                                valid post-7.1) yields EXACTLY
 *                                `{ transport: 'tcp', listenAddress:
 *                                '/ip6/::/tcp/0', mdns: false,
 *                                bootstrap: [], protocolIdentityId }` —
 *                                tcp is selected, the memory transport is
 *                                NEVER returned (R1). 9.1 IPv6-only: the
 *                                bind is v6 (`::` dual-stack socket, policy
 *                                at every boundary) and mDNS DEFAULTS OFF
 *                                (opt-in row below).
 *   BOOTSTRAP_VERBATIM         (AC1) a genesis listing public peers passes
 *                                the list through VERBATIM (same reference
 *                                — no copy, no filter, no reorder; the
 *                                adapter's own gate wires @libp2p/bootstrap
 *                                only when non-empty).
 *   IDENTITY_PASSTHROUGH       (AC1/AD-11) `protocolIdentityId` returns
 *                                UNCHANGED and the config carries NO key
 *                                material: its exact key set is the five
 *                                adapter-config keys — no secret/keypair
 *                                field can hide in it.
 *   BOOT_PATH_NO_MEMORY        (AC2) comment-stripped `src/main/index.ts`
 *                                + `src/main/net-config.ts` contain NO
 *                                occurrence of the word `memory` — neither
 *                                the `'memory'` transport literal nor a
 *                                `/memory/...` listen address can appear
 *                                in the boot path (comments may name the
 *                                rule; code may not: the 4.7-style scan).
 *                                Non-vacuity: BOTH raw sources DO mention
 *                                it (in comments), so the scan would catch
 *                                a regression.
 *
 * Imports: the PURE seam (`../src/main/net-config.js`) + a TYPE-only core
 * import + `vitest` + node builtins. NO electron import, NO adapter boots
 * — zero real sockets, zero LAN prerequisites (AD-10/R4).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { GenesisConfig } from '@succinctcoin/core'

import {
  LAN_LISTEN_ADDRESS,
  defaultNetConfig,
  parseBootstrapFile,
  parseRelaySeeds,
} from '../src/main/net-config.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(here, '..')

/** The two boot-path sources the memory-literal scan pins (AC2). */
const BOOT_PATH_SOURCES = [
  join(APP_DIR, 'src', 'main', 'index.ts'),
  join(APP_DIR, 'src', 'main', 'net-config.ts'),
]

/** Strip comments (the 4.7-style self-scan — comments may name a rule; code may not). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('7.2 — defaultNetConfig: the pure boot net-config seam (tcp + mDNS + genesis bootstrap)', () => {
  it('NET_TCP_MDNS_LAN_ONLY: empty-bootstrap genesis yields tcp + ephemeral listen + mdns + [] — never memory', () => {
    const genesis: Pick<GenesisConfig, 'bootstrap'> = { bootstrap: [] }

    const config = defaultNetConfig(genesis, 'ab'.repeat(32))

    // The full config, EXACTLY (no extra keys, no missing keys). 10.2:
    // relaySeeds is EMPTY by default — an install with no seeds behaves
    // exactly like pre-10.2 (the no-operated-infrastructure pin, E3).
    expect(config).toEqual({
      transport: 'tcp',
      listenAddress: '/ip6/::/tcp/0',
      mdns: false,
      bootstrap: [],
      relaySeeds: [],
      protocolIdentityId: 'ab'.repeat(32),
    })
    // The exported constant IS the pinned ephemeral listen address (9.1:
    // IPv6-only all-interfaces bind, port 0).
    expect(LAN_LISTEN_ADDRESS).toBe('/ip6/::/tcp/0')
    // R1: the isolated transport is NEVER returned from the seam.
    expect(config.transport).not.toBe('memory')
  })

  it('RELAY_SEEDS (10.2): env parse rows + verbatim passthrough, empty default', () => {
    const g: Pick<GenesisConfig, 'bootstrap'> = { bootstrap: [] }
    // Parser: comma-separated, trimmed, empties dropped, unset ⇒ [].
    expect(parseRelaySeeds(undefined)).toEqual([])
    expect(parseRelaySeeds('')).toEqual([])
    expect(parseRelaySeeds(' , ')).toEqual([])
    expect(
      parseRelaySeeds('/ip6/2001:db8::9/tcp/4001/p2p/QmA, /ip6/2001:db8::8/tcp/4001/p2p/QmB '),
    ).toEqual([
      '/ip6/2001:db8::9/tcp/4001/p2p/QmA',
      '/ip6/2001:db8::8/tcp/4001/p2p/QmB',
    ])
    // Seam: seeds pass through untouched; absent ⇒ [] (the pinned default).
    const seeded = defaultNetConfig(g, 'ae'.repeat(32), { relaySeeds: ['/ip6/2001:db8::9/tcp/1/p2p/QmA'] })
    expect(seeded.relaySeeds).toEqual(['/ip6/2001:db8::9/tcp/1/p2p/QmA'])
    expect(defaultNetConfig(g, 'ae'.repeat(32)).relaySeeds).toEqual([])
  })

  it('MDNS_OPT_IN: mdns is OFF by default; ONLY `mdns: true` enables it (9.1)', () => {
    const g: Pick<GenesisConfig, 'bootstrap'> = { bootstrap: [] }
    expect(defaultNetConfig(g, 'ad'.repeat(32)).mdns).toBe(false)
    expect(defaultNetConfig(g, 'ad'.repeat(32), { mdns: false }).mdns).toBe(false)
    expect(defaultNetConfig(g, 'ad'.repeat(32), { mdns: true }).mdns).toBe(true)
  })

  it('BOOTSTRAP_VERBATIM: a public-peer list passes through verbatim (same reference)', () => {
    const peers = [
      '/ip6/2001:db8:c7a1::/tcp/4001/p2p/12D3KooWExampleA',
      '/dns4/bootstrap.example.com/tcp/443/wss/p2p/12D3KooWExampleB',
    ]
    const genesis: Pick<GenesisConfig, 'bootstrap'> = { bootstrap: peers }

    const config = defaultNetConfig(genesis, 'cd'.repeat(32))

    // Verbatim: no copy, no filter, no reorder (the adapter validates +
    // gates on length itself — 5.3).
    expect(config.bootstrap).toBe(peers)
    expect(config.bootstrap).toEqual(peers)
    expect(config.transport).toBe('tcp')
  })

  it('IDENTITY_PASSTHROUGH: the identity id returns unchanged; no key material in the config (AD-11)', () => {
    const identityId = 'ef'.repeat(32)

    const config = defaultNetConfig({ bootstrap: [] }, identityId)

    expect(config.protocolIdentityId).toBe(identityId)
    // The EXACT key set of the adapter config — a secret/keypair field
    // cannot hide in the result (AD-11: only the plain public id crosses).
    expect(Object.keys(config).sort()).toEqual([
      'bootstrap',
      'listenAddress',
      'mdns',
      'protocolIdentityId',
      // 10.2: the relay-seed LIST is public addressing info (multiaddrs) —
      // no key material; the AD-11 pin stands.
      'relaySeeds',
      'transport',
    ])
  })

  it('BOOT_PATH_NO_MEMORY: comment-stripped boot-path sources contain no memory literal (AC2)', () => {
    for (const srcPath of BOOT_PATH_SOURCES) {
      const raw = readFileSync(srcPath, 'utf8')
      // Non-vacuity: the RAW source mentions it (in comments — the rule is
      // named); if the scan passed on an always-clean file this row would
      // prove nothing.
      expect(raw, `${srcPath}: raw source names it in comments`).toMatch(/\bmemory\b/)
      // The code (comments stripped): NO 'memory' transport literal and no
      // /memory/... listen address anywhere in the boot path (R1).
      const stripped = stripComments(raw)
      expect(stripped, `${srcPath}: no memory literal in code`).not.toMatch(/\bmemory\b/)
    }
  })
})

describe('LAN joins when multicast is blocked — listen-port pin + bootstrap hints', () => {
  it('LISTEN_PORT: a valid port pins /ip6/::/tcp/<port>; invalid falls back to ephemeral', () => {
    const g: Pick<GenesisConfig, 'bootstrap'> = { bootstrap: [] }
    expect(defaultNetConfig(g, 'aa'.repeat(32), { listenPort: 4001 }).listenAddress).toBe(
      '/ip6/::/tcp/4001',
    )
    for (const bad of [0, -1, 70000, 2.5, Number.NaN]) {
      expect(defaultNetConfig(g, 'aa'.repeat(32), { listenPort: bad }).listenAddress).toBe(
        LAN_LISTEN_ADDRESS,
      )
    }
    expect(defaultNetConfig(g, 'aa'.repeat(32)).listenAddress).toBe(LAN_LISTEN_ADDRESS)
  })

  it('EXTRA_BOOTSTRAP_MERGE: local hints merge AFTER genesis, deduped, as a NEW array; no hints keeps the verbatim reference', () => {
    const peers = ['/ip6/2001:db8:c7a1::/tcp/4001/p2p/12D3KooWExampleA']
    const genesis: Pick<GenesisConfig, 'bootstrap'> = { bootstrap: peers }

    const merged = defaultNetConfig(genesis, 'bb'.repeat(32), {
      extraBootstrap: ['/ip6/2001:db8:c0a8:111::/tcp/4001/p2p/12D3KooWLanPeer', peers[0] as string],
    })
    expect(merged.bootstrap).toEqual([
      '/ip6/2001:db8:c7a1::/tcp/4001/p2p/12D3KooWExampleA',
      '/ip6/2001:db8:c0a8:111::/tcp/4001/p2p/12D3KooWLanPeer',
    ])
    expect(merged.bootstrap).not.toBe(peers) // genesis untouched
    // Empty hints ⇒ the pinned 7.2 verbatim passthrough still holds.
    expect(defaultNetConfig(genesis, 'bb'.repeat(32), { extraBootstrap: [] }).bootstrap).toBe(peers)
  })

  it('PARSE_BOOTSTRAP_FILE: keeps multiaddr lines (trimmed, ordered); drops blanks, # comments, and non-/ lines', () => {
    const text = [
      '# LAN peers, one per line',
      '  /ip6/2001:db8:c0a8:111::/tcp/4001/p2p/12D3KooWA  ',
      '',
      'not-a-multiaddr',
      '\t/ip6/2001:db8:c0a8:63::/tcp/4001/p2p/12D3KooWB',
      '# /ip6/commented.out/tcp/1/p2p/x',
    ].join('\n')
    expect(parseBootstrapFile(text)).toEqual([
      '/ip6/2001:db8:c0a8:111::/tcp/4001/p2p/12D3KooWA',
      '/ip6/2001:db8:c0a8:63::/tcp/4001/p2p/12D3KooWB',
    ])
  })
})
