/**
 * Ticket 8 — the HEADLESS node runner (`src/main/run-node.ts` + the CLI shell).
 *
 * Plain Node, zero real sockets (AD-10): the runner's net factory seam is
 * injected with the core's MEMORY transport, exactly as the 6.4 suite injects
 * its own net config — production cannot reach this path (the default factory
 * is `createNetAdapter`, a source scan below pins that neither runner file
 * imports electron, and the packaged-boot suite holds the emitted bundle to
 * builtins-only).
 *
 *   RUNNER_BOOTS_AND_MINES      boot → mining → at least one mined-block log
 *                               line; the data dir gains the chain store; a
 *                               clean idempotent stop.
 *   RUNNER_IDENTITY_IS_PERSISTED  same --data-dir twice ⇒ the SAME identityId
 *                               (the 8.1 property, proven through THIS entry
 *                               point); a different dir ⇒ a different one.
 *   RUNNER_INVITE_IS_REAL_DATA    the printed `scinvite:v1:…` line parses and
 *                               verifies through the SHIPPED `verifyInvite`
 *                               against this chain — what a server operator
 *                               copies out of the journal is dialable data,
 *                               not decoration. (The memory adapter's own
 *                               address is off-policy, so the seam reports a
 *                               policy-valid global listen address — the same
 *                               surface the real tcp adapter yields.)
 *   RELAY_SEED_FEEDBACK       the adapter's seed hold/fail events (the only
 *                               feedback a hidden-node operator gets) reach the
 *                               injected log.
 *   BOOT_FAILURE_CLEANUP      a contended data dir (`SC-STORE-1`, thrown after
 *                               the adapter is built) rejects AND leaves no
 *                               transport open behind the rejection.
 *   RUNNER_LOGS_CARRY_NO_KEYS AD-11 over every captured line: no key-material
 *                               name, and neither the seed's text nor a
 *                               rendering of its bytes appears; the seed file
 *                               keeps mode 0600.
 *   ARGV_PRECEDENCE + USAGE       flags override env (observed in the built net
 *                               config), unknown flags die, --data-dir is
 *                               required.
 *   NO_MINE                       `--no-mine` boots an apply-only node: genesis
 *                               stays the head, and the journal stays silent.
 *   (Journal hygiene is pinned inside BOOTS_AND_MINES: mining logs are a
 *   heartbeat — the first block, then every 25th — never one line per block.)
 */
import { mkdtempSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createNetAdapter, loadGenesis, verifyInvite } from '@succinctcoin/core'
import type { NetAdapter, NetAdapterConfig } from '@succinctcoin/core'

import { RUNNER_USAGE, parseRunnerArgs, runNode } from '../src/main/run-node.js'
import type { NodeRunHandle } from '../src/main/run-node.js'

// test → app → packages → repo root (the ONE repo genesis the app build
// copies into dist/config; a headless runner is told this path with --genesis).
const REPO_GENESIS = join(import.meta.dirname, '..', '..', '..', 'config', 'genesis.json')

/** A fixture interface table: no global v6 (the reported dev-box state), so the
 * runner's honest "why no invite" diagnostics are exercised deterministically. */
const NO_GLOBAL_V6 = {
  en0: [{ address: 'fe80::1%en0', family: 'IPv6' }],
  lo0: [{ address: '::1', family: 'IPv6' }],
}

interface Harness {
  handle: NodeRunHandle
  logs: string[]
  configs: NetAdapterConfig[]
  dir: string
  /** How many times the injected adapter's `stop()` ran — the boot-failure
   * cleanup pin needs to see a transport closed without a returned handle. */
  netStops(): number
}

/**
 * Boot the runner over an injected memory adapter. `listenAs` replaces the
 * adapter's reported listen addresses (the announce source) — a global v6 text
 * is what makes the invite path reachable at all, since `/memory/…` is
 * off-policy by design and an announce with no policy-valid address is skipped.
 */
