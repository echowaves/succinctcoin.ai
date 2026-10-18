/**
 * Ticket 8.5 (T4) — the PURE discovery-ladder seam under PLAIN NODE
 * (the 7.2 net-config pattern): path resolution is a pure function of the
 * injected platform/env/userData, the built `DiscoveryPorts` pass the
 * announce hook + report sink through untouched, and the purity scans pin
 * AD-1 (no electron in the seam) + the BOOT_PATH_NO_MEMORY rule extended to
 * the new module.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildDiscoveryPorts, resolveLadderPaths } from '../src/main/discovery-ladder.js'

const here = dirname(fileURLToPath(import.meta.url))
const mainSrc = join(here, '..', 'src', 'main')

/** Strip block + line comments (the 4.7-style scan used by net-config). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('8.5 T4 — resolveLadderPaths (pure path seam)', () => {
  it('darwin/linux/win32: shared LAN hints file + per-install artifact', () => {
    const base = { env: {}, userDataDir: '/ud' }
    expect(resolveLadderPaths({ platform: 'darwin', ...base })).toEqual({
      hintsFilePath: '/Users/Shared/succinctcoin/address-book.json',
      artifactFilePath: join('/ud', 'discovery-artifact.json'),
    })
    expect(resolveLadderPaths({ platform: 'linux', ...base }).hintsFilePath).toBe(
      '/var/tmp/succinctcoin/address-book.json',
    )
    expect(resolveLadderPaths({ platform: 'win32', env: {}, userDataDir: 'C:\\ud' }).hintsFilePath).toBe(
      'C:\\Users\\Public\\succinctcoin\\address-book.json',
    )
  })

  it('env override + shared-dir override win in order (env first)', () => {
    expect(
      resolveLadderPaths({
        platform: 'darwin',
        env: { SUCCINCTCOIN_LAN_BOOK: '/mnt/share/ab.json' },
        userDataDir: '/ud',
        lanSharedDir: '/ignored',
      }).hintsFilePath,
    ).toBe('/mnt/share/ab.json')
    expect(
      resolveLadderPaths({
        platform: 'darwin',
        env: {},
        userDataDir: '/ud',
        lanSharedDir: '/Volumes/LAN',
      }).hintsFilePath,
    ).toBe('/Volumes/LAN/succinctcoin/address-book.json')
  })
})

describe('8.5 T4 — buildDiscoveryPorts (passthrough wiring)', () => {
  it('announce hook + report sink pass through untouched; paths resolved', () => {
    const reports: unknown[] = []
    const ports = buildDiscoveryPorts(
      { platform: 'linux', env: {}, userDataDir: '/ud' },
      () => ['/ip4/1.2.3.4/tcp/9'],
      (r) => reports.push(r),
    )
    expect(ports.hintsFilePath).toBe('/var/tmp/succinctcoin/address-book.json')
    expect(ports.artifactFilePath).toBe(join('/ud', 'discovery-artifact.json'))
    expect(ports.announceAddresses?.()).toEqual(['/ip4/1.2.3.4/tcp/9'])
    ports.onLadderReport?.({ mdns: true, hints: { found: false, ingested: 0, skipped: 0 }, artifact: { found: false, targets: 0, skipped: 0 }, blocks: true })
    expect(reports).toHaveLength(1)
  })
})

describe('8.5 T4 — seam purity scans (AD-1 / BOOT_PATH_NO_MEMORY)', () => {
  it('discovery-ladder.ts imports NO electron and names no memory transport in code', () => {
    const code = stripComments(readFileSync(join(mainSrc, 'discovery-ladder.ts'), 'utf8'))
    expect(code).not.toMatch(/from\s+'electron'/)
    expect(code).not.toContain('memory')
  })

  it('the glue wires the seam: buildDiscoveryPorts + listenAddresses in index.ts', () => {
    const code = readFileSync(join(mainSrc, 'index.ts'), 'utf8')
    expect(code).toContain('buildDiscoveryPorts')
    expect(code).toContain('net.listenAddresses()')
  })
})
