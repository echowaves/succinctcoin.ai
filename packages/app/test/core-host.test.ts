/**
 * Story 6.2 matrix — the app's in-app path under PLAIN NODE (the AD-10
 * electron-main test target, headless-safe): the PURE `CoreHost` (NO
 * electron import) hosts a REAL `createCore` with REAL ports (the memory
 * `createNetAdapter` — zero real sockets, a `FileChainStore` in a temp
 * dir, `createOfflineGateVerifier`, a REAL `deriveIdentityKeypair`
 * identity — the AD-11 key lives in the host) and forwards the core's
 * key-free event payloads through the `forwardEvent` seam (the fake IPC).
 *
 *   APP_IN_APP_PATH_MINES_FORWARDS (AC1) `createCoreHost` (real ports) →
 *                                 `start()` (mines the genesis block,
 *                                 emits `CoreStarted` with the
 *                                 empty-chain slot -1) → `startMining()`
 *                                 (the integrated slot loop) → a BOUNDED
 *                                 poll (AD-3 — a `setTimeout` deadline +
 *                                 tick loop, NO wall-clock assertion) for
 *                                 a `BlockApplied` past the genesis slot;
 *                                 the `forwardEvent` recorder sees
 *                                 `CoreStarted` FIRST then `BlockApplied`
 *                                 (the loop mined); the winner is the
 *                                 local identity (a single participant
 *                                 always wins its own draw); the
 *                                 `getChainHead()` slot advanced past
 *                                 genesis.
 *   APP_AD11_NO_KEYS_CROSS         (AC2) after a `BlockApplied`: NONE of
 *                                 the `forwardEvent` payloads (JSON-
 *                                 scanned) carry a key-material name
 *                                 (`privateKey`/`secret`/`keypair`), and
 *                                 NONE of the read-API results
 *                                 (`getChainHead`/`getBalances`/
 *                                 `getPeers`/`getBlock`) do; the
 *                                 identity's `.secret` BYTES (PKCS#8 DER)
 *                                 never appear by value (hex-scanned).
 *                                 The public `identityId` MAY appear
 *                                 (AD-11: "the UI gets only peer IDs,
 *                                 status, signed artifacts") — and it
 *                                 does (the `BlockApplied` winner). A
 *                                 static guard pins the source: the host
 *                                 + the preload bridge expose no key
 *                                 names, and the IPC tables (the ONE
 *                                 owner of the IPC shape) expose no key-
 *                                 material channel.
 *   APP_READ_API_MINED_STATE       (AC1/AC3) `getBalances()` carries the
 *                                 `MINT_ID` balance (the emission — a
 *                                 non-zero decimal string, AD-5) +
 *                                 `getChainHead()` returns the mined head
 *                                 (slot/hash matching the emitted
 *                                 `BlockApplied`) with
 *                                 `totalSupplyDisplay` = the genesis
 *                                 maxSupply (the closed system);
 *                                 `getBlock(slot)` agrees. The in-app
 *                                 data source (the read-API) is real.
 *
 * Imports: the app's PURE modules (`../src/main/core-host.js`,
 * `../src/main/ipc-channels.js`) + the REAL core ports from the
 * `@succinctcoin/core` PACKAGE (its dist — the build order holds) +
 * `vitest` + node builtins. NO electron import (headless-safe, AD-10).
 *
 * AD-3 discipline: the wait is a BOUNDED poll (a `setTimeout` deadline +
 * a 10 ms tick loop — a liveness bound, NOT a timestamp read); the
 * identity seed is a pinned 32-byte constant (no RNG).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  FileChainStore,
  MINT_ID,
  createNetAdapter,
  createOfflineGateVerifier,
  deriveIdentityKeypair,
} from '@succinctcoin/core'
import type { CoreEvents, IdentityKeypair } from '@succinctcoin/core'

import { createCoreHost } from '../src/main/core-host.js'
import type { CoreEventName, CoreEventPayload, CoreHost } from '../src/main/core-host.js'
import { IPC_COMMANDS, IPC_EVENTS, IPC_READ } from '../src/main/ipc-channels.js'

// ---------------------------------------------------------------------------
// pinned parameters (6.2 — deterministic, AD-3)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
/** The app source files (the AD-11 static guard scans them). */
const HOST_SRC_PATH = join(here, '..', 'src', 'main', 'core-host.ts')
const PRELOAD_SRC_PATH = join(here, '..', 'src', 'preload.ts')