async function bootRunner(opts: {
  dir?: string
  env?: Record<string, string | undefined>
  flags?: { listenPort?: number; relayServer?: boolean }
  listenAs?: string[]
  startMining?: boolean
} = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'succinctcoin-runner-'))
  const logs: string[] = []
  const configs: NetAdapterConfig[] = []
  let netStops = 0
  const handle = await runNode({
    dataDir: dir,
    genesisPath: REPO_GENESIS,
    env: opts.env ?? {},
    platform: 'linux',
    interfaces: () => NO_GLOBAL_V6,
    flags: opts.flags,
    startMining: opts.startMining,
    log: (line) => logs.push(line),
    net: (config) => {
      configs.push(config)
      const base = createNetAdapter({
        ...config,
        transport: 'memory',
        listenAddress: `/memory/runner-${configs.length}-${Math.abs(hashOf(dir))}`,
      })
      const impl: NetAdapter =
        opts.listenAs === undefined
          ? base
          : ({ ...base, listenAddresses: () => opts.listenAs ?? [] } as NetAdapter)
      return {
        ...impl,
        stop: async () => {
          netStops += 1
          await impl.stop()
        },
      }
    },
  })
  return { handle, logs, configs, dir, netStops: () => netStops }
}

function hashOf(text: string): number {
  let h = 0
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0
  return h
}

/** Bounded poll (AD-3 — a deadline, never a wall-clock assertion). Predicates
 * may be async (a promise is awaited, never truth-tested — a pending promise
 * is always truthy, which would make the poll lie). */
function waitFor(
  pred: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 8000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error(`bounded poll: ${what} — no match in time`))
    }, deadlineMs)
    const tick = (): void => {
      if (settled) return
      void Promise.resolve()
        .then(pred)
        .then((ok) => {
          if (settled) return
          if (ok) {
            settled = true
            clearTimeout(timer)
            resolve()
            return
          }
          setTimeout(tick, 10)
        })
        .catch((err: unknown) => {
          settled = true
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
    }
    tick()
  })
}

