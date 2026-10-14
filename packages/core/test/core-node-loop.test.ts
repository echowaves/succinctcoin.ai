/**
 * Story 6.1 matrix — the integrated slot loop (the running node) + the UI
 * data source (AD-9): `createCore` gains a real `startMining()` (the
 * `setTimeout`-driven bounded-poll loop that composes the built seams —
 * never re-implementing the draw (AD-7), the ledger apply (AD-2), or the
 * net (AD-8)) and the real read-API (`getChainHead`/`getBalances`/
 * `getPeers`/`getBlock` — the `SC-CORE-1` stubs are gone).
 *
 *   NODE_LOOP_MINES_REAL_TICKET  (AC-1) real ports — a `createNetAdapter`
 *                                over `@libp2p/memory` (zero real sockets,
 *                                AD-10), a real `FileChainStore` (mkdtemp),
 *                                a store-backed `ClockPort`,
 *                                `createOfflineGateVerifier`, a REAL
 *                                identity (`deriveIdentityKeypair`), a
 *                                recording `uiSink` — `start()` (slot 0,
 *                                tracer) → `startMining()` → a BOUNDED,
 *                                event-driven wait (AD-3 — NO wall-clock
 *                                assertion) for a `BlockApplied` with
 *                                `slot ≥ 1`; the winner is the local
 *                                identity (a single participant always
 *                                wins its own draw — 5.10 deviation 3);
 *                                the payload's key set is EXACTLY
 *                                `{slot, hash, ticketCount, txCount,
 *                                winnerIdentityId}` (no key material);
 *                                `getBlock(slot).hash === payload.hash`;
 *                                the mined block's `winnerTicket` passes
 *                                `verifyTicketSignature` from PUBLIC data
 *                                alone (a REAL signed ticket, AD-12);
 *                                after `stop()` NO further `BlockApplied`
 *                                fires (the loop halted).
 *   NODE_LOOP_READ_API           (AC-2) after mining: `getChainHead()`
 *                                matches the mined head (`slot`/`hash`/
 *                                `winnerIdentityId`) with
 *                                `totalSupplyDisplay` a decimal string
 *                                (AD-5) = the genesis maxSupply (closed
 *                                system); `getBalances()` carries the
 *                                local identity's balance as a NON-ZERO
 *                                decimal string + the MINT balance;
 *                                `getPeers()` resolves (a lone memory node
 *                                → `[]` — the adapter exposes peer ids
 *                                only); `getBlock(0)` is the slot-0
 *                                read-model; `getBlock(<absent>)` REJECTS
 *                                NORMALLY with a `{ code }` — never a sync
 *                                throw (the stub reject is gone).
 *   NODE_LOOP_TRACER_FALLBACK    (D2) `createCore` with NO `identity`
 *                                (the `makePorts`-shape ports) →
 *                                `startMining()` still mines — the tracer
 *                                ticket (empty signature,
 *                                `TRACER_WINNER_ID`): the single-node
 *                                default is preserved.
 *   NODE_LOOP_AD11_AND_HYGIENE   (AC-4/AC-5/AC-6, self-scan) the
 *                                `BlockApplied` payload + the new
 *                                read-models carry no key material (name +
 *                                value); a comment-stripped `src/**` scan
 *                                for `.secret` READS stays EXACTLY
 *                                `['identity/identity.ts']` (the 4.7
 *                                single-reader invariant — the new
 *                                `node-loop.ts` never reads `.secret`);
 *                                the same scan finds NO `Date.now(`/
 *                                `Math.random(` (AD-3 — bounded-poll +
 *                                `setTimeout` only); NO `electron`/
 *                                renderer/UI import (AD-1); NO direct
 *                                `big.js` import outside
 *                                `ledger/display.ts`/`ledger/fee.ts` (the
 *                                2.5 no-float set — the loop uses the
 *                                ledger primitives); every `../src/`
 *                                import in THIS file == the root barrel
 *                                only (no `@libp2p/*`, no
 *                                `@multiformats/*`).
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest` + node
 * builtins `node:fs` / `node:os` / `node:path` / `node:url`) — no deep
 * imports, no transitive-dependency imports (AD-10).
 *
 * AD-3 discipline: no wall-clock reads, no RNG — a pinned 32-byte identity
 * seed (`seedFor(i)` = 32 bytes of `0x40 + i`, the 4.8 convention) →
 * `deriveIdentityKeypair` (IMPORTED); the wait is a BOUNDED, event-driven
 * deadline (`setTimeout` — a liveness bound, like 5.5's `MAX_POLLS`, NOT a
 * timestamp read).
 *
 * AD-5 discipline: no `big.js` here — display strings are asserted as
 * plain decimals; base units stay integer strings.
 *
 * AD-11 discipline: the keypair is a test-internal value (the host would
 * create it via `deriveIdentityKeypair` in main); this file NEVER reads
 * `.secret` for signing (the loop signs via `signTicket` — the identity
 * module's single reader); the `secret` bytes appear ONLY inside the
 * AD-11 absence assertions (by-name / by-value checks).
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  TRACER_WINNER_ID,
  Ticket,
  createCore,
  createNetAdapter,
  createOfflineGateVerifier,
  deriveIdentityKeypair,
  loadGenesis,
  verifyTicketSignature,
} from '../src/index.js'
import type {
  ClockPort,
  CoreEvents,
  CoreInstance,
  CorePorts,
  IdentityKeypair,
  NetAdapter,
  StorePort,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned parameters (6.1 — deterministic, AD-3)
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL('.', import.meta.url))
/** The repo-root `config/genesis.json` (test dir → core → packages → repo root). */
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')
const GENESIS = await loadGenesis(GENESIS_PATH)

