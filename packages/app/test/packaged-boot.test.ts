/**
 * Plan `plan-packaged-app-boot` matrix — the packaged app's boot inputs
 * under PLAIN NODE (AD-10: no electron spawn, no DOM). The packaged app
 * is SELF-CONTAINED (the core + its whole libp2p graph + big.js are
 * inlined into the bundles; externals are exactly {`electron`, node
 * builtins}) and BOOTABLE from its BUNDLED genesis — these rows prove
 * both without launching electron.
 *
 *   GENESIS_COPY             the app build's copy step (`node
 *                            scripts/copy-genesis.mjs` — run HERE, the row
 *                            produces its own precondition) puts the repo
 *                            `config/genesis.json` at
 *                            `dist/config/genesis.json` BYTE-IDENTICAL
 *                            (`copyFileSync`, no re-serialization); the
 *                            core's `loadGenesis` validates it (the ONE
 *                            source both the gate registry and
 *                            `host.start(genesisPath())` read).
 *   BOOT_FROM_BUNDLED        self-sufficient (runs the copy step itself
 *                            first — F6): `createCoreHost` + REAL ports
 *                            (the memory net — zero real sockets, a tmp
 *                            `FileChainStore`, the offline gate built from
 *                            the BUNDLED genesis's gate registry) →
 *                            `host.start(bundledPath)` + `startMining()`
 *                            → `CoreStarted` {slot:-1} then a BOUNDED poll
 *                            (AD-3 — a `setTimeout` deadline + a 10 ms
 *                            tick loop, NO wall-clock assertion) for a
 *                            `BlockApplied` with slot >= 1;
 *                            `getChainHead()` reflects it.
 *   BUNDLE_SELF_CONTAINED    the suite's build owner (plants a simulated
 *                            stale prior-pipeline emit —
 *                            `dist/main/stale-emit.js` — then runs the
 *                            app's `build` script — `corepack pnpm build`
 *                            in the app dir — UNCONDITIONALLY — F3/F7):
 *                            ALL FIVE pinned artifacts exist after the
 *                            clean build (`dist/main/index.js`,
 *                            `dist/preload.mjs`,
 *                            `dist/config/genesis.json`,
 *                            `dist/renderer/index.html`,
 *                            `dist/node/run-node.js`), the planted
 *                            stale emit is GONE (the clean step ran), and
 *                            EVERY comment-stripped import specifier
 *                            (static `from '...'` + line-anchored
 *                            side-effect `import '...'` + dynamic
 *                            `import('...')`) is `electron` or a node
 *                            builtin WITH OR WITHOUT the `node:` prefix
 *                            (Node's ESM loader resolves both identically;
 *                            `node:module`'s `builtinModules` is the
 *                            authoritative set): the core is INLINED, the
 *                            package needs no workspace node_modules. The
 *                            headless runner bundle is held to the STRICTER
 *                            rule — node builtins ONLY, `electron` is not even
 *                            an allowed specifier (ticket 8: it runs on plain
 *                            Node).
 *                            (Node's ESM loader resolves both identically;
 *                            `node:module`'s `builtinModules` is the
 *                            authoritative set): the core is INLINED, the
 *                            package needs no workspace node_modules. The
 *                            negative checks (`@succinctcoin/core`,
 *                            `@libp2p/*`, `big.js`) run on the EXTRACTED
 *                            specifier set — the rolldown output's
 *                            `//#region .../@libp2p/...` source markers +
 *                            inlined `Symbol.for("@libp2p/...")` keys are
 *                            inlined code, not imports (a whole-text scan
 *                            false-positives).
 *   PATH_THREADED            `src/main/index.ts` source (comment-stripped):
 *                            EVERY `host.start` call passes `genesisPath()`
 *                            (never the core's independent default), and
 *                            `genesisPath()` = `join(<module dir>, '..',
 *                            'config', 'genesis.json')` — the bundled
 *                            `dist/config/genesis.json`, ONE level up from
 *                            `dist/main/`.
 *   MISSING_GENESIS          `host.start('<nonexistent>')` REJECTS (the
 *                            core's `loadGenesis` `SC-CONFIG-1` failure —
 *                            a normal rejection, never an unhandled throw).
 *
 * Imports: the app's PURE modules (`../src/main/core-host.js`) + the REAL
 * core ports from the `@succinctcoin/core` package (its dist — the build
 * order holds) + `vitest` + node builtins ONLY. NO electron import
 * (headless-safe, AD-10).
 *
 * AD-3 discipline: the wait is a BOUNDED poll (a `setTimeout` deadline +
 * a 10 ms tick loop — a liveness bound, NOT a timestamp read); the
 * identity seed is a pinned 32-byte constant (no RNG).
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  FileChainStore,
  createNetAdapter,
  createOfflineGateVerifier,
  deriveIdentityKeypair,
  loadGenesis,
} from '@succinctcoin/core'
import type { CoreEvents, IdentityKeypair } from '@succinctcoin/core'

import { createCoreHost } from '../src/main/core-host.js'
import type { CoreEventName, CoreEventPayload, CoreHost } from '../src/main/core-host.js'

// ---------------------------------------------------------------------------
// pinned paths + parameters (deterministic, AD-3)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
/** The app package dir (the scripts, the bundles, the `build` script). */
const APP_DIR = join(here, '..')
/** The repo root (the ONE genesis source: `config/genesis.json`). */
const REPO_ROOT = join(APP_DIR, '..', '..')
const REPO_GENESIS = join(REPO_ROOT, 'config', 'genesis.json')
/** The BUNDLED genesis (the app build's LAST step — a byte-identical copy). */
const BUNDLED_GENESIS = join(APP_DIR, 'dist', 'config', 'genesis.json')
/** The PINNED bundle layout (the forge `main` + the Electron ESM-preload rule). */
const MAIN_BUNDLE = join(APP_DIR, 'dist', 'main', 'index.js')
const PRELOAD_BUNDLE = join(APP_DIR, 'dist', 'preload.mjs')
/** The bundled renderer entry (the build's renderer `vite build` step). */
const RENDERER_INDEX = join(APP_DIR, 'dist', 'renderer', 'index.html')
/** The headless runner bundle (ticket 8 — plain Node, NO Electron anywhere). */
const NODE_BUNDLE = join(APP_DIR, 'dist', 'node', 'run-node.js')
/** A simulated stale prior-pipeline emit (the clean-step probe — F7). */
const STALE_EMIT = join(APP_DIR, 'dist', 'main', 'stale-emit.js')
/** The thin electron glue (the `PATH_THREADED` scan target). */
const MAIN_SRC = join(APP_DIR, 'src', 'main', 'index.ts')

