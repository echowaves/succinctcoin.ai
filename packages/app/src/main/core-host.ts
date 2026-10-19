/**
 * `app/main/core-host` — the MAIN-process core host (6.2, AD-11).
 *
 * PURE: NO `electron` import (AD-1 applied to the app) — this module is
 * the testable seam (the AD-10 electron-main target runs it under plain
 * Node). The thin electron glue (`index.ts`) builds the REAL ports + the
 * REAL identity and delegates ALL core-hosting here.
 *
 * AD-11 (the key-material boundary): the identity keypair, when provided,
 * was created in the main process via the core's `deriveIdentityKeypair`
 * and is passed to `createCore` — it is HELD here and NEVER surfaced. The
 * `CoreHost` surface is commands + the read-API only; `forwardEvent`
 * carries ONLY the core's key-free event payloads (`CoreEvents`), and the
 * read-API returns the key-free read-models. No `privateKey`/`secret`/
 * `keypair` crosses this boundary.
 *
 * AD-3 (chain time only): the host builds the `ClockPort` internally as a
 * CACHE updated from the event stream — the node-loop reads chain time
 * from the STORE, so the clock is used only for the `CoreStarted`/
 * `CoreStopped` `slot` field. The genesis is committed at boot via
 * `mineAndApply` and emits NO `BlockApplied`, so the cache starts at -1
 * (that is what `CoreStarted` carries); the first `BlockApplied` (the
 * loop's first mined block) advances it. No wall clock, no RNG.
 */
import { createCore } from '@succinctcoin/core'
import type {
  ClockPort,
  CoreEvents,
  DiscoveryPorts,
  GateVerifier,
  IdentityKeypair,
  InviteRejectReason,
  NetPort,
  ReadBalances,
  ReadBlock,
  ReadChainHead,
  ReadPeer,
  StorePort,
  UiSink,
} from '@succinctcoin/core'

/** The core event names (re-exported from the core's `CoreEvents` owner). */
export type CoreEventName = keyof CoreEvents

/** A core event payload (the union over all event names). */
export type CoreEventPayload = CoreEvents[CoreEventName]

/**
 * The inputs to the host: the injected REAL ports + the event forwarder +
 * the OPTIONAL identity. `forwardEvent` is the IPC seam — the main process
 * wires it to `webContents.send` (the preload bridge delivers the payload
 * to the renderer, key-free, AD-11).
 */
export interface CoreHostOptions {
  /** The network transport port (AD-8). */
  net: NetPort
  /** The single-writer chainstore port (AD-9). */
  store: StorePort
  /** The offline gate verifier (AD-4). */
  gate: GateVerifier
  /** The AD-1 event forwarder (key-free payloads only — AD-11). */
  forwardEvent: (event: CoreEventName, payload: CoreEventPayload) => void
  /**
   * The node's 4.2 PROTOCOL identity (AD-11 — the keys live in main).
   * Created by the host's caller via the core's `deriveIdentityKeypair`;
   * held here, passed to `createCore`, NEVER surfaced.
   */
  identity?: IdentityKeypair
  /**
   * CAP-7 (8.5): the fallback-ladder discovery ports (built by the glue
   * via `buildDiscoveryPorts`). Passed through untouched — the host has no
   * opinion about WHERE the ladder reads, only that it may.
   */
  discovery?: DiscoveryPorts
}

/**
 * The host surface: the core's commands + the read-API (delegated to the
 * `CoreInstance`). NO key material, NO event subscription — events flow
 * ONLY through `forwardEvent` (AD-11).
 */
export interface CoreHost {
  start(genesisPath?: string): Promise<void>
  stop(): Promise<void>
  startMining(): Promise<void>
  getChainHead(): Promise<ReadChainHead>
  getBalances(): Promise<ReadBalances>
  getPeers(): Promise<ReadPeer[]>
  getBlock(slot: number): Promise<ReadBlock>
  /** 9.2: this node's renderable self-invitation (public signed text; null
   * until the first announce window). Delegated to the core untouched. */
  getInvite(): string | null
  /** 9.2 join seam: verify + ingest + dial one pasted invitation. The glue
   * persists successful lines to `invite.txt` — the host stays fs-free. */
  applyInvite(
    text: string,
  ): Promise<{ ok: true; identityId: string } | { ok: false; reason: InviteRejectReason }>
}

/**
 * Build the core host: wire the injected ports into a REAL `createCore`
 * (the AD-1 seam — the core reaches the host only via the `uiSink`), with
 * the internal chain-time `ClockPort` cache (AD-3).
 */
export function createCoreHost(opts: CoreHostOptions): CoreHost {
  // The chain-time cache (AD-3): starts at the empty-chain head (-1) — the
  // genesis block (slot 0) is committed at boot via `mineAndApply` and
  // emits NO `BlockApplied`, so `CoreStarted` carries -1; the first
  // `BlockApplied` advances the cache. The ONLY writer is the event stream
  // (the sink below).
  let slotCache = -1
  let lastHashCache = '0'.repeat(64)

  const clock: ClockPort = {
    slotIndex: () => slotCache,
    lastBlockHash: () => lastHashCache,
  }

  // The AD-1 seam: every core event is forwarded to the host's callback
  // (key-free payloads only — AD-11), after the cache update.
  const uiSink: UiSink = {
    sink(event, ...args) {
      if (event === 'BlockApplied') {
        const p = args[0] as { slot: number; hash: string }
        slotCache = p.slot
        lastHashCache = p.hash
      }
      opts.forwardEvent(event as CoreEventName, args[0] as CoreEventPayload)
    },
  }

  const core = createCore({
    net: opts.net,
    store: opts.store,
    clock,
    gate: opts.gate,
    uiSink,
    identity: opts.identity,
    discovery: opts.discovery,
  })

  return {
    async start(genesisPath) {
      // The host owns the transport lifecycle (the shell drives the ports,
      // AD-1): start the net, then boot the core (store → genesis → the
      // one-block tracer boot → `CoreStarted`).
      await opts.net.start()
      await core.start(genesisPath)
    },
    async stop() {
      // The AD-9 shutdown order: halt the loop + emit `CoreStopped` + close
      // the store (releases the lock), then stop the transport.
      await core.stop()
      await opts.net.stop()
    },
    startMining: () => core.startMining(),
    getChainHead: () => core.getChainHead(),
    getBalances: () => core.getBalances(),
    getPeers: () => core.getPeers(),
    getBlock: (slot) => core.getBlock(slot),
    getInvite: () => core.getInvite(),
    applyInvite: (text) => core.applyInvite(text),
  }
}
