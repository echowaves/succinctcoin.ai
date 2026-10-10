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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGenesis } from './config/index.js'
import { mineAndApply } from './consensus/index.js'

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
 * The default boot genesis path: the repo-root `config/genesis.json`.
 * Resolved relative to THIS file (`src/index.ts` → core → packages → repo
 * root, three levels up) via `import.meta.url` — the same convention
 * `genesis.test.ts` uses. Works identically from the built `dist/index.js`
 * (dist sits at the same depth as src).
 */
function defaultGenesisPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'config',
    'genesis.json',
  )
}

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
    async start(genesisPath) {
      // Boot, in pinned fail-fast order (AD-9):
      //   1. open the store FIRST — a contended data directory rejects here
      //      with SC-STORE-1, before the genesis is even read;
      //   2. load + validate the genesis — a malformed/missing config
      //      rejects SC-CONFIG-1 BEFORE any block is produced. The path is
      //      the command override, else the port field, else the default
      //      (repo-root config/genesis.json);
      //   3. run the slot loop ONCE — mineAndApply produces exactly one
      //      block from the persisted head; emission flows from the
      //      validated genesis (no inline literals);
      //   4. emit CoreStarted (AD-3: chain-time slot, not wall clock) —
      //      exactly once, AFTER the block.
      await ports.store.open()
      const cfg = await loadGenesis(genesisPath ?? ports.genesisPath ?? defaultGenesisPath())
      await mineAndApply({
        store: ports.store,
        rewardDisplay: cfg.emission.blockReward,
        maxSupplyDisplay: cfg.emission.maxSupply,
      })
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
// verifiable draw). 3.5 wired the tracer into the `createCore` lifecycle —
// `start()` calls `mineAndApply`.
export {
  BURN_ID,
  FEE_RATE,
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
  BlockTx,
  OtherTicket,
} from './consensus/index.js'

// Draw verification (3.4, R2): the thin seam over the pinned `drawWindow`
// (AD-7) that verifies a block's claimed winner against the accepted
// ticket set — the verifiable-election launch gate. 3.5 wired the boot
// path into `createCore`; `verifyDraw` stays a public seam.
export { verifyDraw } from './consensus/index.js'

// AD-7 verifiable public-coin draw (3.3): the ONE pinned draw
// (`drawWindow`), the per-window challenge derivation
// (`deriveWindowChallenge`), and the draw-input ticket interface. 3.4
// rewired the tracer's winner to it; 3.5 wired the boot path into
// `createCore`.
export {
  DrawError,
  deriveWindowChallenge,
  drawWindow,
} from './consensus/index.js'
export type {
  DrawResult,
  DrawTicket,
} from './consensus/index.js'

// Multi-node memory-transport simulation (3.7, R1): the standalone harness
// proving the uptime-only slot rate on the memory transport (no sockets).
// It imports the pinned seams (draw / challenge / mine / apply / verify) —
// the draw is NEVER re-implemented (AD-7) and the challenge NEVER re-derived
// (AD-12). NOT wired into `createCore` — additive surface only.
export {
  drawSchedule,
  simulateNetwork,
  simulateWindow,
  syntheticTicket,
  windowAcceptedSet,
} from './consensus/index.js'
export type { SimNode } from './consensus/index.js'

// Block-acceptance seam (4.3, E2 / AD-7 / AD-12): the conformance of a real
// proto `Ticket` to the draw input set (`protoTicketToDrawTicket`, AD-7) +
// the ONE cohesive acceptance-path seam (`acceptBlockWinner`) — a block is
// accepted iff the winner ticket verifies the AD-7 draw (`verifyDraw`,
// unchanged) AND carries a valid AD-12 identity-bound signature. Additive:
// composes with `verifyDraw`, never weakens it.
export {
  acceptBlockWinner,
  protoTicketToDrawTicket,
} from './consensus/index.js'

// Acceptance cap (4.4, R1): the PURE pre-draw filter on a window's accepted
// set — at most ONE ticket per identityId per window (keep-first, input
// order, AD-3). Additive: a NEW standalone filter; `drawWindow` (AD-7),
// `acceptBlockWinner` (4.3), and the sim (4.8) are unchanged.
export { applyAcceptanceCap } from './consensus/index.js'
export type { AcceptedSet, CappedSet } from './consensus/index.js'

// Uptime-weight derivation (4.5, R2): the PURE derivation of an identity's
// draw weight from its ticket history — the COUNT of distinct valid windows
// in the `L` windows strictly before the current one (ramp from zero, moving
// lookback window; AD-3 chain-time, AD-5 integer bigint). Additive: a NEW
// standalone derivation; `drawWindow` (AD-7 — the weight is a derived INPUT
// to the draw), `applyAcceptanceCap` (4.4), and the sim (4.8) are unchanged.
export { computeUptimeWeight } from './consensus/index.js'

// Multi-identity memory-transport simulation (4.8, R1/R2): the standalone
// harness generalizing 3.7's `sim.ts` into the epic-4 multi-identity
// accepted set — SIGNED tickets (4.2, AD-12), uptime-derived weights (4.5),
// re-attestation eligibility (4.6), and the acceptance cap (4.4) —
// composing with the IMPORTED `drawWindow` (AD-7, never re-implemented) and
// `acceptBlockWinner` (4.3). The keypair is a CORE-INTERNAL sim value
// (AD-11 — the module never reads `.secret`; it signs via `signTicket`).
// NOT wired into `createCore` — additive surface only.
export {
  buildCappedSet,
  eligibleSignedSet,
  multiDrawSchedule,
  signedTicket,
  simulateMultiNetwork,
  simulateMultiWindow,
} from './consensus/index.js'
export type { MultiSimIdentity, MultiSimWindowResult, WindowAcceptedSet } from './consensus/index.js'

// Canonical wire schema (AD-8/AD-12): the four protocol messages, each as a
// message type + a codec namespace, generated from proto/protocol.proto.
// `export { Block }` carries BOTH the type (field set) and the value (codec
// namespace: `Block.encode`/`decode`/`codec`/`stream`) — see src/proto/index.ts.
// Plus the four gossipsub envelope messages (5.2, AD-8/AD-12): each wraps a
// payload class + `sourcePeerId` and travels on its own class topic.
export {
  Block,
  BlockEnvelope,
  PeerInfo,
  PeerInfoEnvelope,
  Ticket,
  TicketEnvelope,
  Tx,
  TxEnvelope,
  succinctcoin,
} from './proto/index.js'
export type { succinctcoinInput } from './proto/index.js'

// Operator identity (epic 4, CAP-2): the OFFLINE gate-credential surface
// (4.1). `createOfflineGateVerifier` is the deterministic offline
// implementation of the AD-4 `GateVerifier` port (the port shape itself
// stays in `ports.ts`); `issueGateCredential` is the offline gate-standin
// the harness/sim uses to mint valid credentials.
export {
  GateError,
  createOfflineGateVerifier,
  issueGateCredential,
} from './identity/index.js'
export type { IssueGateCredentialParams } from './identity/index.js'

// Operator identity (epic 4, CAP-2): the identity keypair + ticket
// signature (4.2, AD-11/AD-12). `deriveIdentityKeypair` is the
// deterministic seed → Ed25519 keypair (no RNG — the golden vector is
// reproducible; the AD-11 `secret` stays a distinct field); `signTicket`
// / `verifyTicketSignature` sign/verify over the EXACT AD-12 digest
// `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖
// nonceCommitment)` — verification reconstructs the public key from
// `identityId` alone (public data), and a reject is a normal `false`.
export {
  IdentityError,
  deriveIdentityKeypair,
  signTicket,
  verifyTicketSignature,
} from './identity/index.js'
export type { IdentityKeypair, TicketFields } from './identity/index.js'

// Operator identity (epic 4, CAP-2): the re-attestation lifecycle (4.6, R4 /
// must-hold (d)). `isEligibleAtWindow` is the PURE lapse gate (an identity is
// eligible only while `currentWindow ≤ attestedUntilWindow` — inclusive
// through the deadline, lapses at `deadline + 1`); `reattestationWindow` is
// the PURE cadence (re-attesting at window `W` extends the deadline to
// `W + K`, `K` = genesis `reattestationK`); `verifyReattestation` is the
// seam that COMPOSES with the 4.1 `GateVerifier` (`verifier.verify` is the
// only credential reader, AD-4 — a lapse is the normal
// `{ valid: false, attestedUntilWindow: 0n }`, never an error).
// Chain-time only (AD-3); no `big.js` (AD-5).
export {
  isEligibleAtWindow,
  reattestationWindow,
  verifyReattestation,
} from './identity/index.js'
export type { ReattestationResult } from './identity/index.js'

// Node network (epic 5, AD-8/AD-10): the libp2p adapter (5.1 scaffold) —
// the FULL 1.2 `NetPort` surface over libp2p + noise + yamux + gossipsub,
// CI-exercised only on the memory transport (zero real sockets). The
// transport identity is libp2p's own keypair (never the 4.2 protocol
// identity, AD-11). 5.2 replaced the scratch topic with the four per-class
// topics (`TOPICS`) + proto envelopes: each `send*` encodes its class's
// envelope and publishes on its own topic; 5.3 wires discovery; 5.7 wires
// the relay transport.
export { createNetAdapter, TOPICS } from './net/index.js'
export type { NetAdapter, NetAdapterConfig, ReceivedEnvelope, TopicClass } from './net/index.js'
