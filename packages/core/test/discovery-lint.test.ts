/**
 * Ticket 8.5 (T6) — the DISCOVERY LINT CI row (design §"Discovery lint":
 * "a repo-wide scan fails on hardwired multiaddrs outside test fixtures")
 * plus the E3 key-material boundary scan.
 *
 * The scanner is a PURE function over (path, text) pairs; one row runs it
 * over the REAL repo (must find NOTHING), one row feeds an embedded fixture
 * violation (must FIRE — non-vacuity). Excluded by design: test files and
 * fixtures (fake addresses are their purpose), docs/epic artifacts, and
 * generated `dist/` + `src/proto/`. 9.1 IPv6-only policy: NO `/ip4`
 * address literal of ANY kind survives in shipped code — not even the old
 * `/ip4/0.0.0.0` bind (the sanctioned bind is now `/ip6/::`). 11.3 hop-
 * awareness: EXACTLY ONE file — the seed-config seam
 * `packages/app/src/main/net-config.ts` — may carry `/ip4` literals, the
 * position where shipped default relay seeds (hop addresses, legal since
 * the 11.2 dual-stack-hop amendment) will be provisioned by 11.5's flip.
 * Every other pattern and every other path keep the hard ban.
 *
 * E3 (ticket 8.5): signing and key derivation are MAIN/CORE concerns — the
 * PRELOAD and RENDERER sources must contain zero occurrences of the key
 * symbols (`deriveIdentityKeypair`, `signTicket`, ...), pinning the AD-11
 * boundary from the UI side.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Repo root: this file → test → core → packages → root.
const ROOT = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
)

/** One lint finding: where and what matched. */
export interface LintFinding {
  path: string
  pattern: string
}

interface ScanPattern {
  name: string
  re: RegExp
}

/** The hardwired-endpoint patterns (design's "hardwired multiaddrs or seed
 * endpoints"). 9.1: the IPv6-only constraint bans EVERY /ip4 address literal
 * in shipped code — bind, loopback, or endpoint alike (`/ip4` followed by any
 * digit; prose mentions like "/an `/ip4` component" never match). */
const PATTERNS: ScanPattern[] = [
  { name: 'hardwired-ip4', re: /\/ip4\/\d/g },
  { name: 'hardwired-dns4', re: /\/dns4?\//g },
  { name: 'ipfs-peer-id', re: /\/ipfs\/Qm/g },
  { name: 'seed-endpoint', re: /seed\.succinctcoin/g },
]

/**
 * 11.3 — the ONE hop/seed-config position exempt from `hardwired-ip4`: the
 * net-config seam is where shipped default relay seeds live, and a seed's
 * hop may be a global `/ip4` (11.2 hop law). The exemption is POSITION-
 * scoped, not file-scoped: ONLY the `DEFAULT_RELAY_SEEDS` array literal —
 * the region 11.5's flip provisions seeds into — reads clean; every other
 * line of the same file (the bind construction above all) keeps the hard
 * ban, and so do `hardwired-dns4`, `ipfs-peer-id`, `seed-endpoint` here and
 * `/ip4` in every other file.
 */
const SEED_CONFIG_PATH = 'packages/app/src/main/net-config.ts'
/** The exempt region: the DEFAULT_RELAY_SEEDS declaration, brackets incl.
 * (past the `readonly string[]` annotation: from the `=` to the array's
 * closing bracket — seed literals never contain `]`). */
const SEED_REGION_RE = /export const DEFAULT_RELAY_SEEDS[^=]*=[^\]]*\]/

/** Paths never scanned (fixtures, docs, build output, generated code). */
function isExcluded(relPath: string): boolean {
  const p = relPath.split(sep).join('/')
  return (
    p.includes('node_modules/') ||
    p.includes('/dist/') ||
    p.startsWith('dist/') ||
    p.includes('/_bmad-output/') ||
    p.startsWith('_bmad-output/') ||
    p.includes('/docs/') ||
    p.startsWith('docs/') ||
    p.includes('/src/proto/') ||
    p.endsWith('.test.ts') ||
    p.endsWith('.mjs') ||
    p.endsWith('.md') ||
    p.endsWith('.json') ||
    p.includes('/test/')
  )
}

/** Pure scanner: findings per (path, text). */
export function scanForHardwiredEndpoints(path: string, text: string): LintFinding[] {
  if (isExcluded(path)) return []
  const rel = path.split(sep).join('/')
  const findings: LintFinding[] = []
  for (const { name, re } of PATTERNS) {
    // 11.3 hop-awareness: /ip4 is legal ONLY inside the seed-config seam's
    // DEFAULT_RELAY_SEEDS region (the hop position); every other (path,
    // pattern, line) triple stays hard — including a v4 BIND in this file.
    let scanText = text
    if (name === 'hardwired-ip4' && rel === SEED_CONFIG_PATH) {
      scanText = text.replace(SEED_REGION_RE, 'export const DEFAULT_RELAY_SEEDS []')
    }
    re.lastIndex = 0
    if (re.test(scanText)) findings.push({ path, pattern: name })
  }
  return findings
}

/** Walk the shipped sources of both packages (pure code files only). */
function collectShippedSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(ROOT, full)
      if (isExcluded(rel)) continue
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push({ path: rel, text: readFileSync(full, 'utf8') })
      }
    }
  }
  for (const pkg of ['packages/core/src', 'packages/app/src']) {
    walk(join(ROOT, pkg))
  }
  return out
}

