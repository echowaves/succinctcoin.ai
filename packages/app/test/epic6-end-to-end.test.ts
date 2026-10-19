/**
 * Story 6.4 matrix — the CLOSING end-to-end suite: ALL FIVE epic-6
 * Done-when in ONE integrated run over the `@libp2p/memory` transport
 * (zero real sockets, AD-10) under PLAIN NODE.
 *
 * The key build decision (the plan §2): this suite drives the
 * MAIN-PROCESS code path DIRECTLY under vitest via the memory transport —
 * it does NOT spawn a real (headless) electron process (the flake vector).
 * It COMPOSES the app's PURE modules (`createCoreHost` from
 * `../src/main/core-host.js`, the ui-state `initialUiState`/`reduce`/
 * `buildInitialSnapshot` from `../src/renderer/ui-state.js`, the
 * `forge.config.js` packaging config) + the REAL core ports from the
 * `@succinctcoin/core` package (its dist — the build order holds) +
 * `vitest` + node builtins. NO electron import (headless-safe, AD-10).
 * NO DOM (the ui-state is PURE). The NEW proof is the integration: the
 * host's `forwardEvent` stream → the renderer's ui-state reducer.
 *
 *   E2E_FORGE_CONFIG_RESOLVES          (Done-when #1 — packaging) the
 *                                     `forge.config.js` default export is
 *                                     the plain object with
 *                                     `packagerConfig` (non-empty `name`
 *                                     + the `executableName`), `makers`
 *                                     (the zip maker array), and
 *                                     `rebuildConfig`; the app's
 *                                     `package.json` `main` is EXACTLY
 *                                     `./dist/main/index.js` (the
 *                                     electron MAIN-process entry — the
 *                                     app's entry) + the `package`
 *                                     script is `electron-forge package`.
 *                                     STATIC — no electron launch.
 *   E2E_IN_APP_PATH_MINES_AND_RENDERS  (Done-when #1 + #2) the harness
 *                                     (real ports over memory, the 6.2
 *                                     shape) → `host.start()` (mines the
 *                                     genesis, emits `CoreStarted
 *                                     {slot:-1}`) → `host.startMining()`
 *                                     (the integrated slot loop) → a
 *                                     BOUNDED poll (AD-3 — a setTimeout
 *                                     deadline + a 10 ms tick loop, NO
 *                                     wall-clock assertion) for a
 *                                     `BlockApplied` past the genesis
 *                                     slot. EVERY recorded core event is
 *                                     fed into the renderer's ui-state
 *                                     through the hook's data-flow
 *                                     semantics (the `toUiEvent` mapper
 *                                     + `reduce`; `CoreStarted` /
 *                                     `BlockApplied` trigger the
 *                                     event-driven `buildInitialSnapshot`
 *                                     re-read — NO timers, E1). Assert:
 *                                     `ui.head !== null` + `ui.mining ===
 *                                     true` + `ui.head.slot >= 1` (a
 *                                     block was mined AND reached the
 *                                     renderer's data source). THEN the
 *                                     read-API: `getChainHead` slot >= 1
 *                                     + `totalSupplyDisplay ===
 *                                     '21000000'` (the closed system),
 *                                     `getBalances` carries the `MINT_ID`
 *                                     emission as a non-zero decimal
 *                                     string (AD-5), `getPeers` an array.
 *                                     The no-timer static check (6.3's
 *                                     RENDERER_NO_POLL) is re-asserted on
 *                                     the ui-state + the hook source.
 *   E2E_AD11_NO_KEYS_INTEGRATED        (Done-when #3 — the AD-11
 *                                     boundary, integrated) after a
 *                                     `BlockApplied`: NONE of the
 *                                     `forwardEvent` payloads, NONE of
 *                                     the read-API results, and the
 *                                     renderer's `UiState` after the
 *                                     `reduce` (JSON-scanned) carry a
 *                                     key-material name
 *                                     (`privateKey`/`secret`/`keypair`,
 *                                     case-insensitive); the identity's
 *                                     `.secret` BYTES (PKCS#8 DER hex)
 *                                     never appear by value anywhere; the
 *                                     PUBLIC `identityId` DOES appear
 *                                     (the `BlockApplied` winner — AD-11:
 *                                     "the UI gets only peer IDs, status,
 *                                     signed artifacts").
 *   E2E_MEMORY_TRANSPORT_PIN           (Done-when #5 — the memory
 *                                     electron-main target) the in-app
 *                                     path BOOTS + MINES over the net
 *                                     adapter whose config pins
 *                                     `transport: 'memory'` (zero real
 *                                     sockets); a self-scan of this file:
 *                                     NO wall-clock read, NO RNG (AD-3),
 *                                     and the imports are the app's PURE
 *                                     modules + `@succinctcoin/core` +
 *                                     `vitest` + node builtins ONLY (no
 *                                     `@libp2p/*` / `@multiformats/*`
 *                                     direct imports — the memory
 *                                     transport is reached through the
 *                                     core's `createNetAdapter`, AD-1).
 *
 * Done-when #4 (CAP-6 — the core suite unchanged under plain-Node) is a
 * GATE, not a row: the orchestrator re-runs the full core suite and the
 * diff-scope gate proves the core is untouched. This suite imports
 * `@succinctcoin/core` (the public barrel) — it does not run the core
 * suite.
 *
 * AD-3 discipline: the wait is a BOUNDED poll (a setTimeout deadline +
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
import type {
  CoreEvents,
  IdentityKeypair,
  NetAdapterConfig,
} from '@succinctcoin/core'

import forgeConfig from '../forge.config.js'
import { createCoreHost } from '../src/main/core-host.js'
import { inviteDiagnostics } from '../src/main/invite-diagnostics.js'
import type { CoreEventName, CoreEventPayload, CoreHost } from '../src/main/core-host.js'
import { buildInitialSnapshot, initialUiState, reduce } from '../src/renderer/ui-state.js'
import type { UiEvent, UiState } from '../src/renderer/ui-state.js'

// ---------------------------------------------------------------------------
// pinned parameters (6.4 — deterministic, AD-3)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
/** The app's `package.json` (the `main` entry + the `package` script). */
const APP_PKG_PATH = join(here, '..', 'package.json')
/** The renderer's PURE ui-state module (the no-timer re-assert scans it). */
const UI_STATE_SRC_PATH = join(here, '..', 'src', 'renderer', 'ui-state.ts')
/** The renderer's hook (the no-timer re-assert scans it too). */
const HOOK_SRC_PATH = join(here, '..', 'src', 'renderer', 'useSuccinctcoin.ts')