describe('ticket 8 — the headless node runner', () => {
  it('RUNNER_BOOTS_AND_MINES: boots, mines, logs, stores, stops cleanly', async () => {
    const h = await bootRunner()
    try {
      expect(h.logs.some((l) => l.startsWith('[boot] identity '))).toBe(true)
      // The honest addressing lines (memory addrs are off-policy ⇒ the second
      // one plus the interface diagnostics fire — the operator's question).
      expect(h.logs.some((l) => l.includes('no dialable (global IPv6) listen address'))).toBe(true)
      expect(h.logs.some((l) => l.startsWith('[boot] reachability '))).toBe(true)
      expect(h.logs.some((l) => l.includes('"linkLocalCount":1'))).toBe(true)
      await waitFor(() => h.logs.some((l) => l.startsWith('[mined] ')), 'a mined block')
      // The ladder report rides the INJECTED sink (not `console.info`): on a
      // server the journal is the only place an operator can read it. It
      // arrives with the first discovery window, so it is waited for.
      await waitFor(() => h.logs.some((l) => l.startsWith('[discovery-ladder] ')), 'the ladder report')
      const head = await h.handle.host.getChainHead()
      expect(head.slot).toBeGreaterThanOrEqual(1)
      // Ordering: the addressing answer comes BEFORE the loop starts producing,
      // so the first thing in a journal is "who am I / where am I".
      const firstMined = h.logs.findIndex((l) => l.startsWith('[mined] '))
      const lastBootLine = h.logs.reduce((acc, l, i) => (l.startsWith('[boot] ') ? i : acc), -1)
      expect(lastBootLine).toBeGreaterThanOrEqual(0)
      expect(lastBootLine).toBeLessThan(firstMined)
      // Journal hygiene: the loop mints a block per tick, so mining is logged
      // as a heartbeat (the first, then every 25th) — never one line each.
      await waitFor(
        async () => (await h.handle.host.getChainHead()).slot >= 30,
        'thirty slots of mining',
      )
      const minedLines = h.logs.filter((l) => l.startsWith('[mined] '))
      expect(minedLines[0]).toContain('1 blocks, head slot 1')
      for (const line of minedLines.slice(1)) {
        const n = Number(/^\[mined\] (\d+) blocks,/.exec(line)?.[1])
        expect(Number.isInteger(n) && n % 25 === 0).toBe(true)
      }
      // The chain store landed under the operator's --data-dir (the core's
      // layout: `chain/blocks/<slot>.block`, head scanned from those files).
      const blocks = await readdir(join(h.dir, 'chain', 'blocks'))
      expect(blocks.filter((f) => f.endsWith('.block')).length).toBeGreaterThanOrEqual(1)
      await h.handle.stop()
      await h.handle.stop() // idempotent
      expect(h.logs.some((l) => l.startsWith('[stop] core stopped'))).toBe(true)
    } finally {
      await h.handle.stop()
    }
  }, 30_000)

  it('RUNNER_IDENTITY_IS_PERSISTED: same data-dir ⇒ same identity; other dir differs', async () => {
    const a = mkdtempSync(join(tmpdir(), 'succinctcoin-runner-a-'))
    const b = mkdtempSync(join(tmpdir(), 'succinctcoin-runner-b-'))
    const running: NodeRunHandle[] = []
    try {
      const first = await bootRunner({ dir: a })
      running.push(first.handle)
      await first.handle.stop()
      const again = await bootRunner({ dir: a })
      running.push(again.handle)
      const other = await bootRunner({ dir: b })
      running.push(other.handle)
      expect(again.handle.identityId).toBe(first.handle.identityId)
      expect(other.handle.identityId).not.toBe(first.handle.identityId)
    } finally {
      for (const handle of running) await handle.stop()
    }
  }, 30_000)

  it('RUNNER_INVITE_IS_REAL_DATA: the printed invite verifies through verifyInvite', async () => {
    const h = await bootRunner({ listenAs: ['/ip6/2001:db8:c0a8:10a::/tcp/4001'] })
    try {
      await waitFor(() => h.logs.some((l) => l.includes('scinvite:v1:')), 'the invite line')
      const line = h.logs.find((l) => l.includes('scinvite:v1:')) ?? ''
      const text = line.slice(line.indexOf('scinvite:')).trim()
      const genesis = await loadGenesis(REPO_GENESIS)
      const head = await h.handle.host.getChainHead()
      const verdict = verifyInvite(text, {
        currentSlot: head.slot,
        expectedChainId: genesis.chainId,
        hadRecentTicket: () => true, // liveness is the caller's store question
      })
      if (!verdict.ok) throw new Error(`invite rejected: ${verdict.reason}`)
      expect(verdict.record.identityId).toBe(h.handle.identityId)
    } finally {
      await h.handle.stop()
    }
  }, 30_000)

  it('RELAY_SEED_FEEDBACK: hold/fail events reach the operator log', async () => {
    const seed = '/ip6/2001:db8:c0a8:10b::/tcp/4001/p2p/12D3KooSeed'
    const h = await bootRunner({ env: { SUCCINCTCOIN_RELAY_SEEDS: seed } })
    try {
      // The adapter never throws for a seed — these lines are the ONLY
      // feedback a hidden-node operator gets that relaying works.
      const onRelaySeed = h.configs[0]?.onRelaySeed
      expect(onRelaySeed, 'the runner wires onRelaySeed into the net config').toBeDefined()
      onRelaySeed?.({ seed, ok: true })
      onRelaySeed?.({ seed: '/ip6/2001:db8:c0a8:10b::/tcp/1/p2p/Bad', ok: false, error: 'no route' })
      expect(h.logs).toContain(`[boot] relay HOLD ${seed}`)
      expect(h.logs.some((l) => l.startsWith('[boot] relay FAIL') && l.includes('no route'))).toBe(
        true,
      )
    } finally {
      await h.handle.stop()
    }
  }, 30_000)

  it('BOOT_FAILURE_CLEANUP: a contended data dir fails loudly AND closes its transport', async () => {
    // The realistic boot failure: another process holds the store lock (taken
    // in the FileChainStore constructor, i.e. AFTER the adapter is built).
    const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-runner-lock-'))
    const holder = await bootRunner({ dir })
    let loserStops = 0
    try {
      await expect(
        runNode({
          dataDir: dir,
          genesisPath: REPO_GENESIS,
          env: {},
          platform: 'linux',
          log: () => {},
          net: (config) => {
            const base = createNetAdapter({
              ...config,
              transport: 'memory',
              listenAddress: '/memory/runner-loser',
            })
            return {
              ...base,
              stop: async () => {
                loserStops += 1
                await base.stop()
              },
            }
          },
        }),
      ).rejects.toThrow(/SC-STORE-1/)
      // Without the cleanup this transport would sit open with no handle to
      // close it — the CLI would hang instead of exiting.
      expect(loserStops).toBe(1)
    } finally {
      await holder.handle.stop()
    }
  }, 30_000)

  it('RUNNER_LOGS_CARRY_NO_KEYS: AD-11 over every captured line', async () => {
    const h = await bootRunner()
    try {
      await waitFor(() => h.logs.some((l) => l.startsWith('[mined] ')), 'a mined block')
      const all = h.logs.join('\n')
      expect(all).not.toMatch(/privateKey|secret|keypair/i)
      // The seed file is the one secret here: neither its text nor any
      // rendering of its bytes reaches a log line.
      const seed = (await readFile(join(h.dir, 'identity.seed'), 'utf8')).trim()
      expect(all).not.toContain(Buffer.from(seed, 'hex').toString('base64'))
      expect(seed).toMatch(/^[0-9a-f]{64}$/)
      expect(all).not.toContain(seed)
      // And the identity file keeps its 0600 mode through the runner.
      expect(statSync(join(h.dir, 'identity.seed')).mode & 0o777).toBe(0o600)
    } finally {
      await h.handle.stop()
    }
  }, 30_000)
})