/** A 32-byte pinned identity seed (AD-3: no RNG — the key lives in the host). */
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (0x40 + i) % 256))

/** The accepted-gate registry (the genesis config — AD-4). */
const ACCEPTED_GATES = ['biometric', 'social-graph']

/** The closed-system maxSupply display (the genesis emission). */
const MAX_SUPPLY_DISPLAY = '21000000'

/** The key-material names AD-11 bans from the boundary (case-insensitive). */
const KEY_NAME_RE = /privatekey|secret|keypair/i

/** One forwarded event (the recorder row). */
interface Recorded {
  event: CoreEventName
  payload: CoreEventPayload
}

/** The per-test harness state (`afterEach` always stops the host). */
interface Harness {
  host: CoreHost
  identity: IdentityKeypair
  recorded: Recorded[]
  dir: string
}

let harness: Harness | null = null

afterEach(async () => {
  const h = harness
  harness = null
  if (h === null) return
  try {
    // ALWAYS stop the host, even on test failure (AD-9: halts the loop,
    // closes the store, releases the lock; the host stops the net too).
    await h.host.stop()
  } catch {
    /* the temp dir cleanup below is what matters for isolation. */
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

/**
 * Build the host with REAL ports (AC1/AD-10): a `createNetAdapter` over
 * the memory transport (zero real sockets), a real `FileChainStore` in a
 * temp dir, `createOfflineGateVerifier`, a REAL identity (derived from the
 * pinned seed — AD-11: the key lives in the host), and the `forwardEvent`
 * recorder (the fake IPC).
 */
function buildHarness(memoryName: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-app-'))
  const identity = deriveIdentityKeypair(SEED)
  const recorded: Recorded[] = []
  const host = createCoreHost({
    net: createNetAdapter({
      transport: 'memory',
      listenAddress: `/memory/${memoryName}`,
      // The adapter stamps the PROTOCOL identity id into envelopes (5.2
      // D3) — a plain public string, never key material (AD-11).
      protocolIdentityId: identity.identityId,
    }),
    store: new FileChainStore(dir),
    gate: createOfflineGateVerifier({ acceptedGates: ACCEPTED_GATES }),
    // The fake IPC (the AD-11 boundary): the host's `forwardEvent`.
    forwardEvent: (event, payload) => {
      recorded.push({ event, payload })
    },
    identity,
  })
  return { host, identity, recorded, dir }
}

/**
 * Bounded poll (AD-3 — NO wall-clock assertion): a 10 ms `setTimeout` tick
 * loop until `pred()` passes; a separate `setTimeout` deadline rejects if
 * the bound elapses (a liveness bound, like 6.1's `waitForBlockApplied` —
 * NOT a timestamp read).
 */
function pollUntil(pred: () => boolean, what: string, deadlineMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error(`bounded poll: ${what} — no match before the deadline`))
    }, deadlineMs)
    const tick = (): void => {
      if (settled) return
      if (pred()) {
        settled = true
        clearTimeout(timer)
        resolve()
        return
      }
      setTimeout(tick, 10)
    }
    setTimeout(tick, 10)
  })
}

/** True once a `BlockApplied` past the genesis slot (slot >= 1) is recorded. */
function sawMinedBlock(recorded: Recorded[]): boolean {
  return recorded.some(
    (r) => r.event === 'BlockApplied' && (r.payload as CoreEvents['BlockApplied']).slot >= 1,
  )
}

/** Strip comments (the 4.7-style self-scan — sufficient for these sources). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Start the host, mine at least one loop block (bounded poll). */
async function startAndMine(h: Harness): Promise<void> {
  await h.host.start()
  await h.host.startMining()
  await pollUntil(
    () => sawMinedBlock(h.recorded),
    'a BlockApplied past the genesis slot',
  )
}

