/**
 * FILE CHAINSTORE + EXCLUSIVE LOCK — the AD-9 single-writer persistence matrix.
 *
 * Covers the story's I/O & edge-case matrix against the real `FileChainStore`
 * (zero-dep file engine) and the real `createCore` boot path:
 *
 *   PERSIST_RELOAD     golden Block (1.4 vector) committed, closed, reopened →
 *                      `getBlock` is byte-identical to `Block.encode(input)`
 *   HEAD_SLOT          -1 when empty; highest committed slot after commits
 *   EXCLUSIVE_LOCK     a second store/core on the same open dir → SC-STORE-1
 *   STALE_LOCK_TAKEOVER lockfile with a dead PID → open() takes over
 *   BOOT_FAIL          a second `createCore` on the same dir fails at `start()`
 *                      with SC-STORE-1; after the first stops, it starts
 *
 * Test hygiene (AD-10): fresh `os.tmpdir()` dir per test, no real sockets, no
 * new runtime deps. The golden vector (test/golden-vector.test.ts) pins the
 * canonical `Block.encode` bytes; this suite re-uses the same field values.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Block, createCore, FileChainStore, StoreError } from '../src/index.js'
import type { Block as BlockType } from '../src/index.js'
import type { CoreInstance, CorePorts } from '../src/index.js'

// ---- helpers -------------------------------------------------------------

let dir: string

/** Fresh temp data dir per test; removed after each. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A PID guaranteed dead: spawn a short-lived `node` process that exits
 * immediately and wait for it. (A high PID could collide with a live process
 * on a busy machine; this cannot.)
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('spawn did not assign a pid')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return pid
}

/** The golden Block (1.4 vector field values) as a generated `Block` object. */
function goldenBlock(): BlockType {
  return {
    slot: 42n,
    parentHash: Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1)),
    winnerIdentityId:
      '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    winnerTicket: new Uint8Array(32).fill(5),
    nonce: Uint8Array.from(Array.from({ length: 32 }, (_, i) => i)),
    hash: new Uint8Array(32).fill(0x99),
    txCount: 3n,
  }
}

const hex = (buf: Uint8Array): string => Buffer.from(buf).toString('hex')
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && Array.from(a).every((v, i) => v === b[i])

/** A core wired to a real `FileChainStore` on `d` (other ports are fakes). */
function makeCore(d: string): CoreInstance {
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
    clock: { slotIndex: () => 0, lastBlockHash: () => '0'.repeat(64) },
    gate: {
      async verify() {
        return { valid: true, identityId: 'i', attestedUntilWindow: 1 }
      },
    },
    uiSink: { sink() {} },
  }
  return createCore(ports)
}

// ---- matrix --------------------------------------------------------------

describe('PERSIST_RELOAD — canonical bytes persist and reload byte-identical', () => {
  it('commit the golden Block, close, reopen → getBlock(slot) === Block.encode(input)', async () => {
    const input = goldenBlock()
    const expected = Block.encode(input)

    const store = new FileChainStore(dir)
    await store.open()
    await store.commit(input)
    await store.close()

    const re = new FileChainStore(dir)
    await re.open()
    const got = await re.getBlock(42)
    expect(got).not.toBeNull()
    expect(hex(got!)).toBe(hex(expected)) // byte-identity against the canonical encoding
    await re.close()
  })

  it('getBlock of an uncommitted slot returns null', async () => {
    const store = new FileChainStore(dir)
    await store.open()
    await store.commit(goldenBlock())
    expect(await store.getBlock(41)).toBeNull()
    expect(await store.getBlock(43)).toBeNull()
    await store.close()
  })
})