describe('ticket 8 — the CLI shell is pure glue', () => {
  it('ARGV: flags override env, defaults hold, junk dies', async () => {
    const args = parseRunnerArgs(['--listen-port', '4101', '--relay'], '/default/genesis.json')
    expect(args.flags).toEqual({ listenPort: 4101, relayServer: true })
    expect(args.genesisPath).toBe('/default/genesis.json')
    expect(parseRunnerArgs(['--genesis', '/g.json'], '/d').genesisPath).toBe('/g.json')
    expect(parseRunnerArgs([], '/d').dataDir).toBeUndefined() // the shell reports it
    expect(parseRunnerArgs([], '/d').mine).toBe(true) // mining is on unless told otherwise
    expect(parseRunnerArgs(['--no-mine'], '/d').mine).toBe(false)
    expect(parseRunnerArgs(['--help'], '/d').help).toBe(true)
    expect(() => parseRunnerArgs(['--nope'], '/d')).toThrow(/unknown argument/)
    expect(() => parseRunnerArgs(['--listen-port', '0'], '/d')).toThrow(/1-65535/)
    expect(() => parseRunnerArgs(['--genesis'], '/d')).toThrow(/needs a value/)

    // Observed precedence: the flag wins over the env knob in the built config.
    const h = await bootRunner({
      env: { SUCCINCTCOIN_LISTEN_PORT: '4200' },
      flags: { listenPort: 4300, relayServer: true },
    })
    await h.handle.stop()
    expect(h.configs[0]?.listenAddress).toBe('/ip6/::/tcp/4300')
    expect(h.configs[0]?.relayRole).toBe('relay')
    // And env alone still works (the app's knobs are unchanged).
    const byEnv = await bootRunner({ env: { SUCCINCTCOIN_LISTEN_PORT: '4242' } })
    await byEnv.handle.stop()
    expect(byEnv.configs[0]?.listenAddress).toBe('/ip6/::/tcp/4242')
    // Precedence cuts both ways: `--no-relay` refuses a role the env sets.
    expect(parseRunnerArgs(['--no-relay'], '/d').flags.relayServer).toBe(false)
    const refused = await bootRunner({
      env: { SUCCINCTCOIN_RELAY_SERVER: '1' },
      flags: { relayServer: false },
    })
    await refused.handle.stop()
    expect(refused.configs[0]?.relayRole).toBeUndefined()
  }, 30_000)

  it('NO_MINE: an apply-only node boots, stays quiet, and holds genesis', async () => {
    const h = await bootRunner({ startMining: false })
    // A MINING node runs through the same window: its first line proves the
    // wait was long enough to be meaningful, so the silence below cannot pass
    // vacuously (a broken loop would make both nodes quiet).
    const miner = await bootRunner()
    try {
      await waitFor(() => miner.logs.some((l) => l.startsWith('[mined] ')), 'the miner speaks')
      expect(h.logs.some((l) => l.startsWith('[boot] identity '))).toBe(true)
      expect(h.logs.filter((l) => l.startsWith('[mined] '))).toEqual([])
      expect((await h.handle.host.getChainHead()).slot).toBe(0)
    } finally {
      await miner.handle.stop()
      await h.handle.stop()
    }
  }, 30_000)

  it('NO_ELECTRON: neither runner file imports electron (the headless pin)', async () => {
    for (const rel of ['../src/main/run-node.ts', '../src/main/cli/run-node.ts']) {
      const src = await readFile(new URL(rel, import.meta.url), 'utf8')
      expect(src, rel).not.toMatch(/from 'electron'|require\('electron'\)/)
    }
    // The bundle entry exists and the build script emits it.
    const pkg = JSON.parse(
      await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toContain('vite.node.config.ts')
    expect(pkg.scripts['start:node']).toBe('node dist/node/run-node.js')
    expect(RUNNER_USAGE).toContain('--data-dir')
  })
})
