/**
 * `app/main/index` — the Electron MAIN process (6.2 — THIN glue).
 *
 * The ONLY electron imports in the app's main path (AD-1 applied to the
 * app): `app` / `BrowserWindow` / `ipcMain`. ALL core-hosting is delegated
 * to the PURE `createCoreHost` (`./core-host.ts`); ALL IPC names come from
 * the PURE routing tables (`./ipc-channels.ts`).
 *
 * AD-11: the identity keypair is created HERE (the main process) via the
 * core's `deriveIdentityKeypair(seed)` and passed to the host — it NEVER
 * crosses the IPC boundary. The `ipcMain.handle` handlers expose ONLY the
 * commands + the read-API; the event stream flows main → renderer via
 * `webContents.send` (the core's key-free payloads, AD-11).
 *
 * plan-packaged-app-boot — the app is SELF-CONTAINED + BOOTABLE: the ONE
 * genesis source is the BUNDLED `dist/config/genesis.json` (the app build
 * copies the repo `config/genesis.json` there byte-identical; `genesisPath()`
 * is threaded into EVERY `host.start` call, so the gate registry AND the
 * core's boot read the same single copy), and the preload is loaded as
 * `../preload.mjs` (the Electron ESM-preload rule — an ESM preload in a
 * `.js` file is parsed as CJS and never loads).
 */
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
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

import { BrowserWindow, app, ipcMain } from 'electron'

import { buildDiscoveryPorts } from './discovery-ladder.js'
import { createCoreHost } from './core-host.js'
import { loadOrCreateIdentitySeed } from './identity-seed.js'
import { inviteDiagnostics } from './invite-diagnostics.js'
import { IPC_COMMANDS, IPC_EVENTS, IPC_READ } from './ipc-channels.js'
import {
  defaultNetConfig,
  parseBootstrapFile,
  parseRelaySeeds,
  relaySeedLine,
  resolveRelayAuto,
} from './net-config.js'

/**
 * The BUNDLED `dist/config/genesis.json` — the ONE genesis source (the
 * app build copies the repo `config/genesis.json` there byte-identical —
 * the build's last step). ONE level up from `dist/main/`: main → dist.
 * Threaded into EVERY `host.start` call (the auto-start + the IPC `start`
 * handler), so the gate registry AND the core's boot read this single
 * copy — the core's independent default (the repo root) is never relied
 * on, because the repo root is NOT in the package. `import.meta.url`
 * survives the Vite node/ssr build, so this resolves identically in dev
 * and inside the packaged asar.
 */
function genesisPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'genesis.json')
}

let mainWindow: BrowserWindow | null = null

