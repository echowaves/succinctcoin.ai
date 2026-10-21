/**
 * `@succinctcoin/core` — the pure-Node event-emitting hexagonal core (AD-1).
 *
 * Public surface, all owned by `core/events/` (AD-1/AD-9):
 *   - events out  → `CoreEvents` map + typed `on`/`emit`
 *   - commands in → `CoreCommands` (baseline lifecycle + the integrated
 *                   slot loop via `startMining`, 6.1)
 *   - read-API    → `CoreReadApi` (`getPeers`/`getBlock`/`getChainHead`/
 *                   `getBalances` → UI read-models)
 *   - ports       → `NetPort`/`StorePort`/`ClockPort`/`GateVerifier`/
 *                   `UiSink` (+ the optional 4.2 `identity`, 6.1)
 *
 * Zero UI imports: the core reaches the host only via the injected `UiSink`
 * (AD-1). Epics 2-5 filled the seams; 6.1 integrates them — `start()`
 * keeps its one-block tracer boot, and `startMining()` starts the running
 * node (the AD-9 consensus loop, the single writer in the main process)
 * that mines a block per window and emits the AD-9 UI data source
 * (`BlockApplied` + the real read-API).
 */
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGenesis } from './config/index.js'
import { MINT_ID, TRACER_WINNER_ID, createNodeLoop, mineAndApply } from './consensus/index.js'
import { createAddressBook, runBootLadder, verifyInvite } from './discovery/index.js'
import { DEFAULT_TICKET_LOOKBACK_SLOTS, encodeInvite } from './discovery/index.js'
import { MAX_BOOK_ENTRIES, runCrawl, servePeerBook } from './discovery/index.js'
import type { PeerBookServed, PeerBookSource } from './net/peerbook.js'
import type { AddressBook, InviteRejectReason } from './discovery/index.js'
import { Block } from './proto/index.js'
import { fromDisplay, fromJson, toJson, toDisplay, totalSupply } from './ledger/index.js'

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
 * The integrated slot loop's tick cadence (6.1, D1): a host/test constant —
 * the `setTimeout` period between windows. The slot advances by loop
 * iteration (`nextSlotAndParent` over the persisted head), NEVER derived
 * from this value (AD-3: no wall clock in the chain logic).
 */
const NODE_LOOP_TICK_MS = 15