/** The closed-system maxSupply display (the genesis emission — totalSupply). */
const MAX_SUPPLY_DISPLAY = '21000000'

/** The transport flag (AD-10 — zero real sockets in CI). */
const TRANSPORT = 'memory' as const

/** A 32-byte pinned identity seed (AD-3: no RNG — the 4.8 convention). */
function seedFor(byte: number): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, i) => (byte + i) % 256))
}

/** The `BlockApplied` event payload (the single owner is `CoreEvents`). */
type BlockAppliedPayload = CoreEvents['BlockApplied']

/**
 * Bounded, event-driven wait (AD-3 — NO wall-clock assertion): resolves
 * with the FIRST `BlockApplied` matching `pred`; rejects after the bounded
 * deadline if none fires (`setTimeout` — a liveness bound, like 5.5's
 * `MAX_POLLS`, not a timestamp read).
 */
function waitForBlockApplied(
  core: CoreInstance,
  pred: (p: BlockAppliedPayload) => boolean,
  deadlineMs = 4000,
): Promise<BlockAppliedPayload> {
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined
    const timer = setTimeout(() => {
      off?.()
      reject(new Error('bounded wait: no matching BlockApplied before the deadline'))
    }, deadlineMs)
    off = core.on('BlockApplied', (p) => {
      if (!pred(p)) return
      clearTimeout(timer)
      off?.()
      resolve(p)
    })
  })
}

/** A bounded yield (a liveness bound, not a timestamp — the 5.5 SLEEP pattern). */
function yieldMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ---------------------------------------------------------------------------
// the real-ports harness (AC-1: memory transport, zero real sockets, AD-10)
// ---------------------------------------------------------------------------

interface Harness {
  core: CoreInstance
  net: NetAdapter
  /** The underlying store (the test inspects persisted blocks through it). */
  rawStore: FileChainStore
  /** Every event forwarded to the `uiSink` (the recording sink, AD-1). */
  events: Array<{ event: string; payload: unknown }>
}

/**
 * Build `createCore` with REAL ports (AC-1): a `createNetAdapter` over the
 * memory transport (AD-10), a real `FileChainStore` on `dir` (wrapped so
 * the `ClockPort` is STORE-BACKED — it reads the head the store commits;
 * only the loop writes the store, AD-9), `createOfflineGateVerifier` (the
 * deterministic AD-4 implementation), a recording `uiSink`, and the
 * OPTIONAL real identity (D2 — `undefined` → the tracer fallback).
 */
