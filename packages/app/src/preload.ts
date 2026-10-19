/**
 * `app/preload` — the `contextBridge` IPC boundary (6.2 — THIN glue).
 *
 * The ONLY other electron import in the app (AD-1): `contextBridge` +
 * `ipcRenderer`. The bridge exposes EXACTLY the commands + the event
 * stream + the read-API (the spine: "the UI gets only peer IDs, status,
 * signed artifacts") — NO key material (AD-11): there is no
 * `privateKey`/`secret`/`keypair` on this surface, and the payloads it
 * carries are the core's key-free event payloads (`CoreEvents`) + read-
 * models.
 */
import type {
  CoreEvents,
  ReadBalances,
  ReadBlock,
  ReadChainHead,
  ReadPeer,
} from '@succinctcoin/core'
import { contextBridge, ipcRenderer } from 'electron'

import type { InviteApplyResult } from './main/ipc-channels.js'
import { IPC_COMMANDS, IPC_EVENTS, IPC_READ } from './main/ipc-channels.js'

/**
 * The renderer-facing bridge (exposed as `window.succinctcoin` — typed in
 * `./preload.d.ts`).
 */
const succinctcoin = {
  // The commands (renderer → main `invoke`).
  start: (): Promise<void> => ipcRenderer.invoke(IPC_COMMANDS.start),
  stop: (): Promise<void> => ipcRenderer.invoke(IPC_COMMANDS.stop),
  startMining: (): Promise<void> => ipcRenderer.invoke(IPC_COMMANDS.startMining),
  // The read-API (renderer → main `invoke`, snapshots — AD-9: read-only).
  getChainHead: (): Promise<ReadChainHead> => ipcRenderer.invoke(IPC_READ.chainHead),
  getBalances: (): Promise<ReadBalances> => ipcRenderer.invoke(IPC_READ.balances),
  getPeers: (): Promise<ReadPeer[]> => ipcRenderer.invoke(IPC_READ.peers),
  getBlock: (slot: number): Promise<ReadBlock> => ipcRenderer.invoke(IPC_READ.block, slot),
  // 9.2 invitations: the renderable self-invite (public signed text — safe
  // for the clipboard) and the join seam (paste → verify → dial). NO key
  // material either way (AD-11): signing stays in main/core.
  getInvite: (): Promise<string | null> => ipcRenderer.invoke(IPC_READ.invite),
  applyInvite: (text: string): Promise<InviteApplyResult> =>
    ipcRenderer.invoke(IPC_COMMANDS.applyInvite, text),
  // The event stream (main → renderer push): subscribe by the CORE event
  // name; the payload is the core's key-free projection (AD-11). Returns
  // an unsubscribe.
  on: <E extends keyof CoreEvents>(
    event: E,
    cb: (payload: CoreEvents[E]) => void,
  ): (() => void) => {
    const channel = IPC_EVENTS[event]
    const listener = (_ipcEvent: unknown, payload: CoreEvents[E]): void => {
      cb(payload)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
}

contextBridge.exposeInMainWorld('succinctcoin', succinctcoin)
