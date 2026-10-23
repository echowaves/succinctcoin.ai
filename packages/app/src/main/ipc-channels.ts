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
import type { CoreEvents, InviteRejectReason } from '@succinctcoin/core'

/**
 * Ticket 9.2: the result of `applyInvite` (owned HERE — the ONE owner of
 * the IPC shape; both bridge sides type against it). Public data only:
 * an identity id or a reject reason, never key material (AD-11).
 */
export type InviteApplyResult = { ok: true; identityId: string } | { ok: false; reason: InviteRejectReason }

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
  /** 9.2 join seam: verify a pasted invitation and join through it. */
  applyInvite: 'core.applyInvite',
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
  // Invite-share UX: the self-invitation PUSHES itself the moment it mints
  // (or clears on stop) — the panel renders it without a Refresh click.
  SelfInviteUpdated: 'selfInviteUpdated',
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
  /** 9.2: this node's renderable self-invitation (public signed text). */
  invite: 'invite',
  /** Invite-share UX: LAN-mode /ip4 dial addresses behind the SAME
   * display-only filter as the boot line (CAP-9); [] whenever not in LAN
   * mode — the renderer never re-implements the mode check. */
  lanDial: 'lanDial',
  /** Post-9.5: WHY there is no invite (IPv6 interface classes — counts only,
   * `main/invite-diagnostics.ts`). Key-free diagnostics, AD-11-safe. */
  inviteDiag: 'inviteDiagnostics',
} as const

export type IpcReadKey = keyof typeof IPC_READ
