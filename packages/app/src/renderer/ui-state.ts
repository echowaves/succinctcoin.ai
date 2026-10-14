/**
 * `app/renderer/ui-state` — the PURE state management of the 6.3 React
 * renderer (the headless-testable core of the story).
 *
 * PURE: NO DOM, NO electron, NO `@succinctcoin/core`, NO timers. The bridge
 * is DEPENDENCY-INJECTED — the runtime provides `window.succinctcoin`, the
 * test provides a mock. The read-model types are DERIVED from the bridge
 * surface (`Window['succinctcoin']`, the 6.2 `preload.d.ts` global) — NEVER
 * imported from the core package (AD-1, the thin client).
 *
 * AD-9 / E1 (the complete UI data source, NO polling): the state is built
 * from the one-time read-API snapshot (`getChainHead`/`getBalances`/
 * `getPeers`) + updated ONLY by the core event stream (the
 * `BlockApplied`/`CoreStarted`/`CoreStopped` subscriptions). There are no
 * timers in this module — a static check in the test asserts it (AC2).
 *
 * AD-11: the state carries only peer IDs, status, and the core's key-free
 * read-models — NO key material (a static check in the test asserts it,
 * AC4).
 *
 * AD-3 (chain-time only): the state holds chain-time values (the slot, the
 * counts) exactly as the core reports them — no wall clock, no RNG.
 */

/**
 * The 6.2 preload bridge — the typed `window.succinctcoin` global (the
 * `./preload.d.ts` declaration). A type-level reference only — erased at
 * runtime (headless-safe). The ONLY core surface the renderer may touch
 * (AD-1).
 */
type Bridge = Window['succinctcoin']

// ---------------------------------------------------------------------------
// The read-models — DERIVED from the bridge surface (AD-1)
// ---------------------------------------------------------------------------

/** The chain-head read-model (derived from `getChainHead`). */
export type ChainHead = Awaited<ReturnType<Bridge['getChainHead']>>

/** The balances read-model (derived from `getBalances`). */
export type BalanceState = Awaited<ReturnType<Bridge['getBalances']>>

/** A connected-peer read-model (derived from a `getPeers` element). */
export type Peer = Awaited<ReturnType<Bridge['getPeers']>>[number]

// ---------------------------------------------------------------------------
// The core event payloads (the bridge's key-free projections, AD-11)
// ---------------------------------------------------------------------------

/**
 * The `BlockApplied` payload — the bridge's key-free projection of a mined
 * window: the chain-time slot, the block hash hex, the winner's PUBLIC
 * identity id, the accepted-set + tx counts. The bridge's typed `on`
 * enforces the core's real payload type at the subscription site — a core
 * drift fails the app typecheck (the single owner of the event types stays
 * the core, AD-9).
 */
export interface BlockAppliedEvent {
  slot: number
  hash: string
  winnerIdentityId: string
  ticketCount: number
  txCount: number
}

/** The `CoreStarted`/`CoreStopped` payload (the chain-time slot). */
export interface SlotEvent {
  slot: number
}

/**
 * The named core events the UI reduces. The renderer NAMES them only — the
 * set is owned by the core's `CoreEvents`; the bridge's typed `on` rejects
 * any name the core does not own (AD-1/AD-9).
 */
export type UiEvent =
  | { type: 'BlockApplied'; payload: BlockAppliedEvent }
  | { type: 'CoreStarted'; payload: SlotEvent }
  | { type: 'CoreStopped'; payload: SlotEvent }

// ---------------------------------------------------------------------------
// The UI state
// ---------------------------------------------------------------------------

/**
 * The complete UI state (the AD-9 data-source projection). Key-free
 * (AD-11): peer IDs, status, the key-free read-models.
 */
export interface UiState {
  /** The chain-head read-model (null until a snapshot resolves). */
  head: ChainHead | null
  /** The balances read-model (null until a snapshot resolves). */
  balances: BalanceState | null
  /** The connected peers (empty until a snapshot resolves). */
  peers: Peer[]
  /** The core-running flag (the `CoreStarted`/`CoreStopped` events). */
  mining: boolean
  /** A bridge-absence error (the preload did not expose the bridge). */
  error: string | null
}

/** The initial (pre-snapshot) state. */
export function initialUiState(): UiState {
  return { head: null, balances: null, peers: [], mining: false, error: null }
}

/**
 * The initial-snapshot builder (the AD-9 one-time read-API call):
 * `getChainHead`/`getBalances`/`getPeers` in parallel. A read rejection is
 * a GRACEFUL null (the core may not have booted yet — the event stream
 * updates the state; the hook re-runs this snapshot on `CoreStarted`, an
 * event-driven re-read, not polling). The `mining` flag is false here —
 * the events own it.
 */
export async function buildInitialSnapshot(bridge: Bridge): Promise<UiState> {
  const [head, balances, peers] = await Promise.allSettled([
    bridge.getChainHead(),
    bridge.getBalances(),
    bridge.getPeers(),
  ])
  return {
    head: head.status === 'fulfilled' ? head.value : null,
    balances: balances.status === 'fulfilled' ? balances.value : null,
    peers: peers.status === 'fulfilled' ? peers.value : [],
    mining: false,
    error: null,
  }
}

/**
 * The event reducer (E1: event-driven, NO timers):
 *   - `BlockApplied`  → the head advances (the event's slot / hash / winner
 *                       id / ticket count / tx count; the snapshot's
 *                       `totalSupplyDisplay` is preserved — the event
 *                       carries no supply). A pre-snapshot event (head
 *                       still null) leaves the head null: the snapshot
 *                       owns the head read-model, and the hook re-snapshots
 *                       on `CoreStarted`, so the gap is transient.
 *   - `CoreStarted`   → the running flag on.
 *   - `CoreStopped`   → the running flag off.
 */
export function reduce(state: UiState, event: UiEvent): UiState {
  switch (event.type) {
    case 'CoreStarted':
      return { ...state, mining: true }
    case 'CoreStopped':
      return { ...state, mining: false }
    case 'BlockApplied': {
      const { slot, hash, winnerIdentityId, ticketCount, txCount } = event.payload
      return {
        ...state,
        // A block was just applied → the core is running (recovers the
        // mining flag if the `CoreStarted` event was missed before the
        // renderer subscribed); `CoreStopped` still clears it.
        mining: true,
        head:
          state.head === null
            ? null
            : { ...state.head, slot, hash, winnerIdentityId, ticketCount, txCount },
      }
    }
  }
}