describe('HEAD_SLOT — empty is -1, then highest committed slot (incl. out-of-order)', () => {
  it('empty store reports -1', async () => {
    const store = new FileChainStore(dir)
    await store.open()
    expect(await store.headSlot()).toBe(-1)
    await store.close()
  })

  it('tracks the highest slot, including out-of-order commits', async () => {
    const store = new FileChainStore(dir)
    await store.open()

    const at = (slot: number): BlockType => ({ ...goldenBlock(), slot: BigInt(slot) })
    await store.commit(at(3))
    expect(await store.headSlot()).toBe(3)
    await store.commit(at(7))
    expect(await store.headSlot()).toBe(7)
    await store.commit(at(5)) // out of order: stored, head stays the max
    expect(await store.headSlot()).toBe(7)

    await store.close()

    const re = new FileChainStore(dir)
    await re.open()
    expect(await re.headSlot()).toBe(7) // scanned from disk on reopen
    await re.close()
  })
})

describe('EXCLUSIVE_LOCK — a second open on the same dir fails at SC-STORE-1', () => {
  it('rejects SC-STORE-1 naming the directory and the holder PID', async () => {
    const first = new FileChainStore(dir)
    await first.open()

    const second = new FileChainStore(dir)
    const err: unknown = await second.open().catch((e) => e)
    expect(err).toBeInstanceOf(StoreError)
    expect((err as { code: string }).code).toBe('SC-STORE-1')
    const msg = (err as Error).message
    expect(msg).toContain(dir) // names the directory
    expect(msg).toContain(String(process.pid)) // names the holder PID

    // After the first releases, the directory opens again.
    await first.close()
    const third = new FileChainStore(dir)
    await expect(third.open()).resolves.toBeUndefined()
    await third.close()
  })
})

describe('STALE_LOCK_TAKEOVER — a lockfile left by a dead PID is taken over', () => {
  it('open() succeeds when the recorded holder is a dead process', async () => {
    // Simulate a crashed holder: write a lockfile holding a guaranteed-dead PID.
    const pid = await deadPid()
    writeFileSync(join(dir, '.lock'), String(pid))

    const store = new FileChainStore(dir)
    await expect(store.open()).resolves.toBeUndefined() // takes over the stale lock
    expect(await store.headSlot()).toBe(-1) // and functions normally

    // The lock now names THIS process.
    const err: unknown = await new FileChainStore(dir).open().catch((e) => e)
    expect((err as { code?: string }).code).toBe('SC-STORE-1')
    expect((err as Error).message).toContain(String(process.pid))

    await store.close()
  })
})

describe('BOOT_FAIL — a second core against the same dir fails at start() (end-to-end)', () => {
  it('core2.start() rejects SC-STORE-1 while core1 is up; after core1.stop() it starts', async () => {
    const core1 = makeCore(dir)
    const core2 = makeCore(dir)

    await expect(core1.start()).resolves.toBeUndefined()

    // The contended boot rejects SC-STORE-1 and emits nothing.
    let started = 0
    core2.on('CoreStarted', () => {
      started++
    })
    const err: unknown = await core2.start().catch((e) => e)
    expect(err).toBeInstanceOf(StoreError)
    expect((err as { code: string }).code).toBe('SC-STORE-1')
    expect((err as Error).message).toContain(dir)
    expect(started).toBe(0) // no event was emitted on the failed boot

    // Releasing the lock lets the second core boot.
    await core1.stop()
    await expect(core2.start()).resolves.toBeUndefined()
    expect(started).toBe(1)

    await core2.stop()
  })
})

describe('NOT_OPEN — using a closed store is SC-STORE-2, not a contention code', () => {
  it('commit/getBlock before open reject SC-STORE-2 (distinct from SC-STORE-1)', async () => {
    const store = new FileChainStore(dir)
    const commitErr: unknown = await store.commit(goldenBlock()).catch((e) => e)
    expect(commitErr).toBeInstanceOf(StoreError)
    expect((commitErr as { code: string }).code).toBe('SC-STORE-2')

    const getErr: unknown = await store.getBlock(1).catch((e) => e)
    expect(getErr).toBeInstanceOf(StoreError)
    expect((getErr as { code: string }).code).toBe('SC-STORE-2')
  })
})
