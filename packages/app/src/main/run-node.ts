/**
 * `app/main/run-node` — the HEADLESS node runner (ticket 8, operator infra).
 *
 * WHY THIS EXISTS: the reliable way to be dialable is an always-on host with
 * native IPv6, and mining rewards UPTIME — but until now the only node entry
 * point was Electron's main process, so a server needed Xvfb + GUI deps. This
 * module is the CLI sibling of `index.ts`: the SAME boot, composed of the
 * SAME modules, with the two electron-specific pieces replaced by parameters
 * (AD-1 made `createCoreHost`/`defaultNetConfig`/`buildDiscoveryPorts`/
 * `loadOrCreateIdentitySeed` injection-friendly precisely so this file could
 * be thin glue rather than a second implementation).
 *
 * Electron-free AND side-effect-free until called: the data dir, genesis path,
 * env table, platform, interface table, net-adapter factory and log sink are
 * ALL parameters, so plain-Node tests drive the real code path with an
 * explicitly injected memory transport (AD-10 — nothing here can select it in
 * production; the default factory is `createNetAdapter`, which boots tcp).
 *
 * Identity parity: the seed file is `<dataDir>/identity.seed` in the SAME
 * format/permissions the app uses, so copying an existing install's seed to a
 * server yields the SAME identity (and corrupt content still throws rather
 * than silently re-rolling — `loadOrCreateIdentitySeed` owns that).
 *
 * AD-11: only key-free payloads reach `log` (the core's event projections), and
 * the seed never leaves the identity module.
 */
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FileChainStore,
  createNetAdapter,
  createOfflineGateVerifier,
  deriveIdentityKeypair,
  isGlobalIp6Multiaddr,
  lanModeDropsAddress,
  loadGenesis,
} from '@succinctcoin/core'
import type {
  GenesisConfig,
  IdentityKeypair,
  NetAdapter,
  NetAdapterConfig,
} from '@succinctcoin/core'

import { buildDiscoveryPorts } from './discovery-ladder.js'
import { createCoreHost } from './core-host.js'
import type { CoreHost } from './core-host.js'
import { loadOrCreateIdentitySeed } from './identity-seed.js'
import { inviteDiagnostics } from './invite-diagnostics.js'
import type { Ip6InterfaceTable } from './invite-diagnostics.js'
import {
  defaultNetConfig,
  parseBootstrapFile,
  parseRelaySeeds,
  relaySeedLine,
  resolveRelayAuto,
} from './net-config.js'

/** A log line sink (the app's equivalent is `webContents.send`). */
export type LogLine = (line: string) => void

export interface RunNodeOptions {
  /** The per-install data dir (identity seed, chain store, invite/bootstrap
   * files). Required — identity lives here, so it is never guessed. */
  dataDir: string
  /** The ONE genesis source (gates + bootstrap list). */
  genesisPath: string
  /** Env table (default `process.env`). Only the documented
   * `SUCCINCTCOIN_*` knobs are read; flags passed here win over env. */
  env?: Record<string, string | undefined>
  /** `process.platform` (default: the real one) — for the LAN hints path. */
  platform?: NodeJS.Platform
  /** The interface table for the honest "why no invite yet" line (default
   * `os.networkInterfaces()`); injected in tests. */
  interfaces?: () => Ip6InterfaceTable
  /** TEST SEAM (AD-10): the net-adapter factory. Production never passes it —
   * the default is the core's real `createNetAdapter` (tcp). Tests inject a
   * memory-transport config + factory to drive this path headless. */
  net?: (config: NetAdapterConfig) => NetAdapter
  /** Log sink (default `console.log`). */
  log?: LogLine
  /** Operator flags that override env (argv parsing lives in the CLI shell). */
  flags?: RunnerFlags
  /** Start the mining loop after boot (default true — uptime is the reward
   * model, so a node that does not mine is a wallet, not a node). */
  startMining?: boolean
}

/** Explicit operator flags (argv), each overriding its env equivalent. */
export interface RunnerFlags {
  listenPort?: number
  relayServer?: boolean
}

/** The running node: the host surface + an idempotent shutdown. */
export interface NodeRunHandle {
  host: CoreHost
  identityId: string
  net: NetAdapter
  stop(): Promise<void>
}

/** The genesis path a built bundle defaults to (same relative layout as the
 * app's main entry: `dist/<what>/run-node.js` → `dist/config/genesis.json`,
 * the copy `scripts/copy-genesis.mjs` lands byte-identical). */
export function defaultGenesisPath(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', 'config', 'genesis.json')
}

/**
 * Boot a node on plain Node. Resolves AFTER the core has started (and, unless
 * `startMining: false`, after the mining loop is running — the app's auto-start
 * order, verbatim); the returned handle stays alive until `stop()`. Any failure
 * after the transport exists stops that transport before rejecting.
 */
