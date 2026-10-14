import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCore } from '../src/index.js'
import type { CorePorts } from '../src/ports.js'

const here = fileURLToPath(new URL('.', import.meta.url))
// test/ -> core/ -> packages/ -> repo root, then config/genesis.json.
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')

// Fake ports (no real network/store/clock). Matrix: FRESH_CORE, EVENT_SINK,
// and LIVE_START_MINING (the 1.2 UNIMPL_STUB row is REPLACED at 6.1 — the
// startMining/getPeers/getBlock stubs are gone; the loop and read-API are
// real, and their behavior is covered by test/core-node-loop.test.ts).
// The store stays a no-op: `start()` runs one `mineAndApply` over it, which
// is harmless (absent snapshot → seed mint, empty head → slot 0,
// commit/saveState are no-ops).
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

describe('createCore — wiring + surface (FRESH_CORE / EVENT_SINK / LIVE_START_MINING)', () => {
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

  it('LIVE_START_MINING: startMining before start() rejects { code }; after start() it is idempotent and stop() halts the loop', async () => {
    const core = createCore(makePorts())
    // D5 — startMining before start(): a NORMAL reject with a `{ code }`
    // (the command is Promise-typed — never a sync throw). The stub
    // (UNIMPL_STUB, 1.2) is gone: the loop is real (6.1), it just needs
    // the genesis-derived parameters captured in start().
    const err: unknown = await core.startMining().catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-CORE-1')

    // After start(): startMining starts the integrated slot loop (idempotent
    // — a second call is a no-op) and stop() halts it before closing. The
    // full mining behavior is covered by test/core-node-loop.test.ts
    // (AC-1/AC-2) — this row pins the lifecycle contract only.
    await core.start()
    await core.startMining()
    await core.startMining() // idempotent no-op
    await core.stop()
    // After stop(): startMining() must REJECT { code } — not silently
    // re-create a loop that would tick forever against the closed store
    // (the genesis params are reset on stop, so the "start() has not run"
    // guard fires — a normal reject, never a sync throw).
    const postStopErr: unknown = await core.startMining().catch((e) => e)
    expect(postStopErr).toBeInstanceOf(Error)
    expect((postStopErr as { code?: string }).code).toBe('SC-CORE-1')
  })
})
