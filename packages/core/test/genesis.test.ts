import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { loadGenesis, validateGenesis } from '../src/index.js'
import type { GenesisConfig } from '../src/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
// test/ -> core/ -> packages/ -> repo root, then config/genesis.json.
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')

// A well-formed in-memory genesis object (VALID_PARSE) — matches the schema.
const wellFormed = {
  protocolVersion: 1,
  bootstrap: ['/ip4/103.192.173.112/tcp/4001/p2p/12D3KooWPlaceholder'],
  emission: { blockReward: '12.5', maxSupply: '21000000' },
  reattestationK: 100,
  uptimeLookbackL: 50,
  gates: ['biometric', 'social-graph'],
}

let tmp: string | undefined

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

describe('genesis config — boot validation (matrix)', () => {
  it('VALID_LOAD: loadGenesis reads the real config/genesis.json and types it', async () => {
    const cfg: GenesisConfig = await loadGenesis(GENESIS_PATH)
    expect(cfg.protocolVersion).toBeGreaterThanOrEqual(1)
    // 7.1: the repo genesis is LAN-only (empty bootstrap = no hardwired peers).
    expect(Array.isArray(cfg.bootstrap)).toBe(true)
    expect(cfg.bootstrap.every((a) => a.startsWith('/'))).toBe(true)
    expect(typeof cfg.emission.blockReward).toBe('string')
    expect(typeof cfg.emission.maxSupply).toBe('string')
    expect(Number.isInteger(cfg.reattestationK)).toBe(true)
    expect(Number.isInteger(cfg.uptimeLookbackL)).toBe(true)
    expect(cfg.gates.length).toBeGreaterThan(0)
  })

  it('VALID_PARSE: a well-formed object passes and comes back typed', () => {
    const cfg = validateGenesis(wellFormed)
    expect(cfg).toMatchObject(wellFormed)
  })

  it('EMPTY_BOOTSTRAP_OK (7.1): an empty bootstrap list validates — LAN-only, no hardwired peers', () => {
    const cfg = validateGenesis({ ...wellFormed, bootstrap: [] })
    expect(cfg.bootstrap).toEqual([])
  })

  it('CHAIN_ID_DEFAULT (8.2): absent chainId defaults deterministically to "succinctcoin-v<protocolVersion>"', () => {
    expect(validateGenesis(wellFormed).chainId).toBe('succinctcoin-v1')
    expect(validateGenesis({ ...wellFormed, protocolVersion: 2 }).chainId).toBe(
      'succinctcoin-v2',
    )
  })

  it('CHAIN_ID_EXPLICIT (8.2): a printable-ASCII chainId passes through verbatim', () => {
    expect(validateGenesis({ ...wellFormed, chainId: 'succinctcoin-mainnet-1' }).chainId).toBe(
      'succinctcoin-mainnet-1',
    )
  })

  it('CHAIN_ID_SHAPE (8.2): empty / non-string / >64 chars / non-printable fail SC-CONFIG-1', () => {
    for (const bad of ['', 42, 'x'.repeat(65), 'tab\there']) {
      expect(() => validateGenesis({ ...wellFormed, chainId: bad })).toThrowError(/chainId/)
    }
  })

  it('BOOTSTRAP_SHAPE: a non-array or entry-without-"/" still fails SC-CONFIG-1 (7.1 relaxation keeps the shape rules)', () => {
    expect(() => validateGenesis({ ...wellFormed, bootstrap: 'nope' })).toThrowError(
      /bootstrap/,
    )
    const badEntry = { ...wellFormed, bootstrap: ['/ip4/1.2.3.4/tcp/1/p2p/x', 'nope'] }
    try {
      validateGenesis(badEntry)
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toMatch(/bootstrap\[1\]/)
      expect((e as { code?: string }).code).toBe('SC-CONFIG-1')
    }
  })

  it('MALFORMED_TYPE: a wrong-typed field throws SC-CONFIG-1 naming the field', () => {
    const bad = { ...wellFormed, reattestationK: 'x' }
    expect(() => validateGenesis(bad)).toThrowError(/reattestationK/)
    try {
      validateGenesis(bad)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect((e as { code?: string }).code).toBe('SC-CONFIG-1')
    }
  })

  it('MALFORMED_MISSING: a missing required field throws SC-CONFIG-1 naming it', () => {
    // Same as wellFormed but with protocolVersion absent.
    const missing = {
      bootstrap: wellFormed.bootstrap,
      emission: wellFormed.emission,
      reattestationK: wellFormed.reattestationK,
      uptimeLookbackL: wellFormed.uptimeLookbackL,
      gates: wellFormed.gates,
    }
    expect(() => validateGenesis(missing)).toThrowError(/protocolVersion/)
    try {
      validateGenesis(missing)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect((e as { code?: string }).code).toBe('SC-CONFIG-1')
    }
  })

  it('MALFORMED_JSON_FILE: a non-JSON file rejects SC-CONFIG-1', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'genesis-'))
    const badPath = join(tmp, 'bad-genesis.json')
    await writeFile(badPath, '{ this is not valid json', 'utf8')
    await expect(loadGenesis(badPath)).rejects.toThrowError(/SC-CONFIG-1/)
  })
})
