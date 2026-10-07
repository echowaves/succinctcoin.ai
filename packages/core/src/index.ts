/**
 * `@succinctcoin/core` — the pure-Node event-emitting hexagonal core (AD-1).
 *
 * Public surface, all owned by `core/events/` (AD-1/AD-9):
 *   - events out  → `CoreEvents` map + typed `on`/`emit`
 *   - commands in → `CoreCommands` (baseline lifecycle works; capability
 *                   commands stub `{ code: 'SC-CORE-1' }`)
 *   - read-API    → `CoreReadApi` (`getPeers`/`getBlock` → UI read-models)
 *   - ports       → `NetPort`/`StorePort`/`ClockPort`/`GateVerifier`/`UiSink`
 *
 * Zero UI imports: the core reaches the host only via the injected `UiSink`
 * (AD-1). No capability logic lives here yet — epics 2-5 fill the seams.
 */
import { EventEmitter } from 'node:events'

import type {
  CoreCommands,
  CoreEvents,
  CoreEventsEmitter,
  CoreInstance,
  CoreReadApi,
  ReadBlock,
  ReadPeer,
} from './events/types.js'
import type {
  ClockPort,
  CorePorts,
  GateCredential,
  GateVerification,
  GateVerifier,
  NetPort,
  StorePort,
  UiSink,
} from './ports.js'

/**
 * Build a core instance from the five injected ports.
 *
 * Wires a `NodeJS.EventEmitter` and forwards every emitted event to the
 * registered `UiSink` (the AD-1 seam — the core reaches the host without
 * importing electron). Capability epics attach logic to the returned instance
 * without forking it. Read-API and capability commands are stubs throwing
 * `SC-CORE-1` until a capability epic implements them.
 */
export function createCore(ports: CorePorts): CoreInstance {
  // `NodeJS.EventEmitter` is a type namespace, not a runtime value — construct
  // the real emitter from node:events and type it with the plan's naming.
  const emitter: NodeJS.EventEmitter = new EventEmitter()

  return {
    on<K extends keyof CoreEvents>(event: K, listener: (payload: CoreEvents[K]) => void) {
      emitter.on(event, listener)
      return () => emitter.off(event, listener)
    },
    emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]) {
      // Notify subscribers and forward to the host (AD-1) in one place. Node's
      // core EventEmitter has no wildcard listener, so forwarding lives here.
      emitter.emit(event, payload)
      ports.uiSink.sink(event, payload)
    },
    async start() {
      // Boot: open the store FIRST (AD-9 — a contended data directory rejects
      // here with SC-STORE-1, before any event is emitted), then emit
      // CoreStarted (AD-3: chain-time slot, not wall clock).
      await ports.store.open()
      this.emit('CoreStarted', { slot: ports.clock.slotIndex() })
    },
    async stop() {
      // Shutdown: emit CoreStopped, then close the store (releases the lock).
      this.emit('CoreStopped', { slot: ports.clock.slotIndex() })
      await ports.store.close()
    },
    startMining() {
      // Capability command — owned by epic 3 (equal-node-mining). Stub.
      throw notImplemented('startMining')
    },
    async getPeers() {
      // Read-API — owned by epic 5 (node-network). Stub: `async` so the throw
      // surfaces as a rejected promise, honoring the Promise<> return type.
      throw notImplemented('getPeers')
    },
    async getBlock(slot) {
      // Read-API — owned by the capability epics. Stub: rejected promise.
      throw notImplemented(`getBlock(slot=${slot})`)
    },
  }
}

/** Build the canonical `{ code: 'SC-CORE-1', message }` not-implemented error. */
function notImplemented(op: string): Error {
  const err = new Error(`SC-CORE-1: ${op} is not implemented yet`)
  ;(err as { code?: string }).code = 'SC-CORE-1'
  return err
}

// Re-export the public surface so consumers import everything from the
// package entry (AD-1/AD-9: one owner, `core/events/`).
export type {
  CoreCommands,
  CoreEvents,
  CoreEventsEmitter,
  CoreInstance,
  CoreReadApi,
  ReadBlock,
  ReadPeer,
} from './events/types.js'
export type {
  ClockPort,
  CorePorts,
  GateCredential,
  GateVerification,
  GateVerifier,
  NetPort,
  StorePort,
  UiSink,
} from './ports.js'

