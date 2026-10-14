/**
 * `app/main/ipc-channels` — the ONE owner of the app's IPC shape (6.2).
 *
 * PURE: NO `electron` import (AD-1 applied to the app — the electron glue
 * lives in the thin `index.ts` / `preload.ts`). The main process, the
 * preload bridge, and the headless test all reference these tables — no
 * duplicated string literals.
 *
 * AD-11 (the key-material boundary): the surface is commands + the event
 * stream + the read-API ONLY. No channel exists for key material — the
 * identity keypair lives in the main process (the core-host) and never
 * crosses this boundary. The payloads that do cross are the core's
 * key-free event payloads (`CoreEvents`, owned by `@succinctcoin/core`)
 * and the key-free read-models (`ReadChainHead`/`ReadBalances`/
 * `ReadPeer`/`ReadBlock`) — the spine: "the UI gets only peer IDs,
 * status, signed artifacts".
 */
import type { CoreEvents } from '@succinctcoin/core'

/** The core event names (the single owner of the set is `CoreEvents`). */
export type CoreEventName = keyof CoreEvents

/**
 * The command channels (renderer → main `invoke`). The key is the command
 * (the `CoreHost` method it drives); the value is the channel string.
 */
export const IPC_COMMANDS = {
  start: 'core.start',
  stop: 'core.stop',
  startMining: 'core.startMining',
} as const

export type IpcCommandKey = keyof typeof IPC_COMMANDS

/**
 * The event channels (main → renderer push). Keyed by the CORE event name
 * (PascalCase — the `CoreEvents` owner); the value is the `webContents`
 * channel string the preload's `on()` subscribes to.
 */
export const IPC_EVENTS: Readonly<Record<CoreEventName, string>> = {
  CoreStarted: 'coreStarted',
  BlockApplied: 'blockApplied',
  CoreStopped: 'coreStopped',
}

/**
 * The read-API channels (renderer → main `invoke`, snapshots — AD-9: the
 * UI reads state only via the read-API). The key is the read-API
 * operation (the `CoreHost` method); the value is the channel string.
 */
export const IPC_READ = {
  chainHead: 'chainHead',
  balances: 'balances',
  peers: 'peers',
  block: 'block',
} as const

export type IpcReadKey = keyof typeof IPC_READ
