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
import type { IdentityKeypair } from './identity/identity.js'
import type { CrawlReport } from './discovery/crawler.js'
import type { LadderReport } from './discovery/boot-files.js'

/**
 * CAP-7 (ticket 8.5): the host-supplied discovery wiring, injected like any
 * other port and read by `start()`/`startMining()` after the genesis (the
 * chainId) is known. Everything optional: an absent `discovery` leaves the
 * node exactly as it was pre-8.5.
 */
export interface DiscoveryPorts {
  /** Rung 2: the LAN shared address-book file (hint-grade ingest). The host
   * resolves the OS-appropriate path (`defaultLanBookPath`) — the core reads
   * no ambient platform state. Absent ⇒ rung skipped. */
  hintsFilePath?: string
  /** Rung 3: the block-grade artifact file (validated + dialed at boot).
   * Absent ⇒ rung skipped. */
  artifactFilePath?: string
  /** Ticket 9.2: the invitation file (`defaultInvitePath(userDataDir)`) —
   * verified invite-grade join, run BEFORE the hint rungs. Absent ⇒ skipped. */
  inviteFilePath?: string
  /** Ticket 9.2: sink for this node's renderable self-invitation (fires
   * every announce window once the node has a policy-valid address). The
   * invite is PUBLIC signed text — safe for clipboard/UI (AD-9). A throwing
   * sink is swallowed. */
  onSelfInvite?: (invite: string) => void
  /** The local listen addresses to advertise (8.5: wired from the net
   * adapter's `listenAddresses()`). Absent/empty ⇒ nothing announced —
   * gossip/sync still flow (the 8.3 rule). */
  announceAddresses?: () => string[]
  /** Rung 1 truth for the report (the host's NetConfig.mdns; default true —
   * mDNS rides `createLibp2p` today). Report-only: it changes no behaviour. */
  mdnsEnabled?: boolean
  /** What-worked report sink (AD-9: counts only — never key material). The
   * host logs it / surfaces it in the UI. A throwing sink is swallowed. */
  onLadderReport?: (report: LadderReport) => void
  /** Ticket 9.3: sink for the peer-book crawl report (counts only — stored /
   * dialed / depth / concurrency / stop reason). Fires once when a boot crawl
   * drains (cap, quiet, or stopped). Absent ⇒ the crawl still runs, unlogged.
   * A throwing sink is swallowed. */
  onCrawlReport?: (report: CrawlReport) => void
}

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
  /**
   * Optional boot-time genesis config file path. When absent, `createCore`
   * resolves the default to the repo-root `config/genesis.json` (the single
   * source). A host can point a node at an alternate config here. The
   * fail-fast boot order (AD-9) reads it only AFTER `store.open()`.
   */
  genesisPath?: string
  /**
   * The node's 4.2 PROTOCOL identity (6.1, D2 / AD-11): the keypair the
   * integrated slot loop (`startMining`) signs its tickets with — via
   * `signTicket`, the identity module's single `.secret` reader. OPTIONAL:
   * when absent, the loop uses the tracer ticket (empty signature,
   * `TRACER_WINNER_ID`), preserving the single-node default (every
   * `createCore(makePorts())` caller that passes no identity still mines).
   * The host creates it via `deriveIdentityKeypair(seed)` (e.g. in the
   * Electron main process, where the keys live — AD-11).
   */
  identity?: IdentityKeypair
  /**
   * CAP-7 (8.5): the fallback-ladder boot wiring (LAN hints file, artifact
   * file, announce addresses, report sink). OPTIONAL — absent keeps the
   * node byte-for-byte pre-8.5 except the loop's block-announcement rung,
   * which is genesis-scoped (`chainId`) since 8.3.
   */
  discovery?: DiscoveryPorts
}
