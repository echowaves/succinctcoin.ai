/**
 * `core/events/` — the single owner of the core public surface (AD-1/AD-9).
 *
 * This module owns the typed surface: the event map (`CoreEvents`), the
 * command set (`CoreCommands`), the read-API (`CoreReadApi`), the lightweight
 * UI read-models (`ReadPeer`/`ReadBlock`/`ReadChainHead`/`ReadBalances`), and
 * the `CoreInstance` shape.
 *
 * `CoreEvents`/`CoreCommands` are the *baseline* set; capability epics extend
 * them here (one owner). 6.1 (the desktop-app epic's prerequisite) adds the
 * `BlockApplied` event (the AD-9 UI data source — the integrated slot loop's
 * per-window emission) and the `ReadChainHead`/`ReadBalances` read-models
 * (the read-API's chain-state projections). The read-models are UI
 * projections, explicitly NOT the wire types — 1.4's generated protocol types
 * stay a separate module and the read-API projects to/from them (AD-12).
 * Types only — `createCore` lives in the package entry.
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
 * A lightweight UI projection of the chain head (6.1). NOT the wire type
 * (AD-12) — 1.4's generated `Block` owns the protocol schema; this is a
 * presentation projection of the head block + the ledger's total supply.
 * `totalSupplyDisplay` is a decimal display string (AD-5 — the ledger's
 * display boundary), never a raw `bigint` or a float. The payload is
 * key-free (AD-11): the winner is a public 32-byte-hex identity id, not
 * key material.
 */
export interface ReadChainHead {
  slot: number
  hash: string
  winnerIdentityId: string
  ticketCount: number
  txCount: number
  totalSupplyDisplay: string
}

/**
 * A lightweight UI projection of the balance state (6.1). NOT the wire type
 * (AD-12): `balances` maps identity id → decimal-string base units (AD-5 —
 * the ledger's `toJson` form, the same document the store persists). Identity
 * ids are public 32-byte-hex, NOT key material (AD-11).
 */
export interface ReadBalances {
  balances: Record<string, string>
}

/**
 * Typed event map. Events are PascalCase nouns (spine convention).
 * Capability epics extend this map; `CoreInstance` is derived from it, so the
 * emitter and the `UiSink` forwarding stay in lock-step. 6.1 adds
 * `BlockApplied` (the AD-9 UI data source): fired by the integrated slot
 * loop once per mined window. The payload is a key-free UI projection
 * (AD-11 — no key material by name or by value): the chain-time slot
 * (`number` form), the block hash hex, the winner's public identity id, and
 * the window's accepted-set / tx counts.
 */
export interface CoreEvents {
  CoreStarted: { slot: number }
  CoreStopped: { slot: number }
  BlockApplied: {
    slot: number
    hash: string
    winnerIdentityId: string
    ticketCount: number
    txCount: number
  }
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
 * Command set (imperative names). `start`/`stop` are the baseline lifecycle
 * and are `Promise`-typed: boot is async — `start()` opens the store first
 * (failing `SC-STORE-1` on lock contention, AD-9), then loads + validates the
 * genesis (failing `SC-CONFIG-1` on a malformed/missing config, BEFORE any
 * block is produced), then runs the slot loop ONCE (one block from the
 * persisted head; emission flows from the validated genesis) and emits
 * `CoreStarted`. It takes an optional `genesisPath` override (the
 * `CorePorts.genesisPath` field is the default when the argument is absent).
 * `stop` halts the running slot loop (if any), emits `CoreStopped`, and
 * closes the store (AD-9 order). `startMining` (6.1, AD-9) starts the
 * integrated slot loop — idempotent (a second call is a no-op) — and rejects
 * (a normal `{ code: 'SC-CORE-1' }`) if `start()` has not run (the
 * genesis-derived loop parameters are captured there).
 */
export interface CoreCommands {
  start(genesisPath?: string): Promise<void>
  stop(): Promise<void>
  startMining(): Promise<void>
}

/**
 * The typed read-API (the 1.2 decision, Option A — the UI read-models above).
 * All four operations are real (6.1 replaced the `SC-CORE-1` stubs): a miss
 * is a NORMAL reject with a `{ code }` — never a sync throw.
 */
export interface CoreReadApi {
  getPeers(): Promise<ReadPeer[]>
  getBlock(slot: number): Promise<ReadBlock>
  /** The chain-head read-model (6.1): the head block's projection + the
   *  ledger's total supply as a decimal display string (AD-5). */
  getChainHead(): Promise<ReadChainHead>
  /** The balance read-model (6.1): identity id → decimal-string base units
   *  (AD-5 — the ledger's `toJson` form). */
  getBalances(): Promise<ReadBalances>
}

/** The complete core instance: events + commands + read-API. */
export interface CoreInstance extends CoreEventsEmitter, CoreCommands, CoreReadApi {}
