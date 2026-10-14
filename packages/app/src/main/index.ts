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
 * The repo-root `config/genesis.json` (the single source — the same
 * default the core resolves at boot, four levels up from `dist/main/`:
 * main → app → packages → repo root). Read here for the accepted-gate
 * registry (AD-4) only.
 */
function genesisPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'config',
    'genesis.json',
  )
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
  // (AD-11).
  ipcMain.handle(IPC_COMMANDS.start, () => host.start())
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
  // (AD-11). `sandbox: false` is required for the ESM preload.
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.js', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // The placeholder renderer (6.2): load the page when the asset pipeline
  // has placed it next to the build (6.3/6.4 wire the copy step); the
  // `data:` URL fallback keeps the 6.2 shell runnable without one.
  const placeholder = fileURLToPath(new URL('../renderer/index.html', import.meta.url))
  if (existsSync(placeholder)) {
    await mainWindow.loadFile(placeholder)
  } else {
    await mainWindow.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body><h1>SuccinctCoin</h1><p>Electron shell up (story 6.2) — the React renderer lands in story 6.3.</p></body></html>',
        ),
    )
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
