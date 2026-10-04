/**
 * The five hexagonal port interfaces (AD-1/AD-4/AD-9).
 *
 * These are type-only seams: the core declares them and capability epics
 * (2-5) supply the adapters (libp2p, file store, slot clock, offline gate
 * verifier, Electron IPC bridge). No adapter logic, no libp2p/store/clock
 * implementation lives in this file.
 *
 * The `UiSink` port is the AD-1 seam made concrete: the shell registers a
 * sink and the core forwards every emitted event to it, so the core never
 * imports `electron`.
 */

/**
 * The only representable gate-credential shape (AD-4). The `blob` is
 * unreadable outside the verifier by type; no module parses credential
 * fields beyond `gateId`.
 */
export interface GateCredential {
  /** Which accepted-gate registry entry this credential attests under. */
  gateId: string
  /** Opaque credential bytes; only `GateVerifier` may interpret them. */
  blob: Uint8Array
}

/**
 * Result of an offline gate-credential verification (AD-4). Exactly the
 * shape the spine binds: no network call is involved.
 */
export interface GateVerification {
  valid: boolean
  identityId: string
  attestedUntilWindow: number
}

/**
 * Offline gate-credential verifier (AD-4). Signature/credential check only;
 * the gate is never a per-window network dependency.
 */
export interface GateVerifier {
  verify(cred: GateCredential, windowIndex: number): Promise<GateVerification>
}

/**
 * Chain-time source (AD-3). Every protocol decision reads chain time —
 * slot count + last block hash — never the wall clock.
 */
export interface ClockPort {
  slotIndex(): number
  lastBlockHash(): string
}

/**
 * Chainstore port (AD-9). The store is the only owner of on-disk state and
 * has exactly one writer — the consensus loop. All other modules read via
 * the core read-API. The concrete engine (SQLite/LevelDB/custom) is a
 * code-level choice at 1.5; this interface stays storage-agnostic.
 */
export interface StorePort {
  open(): Promise<void>
  close(): Promise<void>
  /** Commit one canonical block record (the single mutation path, AD-2). */
  commit(block: unknown): Promise<void>
  /** Highest committed slot, or -1 for an empty chain. */
  headSlot(): Promise<number>
  /**
   * Read the stored canonical bytes for `slot`, or `null` if absent. Returns
   * the stored wire bytes verbatim (no re-serialization) — the read path the
   * persist/reload contract requires (1.5 completes the port's read surface).
   */
  getBlock(slot: number): Promise<Uint8Array | null>
  /**
   * Persist the balance-state snapshot (AD-5): a canonical document of
   * identity id → decimal-string base units. The port stays storage-agnostic —
   * it knows "identity → decimal string", never `BalanceMap`; a malformed
   * document on the read side rejects (`SC-STORE-3`). WHEN a snapshot is taken
   * belongs to the caller (epic 3's `applyBlock`), not the store.
   */
  saveState(doc: Record<string, string>): Promise<void>
  /**
   * Load the balance-state snapshot, or `null` if none has been saved yet
   * (absent = "no snapshot yet" — an empty `{}` document means "state exists,
   * all balances zero"). A document that is not a plain object of
   * string→string (e.g. JSON-number amounts — the float/int64 "column")
   * rejects (`SC-STORE-3`).
   */
  loadState(): Promise<Record<string, string> | null>
}

/**
 * Network transport port (AD-8). The libp2p adapter (epic 5) implements it;
 * the core sends protocol messages and discovers peers through it.
 */
export interface NetPort {
  start(): Promise<void>
  stop(): Promise<void>
  sendBlock(block: unknown): Promise<void>
  sendTicket(ticket: unknown): Promise<void>
  sendTx(tx: unknown): Promise<void>
  peers(): Promise<string[]>
}

/**
 * UI sink port (AD-1). How the core pushes events to the host without
 * importing `electron`: the shell registers a sink, `createCore` forwards
 * every emitted event to it. The sink receives the same typed payloads the
 * emitter does.
 */
export interface UiSink {
  sink(event: string, ...args: unknown[]): void
}

/** The bundle of all five ports injected into `createCore(ports)`. */
export interface CorePorts {
  net: NetPort
  store: StorePort
  clock: ClockPort
  gate: GateVerifier
  uiSink: UiSink
}