/** A 32-byte pinned identity seed (AD-3: no RNG — the key lives in the host). */
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (0x40 + i) % 256))

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
    // ALWAYS stop the host, even on test failure (AD-9: halts the loop if
    // any, closes the store — released even when `start` rejected AFTER
    // opening it — releases the lock; the host stops the net too).
    await h.host.stop()
  } catch {
    /* the temp dir cleanup below is what matters for isolation. */
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

/**
 * Build the host with REAL ports (the 6.2 harness shape): a
 * `createNetAdapter` over the memory transport (zero real sockets), a real
 * `FileChainStore` in a temp dir, `createOfflineGateVerifier` (the gate
 * registry from the given genesis config — AD-4), a REAL identity
 * (derived from the pinned seed — AD-11: the key lives in the host), and
 * the `forwardEvent` recorder (the fake IPC).
 */
function buildHarness(memoryName: string, acceptedGates: string[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-packaged-'))
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
    gate: createOfflineGateVerifier({ acceptedGates }),
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
 * the bound elapses (a liveness bound, NOT a timestamp read).
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

/**
 * EVERY import specifier in a bundle: static `from '...'` (covers
 * `import ... from` + `export ... from`) + line-anchored side-effect
 * imports (`import 'spec'` — no bindings, no `from`) + dynamic
 * `import('...')`. The rolldown output QUOTES package-like names in
 * `//#region ...` source markers and `Symbol.for("@libp2p/...")` keys —
 * INLINED CODE, not imports — so the scans run on this extracted set,
 * never on the whole text.
 */
function extractImportSpecifiers(src: string): string[] {
  const out: string[] = []
  const staticFrom = /from\s+['"]([^'"]+)['"]/g
  const sideEffectImport = /^import\s+['"]([^'"]+)['"]\s*$/gm
  const dynamicImport = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [staticFrom, sideEffectImport, dynamicImport]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) out.push(m[1])
  }
  return out
}

/** The app build's LAST step — the byte-identical genesis copy (F6/F3). */
function runCopyGenesis(): void {
  execFileSync(process.execPath, [join(APP_DIR, 'scripts', 'copy-genesis.mjs')], {
    cwd: APP_DIR,
    stdio: 'pipe',
  })
}

/** The app's `build` script (F3 — the self-sufficient precondition). */
function runAppBuild(): void {
  try {
    execFileSync('corepack', ['pnpm', 'build'], { cwd: APP_DIR, stdio: 'pipe' })
  } catch (err) {
    const e = err as { stderr?: Buffer }
    throw new Error(
      `app build failed: ${e.stderr?.toString().trim() ?? String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// the plan's I/O matrix (5 rows)
// ---------------------------------------------------------------------------

describe('packaged-app boot (plain Node, AD-10 headless-safe)', () => {
  // -----------------------------------------------------------------
  // GENESIS_COPY
  // -----------------------------------------------------------------

  it('GENESIS_COPY: the copy step puts the repo genesis at dist/config/genesis.json byte-identical; loadGenesis validates it', async () => {
    runCopyGenesis()
    expect(existsSync(BUNDLED_GENESIS), 'dist/config/genesis.json exists').toBe(true)

    // Byte-identical (copyFileSync — no re-serialization, no reformatting).
    const bundled = readFileSync(BUNDLED_GENESIS)
    const repo = readFileSync(REPO_GENESIS)
    expect(bundled.equals(repo), 'byte-identical to the repo genesis').toBe(true)

    // The core's `loadGenesis` validates it (the ONE source the gate
    // registry + `host.start(genesisPath())` read).
    const cfg = await loadGenesis(BUNDLED_GENESIS)
    const repoCfg = await loadGenesis(REPO_GENESIS)
    expect(cfg).toEqual(repoCfg)
  })

  // -----------------------------------------------------------------
  // BOOT_FROM_BUNDLED
  // -----------------------------------------------------------------

  it('BOOT_FROM_BUNDLED: the host boots + mines from the BUNDLED genesis path over the memory net', async () => {
    runCopyGenesis() // self-sufficient (F6): the row produces its own precondition
    // The gate registry comes from the BUNDLED copy (the ONE source).
    const bundledCfg = await loadGenesis(BUNDLED_GENESIS)
    harness = buildHarness('packaged-boot', bundledCfg.gates)
    const { host, recorded } = harness

    // The ONE source — threaded into `host.start`, never the core's
    // independent default (whose repo-root path is not in the package).
    await host.start(BUNDLED_GENESIS)
    // The FIRST event is `CoreStarted`, carrying the empty-chain slot -1
    // (the genesis emits no `BlockApplied` — AD-3).
    expect(recorded.length).toBeGreaterThanOrEqual(1)
    expect(recorded[0].event).toBe('CoreStarted')
    expect(recorded[0].payload).toEqual({ slot: -1 })

    await host.startMining() // the integrated slot loop
    await pollUntil(
      () => sawMinedBlock(recorded),
      'a BlockApplied past the genesis slot',
    )

    const applied = recorded
      .filter((r) => r.event === 'BlockApplied')
      .map((r) => r.payload as CoreEvents['BlockApplied'])
    expect(applied.length).toBeGreaterThanOrEqual(1)
    const latest = applied[applied.length - 1]
    expect(latest.slot).toBeGreaterThanOrEqual(1)

    // The read-API reflects the mined head.
    const head = await host.getChainHead()
    expect(head.slot).toBe(latest.slot)
    expect(head.hash).toBe(latest.hash)
  }, 15_000)

  // -----------------------------------------------------------------
  // BUNDLE_SELF_CONTAINED
  // -----------------------------------------------------------------

  it('BUNDLE_SELF_CONTAINED: the pinned bundle layout exists and EVERY import specifier is electron or a node builtin (the core is inlined)', async () => {
    // The suite's build owner (F3/F7): plant a simulated stale
    // prior-pipeline emit, then run the app build UNCONDITIONALLY — the
    // clean step only provably runs when the build runs — so a `build`
    // script that drops the renderer step OR the clean step turns red.
    mkdirSync(dirname(STALE_EMIT), { recursive: true })
    writeFileSync(STALE_EMIT, '/* stale prior-pipeline emit (clean-step probe) */\n')
    runAppBuild()

    // ALL FIVE pinned artifacts exist after a clean build (AC #1) — the
    // forge `main`, the Electron ESM-preload rule (the preload MUST be
    // `.mjs`), the ONE bundled genesis source, the renderer entry, and the
    // headless runner (ticket 8 — same build, no Electron).
    expect(existsSync(MAIN_BUNDLE), 'dist/main/index.js exists').toBe(true)
    expect(existsSync(PRELOAD_BUNDLE), 'dist/preload.mjs exists').toBe(true)
    expect(existsSync(BUNDLED_GENESIS), 'dist/config/genesis.json exists').toBe(true)
    expect(existsSync(RENDERER_INDEX), 'dist/renderer/index.html exists').toBe(true)
    expect(existsSync(NODE_BUNDLE), 'dist/node/run-node.js exists').toBe(true)
    // The planted stale emit is GONE — the build's clean step ran.
    expect(existsSync(STALE_EMIT), 'the planted stale emit is removed by the clean step').toBe(false)

    // The authoritative node-builtin set — prefix OPTIONAL (Node's ESM
    // loader resolves `crypto` and `node:crypto` identically; the inlined
    // third-party graph writes both forms).
    const builtins = new Set<string>([
      ...builtinModules,
      ...builtinModules.map((m) => `node:${m}`),
    ])

    for (const bundle of [MAIN_BUNDLE, PRELOAD_BUNDLE]) {
      const src = stripComments(readFileSync(bundle, 'utf8'))
      const specs = extractImportSpecifiers(src)
      expect(specs.length, `${bundle}: has import specifiers`).toBeGreaterThan(0)

      // EVERY specifier is `electron` or a node builtin (with or without
      // the `node:` prefix) — the package needs no workspace node_modules.
      const foreign = specs.filter((s) => s !== 'electron' && !builtins.has(s))
      expect(foreign, `${bundle}: specifiers outside {electron, node builtins}`).toEqual([])

      // The core + its graph + big.js are INLINED, not imported (the
      // extracted-specifier set — the rolldown `//#region` markers +
      // `Symbol.for("@libp2p/...")` keys are inlined code, not imports).
      const npm = specs.filter(
        (s) => s.startsWith('@succinctcoin/') || s.startsWith('@libp2p/') || s === 'big.js',
      )
      expect(npm, `${bundle}: the core graph must be inlined`).toEqual([])

      // Pure ESM (the repo is all-ESM; the Electron main + `.mjs` preload
      // both parse it).
      expect(src, `${bundle}: no require()`).not.toMatch(/\brequire\s*\(/)
    }

    // The headless runner is STRICTER: same self-containment, and `electron`
    // is not even an allowed specifier — this is the proof behind the README's
    // "no Electron module anywhere in it". (Checked on the EXTRACTED specifier
    // set: a dependency probing `process.versions.electron` at runtime is not
    // an import, and a whole-text scan would false-positive on it.)
    const nodeSrc = stripComments(readFileSync(NODE_BUNDLE, 'utf8'))
    const nodeSpecs = extractImportSpecifiers(nodeSrc)
    expect(nodeSpecs.length, 'dist/node/run-node.js: has import specifiers').toBeGreaterThan(0)
    const nodeForeign = nodeSpecs.filter((s) => !builtins.has(s))
    expect(nodeForeign, 'dist/node/run-node.js: node builtins ONLY (no electron)').toEqual([])
    const nodeNpm = nodeSpecs.filter(
      (s) => s.startsWith('@succinctcoin/') || s.startsWith('@libp2p/') || s === 'big.js',
    )
    expect(nodeNpm, 'dist/node/run-node.js: the core graph must be inlined').toEqual([])
    expect(nodeSrc, 'dist/node/run-node.js: no require()').not.toMatch(/\brequire\s*\(/)
  }, 300_000)

  // -----------------------------------------------------------------
  // PATH_THREADED
  // -----------------------------------------------------------------

  it('PATH_THREADED: every host.start call passes genesisPath(); genesisPath() = join(<module dir>, \'..\', \'config\', \'genesis.json\')', () => {
    const src = stripComments(readFileSync(MAIN_SRC, 'utf8'))

    // EVERY `host.start` call threads the bundled path (never the core's
    // independent default).
    const allStarts = src.match(/host\.start\s*\(/g) ?? []
    expect(allStarts.length, 'host.start call sites exist').toBeGreaterThanOrEqual(1)
    const threaded = src.match(/host\.start\s*\(\s*genesisPath\s*\(\s*\)\s*\)/g) ?? []
    expect(threaded.length, 'every host.start passes genesisPath()').toBe(allStarts.length)

    // `genesisPath()` = `join(<module dir>, '..', 'config', 'genesis.json')`
    // — ONE level up from `dist/main/` (the bundled `dist/config/genesis.json`).
    const body =
      src.match(/function genesisPath\s*\(\s*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(body.length, 'genesisPath() body found').toBeGreaterThan(0)
    expect(body.match(/'\.\.'/g) ?? [], 'exactly ONE level up').toHaveLength(1)
    expect(body, 'the config dir').toContain("'config'")
    expect(body, 'the genesis file').toContain("'genesis.json'")
    expect(body, 'based on the module dir').toContain('import.meta.url')
  })

  // -----------------------------------------------------------------
  // MISSING_GENESIS
  // -----------------------------------------------------------------

  it('MISSING_GENESIS: host.start of a nonexistent genesis REJECTS (the core loadGenesis failure — a normal rejection, never an unhandled throw)', async () => {
    harness = buildHarness('packaged-missing', ['biometric', 'social-graph'])
    const { host, dir } = harness
    const missing = join(dir, 'definitely-not-a-genesis.json')

    // A normal rejection (the core's `loadGenesis` `SC-CONFIG-1`) — caught
    // here: an unhandled throw would fail the test.
    let rejection: unknown = null
    try {
      await host.start(missing)
    } catch (err) {
      rejection = err
    }
    expect(rejection, 'host.start rejects for a nonexistent genesis').not.toBe(null)
    expect(String(rejection)).toMatch(/SC-CONFIG-1/)
  }, 15_000)
})