export async function runNode(opts: RunNodeOptions): Promise<NodeRunHandle> {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const log: LogLine = opts.log ?? ((line) => console.log(line))
  const makeNet = opts.net ?? createNetAdapter

  // 1. The ONE genesis source (gates + the bootstrap list).
  const genesis: GenesisConfig = await loadGenesis(opts.genesisPath)

  // 2. Identity: the persisted per-install seed (same file, same rules).
  const identity = deriveIdentityKeypair(await loadOrCreateIdentitySeed(opts.dataDir))

  // 3. The real ports — the SAME env knobs as the app, so operator docs stay
  //    single-sourced. Flags (argv) override env.
  const envPort = Number.parseInt(env.SUCCINCTCOIN_LISTEN_PORT ?? '', 10)
  const listenPort = opts.flags?.listenPort ?? (Number.isNaN(envPort) ? undefined : envPort)
  const bootstrapFile = join(opts.dataDir, 'bootstrap.txt')
  const extraBootstrap = existsSync(bootstrapFile)
    ? parseBootstrapFile(readFileSync(bootstrapFile, 'utf8'))
    : []
  const relaySeeds = parseRelaySeeds(env.SUCCINCTCOIN_RELAY_SEEDS)
  const relayServer =
    opts.flags?.relayServer ?? env.SUCCINCTCOIN_RELAY_SERVER === '1'
  // Ticket 7 — same auto-relay default as the app boot (kill switch
  // SUCCINCTCOIN_RELAY_AUTO=0); no argv flag: this is a network-policy
  // knob, not a per-run preference.
  const relayAuto = resolveRelayAuto(env)

  // The adapter's seed events are boot facts, not debug noise: a hidden node
  // operator's only feedback that `SUCCINCTCOIN_RELAY_SEEDS` is working (or
  // why it is not) is these lines — the adapter never throws for a bad seed.
  const netConfig: NetAdapterConfig = {
    ...defaultNetConfig(genesis, identity.identityId, {
      listenPort,
      extraBootstrap,
      mdns: env.SUCCINCTCOIN_MDNS === '1',
      // LAN locality prototype (2026-10-22) — same knob as the app boot.
      lan: env.SUCCINCTCOIN_LAN === '1',
      relaySeeds,
      relayServer,
      relayAuto,
    }),
    // 11.3 — one shared formatter (relaySeedLine) for both boot paths:
    // family-tagged HOLD/FAIL, dns-named seeds untagged.
    onRelaySeed: (event) => {
      log(relaySeedLine(event))
    },
  }
  const net = makeNet(netConfig)

  // Everything past this point can fail with the transport already listening —
  // most realistically `SC-STORE-1`: another process holds this data dir's
  // store lock (the `FileChainStore` constructor takes it, before `host.start`
  // ever runs). A rejected boot must not leave a live libp2p node behind: the
  // CLI's exit would never fire and the operator would get a hung process
  // instead of an error line.
  try {
    return await bootOverTransport({ opts, log, net, genesis, identity, env, platform })
  } catch (err) {
    await net.stop().catch(() => {})
    throw err
  }
}

/** The second half of the boot — store, host, start, honest boot reporting.
 * Split out so {@link runNode} owns exactly one cleanup decision. */
