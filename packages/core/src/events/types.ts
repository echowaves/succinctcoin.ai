/**
 * `core/events/` — the single owner of the core public surface (AD-1/AD-9).
 *
 * This module owns the typed surface: the event map (`CoreEvents`), the
 * command set (`CoreCommands`), the read-API (`CoreReadApi`), the lightweight
 * UI read-models (`ReadPeer`/`ReadBlock`), and the `CoreInstance` shape.
 *
 * `CoreEvents`/`CoreCommands` are the *baseline* set; capability epics extend
 * them here (one owner). The read-models are UI projections, explicitly NOT
 * the wire types — 1.4's generated protocol types stay a separate module and
 * the read-API projects to/from them later (AD-12). Types only — `createCore`
 * lives in the package entry.
 */

/** A lightweight UI projection of a connected peer. NOT the wire type. */
export interface ReadPeer {
  peerId: string
  multiaddrs: string[]
}

/**
 * A lightweight UI projection of a block. NOT the wire type — 1.4's generated
 * `Block` owns the protocol schema (AD-12); this is a presentation projection.
 */
export interface ReadBlock {
  slot: number
  hash: string
  winnerIdentityId: string
  ticketCount: number
  txCount: number
}

/**
 * Baseline typed event map. Events are PascalCase nouns (spine convention).
 * Capability epics extend this map; `CoreInstance` is derived from it, so the
 * emitter and the `UiSink` forwarding stay in lock-step.
 */
export interface CoreEvents {
  CoreStarted: { slot: number }
  CoreStopped: { slot: number }
}

/**
 * The typed emitter slice of the public surface: subscribe (`on`, returns an
 * unsubscribe) and emit. Event names/payloads are constrained to `CoreEvents`,
 * so an untyped event fails at the call site.
 */
export interface CoreEventsEmitter {
  on<K extends keyof CoreEvents>(event: K, listener: (payload: CoreEvents[K]) => void): () => void
  emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]): void
}

/**
 * Baseline command set (imperative names). `start`/`stop` are the baseline
 * lifecycle and are `Promise`-typed: boot is async (the store opens at
 * `start()` and can fail on lock contention, AD-9), and `stop` closes the
 * store. `startMining` is a capability command — a stub throwing
 * `{ code: 'SC-CORE-1' }` until epic 3 implements it (AD-9: every command
 * resolves its promise once implemented).
 */
export interface CoreCommands {
  start(): Promise<void>
  stop(): Promise<void>
  startMining(): void
}

/**
 * The typed read-API. `getPeers`/`getBlock` return the UI read-models above
 * (the 1.2 decision, Option A). Until a capability epic implements them they
 * throw `{ code: 'SC-CORE-1' }`.
 */
export interface CoreReadApi {
  getPeers(): Promise<ReadPeer[]>
  getBlock(slot: number): Promise<ReadBlock>
}

/** The complete core instance: events + commands + read-API. */
export interface CoreInstance extends CoreEventsEmitter, CoreCommands, CoreReadApi {}
