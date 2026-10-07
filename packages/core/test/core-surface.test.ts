import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCore } from '../src/index.js'
import type { CorePorts } from '../src/ports.js'

const here = fileURLToPath(new URL('.', import.meta.url))
// test/ -> core/ -> packages/ -> repo root, then config/genesis.json.
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')

// Fake ports (no real network/store/clock). Matrix: FRESH_CORE, EVENT_SINK,
// and UNIMPL_STUB. The store stays a no-op: `start()` now runs one
// `mineAndApply` over it, which is harmless (absent snapshot → seed mint,
// empty head → slot 0, commit/saveState are no-ops).
function makePorts(slot = 0): CorePorts {
  return {
    genesisPath: GENESIS_PATH,
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
    store: {
      async open() {},
      async close() {},
      async commit() {},
      async headSlot() {
        return -1
      },
      async getBlock() {
        return null
      },
      async saveState() {},
      async loadState() {
        return null
      },
    },
    clock: {
      slotIndex: () => slot,
      lastBlockHash: () => '0'.repeat(64),
    },
    gate: {
      async verify() {
        return { valid: true, identityId: 'i', attestedUntilWindow: 1 }
      },
    },
    uiSink: {
      sink() {},
    },
  }
}

describe('createCore — wiring + surface (FRESH_CORE / EVENT_SINK / UNIMPL_STUB)', () => {
  it('FRESH_CORE: returns an instance; on() subscribes; start() resolves without throwing', async () => {
    const core = createCore(makePorts())
    const off = core.on('CoreStarted', () => {})
    expect(typeof off).toBe('function')
    off()
    await expect(core.start()).resolves.toBeUndefined()
  })

  it('EVENT_SINK: emitting an event reaches both the emitter and the ui-sink', () => {
    const seen = { emitter: 0, sink: 0 }
    const ports = makePorts()
    ports.uiSink.sink = (event) => {
      if (event === 'CoreStarted') seen.sink++
    }
    const core = createCore(ports)
    const off = core.on('CoreStarted', () => {
      seen.emitter++
    })
    core.emit('CoreStarted', { slot: 0 })
    // Node EventEmitter.emit is synchronous, so both observers fired.
    expect(seen.emitter).toBe(1)
    expect(seen.sink).toBe(1)
    off()
  })

  it('start() emits CoreStarted with the chain-time slot, forwarded to the sink', async () => {
    const ports = makePorts(7)
    const payloads: unknown[] = []
    ports.uiSink.sink = (event, ...args) => {
      if (event === 'CoreStarted') payloads.push(args[0])
    }
    const core = createCore(ports)
    await core.start()
    expect(payloads).toEqual([{ slot: 7 }])
  })

  it('UNIMPL_STUB: getPeers / getBlock / startMining fail with { code: SC-CORE-1 }', async () => {
    const core = createCore(makePorts())
    // startMining is a void command — throws synchronously.
    let miningErr: unknown = null
    try {
      core.startMining()
    } catch (e) {
      miningErr = e
    }
    expect(miningErr).toBeInstanceOf(Error)
    expect((miningErr as { code: string }).code).toBe('SC-CORE-1')
    // getPeers / getBlock are Promise-typed — they reject (not sync-throw),
    // carrying SC-CORE-1.
    const peerErr: unknown = await core.getPeers().catch((e) => e)
    expect(peerErr).toBeInstanceOf(Error)
    expect((peerErr as { code: string }).code).toBe('SC-CORE-1')
    const blockErr: unknown = await core.getBlock(3).catch((e) => e)
    expect(blockErr).toBeInstanceOf(Error)
    expect((blockErr as { code: string }).code).toBe('SC-CORE-1')
  })
})