async function bootOverTransport(args: {
  opts: RunNodeOptions
  log: LogLine
  net: NetAdapter
  genesis: GenesisConfig
  identity: IdentityKeypair
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
}): Promise<NodeRunHandle> {
  const { opts, log, net, genesis, identity, env, platform } = args
  const store = new FileChainStore(join(opts.dataDir, 'chain'))
  const gate = createOfflineGateVerifier({ acceptedGates: genesis.gates })

  // The invite line is logged ONCE (it refreshes every announce window — the
  // app's rule; a server log that repeats it would bury everything else).
  let inviteLogged = false
  const onSelfInvite = (invite: string): void => {
    if (inviteLogged) return
    inviteLogged = true
    log(`[boot] to invite a friend, send them exactly:\n${invite}`)
  }

  // The headless event surface: one line per notable event, key-free (the
  // core's payloads already are — AD-11). Mined blocks are THROTTLED: the loop
  // produces a block every poll tick, so one line each would bury a server
  // journal — the first is logged (proof of life), then one per
  // `MINED_LOG_EVERY` as a heartbeat carrying the current slot.
  let mined = 0
  const MINED_LOG_EVERY = 25
  const host = createCoreHost({
    net,
    store,
    gate,
    identity,
    discovery: buildDiscoveryPorts(
      { platform, env, userDataDir: opts.dataDir },
      () => net.listenAddresses(),
      // The ladder's "how did this node find its way" report goes through the
      // SAME sink as everything else — with the default it would print past an
      // injected log and vanish in a test (or a future non-stdout sink).
      (report) => log(`[discovery-ladder] ${JSON.stringify(report)}`),
      onSelfInvite,
    ),
    forwardEvent: (event, payload) => {
      if (event === 'BlockApplied') {
        const p = payload as { slot: number; winnerIdentityId: string }
        mined += 1
        if (mined === 1 || mined % MINED_LOG_EVERY === 0) {
          log(
            `[mined] ${String(mined)} blocks, head slot ${p.slot}` +
              `${mined === 1 ? ` winner ${p.winnerIdentityId.slice(0, 8)}…` : ''}`,
          )
        }
      } else if (event === 'CoreStopped') {
        const slot = (payload as { slot: number }).slot
        // Chain time is -1 until a block exists — printing "slot -1" would
        // read like a broken node rather than an empty chain.
        log(slot >= 0 ? `[stop] core stopped at slot ${slot}` : '[stop] core stopped')
      }
    },
  })

  log(`[boot] identity ${identity.identityId.slice(0, 8)}… data-dir ${opts.dataDir}`)
  await host.start(opts.genesisPath)

  // The operator's two questions, answered BEFORE the loop starts producing:
  // "what is my address" and, if none, "why not". `listenAddresses()` throws
  // before/after start — a log line must never unwind a running node, and
  // mining first would bury these lines under block logs.
  try {
    const dialable = net.listenAddresses().filter(isGlobalIp6Multiaddr)
    // LAN locality mode prints its real local addresses instead (never an
    // invite — the chain-level law still drops /ip4 from every announcement).
    const lanDialable =
      env.SUCCINCTCOIN_LAN === '1'
        ? net
            .listenAddresses()
            .filter((a) => a.startsWith('/ip4/') && !lanModeDropsAddress(a))
        : []
    log(
      dialable.length > 0
        ? `[boot] dial me: ${dialable.join(' ')}`
        : lanDialable.length > 0
          ? `[boot] LAN dial: ${lanDialable.join(' ')} (local testnet — not an invite)`
          : '[boot] no dialable (global IPv6) listen address yet',
    )
    // AutoNAT has not had time to probe at this instant, so `unknown` is the
    // normal honest answer here; `dial me:` above is the authoritative one.
    log(`[boot] reachability ${net.reachability()}`)
    if (dialable.length === 0) {
      const diag = inviteDiagnostics((opts.interfaces ?? networkInterfaces)())
      log(`[boot] interfaces (v6 classes): ${JSON.stringify(diag)}`)
    }
  } catch {
    /* never unwinds a running node for a log line */
  }

  if (opts.startMining !== false) await host.startMining()

  let stopped = false
  return {
    host,
    identityId: identity.identityId,
    net,
    async stop() {
      if (stopped) return
      stopped = true
      await host.stop()
    },
  }
}

/** Parsed CLI arguments (pure — pinned by tests). */
export interface RunnerArgs {
  dataDir?: string
  genesisPath: string
  flags: RunnerFlags
  help: boolean
  /** `false` with `--no-mine`: apply blocks, never race for one. */
  mine: boolean
}

const USAGE = [
  'Usage: run-node [options]',
  '',
  '  --data-dir <path>   where identity.seed + chain/ live (REQUIRED)',
  `  --genesis <path>    genesis config (default: ${'"<bundle>/../config/genesis.json"'})`,
  '  --listen-port <n>   fixed TCP port (else $SUCCINCTCOIN_LISTEN_PORT)',
  '  --relay / --no-relay  volunteer as a circuit relay, or refuse to (else',
  '                      $SUCCINCTCOIN_RELAY_SERVER=1)',
  '  --no-mine           apply blocks only — never race for one',
  '  --help              this text',
  '',
  'Env: SUCCINCTCOIN_LISTEN_PORT, SUCCINCTCOIN_RELAY_SEEDS, SUCCINCTCOIN_RELAY_SERVER,',
  '     SUCCINCTCOIN_MDNS, SUCCINCTCOIN_LAN (=1 local-first testnet: v4 bind,',
  '     mDNS on, loopback dropped from the wire view; NO invite),',
  '     SUCCINCTCOIN_RELAY_AUTO (=0 disables auto-relay:',
  '     serving hops + holding circuits through hop-capable peers when behind',
  '     NAT — explicit seeds/server role only). Files in --data-dir: invite.txt',
  '     (joins), bootstrap.txt.',
].join('\n')

/**
 * Parse argv for the runner. Unknown `--flags` are REJECTED (a typo'd operator
 * flag must fail loudly at boot, not silently change topology); a missing
 * `--data-dir` is reported rather than defaulted — the identity lives there.
 */
export function parseRunnerArgs(argv: readonly string[], genesisDefault: string): RunnerArgs {
  const out: RunnerArgs = { genesisPath: genesisDefault, flags: {}, help: false, mine: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${String(arg)} needs a value`)
      return v
    }
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--data-dir') out.dataDir = next()
    else if (arg === '--genesis') out.genesisPath = next()
    else if (arg === '--listen-port') {
      const n = Number.parseInt(next(), 10)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--listen-port must be 1-65535')
      out.flags.listenPort = n
    } else if (arg === '--relay') out.flags.relayServer = true
    else if (arg === '--no-relay') out.flags.relayServer = false
    else if (arg === '--no-mine') out.mine = false
    else throw new Error(`unknown argument ${String(arg)}\n\n${USAGE}`)
  }
  return out
}

export const RUNNER_USAGE = USAGE