async function boot(): Promise<void> {
  // The accepted-gate registry (AD-4) from the single genesis source.
  const genesis = await loadGenesis(genesisPath())

  // AD-11 — the identity keypair lives in MAIN: created here, passed to
  // the host, never surfaced. The seed is the PERSISTED per-install secret
  // (8.1 — CAP-7 prerequisite): same userData ⇒ same identity across
  // reboots, distinct installs ⇒ distinct identities (the shared constant
  // seed this replaced made every install the same peer).
  const identity = deriveIdentityKeypair(
    await loadOrCreateIdentitySeed(app.getPath('userData')),
  )

  // The REAL ports. Net: the REAL stack via the pure seam (7.2 R1) — tcp +
  // mDNS + the genesis bootstrap list; the ephemeral listen address lets
  // multiple instances coexist on one machine. The isolated in-memory
  // transport is TEST-ONLY (AD-10): tests inject their own net configs,
  // nothing here can select it. Store: the app's userData dir (the state,
  // AD-9).
  //
  // LAN joins when MULTICAST IS BLOCKED (guest Wi-Fi, VLANs, endpoint
  // filters): SUCCINCTCOIN_LISTEN_PORT pins a fixed port so this node's
  // multiaddr is stable, and <userData>/bootstrap.txt lists known peer
  // multiaddrs (one per line, `#` comments) merged after genesis.bootstrap.
  // The boot log prints this node's own dialable multiaddr to copy over.
  const envPort = Number.parseInt(process.env.SUCCINCTCOIN_LISTEN_PORT ?? '', 10)
  const bootstrapFile = join(app.getPath('userData'), 'bootstrap.txt')
  const extraBootstrap = existsSync(bootstrapFile)
    ? parseBootstrapFile(readFileSync(bootstrapFile, 'utf8'))
    : []
  // 10.2 — relay seeds (comma-separated multiaddrs carrying /p2p/<relayId>):
  // the reachability tier's operator channel. Empty default; every attempt
  // outcome logs a [boot] line (hold success, or each bounded-retry failure).
  const relaySeeds = parseRelaySeeds(process.env.SUCCINCTCOIN_RELAY_SEEDS)
  const net = createNetAdapter({
    ...defaultNetConfig(genesis, identity.identityId, {
      listenPort: Number.isNaN(envPort) ? undefined : envPort,
      extraBootstrap,
      // 9.1: LAN multicast is opt-in — middleboxes eat it and the network is
      // IPv6-only; SUCCINCTCOIN_MDNS=1 re-enables it on friendly LANs.
      mdns: process.env.SUCCINCTCOIN_MDNS === '1',
      // LAN locality prototype (2026-10-22): SUCCINCTCOIN_LAN=1 binds the
      // IPv4 wildcard + implies mDNS + drops loopback from the wire view.
      // A LOCAL-FIRST testnet: no invite, no WAN identity (see net-config).
      lan: process.env.SUCCINCTCOIN_LAN === '1',
      relaySeeds,
      // 10.3 — volunteer as a circuit relay (the 5.7 server role). Its own
      // dialable multiaddr + peer id print in the boot log; share that seed
      // out-of-band and peers behind firewalls hold circuits through it.
      relayServer: process.env.SUCCINCTCOIN_RELAY_SERVER === '1',
      // Ticket 7 — auto-relay (ladder rung 3) is ON by default: serve hops
      // while reachable, hold circuits through hop-advertising direct peers
      // once proven-unreachable. SUCCINCTCOIN_RELAY_AUTO=0 ⇒ explicit-only.
      relayAuto: resolveRelayAuto(process.env),
    }),
    // 11.3 — one shared formatter (relaySeedLine) for both boot paths:
    // family-tagged HOLD/FAIL, dns-named seeds untagged.
    onRelaySeed: (event) => {
      console.log(relaySeedLine(event))
    },
  })
  const store = new FileChainStore(join(app.getPath('userData'), 'chain'))
  const gate = createOfflineGateVerifier({ acceptedGates: genesis.gates })

  // 9.2: the renderable self-invitation is logged ONCE (it refreshes every
  // announce window — logging each would spam; the UI reads it via IPC).
  let inviteLogged = false
  const inviteFile = join(app.getPath('userData'), 'invite.txt')

  const host = createCoreHost({
    net,
    store,
    gate,
    identity,
    // CAP-7 (8.5): the fallback-ladder wiring — OS-appropriate LAN hints
    // file, per-install artifact file, and the REAL listen addresses read
    // back from the started adapter (the seam is pure; the electron/env
    // reads happen HERE). The report logs counts only (AD-9).
    discovery: buildDiscoveryPorts(
      {
        platform: process.platform,
        env: process.env,
        userDataDir: app.getPath('userData'),
      },
      () => net.listenAddresses(),
      undefined,
      (invite) => {
        if (inviteLogged) return
        inviteLogged = true
        console.log(`[boot] to invite a friend, send them exactly:\n${invite}`)
      },
    ),
    // The AD-11 IPC seam: the core's key-free event payloads → the
    // renderer (the preload's `on()` delivers them on the channel in
    // `IPC_EVENTS`).
    forwardEvent: (event, payload) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_EVENTS[event], payload)
      }
    },
  })

  // The command surface (renderer → main): commands ONLY — no key material
  // (AD-11). `start` threads the bundled `genesisPath()` — the ONE source
  // (never the core's independent default).
  ipcMain.handle(IPC_COMMANDS.start, () => host.start(genesisPath()))
  ipcMain.handle(IPC_COMMANDS.stop, () => host.stop())
  ipcMain.handle(IPC_COMMANDS.startMining, () => host.startMining())

  // 9.2 join seam: verify + join NOW (core), and persist the line for the
  // next boot only after it verified — invite.txt never accumulates junk.
  // The file write is fail-soft (a full disk must not undo a live join).
  ipcMain.handle(IPC_COMMANDS.applyInvite, async (_event, text: string) => {
    const result = await host.applyInvite(text)
    if (result.ok) {
      try {
        const line = text.replace(/\s+/g, '')
        const existing = await readFile(inviteFile, 'utf8').catch(() => '')
        if (!existing.split(/\r?\n/).some((l) => l.trim().replace(/\s+/g, '') === line)) {
          // A hand-edited file may lack a trailing newline — never splice the
          // new invite onto the previous line (that would corrupt both).
          const sep = existing.length === 0 ? '# SuccinctCoin invitations (one scinvite:v1: line each)\n' : existing.endsWith('\n') ? '' : '\n'
          await appendFile(inviteFile, sep + line + '\n', 'utf8')
        }
      } catch {
        /* persistence is best-effort — the join already happened */
      }
    }
    return result
  })

  // The read-API surface (renderer → main): key-free read-models only
  // (AD-9: the UI reads state only via the read-API).
  ipcMain.handle(IPC_READ.chainHead, () => host.getChainHead())
  ipcMain.handle(IPC_READ.balances, () => host.getBalances())
  ipcMain.handle(IPC_READ.peers, () => host.getPeers())
  ipcMain.handle(IPC_READ.block, (_event, slot: number) => host.getBlock(slot))
  // 9.2: this node's renderable self-invitation (public signed text — the
  // clipboard/QR source; signing itself stays in main/core, E3).
  ipcMain.handle(IPC_READ.invite, () => host.getInvite())
  // Post-9.5: the honest "why no invite yet" — classify this machine's IPv6
  // interfaces (the os read lives HERE, the glue; the module stays pure).
  ipcMain.handle(IPC_READ.inviteDiag, () =>
    inviteDiagnostics(networkInterfaces()),
  )

  // The BrowserWindow: contextIsolation ON, nodeIntegration OFF — the ONLY
  // bridge to the main process is the preload's `contextBridge` surface
  // (AD-11). `sandbox: false` is required for the ESM preload. The
  // preload MUST be the `.mjs` emit (`../preload.mjs` — the Electron
  // ESM-preload rule): preload scripts IGNORE the package's
  // `"type": "module"` field, so an ESM preload in a `.js` file is parsed
  // as CJS — a SyntaxError that would leave `contextBridge.
  // exposeInMainWorld` unrun, `window.succinctcoin` undefined, and the
  // renderer's entire data source dead while main boots and mines.
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.mjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // The Vite-built renderer (6.3): the app build's `vite build` step
  // produces `dist/renderer/index.html` (from `dist/main/` it is
  // `../renderer/index.html` — the same path the 6.2 placeholder used, so
  // the asset now lands where the shell already looks). `base: './'` keeps
  // the bundle's asset paths relative for the `file://` load. The `data:`
  // URL fallback keeps a missing bundle a startup error, not a silent
  // blank window.
  const rendererEntry = fileURLToPath(new URL('../renderer/index.html', import.meta.url))
  if (existsSync(rendererEntry)) {
    await mainWindow.loadFile(rendererEntry)
  } else {
    await mainWindow.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body><h1>SuccinctCoin</h1><p>Electron shell up — the renderer bundle is missing (run the package build script: `pnpm build`).</p></body></html>',
        ),
    )
  }

  // Auto-start the node on boot (Done-when #1 — "the packaged app's main
  // process starts a node on a testnet … the UI shows blocks being mined").
  // The renderer is loaded FIRST (above) so the `forwardEvent` seam can
  // deliver the `CoreStarted` + `BlockApplied` events to it (the 6.3 hook's
  // event-driven re-snapshot recovers the initial state). The display-only
  // renderer never calls `start`/`startMining` — the app auto-starts them
  // here (the 6.2 plan's "the main process runs the node"). The `stop`
  // handler below remains for a future user-driven stop. `start` threads
  // the bundled `genesisPath()` — the ONE source (never the core's
  // independent default, whose repo-root path is not in the package).
  await host.start(genesisPath())
  await host.startMining()

  // Copy-paste this line's address to a LAN peer's bootstrap.txt when mDNS
  // cannot cross the network (the dial path is plain unicast TCP).
  try {
    const dialable = net.listenAddresses().filter(isGlobalIp6Multiaddr)
    // LAN locality mode prints its real local addresses instead (never an
    // invite — the chain-level law still drops /ip4 from every announcement).
    const lanDialable =
      process.env.SUCCINCTCOIN_LAN === '1'
        ? net
            .listenAddresses()
            .filter((a) => a.startsWith('/ip4/') && !lanModeDropsAddress(a))
        : []
    // Same hints feedback on both address lines (review F5 parity).
    const hints =
      extraBootstrap.length > 0
        ? ` (bootstrap hints: ${String(extraBootstrap.length)} from ${bootstrapFile})`
        : ''
    console.log(
      dialable.length > 0
        ? `[boot] dial me: ${dialable.join(' ')}${hints}`
        : lanDialable.length > 0
          ? `[boot] LAN dial: ${lanDialable.join(' ')} (local testnet — not an invite)${hints}`
          : '[boot] no LAN listen address yet (adapter reported none)',
    )
  } catch {
    // never unwinds boot for a log line
  }
}

void app.whenReady().then(() =>
  boot().catch((err) => {
    console.error('succinctcoin: boot failed', err)
    app.exit(1)
  }),
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