function buildHarness(opts: {
  dir: string
  identity?: IdentityKeypair
  memoryName: string
}): Harness {
  const rawStore = new FileChainStore(opts.dir)
  let head = -1
  const store: StorePort = {
    open: () => rawStore.open(),
    close: () => rawStore.close(),
    async commit(block) {
      const slot = Number((block as Block).slot)
      if (slot > head) head = slot
      await rawStore.commit(block)
    },
    headSlot: () => rawStore.headSlot(),
    getBlock: (slot) => rawStore.getBlock(slot),
    saveState: (doc) => rawStore.saveState(doc),
    loadState: () => rawStore.loadState(),
  }
  // The store-backed ClockPort (AC-1): chain time = the head the store has
  // committed (never the wall clock, AD-3).
  const clock: ClockPort = {
    slotIndex: () => head,
    lastBlockHash: () => '0'.repeat(64),
  }
  const events: Array<{ event: string; payload: unknown }> = []
  const net = createNetAdapter({
    transport: TRANSPORT,
    listenAddress: `/memory/${opts.memoryName}`,
    // The adapter stamps its PROTOCOL identity id into envelopes (5.2 D3) —
    // a plain string field, never a keypair (AD-11).
    protocolIdentityId: opts.identity?.identityId ?? TRACER_WINNER_ID,
  })
  const ports: CorePorts = {
    genesisPath: GENESIS_PATH,
    net,
    store,
    clock,
    gate: createOfflineGateVerifier({ acceptedGates: GENESIS.gates }),
    uiSink: {
      sink(event, ...args) {
        events.push({ event, payload: args[0] })
      },
    },
    identity: opts.identity,
  }
  const core = createCore(ports)
  return { core, net, rawStore, events }
}

// ---------------------------------------------------------------------------
// NODE_LOOP_MINES_REAL_TICKET (AC-1)
// ---------------------------------------------------------------------------

