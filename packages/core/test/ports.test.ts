import { describe, expect, it } from 'vitest'
import { createCore } from '../src/index.js'
import type { CorePorts } from '../src/ports.js'

// FIVE_PORTS (matrix): all five port interfaces + the CorePorts bundle are
// exported from @succinctcoin/core. The interfaces are type-only, so the
// compile-time proof is that the fakes below satisfy `CorePorts`; the runtime
// proof is that `createCore` is exported and callable.
const fake: CorePorts = {
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
  },
  clock: {
    slotIndex: () => 0,
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

describe('FIVE_PORTS — port interfaces + CoreInstance are exported', () => {
  it('all five ports + CorePorts type-check and createCore is callable', () => {
    expect(typeof createCore).toBe('function')
    expect(() => createCore(fake)).not.toThrow()
  })
})
