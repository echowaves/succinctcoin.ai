/**
 * BOOT PATH — `createCore().start()` wired to the real boot path (story 3.5).
 *
 * Covers the plan's I/O & edge-case matrix against a REAL `FileChainStore`
 * (fresh `os.tmpdir()` dir per test) and the REAL repo-root
 * `config/genesis.json` (the default path):
 *
 *   START_SUCCESS_FRESH  fresh dir + valid genesis → exactly one block at
 *                        slot 0, winner = TRACER_WINNER_ID, `CoreStarted`
 *                        emitted once with the unchanged `{ slot }` payload,
 *                        no `CoreStopped`
 *   START_SUCCESS_FLOW   the block's reward = fromDisplay("12.5") base units
 *                        credited MINT_ID → winner; totalSupply stays
 *                        fromDisplay("21000000"); seeded mint balance =
 *                        maxSupply (absent snapshot)
 *   START_MALFORMED      a malformed genesis file (missing `emission`) →
 *                        rejects SC-CONFIG-1 with an EMPTY chain (headSlot
 *                        -1, no state/balances.json, `CoreStarted` never
 *                        emitted, store stays OPEN — not auto-closed)
 *   START_FAILFAST_ORDER  a contended dir (a second core holds the lock) + a
 *                        malformed genesis path → rejects SC-STORE-1, proving
 *                        store.open() runs BEFORE loadGenesis
 *   START_RESUME         a dir already holding N blocks + a snapshot (from a
 *                        prior start()) → a NEW core on the same dir mines
 *                        slot N (head+1), NOT slot 0
 *
 * Test hygiene (AD-10): fresh temp dir per test (removed in `afterEach`), the
 * repo-root genesis is read-only, no new runtime deps.
 */
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  TRACER_WINNER_ID,
  createCore,
  fromDisplay,
  fromJson,
  totalSupply,
} from '../src/index.js'
import type { CoreInstance, CorePorts } from '../src/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
// test/ -> core/ -> packages/ -> repo root, then config/genesis.json.
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-boot-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A core wired to a real `FileChainStore` on `d` (other ports are fakes). */
function makeCore(d: string, slot = 0): CoreInstance {
  const ports: CorePorts = {
    net: {
      async start() {},
      async stop() {},
      async sendBlock() {},
      async sendTicket() {},
      async sendTx() {},
      async peers() {
        return []
      },
    },
    store: new FileChainStore(d),
    clock: { slotIndex: () => slot, lastBlockHash: () => '0'.repeat(64) },
    gate: {
      async verify() {
        return { valid: true, identityId: 'i', attestedUntilWindow: 1 }
      },
    },
    uiSink: { sink() {} },
  }
  return createCore(ports)
}

describe('START_SUCCESS_FRESH — one block at slot 0, CoreStarted once', () => {
  it('fresh dir + valid genesis → exactly one block; CoreStarted once; no CoreStopped', async () => {
    const core = makeCore(dir, 0)
    const started: unknown[] = []
    const stopped: unknown[] = []
    core.on('CoreStarted', (p) => started.push(p))
    core.on('CoreStopped', (p) => stopped.push(p))

    await core.start()

    // start() leaves the store open (lock held) and does NOT stop: exactly one
    // CoreStarted with the unchanged `{ slot }` payload, no CoreStopped yet.
    expect(started).toEqual([{ slot: 0 }])
    expect(stopped).toEqual([])

    // Release the lock, then inspect the persisted chain via a fresh store.
    await core.stop()
    expect(stopped).toEqual([{ slot: 0 }])

    const store = new FileChainStore(dir)
    await store.open()
    expect(await store.headSlot()).toBe(0)
    const bytes = await store.getBlock(0)
    expect(bytes).not.toBeNull()
    const block = Block.decode(bytes!)
    expect(block.slot).toBe(0n)
    expect(block.winnerIdentityId).toBe(TRACER_WINNER_ID)
    await store.close()
  })
})

describe('START_SUCCESS_FLOW — reward + maxSupply flow from the validated genesis', () => {
  it('reward = fromDisplay("12.5") credited MINT_ID -> winner; totalSupply = fromDisplay("21000000")', async () => {
    const core = makeCore(dir)
    await core.start()
    await core.stop() // release the lock (start() leaves the store open)

    const store = new FileChainStore(dir)
    await store.open()
    // The seeded mint balance (absent snapshot) = maxSupply, minus the one
    // reward paid out; the winner = the reward. totalSupply is unchanged
    // (closed system) and equals the genesis maxSupply in base units.
    const doc = await store.loadState()
    expect(doc).not.toBeNull()

    const reward = fromDisplay('12.5') // genesis emission.blockReward
    const maxSupply = fromDisplay('21000000') // genesis emission.maxSupply

    // Decode the snapshot back to a BalanceMap via the ledger seam and read
    // it through the projections: the reward is credited MINT_ID -> winner,
    // the seeded mint balance is maxSupply - reward, and totalSupply stays
    // maxSupply (closed system) — exactly the genesis emission values.
    const balances = fromJson(doc!)
    expect(totalSupply(balances)).toBe(maxSupply)
    expect(balances.get(TRACER_WINNER_ID)).toBe(reward)
    expect(balances.get(MINT_ID)).toBe(maxSupply - reward)

    await store.close()
  })
})