/** A 32-byte pinned identity seed (AD-3: no RNG — the key lives in the host). */
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (0x40 + i) % 256))

/** The accepted-gate registry (the genesis config — AD-4). */
const ACCEPTED_GATES = ['biometric', 'social-graph']

/** The closed-system maxSupply display (the genesis emission, AD-5). */
const MAX_SUPPLY_DISPLAY = '21000000'

/** The key-material names AD-11 bans from the boundary (case-insensitive). */
const KEY_NAME_RE = /privatekey|secret|keypair/i

/** One forwarded core event (the recorder row). */
interface Recorded {
  event: CoreEventName
  payload: CoreEventPayload
}

/** The per-test harness state (`afterEach` always stops the host). */
interface Harness {
  host: CoreHost
  identity: IdentityKeypair
  netConfig: NetAdapterConfig
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
    // emits `CoreStopped`, closes the store, releases the lock; the host
    // stops the net too).
    await h.host.stop()
  } catch {
    /* the temp dir cleanup below is what matters for isolation. */
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// the harness (the 6.2 shape — real ports over the memory transport)
// ---------------------------------------------------------------------------

/**
 * Build the host with REAL ports (the in-app path, AD-10): a
 * `createNetAdapter` over the memory transport (zero real sockets), a
 * real `FileChainStore` in a temp dir, `createOfflineGateVerifier`, a
 * REAL identity (derived from the pinned seed — AD-11: the key lives in
 * the host), and the `forwardEvent` recorder (the fake IPC).
 */
function buildHarness(memoryName: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-e2e-'))
  const identity = deriveIdentityKeypair(SEED)
  const recorded: Recorded[] = []
  const netConfig: NetAdapterConfig = {
    transport: 'memory',
    listenAddress: `/memory/${memoryName}`,
    // The adapter stamps the PROTOCOL identity id into envelopes (5.2
    // D3) — a plain public string, never key material (AD-11).
    protocolIdentityId: identity.identityId,
  }
  const host = createCoreHost({
    net: createNetAdapter(netConfig),
    store: new FileChainStore(dir),
    gate: createOfflineGateVerifier({ acceptedGates: ACCEPTED_GATES }),
    // The fake IPC (the AD-11 boundary): the host's `forwardEvent`.
    forwardEvent: (event, payload) => {
      recorded.push({ event, payload })
    },
    identity,
  })
  return { host, identity, netConfig, recorded, dir }
}

/**
 * Bounded poll (AD-3 — NO wall-clock assertion): a 10 ms setTimeout tick
 * loop until `pred()` passes; a separate setTimeout deadline rejects if
 * the bound elapses (a liveness bound, like the 6.2 harness — NOT a
 * timestamp read).
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

/** Start the host, mine at least one loop block (bounded poll). */
async function startAndMine(h: Harness): Promise<void> {
  await h.host.start()
  await h.host.startMining()
  await pollUntil(() => sawMinedBlock(h.recorded), 'a BlockApplied past the genesis slot')
}

// ---------------------------------------------------------------------------
// the renderer integration (the NEW proof — host events → ui-state)
// ---------------------------------------------------------------------------

/**
 * The pure mapper: a recorded core event → the renderer's local
 * `UiEvent` projection (or `null` for a name the UI does not reduce).
 * The renderer NAMES the events only — the payload shape is owned by the
 * core's `CoreEvents` (AD-9's one-owner rule).
 */
function toUiEvent(r: Recorded): UiEvent | null {
  switch (r.event) {
    case 'CoreStarted':
      return { type: 'CoreStarted', payload: { slot: (r.payload as CoreEvents['CoreStarted']).slot } }
    case 'CoreStopped':
      return { type: 'CoreStopped', payload: { slot: (r.payload as CoreEvents['CoreStopped']).slot } }
    case 'BlockApplied': {
      const p = r.payload as CoreEvents['BlockApplied']
      return {
        type: 'BlockApplied',
        payload: {
          slot: p.slot,
          hash: p.hash,
          winnerIdentityId: p.winnerIdentityId,
          ticketCount: p.ticketCount,
          txCount: p.txCount,
        },
      }
    }
  }
  return null
}

/**
 * The host-backed bridge — this suite's stand-in for
 * `window.succinctcoin`: the SAME AD-11 surface (commands + the event
 * stream + the read-API), backed by the running `CoreHost` (the read-API
 * delegates to the host's read-API — the key-free read-models).
 */
function makeBridge(host: CoreHost): Window['succinctcoin'] {
  const listeners = new Map<string, (payload: unknown) => void>()
  return {
    start: () => host.start(),
    stop: () => host.stop(),
    startMining: () => host.startMining(),
    getChainHead: () => host.getChainHead(),
    getBalances: () => host.getBalances(),
    getPeers: () => host.getPeers(),
    getBlock: (slot) => host.getBlock(slot),
    getInvite: async () => host.getInvite(),
    // Post-9.5: diagnostics are glue-level (not host-level) — the stand-in
    // reports the empty table (the pure module is tested directly).
    getInviteDiagnostics: async () => inviteDiagnostics({}),
    applyInvite: (text) => host.applyInvite(text),
    on: (event, cb) => {
      listeners.set(event, cb as (payload: unknown) => void)
      return () => {
        listeners.delete(event)
      }
    },
  }
}

/**
 * Feed the recorded core events through the renderer's ui-state with the
 * HOOK's data-flow semantics (`useSuccinctcoin`): the event stream
 * reduces the PURE ui-state (`toUiEvent` + `reduce`); `CoreStarted`
 * re-runs the read-API snapshot (event-driven, NOT polling); each
 * `BlockApplied` re-reads the read-API (the F3 re-read — the event
 * carries only the head fields). No timers anywhere (E1).
 */
async function driveUi(
  recorded: readonly Recorded[],
  bridge: Window['succinctcoin'],
): Promise<UiState> {
  let ui: UiState = initialUiState()
  for (const r of recorded) {
    const ev = toUiEvent(r)
    if (ev === null) continue
    ui = reduce(ui, ev)
    if (ev.type === 'CoreStarted') {
      const snapshot = await buildInitialSnapshot(bridge)
      ui = { ...snapshot, mining: ui.mining }
    } else if (ev.type === 'BlockApplied') {
      const snapshot = await buildInitialSnapshot(bridge)
      ui = {
        ...ui,
        head: snapshot.head ?? ui.head,
        balances: snapshot.balances ?? ui.balances,
        peers: snapshot.peers.length > 0 ? snapshot.peers : ui.peers,
      }
    }
  }
  return ui
}

// ---------------------------------------------------------------------------
// the static-scan helpers (the 6.2/6.3 self-scan style)
// ---------------------------------------------------------------------------

/** Strip comments (the 4.7-style self-scan — comments may name a rule; code may not). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

// ---------------------------------------------------------------------------
// E2E_FORGE_CONFIG_RESOLVES (Done-when #1 — the packaging)
// ---------------------------------------------------------------------------

describe('6.4 — the closing end-to-end suite (plain Node, memory transport, zero real sockets)', () => {
  it('E2E_FORGE_CONFIG_RESOLVES: the forge config is a valid plain object + the app main is the electron MAIN-process entry (static — no electron launch)', () => {
    // The `forge.config.js` default export — a plain object (NO type
    // import from the transitive `@electron-forge/shared-types`):
    expect(typeof forgeConfig).toBe('object')
    expect(forgeConfig).not.toBeNull()

    // The packager config (the `package` command needs it): the app name
    // + the executable name, EXACTLY as the plan §3.2 pins them:
    expect(forgeConfig.packagerConfig).toEqual({
      name: 'SuccinctCoin',
      executableName: 'succinctcoin',
    })

    // The makers (for `make`): the zip maker for the three launch
    // platforms, referenced by NAME string (the maker packages are NOT
    // installed — the config + this test do not need them):
    expect(forgeConfig.makers).toEqual([
      {
        name: '@electron-forge/maker-zip',
        platforms: ['darwin', 'win32', 'linux'],
        config: {},
      },
    ])

    // The rebuild config (an object — the native-rebuild step's config):
    expect(forgeConfig.rebuildConfig).toEqual({})

    // The app's `package.json`: the `main` field is EXACTLY
    // `./dist/main/index.js` (the electron MAIN-process entry — the app's
    // entry; `tsconfig.build.json` emits `src/main/index.ts` → there) and
    // the `package` script runs `electron-forge package`:
    const pkg = JSON.parse(readFileSync(APP_PKG_PATH, 'utf8')) as {
      main?: string
      scripts?: Record<string, string>
    }
    expect(pkg.main).toBe('./dist/main/index.js')
    expect(pkg.scripts?.package).toBe('electron-forge package')

    // The entry's SOURCE is the electron MAIN process: `src/main/index.ts`
    // (which `tsconfig.build.json` emits to `./dist/main/index.js`) imports
    // `electron` (the AD-1 main-path import) — the entry is not a
    // non-electron file (the row name's claim, not just the string):
    const mainSrcPath = join(here, '..', 'src', 'main', 'index.ts')
    const mainSrc = stripComments(readFileSync(mainSrcPath, 'utf8'))
    expect(mainSrc, 'src/main/index.ts imports electron').toMatch(
      /from\s+['"]electron['"]/,
    )
  })

  // -----------------------------------------------------------------------
  // E2E_IN_APP_PATH_MINES_AND_RENDERS (Done-when #1 + #2)
  // -----------------------------------------------------------------------

  it('E2E_IN_APP_PATH_MINES_AND_RENDERS: the host mines over memory and the BlockApplied reaches the renderer ui-state (the event stream + the read-API — no polling)', async () => {
    harness = buildHarness('e2e-mines-and-renders')
    const { host, recorded } = harness

    // The in-app path: boot + the integrated slot loop, a bounded poll
    // (AD-3) for a `BlockApplied` past the genesis slot.
    await startAndMine(harness)

    // The first event is `CoreStarted` (the empty-chain slot -1 — the
    // genesis emits no `BlockApplied`, the host's clock cache starts at
    // -1, AD-3); the loop then mined (at least one `BlockApplied`).
    expect(recorded[0]?.event).toBe('CoreStarted')
    const applied = recorded
      .filter((r) => r.event === 'BlockApplied')
      .map((r) => r.payload as CoreEvents['BlockApplied'])
    expect(applied.length).toBeGreaterThanOrEqual(1)

    // THE NEW INTEGRATION: feed EVERY recorded core event into the
    // renderer's ui-state (the hook's data-flow semantics — the reducer +
    // the event-driven snapshot re-reads; NO polling, NO timers).
    const bridge = makeBridge(host)
    const ui = await driveUi([...recorded], bridge)

    // A block was mined AND reached the renderer's data source:
    expect(ui.head).not.toBeNull()
    expect(ui.mining).toBe(true)
    expect(ui.head!.slot).toBeGreaterThanOrEqual(1)
    // The UI's balance + peers are driven by the snapshot (the read-API):
    expect(ui.balances).not.toBeNull()
    expect(ui.balances!.balances[MINT_ID]).toMatch(/^\d+$/)
    expect(Array.isArray(ui.peers)).toBe(true)

    // The read-API (the AD-9 snapshot source) reflects the mined state:
    const head = await host.getChainHead()
    const balances = await host.getBalances()
    const peers = await host.getPeers()
    expect(head.slot).toBeGreaterThanOrEqual(1)
    expect(head.totalSupplyDisplay).toBe(MAX_SUPPLY_DISPLAY) // the closed system
    expect(MINT_ID in balances.balances).toBe(true)
    expect(balances.balances[MINT_ID]).toMatch(/^\d+$/) // decimal string, AD-5
    expect(BigInt(balances.balances[MINT_ID])).toBeGreaterThan(0n) // non-zero emission
    expect(Array.isArray(peers)).toBe(true)

    // The no-timer static check (6.3's RENDERER_NO_POLL, re-asserted on the
    // ui-state + the hook source): the ui-state is PURE — the data flows
    // from the event stream + the read-API, never a poll.
    for (const srcPath of [UI_STATE_SRC_PATH, HOOK_SRC_PATH]) {
      const code = stripComments(readFileSync(srcPath, 'utf8'))
      expect(code, `setInterval in ${srcPath}`).not.toMatch(/setInterval/)
      expect(code, `setTimeout in ${srcPath}`).not.toMatch(/setTimeout/)
    }
  }, 15000)

  // -----------------------------------------------------------------------
  // E2E_AD11_NO_KEYS_INTEGRATED (Done-when #3)
  // -----------------------------------------------------------------------

  it('E2E_AD11_NO_KEYS_INTEGRATED: no key material crosses the integrated host → events → renderer-state boundary (by name + by value)', async () => {
    harness = buildHarness('e2e-ad11-integrated')
    const { host, identity, recorded } = harness
    await startAndMine(harness)

    const applied = recorded
      .filter((r) => r.event === 'BlockApplied')
      .map((r) => r.payload as CoreEvents['BlockApplied'])

    // The read-API results (all four operations, the AD-9 surface) + the
    // renderer's ui-state after the `reduce` (the integrated endpoint of
    // the event stream):
    const readApi = [
      await host.getChainHead(),
      await host.getBalances(),
      await host.getPeers(),
      await host.getBlock(applied[0].slot),
    ]
    const bridge = makeBridge(host)
    const ui = await driveUi([...recorded], bridge)
    const uiJson = JSON.stringify(ui) ?? ''

    // (a) By NAME: no key-material field in ANY forwarded payload, ANY
    //     read-API result, or the renderer's ui-state (AD-11):
    for (const r of recorded) {
      expect(JSON.stringify(r.payload) ?? '', `forwarded ${r.event}`).not.toMatch(KEY_NAME_RE)
    }
    for (const result of readApi) {
      expect(JSON.stringify(result) ?? '', 'read-API result').not.toMatch(KEY_NAME_RE)
    }
    expect(uiJson, 'the renderer ui-state').not.toMatch(KEY_NAME_RE)

    // (b) By VALUE: the identity's `.secret` bytes (the PKCS#8 DER — the
    //     AD-11 key material) never appear in ANY forwarded payload, ANY
    //     read-API result, or the renderer's ui-state (hex-scanned):
    const secretHex = Buffer.from(identity.secret).toString('hex')
    const everything = [
      ...recorded.map((r) => JSON.stringify(r.payload) ?? ''),
      ...readApi.map((r) => JSON.stringify(r) ?? ''),
      uiJson,
    ].join('')
    expect(everything).not.toContain(secretHex)

    // (c) The PUBLIC identity id MAY appear (AD-11: "the UI gets only peer
    //     IDs, status, signed artifacts") — and it does: the
    //     `BlockApplied` winner is the local identity (a single
    //     participant always wins its own draw):
    expect(applied[0].winnerIdentityId).toBe(identity.identityId)
    expect(everything).toContain(identity.identityId)
  }, 15000)

  // -----------------------------------------------------------------------
  // E2E_MEMORY_TRANSPORT_PIN (Done-when #5)
  // -----------------------------------------------------------------------

  it('E2E_MEMORY_TRANSPORT_PIN: the in-app path runs over the memory transport (zero real sockets) + the self-scan (no wall clock, no RNG, the pure-module import set only)', async () => {
    harness = buildHarness('e2e-transport-pin')
    const { netConfig } = harness

    // The in-app path BOOTS + MINES over the net adapter whose config
    // pins the memory transport (AD-10 — the empirical zero-sockets proof
    // is this integrated run, headless, no electron, no real socket):
    await startAndMine(harness)
    expect(netConfig.transport).toBe('memory')

    // The self-scan of THIS file (the 5.10/6.2 guard pattern,
    // comment-stripped — comments may name a rule; code may not):
    const selfSource = stripComments(
      readFileSync(fileURLToPath(import.meta.url), 'utf8'),
    )
    // AD-3 — no wall-clock read, no RNG (the wait is a bounded poll):
    expect(selfSource).not.toMatch(/Date\.now\s*\(/)
    expect(selfSource).not.toMatch(/\bMath\.random\s*\(/)
    // The import set is EXACTLY the app's PURE modules + the core's
    // public package surface + vitest + node builtins (no @libp2p/*, no
    // @multiformats/* — the memory transport is reached through the
    // core's createNetAdapter, AD-1):
    const importSpecifiers = [
      ...selfSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1])
    // (code-unit sort: `.` < `@` < `n` < `v` — the `../` specs first)
    expect([...new Set(importSpecifiers)].sort()).toEqual([
      '../forge.config.js',
      '../src/main/core-host.js',
      '../src/main/invite-diagnostics.js', // post-9.5 pure diagnostics module
      '../src/renderer/ui-state.js',
      '@succinctcoin/core',
      'node:fs',
      'node:os',
      'node:path',
      'node:url',
      'vitest',
    ])
    expect(selfSource).not.toMatch(/from\s+['"]@libp2p\//)
    expect(selfSource).not.toMatch(/from\s+['"]@multiformats\//)
  }, 15000)
})