/** Bytes → lowercase hex (the read-API's hash projection, AD-12 public data). */
function bytesToHex(buf: Uint8Array): string {
  let out = ''
  for (let i = 0; i < buf.byteLength; i += 1) {
    out += buf[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Build a core instance from the injected ports.
 *
 * Wires a `NodeJS.EventEmitter` and forwards every emitted event to the
 * registered `UiSink` (the AD-1 seam — the core reaches the host without
 * importing electron). Capability epics attach logic to the returned instance
 * without forking it. 6.1 completes the integration: `start()` keeps its
 * one-block tracer boot (AD-9) and ALSO captures the genesis-derived loop
 * parameters; `startMining()` starts the integrated slot loop (the running
 * node — the AD-9 single writer); `stop()` halts the loop before closing;
 * the read-API (`getPeers`/`getBlock`/`getChainHead`/`getBalances`) is real
 * — a miss is a normal reject with a `{ code }`, never a sync throw.
 */
export function createCore(ports: CorePorts): CoreInstance {
  // `NodeJS.EventEmitter` is a type namespace, not a runtime value — construct
  // the real emitter from node:events and type it with the plan's naming.
  const emitter: NodeJS.EventEmitter = new EventEmitter()

  // The integrated slot loop (6.1, AD-9) — `null` until `startMining()`;
  // `stop()` halts it (if running) before emitting `CoreStopped` (D5).
  let loop: { stop(): void } | null = null
  // The genesis-derived loop parameters, captured ONCE in `start()` (D5) —
  // the one-time display→base-unit conversion (`fromDisplay`, the AD-5
  // big.js boundary) happens here, never per window.
  let genesis: {
    rewardBaseUnits: bigint
    maxSupplyDisplay: string
    lookbackL: bigint
    chainId: string
  } | null = null
  // The loop's most recently emitted window (the D6 note): the decoded
  // `Block` proto carries NO ticket count, so the read-API projects the
  // accepted-set size from the loop's tracked window (`1` when only the
  // winner ticket is known — a documented projection).
  let lastWindow: { slot: number; ticketCount: number } | null = null
  // CAP-7 (8.5): the core-owned address book, created in `start()` once the
  // genesis (chainId) is known and fed by EVERY ingest path — block-grade
  // from the loop's post-commit handoff (real blockRefs), hint-grade from
  // gossiped records/introductions, LAN-file hints from the boot ladder.
  // Verify-before-connect stays structural: each path validates internally.
  let addressBook: AddressBook | null = null
  // Ticket 9.2: the renderable self-invitation — the latest self-announce-
  // ment encoded (`encodeInvite`), refreshed every announce window; null
  // until the first announcement publishes. Public text (a signed public
  // record), safe for the clipboard/UI (AD-9: no key material).
  let latestSelfInvite: string | null = null
  // Ticket 9.3: cooperative stop for the fire-and-forget crawl (the boot
  // ladder + crawl run detached from `start()`; `stop()` flips this so an
  // in-flight crawl drains between dequeues instead of outliving the node).
  let discoveryStopped = false

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
      //   4. capture the genesis-derived loop parameters (6.1, D5) — the
      //      one-time display→base-unit conversion (AD-5 boundary);
      //   5. emit CoreStarted (AD-3: chain-time slot, not wall clock) —
      //      exactly once, AFTER the block.
      await ports.store.open()
      const cfg = await loadGenesis(genesisPath ?? ports.genesisPath ?? defaultGenesisPath())
      await mineAndApply({
        store: ports.store,
        rewardDisplay: cfg.emission.blockReward,
        maxSupplyDisplay: cfg.emission.maxSupply,
      })
      genesis = {
        rewardBaseUnits: fromDisplay(cfg.emission.blockReward),
        maxSupplyDisplay: cfg.emission.maxSupply,
        lookbackL: BigInt(cfg.uptimeLookbackL),
        // CAP-7 (8.3): the announcement scope — derived default in 8.2.
        chainId: cfg.chainId,
      }
      // Self-exclusion (8.5): the node's own announcements/introductions are
      // valid observations but never dial targets — the book ignores them.
      addressBook = createAddressBook({ selfIdentityId: ports.identity?.identityId })
      discoveryStopped = false
      const netExt = ports.net as unknown as {
        dial?: (address: string) => Promise<void>
        setPeerBookSource?: (source: PeerBookSource | null) => void
        requestPeerBook?: (peer: string, limit: number) => Promise<PeerBookServed>
      }
      // 9.3 — peer-book SERVER: serve this book on /succinctcoin/peerbook/1
      // when the adapter carries the stream surface (memory/tcp alike). The
      // policy lives in `servePeerBook` (freshness order pre-9.4, hint-grade
      // excluded, self-signed witnesses); slot + chain scope read FRESH per
      // request so a long-lived node never serves against stale time.
      netExt.setPeerBookSource?.(
        async (limit) =>
          servePeerBook({
            book: addressBook!,
            currentSlot: BigInt(Math.max(await ports.store.headSlot(), 0)),
            expectedChainId: genesis!.chainId,
            limit,
            witnessSigner: ports.identity,
          }),
      )
      // CAP-7 (8.5): the fallback-ladder boot — rungs 2 + 3 (LAN hints file,
      // artifact file) over the just-created book. FIRE-AND-FORGET: dial
      // timeouts must never stall boot (fail-soft, R4); the report lands at
      // the host sink when the run finishes. Rungs 1 + 4 are reported from
      // the config truths (mDNS flag / chainId wiring).
      if (ports.discovery !== undefined) {
        const bootSlot = await ports.store.headSlot()
        // 9.2 invite rung: the liveness probe over APPLIED blocks, computed
        // ONCE at boot (the sync getter `verifyInvite` needs — AD-3 keeps the
        // pure module store-free). If a host ever exposes a custom lookback,
        // pass it HERE too — the probe snapshot and verifyInvite's window are
        // two parameters of ONE rule and must move together.
        const inviteProbe =
          ports.discovery.inviteFilePath === undefined
            ? undefined
            : await createInviteLiveness(ports.store, bootSlot)
        void runBootLadder({
          chainId: genesis.chainId,
          currentSlot: bootSlot,
          inviteFilePath: ports.discovery.inviteFilePath,
          hadRecentTicket: inviteProbe,
          hintsFilePath: ports.discovery.hintsFilePath,
          book: addressBook,
          artifactFilePath: ports.discovery.artifactFilePath,
          selfIdentityId: ports.identity?.identityId,
          mdnsEnabled: ports.discovery.mdnsEnabled ?? true,
          // Rung 4 truth: chain-grade discovery IS wired (chainId below + the
          // onAnnouncements handoff). Rung 1 truth comes from the host port.
          blocksEnabled: true,
          dial:
            netExt.dial === undefined
              ? undefined
              : async (address) => {
                  try {
                    await netExt.dial!(address)
                    return true
                  } catch {
                    return false
                  }
                },
        })
          .then((report) => ports.discovery?.onLadderReport?.(report))
          // 9.3 — the CRAWL starts where the ladder's trust ends: seeds are
          // the dial-eligible identities the invite/artifact rungs produced,
          // and the bounded BFS (depth ≤ 3, concurrency ≤ 8) fills the book
          // toward the cap. Fire-and-forget like the ladder (R4); stops at
          // cap, at quiet, or when `stop()` flips the shared flag.
          .then(() => {
            if (
              netExt.dial === undefined ||
              netExt.requestPeerBook === undefined ||
              addressBook === null ||
              addressBook.size() >= MAX_BOOK_ENTRIES
            )
              return
            const seeds = addressBook
              .dialEligible(BigInt(Math.max(ports.clock.slotIndex(), 0)))
              .flatMap((t) => t.multiaddrs.map((address) => ({ address, identityId: t.identityId })))
            if (seeds.length === 0) return
            return runCrawl({
              request: (address, limit) => netExt.requestPeerBook!(address, limit),
              dial: (address) => netExt.dial!(address),
              book: addressBook,
              expectedChainId: genesis!.chainId,
              currentSlot: () => BigInt(Math.max(ports.clock.slotIndex(), 0)),
              stopped: () => discoveryStopped,
              // 9.4 latency sampling: monotonic ms around each crawl dial —
              // a local ordering signal only, never consensus time (AD-3).
              now: () => performance.now(),
            }, seeds).then((report) => ports.discovery?.onCrawlReport?.(report))
          })
          .catch(() => undefined) // the ladder never unwinds boot (R4)
      }
      this.emit('CoreStarted', { slot: ports.clock.slotIndex() })
    },
    async stop() {
      // Shutdown (AD-9 order, D5): halt the loop first (if running), then
      // emit CoreStopped, then close the store (releases the lock). Reset
      // the captured genesis params too — a `startMining()` after `stop()`
      // (without a fresh `start()`) must reject `SC-CORE-1`, not re-create a
      // loop that would tick forever against the closed store.
      if (loop !== null) {
        loop.stop()
        loop = null
      }
      genesis = null
      latestSelfInvite = null // 9.2: a stopped node has no renderable invite
      discoveryStopped = true // 9.3: an in-flight crawl drains between dequeues
      ;(ports.net as unknown as {
        setPeerBookSource?: (source: PeerBookSource | null) => void
      }).setPeerBookSource?.(null)
      this.emit('CoreStopped', { slot: ports.clock.slotIndex() })
      await ports.store.close()
    },
    async startMining() {
      // The integrated slot loop (6.1, AD-9): idempotent — a second call is
      // a no-op. Rejects (a normal `{ code }`, never a sync throw) if
      // `start()` has not run (the genesis-derived parameters are captured
      // there, D5). The loop COMPOSES the built seams (AD-7/AD-2) — it never
      // re-implements the draw, the ledger apply, or the net — and signs its
      // ticket via `signTicket` when `ports.identity` is injected (AD-11/
      // AD-12), else the tracer ticket (D2 — the single-node default).
      if (loop !== null) return
      if (genesis === null) {
        const err = new Error(
          'SC-CORE-1: startMining requires start() to have run first',
        )
        ;(err as { code?: string }).code = 'SC-CORE-1'
        throw err
      }
      // Narrowed ONCE for the discovery closures below (the mutable
      // `genesis` cache does not narrow inside callbacks).
      const discChainId = genesis.chainId
      loop = createNodeLoop({
        store: ports.store,
        net: ports.net,
        identity: ports.identity,
        rewardBaseUnits: genesis.rewardBaseUnits,
        maxSupplyDisplay: genesis.maxSupplyDisplay,
        mintId: MINT_ID,
        lookbackL: genesis.lookbackL,
        emitBlockApplied: (p) => {
          lastWindow = { slot: p.slot, ticketCount: p.ticketCount }
          this.emit('BlockApplied', p)
        },
        tickMs: NODE_LOOP_TICK_MS,
        // CAP-7 (8.3/8.5): the discovery scope. 8.5 resolves the earlier
        // "announceAddresses stays unset" note: the host supplies the real
        // listen addresses via `ports.discovery.announceAddresses` (wired
        // from the adapter's `listenAddresses()`), and the introduction leg
        // is ON — verify-before-relay + the 8.4 caps bound its traffic, and
        // a port without `sendIntroduction` simply publishes nothing.
        chainId: genesis.chainId,
        announceAddresses: ports.discovery?.announceAddresses,
        // 9.2: the renderable self-invitation (refreshed every announce
        // window — invites stay fresh as long as the node keeps mining).
        onSelfAnnouncement: (record) => {
          try {
            latestSelfInvite = encodeInvite(record)
            ports.discovery?.onSelfInvite?.(latestSelfInvite)
          } catch {
            /* render/observer errors never unwind the loop */
          }
        },
        introduce: true,
        // CAP-7 (8.5): every ingest path feeds the core-owned book —
        // block-grade with REAL blockRefs (post-commit handoff, 8.3's
        // emission), hint-grade for gossiped records (the 8.4 seam), and
        // verified introductions as corroboration vouchs.
        onAnnouncements: (records, ctx) => {
          if (addressBook === null) return
          for (const record of records) {
            addressBook.ingestAnnouncement(record, {
              currentSlot: ctx.slot,
              expectedChainId: discChainId,
              sourceClass: 'block',
              blockRef: { blockHashHex: ctx.blockHashHex, slot: ctx.slot },
            })
          }
        },
        onGossipedAnnouncement: (record, slot) => {
          addressBook?.ingestAnnouncement(record, {
            currentSlot: slot,
            expectedChainId: discChainId,
            sourceClass: 'hint',
          })
        },
        onGossipedIntroduction: (introduction, slot) => {
          addressBook?.ingestIntroduction(introduction, {
            currentSlot: slot,
            expectedChainId: discChainId,
          })
        },
      })
    },
    async getPeers() {
      // The net adapter's connected peer ids (AD-8). `multiaddrs` is always
      // `[]` — the adapter exposes peer ids only (a documented projection
      // limitation, not a defect — D4).
      const ids = await ports.net.peers()
      return ids.map((peerId) => ({ peerId, multiaddrs: [] as string[] }))
    },
    get addressBook() {
      // CAP-7 (8.5): the core-owned book (created in `start()`; undefined
      // before boot). Public data only — dial decisions belong to the host.
      return addressBook ?? undefined
    },
    getInvite(): string | null {
      // 9.2: the renderable self-invitation — public signed text, safe for
      // the clipboard (AD-9: no key material in anything invite-shaped).
      return latestSelfInvite
    },
    async applyInvite(
      text: string,
    ): Promise<{ ok: true; identityId: string } | { ok: false; reason: InviteRejectReason }> {
      // 9.2 join seam (runtime paste path — the boot file rung applies the
      // same verification). Requires a booted node: chain scope + liveness
      // come from the running store, so pre-start there is nothing to
      // verify against (SC-CORE-1 like every other command).
      if (genesis === null || addressBook === null) {
        const err = new Error('SC-CORE-1: applyInvite requires start() to have run first')
        ;(err as { code?: string }).code = 'SC-CORE-1'
        throw err
      }
      const head = await ports.store.headSlot()
      const currentSlot = Math.max(head, 0)
      const liveness = await createInviteLiveness(ports.store, head)
      const result = verifyInvite(text, {
        currentSlot,
        expectedChainId: genesis.chainId,
        hadRecentTicket: liveness,
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      // Own invite: verified, then verify-only — never stored, NEVER DIALed
      // (the book's self-exclusion covers storage only; the dial loop below
      // must not lean on it — same rule as applyInvites' self skip).
      if (ports.identity !== undefined && ports.identity.identityId === result.record.identityId) {
        return { ok: true, identityId: result.record.identityId }
      }
      // Invite-grade ingest, then fire-and-forget dial, ladder rules (fail-soft R4).
      addressBook.ingestAnnouncement(result.record, {
        currentSlot,
        expectedChainId: genesis.chainId,
        sourceClass: 'invite',
      })
      const netExt = ports.net as unknown as { dial?: (address: string) => Promise<void> }
      if (netExt.dial !== undefined) {
        void (async () => {
          for (const addr of result.record.multiaddrs) {
            try {
              await netExt.dial!(addr)
              return
            } catch {
              /* next address — the book's ladder owns the retry policy */
            }
          }
        })()
      }
      return { ok: true, identityId: result.record.identityId }
    },
    async getBlock(slot) {
      // The block read-model for `slot` (D4): a missing slot is a NORMAL
      // reject with a `{ code }` — never a sync throw. `ticketCount` is the
      // loop's tracked accepted-set size for that window (the D6 note; `1`
      // when only the winner ticket is known).
      const bytes = await ports.store.getBlock(slot)
      if (bytes === null) {
        const err = new Error(`SC-CORE-1: no block stored at slot ${slot}`)
        ;(err as { code?: string }).code = 'SC-CORE-1'
        throw err
      }
      const block = Block.decode(bytes)
      return {
        slot: Number(block.slot),
        hash: bytesToHex(block.hash),
        winnerIdentityId: block.winnerIdentityId,
        ticketCount: lastWindow !== null && lastWindow.slot === slot ? lastWindow.ticketCount : 1,
        txCount: Number(block.txCount),
      }
    },
    async getChainHead() {
      // The chain-head read-model (D4): `headSlot()` (−1 → the zero/empty
      // head read-model) → `getBlock(head)` → `Block.decode` → project
      // (`totalSupplyDisplay` via the ledger's display boundary, AD-5).
      const head = await ports.store.headSlot()
      if (head === -1) {
        return {
          slot: 0,
          hash: '0'.repeat(64),
          winnerIdentityId: '',
          ticketCount: 0,
          txCount: 0,
          totalSupplyDisplay: '0',
        }
      }
      const bytes = await ports.store.getBlock(head)
      if (bytes === null) {
        const err = new Error(`SC-CORE-1: head slot ${head} has no stored block`)
        ;(err as { code?: string }).code = 'SC-CORE-1'
        throw err
      }
      const block = Block.decode(bytes)
      const doc = await ports.store.loadState()
      const balances = doc === null ? new Map<string, bigint>() : fromJson(doc)
      return {
        slot: Number(block.slot),
        hash: bytesToHex(block.hash),
        winnerIdentityId: block.winnerIdentityId,
        ticketCount: lastWindow !== null && lastWindow.slot === head ? lastWindow.ticketCount : 1,
        txCount: Number(block.txCount),
        totalSupplyDisplay: toDisplay(totalSupply(balances)),
      }
    },
    async getBalances() {
      // The balance read-model (D4, AD-5): `loadState()` (null → empty)
      // → `fromJson` → `toJson` (identity id → decimal-string base units).
      const doc = await ports.store.loadState()
      if (doc === null) return { balances: {} }
      return { balances: toJson(fromJson(doc)) }
    },
  }
}

// Re-export the public surface so consumers import everything from the
// package entry (AD-1/AD-9: one owner, `core/events/`).
export type {
  CoreCommands,
  CoreDiscoveryAccess,
  CoreEvents,
  CoreEventsEmitter,
  CoreInstance,
  CoreReadApi,
  ReadBalances,
  ReadBlock,
  ReadChainHead,
  ReadPeer,
} from './events/types.js'
export type {
  ClockPort,
  CorePorts,
  DiscoveryPorts,
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
  AnnouncementBlockError,
  MAX_BLOCK_ANNOUNCEMENTS,
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

// Chain-sync orchestration (5.4, D2/D3/D7/D9): the CLIENT catch-up
// (`syncChain` — derive the challenge (3.3) → `acceptBlockWinner` (4.3) →
// `applyBlock` (AD-2), threading balances, reject = a normal stop) + the
// SERVER factory (`buildSyncSource` — stream the peer's per-window
// `{ block, acceptedTickets, weights }` from `fromSlot`). Composes ONLY
// imported seams (never re-implements them). NOT wired into `createCore`
// (AD-1) — the test drives it. The `SyncClient`/`SyncSource`/
// `SyncWindowRecord` types are the structural seams (no net import, D7).
export { buildSyncSource, syncChain } from './consensus/index.js'
export type {
  SyncChainParams,
  SyncChainResult,
  SyncClient,
  SyncSource,
  SyncWindowRecord,
} from './consensus/index.js'

// Canonical wire schema (AD-8/AD-12): the four protocol messages, each as a
// message type + a codec namespace, generated from proto/protocol.proto.
// `export { Block }` carries BOTH the type (field set) and the value (codec
// namespace: `Block.encode`/`decode`/`codec`/`stream`) — see src/proto/index.ts.
// Plus the gossipsub envelope messages (5.2, AD-8/AD-12; six classes since
// 8.3's `AnnouncementEnvelope` + 8.4's `IntroductionEnvelope`): each wraps a
// payload class + `sourcePeerId` and travels on its own class topic.
export {
  AnnouncementEnvelope,
  Block,
  BlockEnvelope,
  Introduction,
  IntroductionEnvelope,
  PeerAnnouncement,
  PeerInfo,
  PeerInfoEnvelope,
  SyncBlock,
  SyncRequest,
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
// `signDigest` (the ONE key-material reader's generic face, 8.2) is
// deliberately NOT on the package surface — core-internal use only (e.g.
// discovery's signPeerAnnouncement); external callers get purpose-built
// signers so no arbitrary-digest signing oracle ships.
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
// envelope and publishes on its own topic; 5.3 wired discovery; 5.7 wired
// the relay transport.
export { createNetAdapter, SYNC_PROTOCOL, TOPICS } from './net/index.js'
export type {
  NetAdapter,
  NetAdapterConfig,
  ReceivedEnvelope,
  RelaySeedEvent,
  TopicClass,
} from './net/index.js'
// Auto-relay policy (pure): serve/hold/candidate rules over reachability truth.
export {
  autoHoldWanted,
  type AutoRelayMode,
  autoServeEnabled,
  MAX_AUTO_RELAYS,
  pickRelayCandidates,
  type RelayCandidate,
} from './net/auto-relay.js'
// 10.1 — AutoNAT reachability truth (pure module; the adapter applies it at
// both the wire-level announce filter and `listenAddresses()`).
export {
  autoNatEnabledFor,
  createReachabilityTracker,
  dcutrEnabledFor,
  filterHonestAddresses,
  isCircuitAddressText,
  normalizeAddressKey,
  type Reachability,
  type ReachabilityTracker,
} from './net/reachability.js'
// 9.1 — the addressing policy (spec constraint 2026-10-18, amended
// 2026-10-21 with the relay-hop law): the ONE module behind announce/dial/
// ingest eligibility on real transports. Direct stays global-IPv6-only; a
// /p2p-circuit address is valid iff its hop is global scope (either family).
export {
  ALLOW_LOOPBACK_ENV,
  classifyIp6Address,
  type Ip6AddressClass,
  assertDialable,
  filterDialableAddresses,
  filterPolicyAddresses,
  hopNetworkKey,
  isAddressableMultiaddr,
  isDialableMultiaddr,
  isGlobalHopMultiaddr,
  isGlobalIp6Multiaddr,
  isLoopbackIp6Multiaddr,
  isRelayHopCircuitMultiaddr,
} from './net/index.js'

// Peer-book exchange (epic 9 — ticket 9.3): the `/succinctcoin/peerbook/1`
// stream (pure handler/client, sync's framing) + the /64 group key used by
// the book's diversity floor.
export {
  ip6Slash64,
  makePeerBookHandler,
  PEERBOOK_PROTOCOL,
  PEERBOOK_TIMEOUT_MS,
  requestPeerBook,
} from './net/index.js'
export type { PeerBookSource, PeerBookServed } from './net/index.js'

// Bootstrap-free discovery (epic 8, CAP-7 — ticket 8.2): the signed peer
// announcement contract (digest / sign / verify / PURE validator). The
// signature IS the liveness proof; freshness is judged against a CALLER-
// SUPPLIED slot (AD-3 — no wall clocks), and network scope is the genesis
// `chainId`. 8.3 carries these in blocks; 8.4 keeps the address book.
export {
  PEER_ANNOUNCEMENT_DOMAIN,
  peerAnnouncementDigest,
  signPeerAnnouncement,
  validatePeerAnnouncement,
  verifyPeerAnnouncementSignature,
} from './discovery/index.js'
export type {
  AnnouncementContext,
  AnnouncementRejectReason,
  AnnouncementValidation,
  PeerAnnouncementFields,
  SignedPeerAnnouncement,
} from './discovery/index.js'

// Bootstrap-free discovery (epic 8, CAP-7 — ticket 8.4): the Introduction
// vouch contract ("saw identity X online at slot s", signed by the signer,
// digest binding signer AND subject, domain-separated from announcements)
// and the PURE address book (source classes block > log > dns > hint,
// three-introductions promotion, slot-parameterized expiry + quarantine,
// reorg retraction keyed by originating block). Verify-before-connect is
// structural: the ONLY ingest paths run the validators internally.
export {
  ADDRESS_SOURCE_CLASSES,
  createAddressBook,
  DEFAULT_QUARANTINE_SLOTS,
  DIAL_FAILURES_TO_QUARANTINE,
  INTRODUCTION_DOMAIN,
  introductionDigest,
  MAX_BOOK_ENTRIES,
  MAX_VOUCHES_PER_SUBJECT,
  REACHABILITY_CLASSES,
  signIntroduction,
  validateIntroduction,
  verifyIntroductionSignature,
} from './discovery/index.js'
export type {
  AddressBook,
  AddressBookEntry,
  AddressBookOptions,
  AddressSourceClass,
  BlockRef,
  BookIngestContext,
  BookIngestResult,
  BookIntroResult,
  DialTarget,
  IntroductionContext,
  IntroductionFields,
  IntroductionReachability,
  IntroductionRejectReason,
  IntroductionValidation,
  SignedIntroduction,
} from './discovery/index.js'

// Bootstrap-free discovery (epic 8, CAP-7 — ticket 8.5): the fallback-ladder
// boot FILE rungs — the LAN hints file (hint-grade ingest, poisoned-hint
// inert by construction) and the block-grade artifact file (validated at a
// caller-supplied slot, dialed directly). Bootstrap I/O boundary by design
// (genesis-loader precedent): this is the ONE discovery module allowed fs,
// never purity-scanned; everything downstream stays pure.
export {
  applyInvites,
  defaultArtifactPath,
  defaultInvitePath,
  defaultLanBookPath,
  MAX_ARTIFACT_RECORDS,
  MAX_INVITE_LINES,
  readAnnouncementFile,
  readInviteFile,
  runBootLadder,
  writeAnnouncementFile,
  writeAnnouncementsFromMessages,
} from './discovery/index.js'
export type {
  AnnouncementFileRead,
  ApplyInvitesOptions,
  BootLadderOptions,
  InviteApplyReport,
  InviteFileRead,
  LadderReport,
  LadderRungReport,
} from './discovery/index.js'

// Invitation join (epic 9 — ticket 9.2): the ONE invite text format (an 8.2
// announcement + ticket liveness, base64url of the proto bytes) — render,
// parse, verify. Verification is three-gated with distinct reasons; an
// unverified invite never yields a dial target (verify-before-connect).
export {
  DEFAULT_TICKET_LOOKBACK_SLOTS,
  encodeInvite,
  INVITE_PREFIX,
  parseInvite,
  verifyInvite,
} from './discovery/index.js'
export type { InviteContext, InviteRejectReason, InviteValidation } from './discovery/index.js'

// Peer-book exchange + bounded BFS crawl (epic 9 — ticket 9.3): the serve
// policy (what a node shares) and the crawler machine (how far it reaches).
// Bounds are exported for the tests that pin them.
export { CRAWL_CONCURRENCY, CRAWL_MAX_DEPTH, runCrawl, servePeerBook } from './discovery/index.js'
export {
  CORROBORATION_CAP,
  emptyPeerHistory,
  ewmaUpdate,
  LATENCY_CAP_MS,
  scorePeer,
  SCORE_EWMA_ALPHA,
  STABILITY_WINDOW_SLOTS,
  VALIDITY_NEUTRAL,
  WEIGHT_CORROBORATION,
  WEIGHT_DIAL,
  WEIGHT_LATENCY,
  WEIGHT_STABILITY,
  WEIGHT_VALIDITY,
} from './discovery/index.js'
export type { PeerHistory } from './discovery/index.js'
export type { CrawlReport, CrawlerDeps, ServePeerBookOptions } from './discovery/index.js'

/**
 * 9.2 — the ticket-liveness ground truth over APPLIED blocks (the getter
 * `verifyInvite` consumes). Winner identities of the last `lookbackSlots`
 * block slots; winner tickets ONLY — gossiped tickets are un-anchored and
 * prove nothing, applied winners were validated at accept time.
 *
 * THE EMPTY-CHAIN RULE (pinned): a freshly wiped node has no real tickets —
 * its only block is the boot tracer's, whose winner (`TRACER_WINNER_ID`) is
 * not a signable identity. Demanding liveness there would make invitation
 * joining impossible at exactly the moment it exists for. So when the scan
 * finds NO real (non-tracer) winner, liveness is UNDECIDABLE and the probe
 * allows: the trust event is then the social channel the invite arrived on
 * (spec: "a trusted party shares it with a friend"), still gated by parse +
 * signature + freshness + chain scope + IPv6 policy. The moment real blocks
 * exist (post-sync), the probe goes strict — a squatter replaying an old
 * announcement dies at `no-recent-ticket`.
 */
export async function createInviteLiveness(
  store: StorePort,
  headSlot: number,
  lookbackSlots: number = DEFAULT_TICKET_LOOKBACK_SLOTS,
): Promise<(identityId: string) => boolean> {
  const winners = new Set<string>()
  if (headSlot >= 0) {
    const from = Math.max(0, headSlot - lookbackSlots + 1)
    for (let s = headSlot; s >= from; s -= 1) {
      try {
        const bytes = await store.getBlock(s)
        if (bytes === null) continue
        winners.add(Block.decode(bytes).winnerIdentityId)
      } catch {
        /* unreadable slot: skip — liveness counts what IS on chain */
      }
    }
  }
  let realWinners = 0
  for (const id of winners) if (id !== TRACER_WINNER_ID) realWinners += 1
  if (realWinners === 0) return () => true // undecidable → social-trust allow
  return (identityId: string) => winners.has(identityId)
}