describe('START_MALFORMED — a malformed genesis rejects before any block', () => {
  it('missing `emission` → SC-CONFIG-1; empty chain; no snapshot; CoreStarted never; store stays open', async () => {
    const malformedPath = join(dir, 'malformed-genesis.json')
    // A genesis missing the `emission` field (SC-CONFIG-1 names it).
    writeFileSync(
      malformedPath,
      JSON.stringify({
        protocolVersion: 1,
        bootstrap: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWPlaceholder'],
        reattestationK: 100,
        uptimeLookbackL: 50,
        gates: ['biometric'],
      }),
      'utf8',
    )

    const core = makeCore(dir)
    let started = 0
    core.on('CoreStarted', () => {
      started++
    })

    const err: unknown = await core.start(malformedPath).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-CONFIG-1')
    expect((err as Error).message).toContain('emission')

    // The chain stayed empty and the store is still OPEN (not auto-closed):
    // a second store against the same dir is contended while the failed
    // core's lock is still held.
    expect(started).toBe(0)
    expect(existsSync(join(dir, 'state', 'balances.json'))).toBe(false)
    const contended: unknown = await new FileChainStore(dir)
      .open()
      .catch((e) => e)
    expect((contended as { code?: string }).code).toBe('SC-STORE-1')

    // After releasing the lock, a fresh inspector confirms the chain stayed
    // EMPTY (no block, headSlot -1) — the malformed genesis rejected before
    // any block was produced.
    await core.stop()
    const inspect = new FileChainStore(dir)
    await inspect.open()
    expect(await inspect.headSlot()).toBe(-1)
    expect(await inspect.getBlock(0)).toBeNull()
    await inspect.close()
  })
})

describe('START_MALFORMED — missing file (AC2 "malformed OR missing")', () => {
  it('nonexistent path → SC-CONFIG-1; empty chain', async () => {
    const missingPath = join(dir, 'does-not-exist.json')
    const core = makeCore(dir)
    let started = 0
    core.on('CoreStarted', () => {
      started++
    })

    // `loadGenesis` catches the `readFile` failure and routes it to the same
    // `SC-CONFIG-1` path as a malformed file — BEFORE any block is produced.
    const err: unknown = await core.start(missingPath).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-CONFIG-1')
    expect(started).toBe(0)

    await core.stop()
    const inspect = new FileChainStore(dir)
    await inspect.open()
    expect(await inspect.headSlot()).toBe(-1) // no block was produced
    await inspect.close()
  })
})

describe('START_FAILFAST_ORDER — store.open() runs before loadGenesis', () => {
  it('contended dir + malformed genesis → SC-STORE-1 (the lock check wins)', async () => {
    // core1 holds the lock (boots fine on the default, valid genesis).
    const core1 = makeCore(dir)
    await core1.start()

    const malformedPath = join(dir, 'malformed-genesis.json')
    writeFileSync(malformedPath, '{ not json', 'utf8')

    // core2 on the SAME dir: even with a malformed genesis, it must reject
    // SC-STORE-1 (lock contention) — NOT SC-CONFIG-1 — proving the store is
    // opened BEFORE the genesis is read.
    const core2 = makeCore(dir)
    let started = 0
    core2.on('CoreStarted', () => {
      started++
    })
    const err: unknown = await core2.start(malformedPath).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-STORE-1')
    expect(started).toBe(0)

    await core1.stop()
  })
})

describe('START_RESUME — a new core on an existing dir mines head+1, not slot 0', () => {
  it('seed N=2 blocks, then a NEW core mines slot 2', async () => {
    // Seed N=2 blocks with a first core (default genesis).
    const first = makeCore(dir)
    await first.start()
    await first.start()
    await first.stop()

    // A brand-new core on the SAME dir resumes from the persisted head:
    // it mines slot N (head+1), NOT slot 0.
    const second = makeCore(dir, 5)
    let started = 0
    second.on('CoreStarted', () => {
      started++
    })
    await second.start()
    expect(started).toBe(1)
    await second.stop() // release the lock (start() leaves the store open)

    const store = new FileChainStore(dir)
    await store.open()
    expect(await store.headSlot()).toBe(2) // was 1 (slots 0,1) → now 2
    const bytes = await store.getBlock(2)
    expect(bytes).not.toBeNull()
    const block = Block.decode(bytes!)
    expect(block.slot).toBe(2n) // NOT 0n — resumed from the persisted head
    expect(block.winnerIdentityId).toBe(TRACER_WINNER_ID)
    await store.close()
  })
})

describe('START_DEFAULT_PATH — no override → the repo-root config/genesis.json is used', () => {
  it('start() with no command arg and no ports.genesisPath boots on the repo-root genesis', async () => {
    // `makeCore` does NOT set `genesisPath`, and `start()` is called with no
    // arg — so `createCore` must fall back to `defaultGenesisPath()` (the
    // repo-root `config/genesis.json`, resolved via `import.meta.url`). This
    // pins the default-path branch explicitly (the other rows exercise it
    // only incidentally). The expected default is computed the same way
    // `createCore` does: src/index.ts → core → packages → repo root →
    // config/genesis.json.
    const expectedDefault = join(here, '..', '..', '..', 'config', 'genesis.json')
    expect(existsSync(expectedDefault)).toBe(true)

    const core = makeCore(dir)
    await core.start() // no genesisPath override → default repo-root genesis
    await core.stop()

    const store = new FileChainStore(dir)
    await store.open()
    expect(await store.headSlot()).toBe(0)
    await store.close()
  })
})