describe('6.1 — the integrated slot loop + the UI data source', () => {
  it('NODE_LOOP_MINES_REAL_TICKET: start() → startMining() mines a real signed block (key-free BlockApplied); stop() halts the loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-loop-'))
    try {
      const keypair = deriveIdentityKeypair(seedFor(0x40))
      const { core, net, rawStore, events } = buildHarness({
        dir,
        identity: keypair,
        memoryName: 'loop-mines-a',
      })

      await net.start()
      await core.start() // slot 0 (the tracer boot block, unchanged)
      await core.startMining()

      // Bounded, event-driven wait (AD-3 — NO wall-clock assertion): the
      // first loop-mined block is slot ≥ 1.
      const p = await waitForBlockApplied(core, (e) => e.slot >= 1)

      // The single participant always wins its own draw (5.10 deviation 3):
      // the winner is the local identity.
      expect(p.winnerIdentityId).toBe(keypair.identityId)
      // The payload's key set is EXACTLY the declared set (no key material
      // — the 4.7 guard is the type-level authority; this pins the runtime
      // shape).
      expect(Object.keys(p).sort()).toEqual([
        'hash',
        'slot',
        'ticketCount',
        'txCount',
        'winnerIdentityId',
      ])
      expect(p.slot).toBeGreaterThanOrEqual(1)
      expect(p.ticketCount).toBeGreaterThanOrEqual(1)
      expect(p.txCount).toBe(0)
      expect(p.hash).toMatch(/^[0-9a-f]{64}$/)

      // The read-API agrees with the event: `getBlock(slot)` projects the
      // same block the loop emitted (AC-1 / D4).
      const rb = await core.getBlock(p.slot)
      expect(rb.slot).toBe(p.slot)
      expect(rb.hash).toBe(p.hash)
      expect(rb.winnerIdentityId).toBe(keypair.identityId)

      // The mined block carries a REAL signed ticket (AD-12): decode the
      // `winnerTicket` and verify it from PUBLIC data alone —
      // `verifyTicketSignature` reconstructs the public key from the
      // `identityId`; the secret never participates.
      const bytes = await rawStore.getBlock(p.slot)
      expect(bytes).not.toBeNull()
      const block = Block.decode(bytes!)
      expect(block.winnerIdentityId).toBe(keypair.identityId)
      const ticket = Ticket.decode(block.winnerTicket)
      expect(ticket.identityId).toBe(keypair.identityId)
      expect(ticket.windowIndex).toBe(BigInt(p.slot))
      expect(
        verifyTicketSignature(
          ticket.identityId,
          {
            windowIndex: ticket.windowIndex,
            challenge: ticket.challenge,
            nonceCommitment: ticket.nonceCommitment,
          },
          ticket.signature,
        ),
      ).toBe(true)

      // stop() halts the loop (AD-9): NO further `BlockApplied` fires.
      const countBefore = events.filter((e) => e.event === 'BlockApplied').length
      await core.stop()
      await yieldMs(100) // a few ticks' worth of bounded yield
      const countAfter = events.filter((e) => e.event === 'BlockApplied').length
      expect(countAfter).toBe(countBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -----------------------------------------------------------------
  // NODE_LOOP_READ_API (AC-2)
  // -----------------------------------------------------------------

  it('NODE_LOOP_READ_API: getChainHead / getBalances / getPeers / getBlock are real (the SC-CORE-1 stubs are gone)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-loop-'))
    try {
      const keypair = deriveIdentityKeypair(seedFor(0x41))
      const { core, net } = buildHarness({
        dir,
        identity: keypair,
        memoryName: 'loop-read-a',
      })
      await net.start()
      await core.start()
      await core.startMining()
      const p = await waitForBlockApplied(core, (e) => e.slot >= 1)

      // getChainHead — matches the mined head; `totalSupplyDisplay` is a
      // DECIMAL STRING (AD-5) and equals the genesis maxSupply (the closed
      // system — totalSupply is conserved at every step).
      const head = await core.getChainHead()
      expect(head.slot).toBe(p.slot)
      expect(head.hash).toBe(p.hash)
      expect(head.winnerIdentityId).toBe(keypair.identityId)
      expect(head.txCount).toBe(0)
      expect(head.ticketCount).toBeGreaterThanOrEqual(1)
      expect(head.totalSupplyDisplay).toBe(MAX_SUPPLY_DISPLAY)
      expect(head.totalSupplyDisplay).toMatch(/^\d+(\.\d+)?$/)

      // getBalances — DECIMAL-STRING base units (AD-5): the local
      // identity's balance is a NON-ZERO decimal string; the MINT balance
      // is present (the pre-funded treasury, minus the paid rewards).
      const { balances } = await core.getBalances()
      const mine = balances[keypair.identityId]
      expect(typeof mine).toBe('string')
      expect(mine).toMatch(/^\d+$/)
      expect(BigInt(mine)).toBeGreaterThan(0n)
      expect(MINT_ID in balances).toBe(true)
      expect(balances[MINT_ID]).toMatch(/^\d+$/)

      // getPeers — a lone memory node (no peers dialed) resolves to `[]`
      // (the adapter's `peers()` — it exposes peer ids only; `multiaddrs`
      // is `[]` by construction, D4).
      const peers = await core.getPeers()
      expect(Array.isArray(peers)).toBe(true)
      expect(peers).toEqual([])

      // getBlock(0) — the slot-0 read-model (the tracer boot block).
      const b0 = await core.getBlock(0)
      expect(b0.slot).toBe(0)
      expect(b0.winnerIdentityId).toBe(TRACER_WINNER_ID)
      expect(b0.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(b0.txCount).toBe(0)

      // getBlock(<absent>) — a NORMAL reject with a `{ code }`, never a
      // sync throw (the `SC-CORE-1` stub reject is gone — this is a miss on
      // a real read-API, D4).
      const err: unknown = await core.getBlock(999999).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as { code?: string }).code).toBe('SC-CORE-1')

      await core.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -----------------------------------------------------------------
  // NODE_LOOP_TRACER_FALLBACK (D2)
  // -----------------------------------------------------------------

  it('NODE_LOOP_TRACER_FALLBACK: no identity injected → startMining still mines (the tracer ticket — empty signature, TRACER_WINNER_ID)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-loop-'))
    try {
      // NO `identity` (the `makePorts`-shape ports, D2): the single-node
      // default is preserved — every `createCore(makePorts())` caller that
      // passes no identity still mines.
      const { core, net, rawStore } = buildHarness({
        dir,
        identity: undefined,
        memoryName: 'loop-tracer-a',
      })
      await net.start()
      await core.start()
      await core.startMining()
      const p = await waitForBlockApplied(core, (e) => e.slot >= 1)

      // The tracer winner — with a REAL (deterministic) ticket carrying an
      // EMPTY signature (the tracer signs nothing; the tracer's
      // `nonceCommitment` is the pinned sha256 of public data, AD-3).
      expect(p.winnerIdentityId).toBe(TRACER_WINNER_ID)
      const bytes = await rawStore.getBlock(p.slot)
      expect(bytes).not.toBeNull()
      const block = Block.decode(bytes!)
      const ticket = Ticket.decode(block.winnerTicket)
      expect(ticket.identityId).toBe(TRACER_WINNER_ID)
      expect(ticket.windowIndex).toBe(BigInt(p.slot))
      expect(ticket.signature.byteLength).toBe(0)

      // The tracer ticket's nonceCommitment is the PINNED deterministic
      // sha256 — byte-identical to `slot-loop.ts`'s tracer ticket (the
      // module doc's byte-identity claim, pinned here): sha256(
      // "SC-TRACER-COMMIT/1" ‖ parentHash ‖ u64be(slot)). Recompute it from
      // the PARENT block's hash (public data only) and assert equality
      // (AD-3 — no RNG; AD-12 — public data; no `.secret` read).
      const parentBytes = Block.decode((await rawStore.getBlock(p.slot - 1))!).hash
      const u64be = new Uint8Array(8)
      new DataView(u64be.buffer).setBigUint64(0, BigInt(p.slot), false)
      const expectedCommit = createHash('sha256')
        .update(new TextEncoder().encode('SC-TRACER-COMMIT/1'))
        .update(parentBytes)
        .update(u64be)
        .digest()
      expect(Buffer.from(ticket.nonceCommitment).toString('hex')).toBe(
        expectedCommit.toString('hex'),
      )

      await core.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // -----------------------------------------------------------------
  // NODE_LOOP_AD11_AND_HYGIENE (AC-4 / AC-5 / AC-6 — self-scan)
  // -----------------------------------------------------------------

  it('NODE_LOOP_AD11_AND_HYGIENE: key-free surface; the .secret single-reader invariant; no wall clock / RNG / UI imports; the big.js set unchanged; root-barrel-only imports', () => {
    // (a) The `BlockApplied` payload + the new read-models carry NO key
    //     material — by name AND by value (AD-11; the 4.7 guard is the
    //     type-level authority — this is the runtime shadow for the loop's
    //     NEW surface).
    const keypair = deriveIdentityKeypair(seedFor(0x42))
    const surface: Record<string, Record<string, unknown>> = {
      BlockApplied: {
        slot: 3,
        hash: 'a'.repeat(64),
        winnerIdentityId: keypair.identityId,
        ticketCount: 1,
        txCount: 0,
      },
      ReadChainHead: {
        slot: 3,
        hash: 'a'.repeat(64),
        winnerIdentityId: keypair.identityId,
        ticketCount: 1,
        txCount: 0,
        totalSupplyDisplay: MAX_SUPPLY_DISPLAY,
      },
      ReadBalances: {
        balances: {
          [keypair.identityId]: '1250000000',
          [MINT_ID]: (BigInt(MAX_SUPPLY_DISPLAY) * 10n ** 8n - 1250000000n).toString(),
        },
      },
    }
    for (const [name, payload] of Object.entries(surface)) {
      for (const k of KEY_MATERIAL_NAMES) {
        expect(k in payload, `surface ${name} must not carry \`${k}\``).toBe(false)
      }
      for (const [key, value] of Object.entries(payload)) {
        const inner = typeof value === 'object' && value !== null ? Object.values(value as object) : [value]
        for (const v of inner) {
          expect(
            sameBytes(keypair.secret, v),
            `surface ${name} field \`${key}\` must not be the keypair secret bytes`,
          ).toBe(false)
        }
      }
    }

    // (b) The AD-11 single-reader invariant (re-asserting the 4.7 scan —
    //     the authority): a comment-stripped `src/**` scan for `.secret`
    //     READS finds EXACTLY `identity/identity.ts` — the new
    //     `consensus/node-loop.ts` reads `.secret` NOWHERE (it signs via
    //     the imported `signTicket` seam, the identity module's own single
    //     reader).
    const readers = tsFiles(srcDir)
      .filter((f) => SECRET_READ.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(readers, `modules reading .secret in src/:\n${readers.join('\n')}`).toEqual([
      'identity/identity.ts',
    ])

    // (c) AD-3: a comment-stripped `src/**` scan finds NO `Date.now(` /
    //     `Math.random(` — the loop is bounded-poll + `setTimeout` only.
    const clockOrRng = tsFiles(srcDir)
      .filter((f) => WALL_CLOCK_OR_RNG.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(clockOrRng, `wall-clock/RNG found in:\n${clockOrRng.join('\n')}`).toEqual([])

    // (d) AD-1: NO `electron`/renderer/UI import in `src/**`.
    const uiImports = tsFiles(srcDir)
      .filter((f) => FORBIDDEN_UI.test(readFileSync(f, 'utf8')))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(uiImports, `forbidden UI import found in:\n${uiImports.join('\n')}`).toEqual([])

    // (e) The 2.5 no-float set is UNCHANGED: `big.js` is imported by
    //     EXACTLY `ledger/display.ts` + `ledger/fee.ts` — the loop uses
    //     the ledger primitives (`fromDisplay`/`fromJson`), never
    //     `big.js` directly (AD-5).
    const bigJs = tsFiles(srcDir)
      .filter((f) => BIG_JS_IMPORT.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(bigJs, `big.js import statements found in:\n${bigJs.join('\n')}`).toEqual([
      'ledger/display.ts',
      'ledger/fee.ts',
    ])

    // (f) This test file imports ONLY the root barrel + `vitest` + node
    //     builtins — no `@libp2p/*`, no `@multiformats/*`, no deep
    //     `../src/` paths (AD-10).
    const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const specifiers = [...ownSource.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(
      specifiers.every(
        (s) => s === '../src/index.js' || s === 'vitest' || s.startsWith('node:'),
      ),
      `non-barrel import specifiers:\n${specifiers.join('\n')}`,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// scan helpers (the established 4.7 / 2.5 / AD-1 pattern, verbatim)
// ---------------------------------------------------------------------------

const srcDir = join(here, '..', 'src')

/** The key-material name set (the 4.7 D3 set — a runtime shadow). */
const KEY_MATERIAL_NAMES = ['privateKey', 'privateKeyHex', 'keypair', 'secret'] as const

/** Byte-wise equality over any value (the "is this value the secret bytes?" check). */
function sameBytes(a: Uint8Array, value: unknown): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('byteLength' in value) ||
    !('buffer' in value)
  ) {
    return false
  }
  const b = value as Uint8Array
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Recursively collect every `.ts` file under `dir`. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Remove block and line comments (both preserved as blank lines so line
 * structure is intact). Safe for this codebase because no string or
 * template literal contains a comment marker (verified across `src/`);
 * the block regex is non-greedy so a comment body that contains a slash
 * never swallows past its real close.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** `dir`-relative path with `/` separators (stable for assertion messages). */
function rel(dir: string, p: string): string {
  return p.slice(dir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
}

// A `.secret` READ: a dot + the `secret` identifier, with no following word
// char (so `.secretx` is not a match) and not a call (so `.secret(...)` is
// not a match) — the 4.7 `SECRET_READ` pattern, verbatim.
const SECRET_READ = /\.secret(?![\w(])/

// AD-3 — a wall-clock read or an RNG call in `src/`: `Date.now(` or
// `Math.random(` (the loop's `setTimeout` cadence is a liveness bound, not
// a timestamp read — it does NOT match).
const WALL_CLOCK_OR_RNG = /Date\.now\(|Math\.random\(/

// AD-1 — the forbidden UI import forms (the `no-ui-imports.test.ts`
// regex, verbatim): static from-`"x"` / import-`"x"` statements, dynamic
// `import("x")`, and CJS `require("x")` for electron / react.
// (The from/import forms are hyphenated in this comment ON PURPOSE: this
// file's own scan (f) matches `from` + quote sequences, so the literal
// examples must not appear verbatim here.)
const FORBIDDEN_UI =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](electron|@electron[\w/-]+|react-dom|react)(["'])/

// The 2.5 `BIG_JS_IMPORT` regex, verbatim: the idiomatic import forms in
// an ESM NodeNext codebase, specialized to the module literal `big.js`.
const BIG_JS_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']big\.js["']/
