/**
 * Ticket 8.5 (T6) — the DISCOVERY LINT CI row (design §"Discovery lint":
 * "a repo-wide scan fails on hardwired multiaddrs outside test fixtures")
 * plus the E3 key-material boundary scan.
 *
 * The scanner is a PURE function over (path, text) pairs; one row runs it
 * over the REAL repo (must find NOTHING), one row feeds an embedded fixture
 * violation (must FIRE — non-vacuity). Excluded by design: test files and
 * fixtures (fake `/ip4` addresses are their purpose), docs/epic artifacts,
 * generated `dist/` + `src/proto/`, and the ONE sanctioned listen address
 * (`/ip4/0.0.0.0` — all-interfaces bind, not an endpoint).
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
 * endpoints"). `/ip4/0.0.0.0` is the sanctioned all-interfaces BIND, not an
 * endpoint — allowed; any routable /ip4 literal in shipped code is a bug. */
const PATTERNS: ScanPattern[] = [
  { name: 'hardwired-ip4', re: /\/ip4\/(?!0\.0\.0\.0)(?!127\.0\.0\.1)[1-9]\d*(?:\.\d+){3}/g },
  { name: 'hardwired-dns4', re: /\/dns4?\//g },
  { name: 'ipfs-peer-id', re: /\/ipfs\/Qm/g },
  { name: 'seed-endpoint', re: /seed\.succinctcoin/g },
]

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
  const findings: LintFinding[] = []
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    if (re.test(text)) findings.push({ path, pattern: name })
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

  it('the sanctioned all-interfaces BIND and loopback never fire; tests are excluded', () => {
    expect(
      scanForHardwiredEndpoints('packages/app/src/main/net-config.ts', "const A = '/ip4/0.0.0.0/tcp/0'"),
    ).toEqual([])
    expect(
      scanForHardwiredEndpoints('packages/core/test/fake.ts', "const A = '/ip4/10.0.0.1/tcp/1'"),
    ).toEqual([]) // test files are the sanctioned fixtures
  })

  it('the collector actually collects (scan is not vacuously empty)', () => {
    const sources = collectShippedSources()
    expect(sources.length).toBeGreaterThan(20)
    // The ONE sanctioned listen address IS present in the shipped tree —
    // scanned, and (row above) allowed.
    expect(
      sources.some((s) => s.path.endsWith('net-config.ts') && s.text.includes('/ip4/0.0.0.0/tcp/0')),
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