// Exact-money ledger (AD-2/AD-5): the `apply` seam is the ledger's only
// mutation path; balances are read via projections (`balanceOf`/
// `totalSupply`) and serialized via `toJson` (decimal-string base units —
// raw BigInt is banned from JSON), deserialized via `fromJson` (the
// state-decode boundary; SC-LEDGER-4). `toDisplay`/`fromDisplay` are the
// big.js display boundary (AD-5's 2nd boundary; the fee boundary lands in
// 2.2). The read-API projection of balances into `CoreReadApi` is a later
// epic's concern — this is the additive surface only.
export {
  BASE_UNIT_DECIMALS,
  LedgerError,
  apply,
  balanceOf,
  computeFee,
  fromDisplay,
  fromJson,
  toJson,
  toDisplay,
  totalSupply,
} from './ledger/index.js'
export type { BalanceMap, Transfer } from './ledger/index.js'

// Genesis config seam (the single owner of the genesis shape — boot validation).
export {
  GenesisConfigError,
  loadGenesis,
  validateGenesis,
} from './config/index.js'
export type { GenesisConfig, GenesisEmission } from './config/index.js'

// File-backed chainstore adapter (AD-9 single-writer persistence): the
// zero-dep engine + its SC-STORE-1 error.
export { FileChainStore, StoreError } from './store/index.js'

// PoW seam (E1 spike, AD-6/AD-12): the canonical digest encoding of a
// `Block` (BE fixed-width, proto field order, `hash` excluded) + the
// fixed-at-launch leading-zero-bits target + the per-attempt PoW check the
// tracer's mining loop (3.2) and the block-hash math build on.
export {
  POW_TARGET_LEADING_ZERO_BITS,
  PowError,
  blockDigest,
  canonicalBlockBytes,
  leadingZeroBits,
  powCheck,
} from './consensus/index.js'

// Tracer (3.2): the per-attempt mining loop (AD-6 hot path — node:crypto
// sha256 + integer counter via the PoW seam), the chain-time slot
// derivation (AD-3), the single mutation path `applyBlock` (AD-2), and the
// one-block end-to-end tracer `mineAndApply` (3.4 rewires it for the
// verifiable draw). `createCore` is untouched — 3.5 wires the tracer into
// the core lifecycle.
export {
  MINT_ID,
  TRACER_WINNER_ID,
  applyBlock,
  mineAndApply,
  mineBlock,
  nextSlotAndParent,
} from './consensus/index.js'
export type {
  ApplyBlockParams,
  BlockTemplate,
  OtherTicket,
} from './consensus/index.js'

// Draw verification (3.4, R2): the thin seam over the pinned `drawWindow`
// (AD-7) that verifies a block's claimed winner against the accepted
// ticket set — the verifiable-election launch gate. Additive surface —
// `createCore` untouched.
export { verifyDraw } from './consensus/index.js'

// AD-7 verifiable public-coin draw (3.3): the ONE pinned draw
// (`drawWindow`), the per-window challenge derivation
// (`deriveWindowChallenge`), and the draw-input ticket interface. Additive
// surface — 3.4 wires the tracer's winner to it; `createCore` untouched.
export {
  DrawError,
  deriveWindowChallenge,
  drawWindow,
} from './consensus/index.js'
export type {
  DrawResult,
  DrawTicket,
} from './consensus/index.js'

// Canonical wire schema (AD-8/AD-12): the four protocol messages, each as a
// message type + a codec namespace, generated from proto/protocol.proto.
// `export { Block }` carries BOTH the type (field set) and the value (codec
// namespace: `Block.encode`/`decode`/`codec`/`stream`) — see src/proto/index.ts.
export {
  Block,
  PeerInfo,
  Ticket,
  Tx,
  succinctcoin,
} from './proto/index.js'
export type { succinctcoinInput } from './proto/index.js'