describe('8.5 T6 — discovery lint (repo-wide hardwired-endpoint scan)', () => {
  it('the REAL repo is clean: zero hardwired multiaddrs / seed endpoints in shipped code', () => {
    const findings = collectShippedSources().flatMap(({ path, text }) =>
      scanForHardwiredEndpoints(path, text),
    )
    expect(findings).toEqual([])
  })

  it('NON-VACUITY: an embedded fixture violation FIRES every pattern', () => {
    const fixture = [
      'const BOOTSTRAP = "/ip4/203.0.113.7/tcp/4001/ipfs/QmFoo"', // ip4 + ipfs
      'const SEED = "/dns4/seed.succinctcoin.example/tcp/4001"', // dns + seed
    ].join('\n')
    const findings = scanForHardwiredEndpoints('packages/core/src/planted.ts', fixture)
    expect(new Set(findings.map((f) => f.pattern))).toEqual(
      new Set(['hardwired-ip4', 'hardwired-dns4', 'ipfs-peer-id', 'seed-endpoint']),
    )
  })

  it('9.1 + 11.3: /ip4 fires EVERYWHERE except the seed-config seam; tests are excluded', () => {
    // The direct-v4 ban stands in every other shipped file — the adapter
    // (the dialing code) is the canonical planted fixture.
    expect(
      scanForHardwiredEndpoints('packages/core/src/net/adapter.ts', "const A = '/ip4/1.2.3.4/tcp/9/p2p/QmR'"),
    ).toEqual([{ path: 'packages/core/src/net/adapter.ts', pattern: 'hardwired-ip4' }])
    expect(
      scanForHardwiredEndpoints('packages/app/src/main/index.ts', "const A = '/ip4/0.0.0.0/tcp/0'"),
    ).toEqual([{ path: 'packages/app/src/main/index.ts', pattern: 'hardwired-ip4' }]) // bind included
    expect(
      scanForHardwiredEndpoints('packages/core/test/fake.ts', "const A = '/ip4/10.0.0.1/tcp/1'"),
    ).toEqual([]) // test files are the sanctioned fixtures
  })

  it('11.3 hop position: /ip4 is clean ONLY inside the DEFAULT_RELAY_SEEDS region; elsewhere — same file included — it fires', () => {
    // The exempt position, shaped like the shipped constant (11.5's flip
    // provisions dual-stack hops exactly here):
    expect(
      scanForHardwiredEndpoints(
        SEED_CONFIG_PATH,
        "export const DEFAULT_RELAY_SEEDS: readonly string[] = [\n  '/ip4/1.2.3.4/tcp/9/p2p/QmR',\n]",
      ),
    ).toEqual([])
    // A v4 BIND planted in the SAME file (the deleted 9.1 row, restored):
    // position-scoped exemption keeps the bind law guarded where the bind
    // is constructed.
    expect(
      scanForHardwiredEndpoints(SEED_CONFIG_PATH, "const A = '/ip4/0.0.0.0/tcp/0'"),
    ).toEqual([{ path: SEED_CONFIG_PATH, pattern: 'hardwired-ip4' }])
    // Same hop literal, one directory over ⇒ hard finding.
    expect(
      scanForHardwiredEndpoints('packages/app/src/main/index.ts', "const SEED = '/ip4/1.2.3.4/tcp/9/p2p/QmR'"),
    ).toEqual([{ path: 'packages/app/src/main/index.ts', pattern: 'hardwired-ip4' }])
    // The exemption does not soften the OTHER patterns in net-config.
    expect(
      scanForHardwiredEndpoints(SEED_CONFIG_PATH, "const S = '/dns4/relay.example/tcp/1'"),
    ).toEqual([{ path: SEED_CONFIG_PATH, pattern: 'hardwired-dns4' }])
    // The sanctioned v6 bind stays clean in the exempt file too.
    expect(
      scanForHardwiredEndpoints(SEED_CONFIG_PATH, "const A = '/ip6/::/tcp/0'"),
    ).toEqual([])
  })

  it('the collector actually collects (scan is not vacuously empty)', () => {
    const sources = collectShippedSources()
    expect(sources.length).toBeGreaterThan(20)
    // The sanctioned 9.1 listen address IS present in the shipped tree —
    // scanned, and (row above) clean.
    expect(
      sources.some((s) => s.path.endsWith('net-config.ts') && s.text.includes('/ip6/::/tcp/0')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// E3 — the key-material boundary from the UI side (AD-11 pinning)
// ---------------------------------------------------------------------------

const FORBIDDEN_UI_SYMBOLS = [
  'deriveIdentityKeypair',
  'createIdentityFromSeed',
  'signTicket',
  'signPeerAnnouncement',
  'signIntroduction',
] as const

function collectUiSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  // The preload is TWO FILES at src/ (preload.ts + preload.d.ts); the
  // renderer is a directory.
  for (const file of ['packages/app/src/preload.ts', 'packages/app/src/preload.d.ts']) {
    out.push({ path: file, text: readFileSync(join(ROOT, file), 'utf8') })
  }
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry))
        out.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') })
    }
  }
  walk(join(ROOT, 'packages/app/src/renderer'))
  return out
}

describe('8.5 T6 — E3 key-material scan (preload + renderer)', () => {
  it('no preload/renderer source mentions a key-derivation or signing symbol', () => {
    const violations = collectUiSources().flatMap(({ path, text }) =>
      FORBIDDEN_UI_SYMBOLS.filter((sym) => text.includes(sym)).map((sym) => ({ path, sym })),
    )
    expect(violations).toEqual([])
  })

  it('the UI tree is non-empty (scan is not vacuously clean)', () => {
    expect(collectUiSources().length).toBeGreaterThan(0)
  })
})