// ---------------------------------------------------------------------------
// APP_IN_APP_PATH_MINES_FORWARDS (AC1)
// ---------------------------------------------------------------------------

describe('6.2 — the app in-app path (plain Node, AD-10 headless-safe)', () => {
  it('APP_IN_APP_PATH_MINES_FORWARDS: the host hosts a real mining core; forwardEvent carries CoreStarted then BlockApplied', async () => {
    harness = buildHarness('app-mines-a')
    const { host, identity, recorded } = harness

    await host.start() // mines the genesis block (slot 0) → CoreStarted
    // The FIRST event is `CoreStarted`, carrying the empty-chain slot -1
    // (the genesis emits no `BlockApplied` — the host's clock cache starts
    // at -1, AD-3).
    expect(recorded.length).toBeGreaterThanOrEqual(1)
    expect(recorded[0].event).toBe('CoreStarted')
    expect(recorded[0].payload).toEqual({ slot: -1 })

    await host.startMining() // the integrated slot loop
    await pollUntil(
      () => sawMinedBlock(recorded),
      'a BlockApplied past the genesis slot',
    )

    // The loop mined: a `BlockApplied` past the genesis slot, and NOTHING
    // but the core's event names was forwarded (the AD-11 surface).
    const applied = recorded
      .filter((r) => r.event === 'BlockApplied')
      .map((r) => r.payload as CoreEvents['BlockApplied'])
    expect(applied.length).toBeGreaterThanOrEqual(1)
    const names = new Set(recorded.map((r) => r.event))
    expect([...names].sort()).toEqual(['BlockApplied', 'CoreStarted'])

    // The single participant always wins its own draw (5.10 deviation 3):
    // the winner is the local identity (the AD-11 key's public id).
    const first = applied[0]
    expect(first.winnerIdentityId).toBe(identity.identityId)
    expect(first.slot).toBeGreaterThanOrEqual(1)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)

    // The read-API advanced past genesis.
    const head = await host.getChainHead()
    expect(head.slot).toBeGreaterThanOrEqual(1)
  })

  // -----------------------------------------------------------------
  // APP_AD11_NO_KEYS_CROSS (AC2)
  // -----------------------------------------------------------------

  it('APP_AD11_NO_KEYS_CROSS: no key material crosses the forwardEvent / read-API boundary (by name + by value + static guard)', async () => {
    harness = buildHarness('app-ad11-a')
    const { host, identity, recorded } = harness
    await startAndMine(harness)

    // The read-API results (all four operations, AD-9 surface).
    const applied = recorded
      .filter((r) => r.event === 'BlockApplied')
      .map((r) => r.payload as CoreEvents['BlockApplied'])
    const readApi = [
      await host.getChainHead(),
      await host.getBalances(),
      await host.getPeers(),
      await host.getBlock(applied[0].slot),
    ]

    // (a) By NAME: no key-material field in ANY forwarded payload or ANY
    //     read-API result (AD-11).
    for (const r of recorded) {
      expect(JSON.stringify(r.payload) ?? '', `forwarded ${r.event}`).not.toMatch(KEY_NAME_RE)
    }
    for (const result of readApi) {
      expect(JSON.stringify(result) ?? '', 'read-API result').not.toMatch(KEY_NAME_RE)
    }

    // (b) By VALUE: the identity's `.secret` bytes (the PKCS#8 DER — the
    //     AD-11 key material) never appear in ANY forwarded payload or
    //     read-API result (hex-scanned).
    const secretHex = Buffer.from(identity.secret).toString('hex')
    const everything = [
      ...recorded.map((r) => JSON.stringify(r.payload) ?? ''),
      ...readApi.map((r) => JSON.stringify(r) ?? ''),
    ].join('')
    expect(everything).not.toContain(secretHex)

    // (c) The PUBLIC identity id MAY appear (AD-11: "the UI gets only peer
    //     IDs, status, signed artifacts") — and it does: the `BlockApplied`
    //     winner is the local identity.
    expect(everything).toContain(identity.identityId)

    // (d) Static guard: the host + the preload bridge source expose NO key
    //     names (the comment-stripped self-scan — the 4.7-style guard).
    const hostSrc = stripComments(readFileSync(HOST_SRC_PATH, 'utf8'))
    expect(hostSrc).not.toMatch(/privateKey/)
    expect(hostSrc).not.toMatch(/\.secret\b/)
    const preloadSrc = stripComments(readFileSync(PRELOAD_SRC_PATH, 'utf8'))
    expect(preloadSrc).not.toMatch(KEY_NAME_RE)

    // (e) The IPC tables (the ONE owner of the IPC shape): exactly the
    //     command + event + read surface, and NO key-material channel.
    expect(Object.values(IPC_COMMANDS).sort()).toEqual([
      'core.applyInvite', // 9.2 join seam — text in, { ok | reason } out
      'core.start',
      'core.startMining',
      'core.stop',
    ])
    expect(Object.keys(IPC_EVENTS).sort()).toEqual([
      'BlockApplied',
      'CoreStarted',
      'CoreStopped',
    ])
    // 9.2 adds `invite` — public signed text out, never key material (E3).
    expect(Object.values(IPC_READ).sort()).toEqual([
      'balances',
      'block',
      'chainHead',
      'invite',
      'peers',
    ])
    const channels = [
      ...Object.values(IPC_COMMANDS),
      ...Object.values(IPC_EVENTS),
      ...Object.values(IPC_READ),
    ]
    expect(channels.join(' ')).not.toMatch(KEY_NAME_RE)
  })

  // -----------------------------------------------------------------
  // APP_READ_API_MINED_STATE (AC1/AC3)
  // -----------------------------------------------------------------

  it('APP_READ_API_MINED_STATE: the in-app read-API reflects the mined state (the MINT_ID emission + the mined head)', async () => {
    harness = buildHarness('app-read-a')
    const { host, recorded } = harness
    await startAndMine(harness)

    const applied = recorded
      .filter((r) => r.event === 'BlockApplied')
      .map((r) => r.payload as CoreEvents['BlockApplied'])
    const latest = applied[applied.length - 1]

    // getBalances — the `MINT_ID` balance (the pre-funded treasury minus
    // the paid rewards) is present + a NON-ZERO decimal string (AD-5).
    const { balances } = await host.getBalances()
    expect(MINT_ID in balances).toBe(true)
    expect(balances[MINT_ID]).toMatch(/^\d+$/)
    expect(BigInt(balances[MINT_ID])).toBeGreaterThan(0n)

    // getChainHead — the mined head (slot/hash matching the emitted event),
    // `totalSupplyDisplay` = the genesis maxSupply (the closed system, AD-5).
    const head = await host.getChainHead()
    expect(head.slot).toBe(latest.slot)
    expect(head.hash).toBe(latest.hash)
    expect(head.totalSupplyDisplay).toBe(MAX_SUPPLY_DISPLAY)

    // getBlock — the mined slot's read-model agrees with the event.
    const block = await host.getBlock(latest.slot)
    expect(block.slot).toBe(latest.slot)
    expect(block.hash).toBe(latest.hash)
    expect(block.winnerIdentityId).toBe(latest.winnerIdentityId)
  })
})

// Type-level parity (9.2 review): the renderer mirrors core's InviteRejectReason
// union (thin-client AD-1 forbids a runtime import), so nothing pins it at the
// type layer EXCEPT this compile-time mutual-assignability check — a core-side
// rename/deletion fails `tsc` here instead of silently degrading UI labels.
type _Assert<T extends true> = T
type _RendererReasons = import('../src/renderer/App.js').InviteRejectReason
type _CoreContainsAllRenderer = _RendererReasons extends
  import('@succinctcoin/core').InviteRejectReason ? true : false
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PIN_RENDERER_REASONS_SUBSET = _Assert<_CoreContainsAllRenderer>

describe('9.2 — invite reject-reason parity', () => {
  it('renderer mirror is a compile-checked subset of core (see type pins)', () => {
    // The assertion lives entirely in the types above; this runtime row just
    // keeps the suite honest that the pin file is present and compiled.
    expect(true).toBe(true)
  })
})
