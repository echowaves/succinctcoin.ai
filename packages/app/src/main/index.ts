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
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FileChainStore,
  createNetAdapter,
  createOfflineGateVerifier,
  deriveIdentityKeypair,
  loadGenesis,
} from '@succinctcoin/core'

import { BrowserWindow, app, ipcMain } from 'electron'

import { createCoreHost } from './core-host.js'
import { IPC_COMMANDS, IPC_EVENTS, IPC_READ } from './ipc-channels.js'

/**
 * The fixed per-install identity seed (6.2 — AD-3: deterministic, no RNG).
 * A pinned 32-byte constant: the same install always derives the same
 * identity (the AD-11 key lives in main). Moving this to a persisted
 * per-install secret is a packaging concern (6.4).
 */
const IDENTITY_SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (0x5c + i) % 256))

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
  // the host, never surfaced.
  const identity = deriveIdentityKeypair(IDENTITY_SEED)

  // The REAL ports. Net: the memory transport (the AD-10/AD-1 testnet
  // default — zero real sockets; the real net transport is a config
  // choice, 6.4). Store: the app's userData dir (the state, AD-9).
  const net = createNetAdapter({
    transport: 'memory',
    listenAddress: '/memory/succinctcoin-app',
    // The adapter stamps the PROTOCOL identity id into envelopes (5.2 D3) —
    // a plain public string, never key material (AD-11).
    protocolIdentityId: identity.identityId,
  })
  const store = new FileChainStore(join(app.getPath('userData'), 'chain'))
  const gate = createOfflineGateVerifier({ acceptedGates: genesis.gates })

  const host = createCoreHost({
    net,
    store,
    gate,
    identity,
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

  // The read-API surface (renderer → main): key-free read-models only
  // (AD-9: the UI reads state only via the read-API).
  ipcMain.handle(IPC_READ.chainHead, () => host.getChainHead())
  ipcMain.handle(IPC_READ.balances, () => host.getBalances())
  ipcMain.handle(IPC_READ.peers, () => host.getPeers())
  ipcMain.handle(IPC_READ.block, (_event, slot: number) => host.getBlock(slot))

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
