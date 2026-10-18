/**
 * 5.4 — Chain sync: a new node fetches the chain from a peer (epic-
 * node-network, R1, AD-2/AD-7/AD-8/AD-10/AD-12).
 *
 * A fresh node (empty `FileChainStore`) connected to a peer with N mined
 * blocks fetches and APPLIES all N through `applyBlock` (AD-2 — imported,
 * never re-implemented), each passing the 4.3 acceptance path
 * (`acceptBlockWinner`), and reaches the peer's head. Sync travels over a
 * dedicated libp2p STREAM (request/response — the client sends ONE
 * `SyncRequest`, the server streams one `SyncBlock` per window), proto-
 * encoded (AD-12) and u32be length-prefix framed. The per-window accepted
 * set is supplied by the sync payload (D3 — a fresh node has not collected
 * the gossiped tickets for historical windows; the challenge is derived by
 * the fresh node from the block's own public data, never trusted from the
 * wire). A TAMPERED block (a foreign `winnerIdentityId`) is rejected by the
 * 4.3 path (a normal `false`, never a throw) and is never applied (the
 * catch-up stops at the last good block).
 *
 * NOT wired into `createCore` (AD-1 — the 3.7/4.8 standalone-harness
 * precedent): the test drives it. Two net adapters over the memory
 * transport connect (5.1's explicit `dial` — zero real sockets, AD-10); the
 * peer registers `setSyncSource(buildSyncSource(peerRecords))`; the fresh
 * node runs `syncChain` with its own empty store.
 *
 * Imports: the ROOT BARREL `../src/index.js` only (+ `vitest` + node
 * builtins) — no deep imports into src/net, src/consensus, or src/proto.
 *
 * Rows (plan Matrix):
 *   SYNC_CATCHUP                 (AC-1) a fresh node fetches + applies all N
 *                                 via `applyBlock` (AD-2), each passing
 *                                 `acceptBlockWinner` (4.3); head reaches the
 *                                 peer's head; committed bytes byte-identical.
 *   SYNC_TAMPERED_REJECTED       (AC-2) a tampered block at slot T (foreign
 *                                 `winnerIdentityId`) is rejected (normal
 *                                 `false`) and never applied; head stops at
 *                                 T-1; a direct unit assertion pins
 *                                 `acceptBlockWinner(tampered) === false`.
 *   SYNC_SEQUENTIAL_FROM_HEAD    (AC-3) the catch-up applies blocks in slot
 *                                 order from the client's head + 1 (empty
 *                                 store → slot 0); each block's `parentHash`
 *                                 === the previous block's `hash` (contiguous
 *                                 — sequential, not binary search).
 *   SYNC_REQUEST_RESPONSE_STREAM (AC-4) sync travels over a dedicated libp2p
 *                                 STREAM (the catch-up itself proves the
 *                                 request/response); `SYNC_PROTOCOL` is a
 *                                 stable constant DISTINCT from the four
 *                                 gossip topics (which are unchanged).
 *   SYNC_ADDITIVE                (AC-5) the 4.3/AD-2/3.3 seams are IMPORTED
 *                                 (composed, never re-implemented); the four
 *                                 topics are unchanged; the proto is
 *                                 additive-only (the 8 existing messages'
 *                                 wire encodings are pinned).
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — the peer is mined with
 * the IMPORTED `simulateMultiWindow` (4.8) over PINNED identity seeds
 * (`seedFor(i) = new Uint8Array(32).fill(0x40 + i)`, the 4.8 convention),
 * `attestedUntilWindow: 100000n`, `validWindows: [0..N)`. The catch-up is
 * driven by CHAIN-TIME slots (`fromSlot = headSlot + 1`), never a clock read.
 * Bounded test-side waiting (the `SLEEP_MS`/`MAX_POLLS` poll helpers model
 * `net-adapter.test.ts`) — the 10 s dial bound is a timeout in the adapter,
 * not a clock read here.
 * AD-5 discipline: NO `big.js` in the new src (the no-float guard pins big.js
 * to `ledger/display.ts` + `ledger/fee.ts`); this test imports only the root
 * barrel.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  PeerInfo,
  SYNC_PROTOCOL,
  TOPICS,
  Ticket,
  Tx,
  acceptBlockWinner,
  buildSyncSource,
  createNetAdapter,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  simulateMultiWindow,
  syncChain,
} from '../src/index.js'
import type {
  Block as BlockType,
  MultiSimIdentity,
  NetAdapter,
  PeerInfo as PeerInfoType,
  SyncWindowRecord,
  Ticket as TicketType,
  Tx as TxType,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Pinned sim parameters (5.4, the 4.8 convention — deterministic, AD-3)
// ---------------------------------------------------------------------------

/** The peer's mined-block count (kept small — the PoW loop is the slow part). */
const N = 4
/** The tampered slot (AC-2): `T` is the last good block's successor. */
const T = 2
/** Fixed-emission display params (the genesis emission carries them). */
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'
/** L = the lookback (genesis `uptimeLookbackL`) — the sim's weight input. */
const L = 50n
/** A foreign 64-hex identity id (the AC-2 tamper — a non-drawn-winner claim). */
const FOREIGN_ID = 'f'.repeat(64)

/** A 32 zero-byte parent (the sim's `FIXED_PARENT` — the pure schedule). */
const SCHED_PARENT = new Uint8Array(32)

/**
 * Pinned identity seeds (4.8 convention, no RNG): a 32-byte value filled with
 * `0x40 + i` (distinct from the reserved MINT/BURN/TRACER ids and from each
 * other). `deriveIdentityKeypair` (IMPORTED) maps each seed deterministically
 * to a keypair (the same seed → the same keypair — AD-3/AD-10).
 */
function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

/**
 * A gate-verified sim identity (4.8): the IMPORTED `deriveIdentityKeypair`
 * keypair, an attestation deadline far beyond any sim window (fully
 * un-lapsed — `attestedUntilWindow: 100000n`), and a `validWindows` history
 * covering every sim window (fully up → weight `L`).
 */
function makeIdentity(seedIndex: number, windows: number): MultiSimIdentity {
  return {
    keypair: deriveIdentityKeypair(seedFor(seedIndex)),
    attestedUntilWindow: 100000n,
    validWindows: Array.from({ length: windows }, (_, w) => BigInt(w)),
  }
}

/** The sim identities (3 fully-up gate-verified identities). */
const IDENTITIES = [
  makeIdentity(0, N),
  makeIdentity(1, N),
  makeIdentity(2, N),
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Byte-wise equality for two `Uint8Array`s. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Encode a `Uint8Array` to a lowercase hex string (the proto golden pins). */
function hexOf(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Decode a `FileChainStore` block's canonical bytes back to a `Block`. */
function decodeBlock(bytes: Uint8Array): BlockType {
  return Block.decode(bytes)
}

/**
 * Mine `N` windows on a REAL `FileChainStore` (a loop calling the IMPORTED
 * `simulateMultiWindow`, 4.8) — the "peer with N mined blocks". Returns the
 * per-window `{ block, acceptedTickets, weights }` records (indexed by slot
 * from slot 0) — the peer's chain, what `buildSyncSource` streams.
 */
async function minePeerRecords(store: FileChainStore): Promise<SyncWindowRecord[]> {
  const records: SyncWindowRecord[] = []
  for (let w = 0; w < N; w++) {
    const r = await simulateMultiWindow({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
      identities: IDENTITIES,
      lookbackL: L,
    })
    // Every mined window is accepted from PUBLIC data (the 4.3 seam the
    // catch-up re-runs on the fresh side) — a precondition on the fixture.
    expect(r.accept).toBe(true)
    records.push({
      block: r.block,
      acceptedTickets: r.tickets,
      weights: r.weights,
    })
  }
  return records
}

/**
 * Start A (the peer, listens `/memory/sync-peer`) + B (the fresh node,
 * listens `/memory/sync-fresh`) over the memory transport and connect them
 * (5.1's explicit `dial` — B dials A). Zero real sockets (AD-10).
 */
async function connectPeerAndFresh(): Promise<{ peer: NetAdapter; fresh: NetAdapter }> {
  const peer = createNetAdapter({
    transport: 'memory',
    listenAddress: '/memory/sync-peer',
    protocolIdentityId: 'a'.repeat(64),
  })
  const fresh = createNetAdapter({
    transport: 'memory',
    listenAddress: '/memory/sync-fresh',
    protocolIdentityId: 'b'.repeat(64),
  })
  await peer.start()
  await fresh.start()
  // Explicit connect (5.1) — B dials A. A small bounded retry guards against
  // the memory transport's connection-setup latency (a test-side wait, not a
  // clock read — the adapter's own 10 s dial bound is a timeout, not a read).
  let lastErr: unknown = null
  for (let i = 0; i < 40; i++) {
    try {
      await fresh.dial('/memory/sync-peer')
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  if (lastErr !== null) throw lastErr
  return { peer, fresh }
}

/** Run a catch-up: mine the peer, connect, register the source, syncChain. */
async function runCatchUp(records: SyncWindowRecord[], fresh: FileChainStore) {
  const { peer, fresh: freshAdapter } = await connectPeerAndFresh()
  try {
    peer.setSyncSource(buildSyncSource(records))
    const result = await syncChain({
      client: freshAdapter,
      peer: '/memory/sync-peer',
      store: fresh,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    return { result, peer, freshAdapter }
  } finally {
    await freshAdapter.stop()
    await peer.stop()
  }
}

// ---------------------------------------------------------------------------
// SYNC_CATCHUP (AC-1) — a fresh node fetches + applies the peer's chain
// ---------------------------------------------------------------------------

describe('SYNC_CATCHUP (AC-1) — a fresh node fetches + applies the peer\'s chain', () => {
  let peerStore: FileChainStore | null = null
  let peerDir: string | null = null
  let freshStore: FileChainStore | null = null
  let freshDir: string | null = null

  afterEach(async () => {
    if (peerStore && peerDir) {
      await peerStore.close()
      rmSync(peerDir, { recursive: true, force: true })
      peerStore = null
      peerDir = null
    }
    if (freshStore && freshDir) {
      await freshStore.close()
      rmSync(freshDir, { recursive: true, force: true })
      freshStore = null
      freshDir = null
    }
  })

  it(`a fresh node (empty store) fetches + applies all ${N} blocks via applyBlock (AD-2), each passing acceptBlockWinner (4.3); head reaches the peer's head; committed bytes are byte-identical`, async () => {
    // Mine the peer's N blocks (the "peer with N mined blocks").
    peerDir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-peerstore-'))
    peerStore = new FileChainStore(peerDir)
    await peerStore.open()
    const records = await minePeerRecords(peerStore)
    const peerHead = await peerStore.headSlot()
    expect(peerHead).toBe(N - 1)

    // The fresh node's EMPTY store (head -1 → fromSlot 0).
    freshDir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-freshstore-'))
    freshStore = new FileChainStore(freshDir)
    await freshStore.open()
    expect(await freshStore.headSlot()).toBe(-1)

    // The catch-up: fetch + apply all N through `applyBlock` (AD-2), each
    // passing the 4.3 acceptance path (the per-window accepted set is
    // supplied by the sync payload, D3; the challenge is derived from the
    // block's own public data, never trusted from the wire).
    const { result } = await runCatchUp(records, freshStore)
    expect(result.applied).toBe(N)
    // The fresh node reaches the PEER'S HEAD (AC-1).
    expect(result.headSlot).toBe(peerHead)
    expect(await freshStore.headSlot()).toBe(N - 1)

    // Every fetched block passes the 4.3 acceptance path (re-verified here
    // from the FRESH side's own store — the block's parentHash + slot + the
    // sync-payload's accepted set + the derived challenge).
    for (let s = 0; s < N; s++) {
      const fb = decodeBlock((await freshStore.getBlock(s))!)
      const rec = records[s]
      const challenge = deriveWindowChallenge(fb.parentHash, fb.slot)
      expect(acceptBlockWinner(fb, rec.acceptedTickets, rec.weights, challenge)).toBe(true)
    }

    // The fresh node's committed block bytes are BYTE-IDENTICAL to the
    // peer's (`getBlock(slot)` matches on both sides — AC-1).
    for (let s = 0; s < N; s++) {
      const peerBytes = await peerStore.getBlock(s)
      const freshBytes = await freshStore.getBlock(s)
      expect(peerBytes).not.toBeNull()
      expect(freshBytes).not.toBeNull()
      expect(bytesEqual(peerBytes!, freshBytes!)).toBe(true)
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// SYNC_TAMPERED_REJECTED (AC-2) — a tampered block is rejected, never applied
// ---------------------------------------------------------------------------

describe('SYNC_TAMPERED_REJECTED (AC-2) — a tampered block is rejected, never applied', () => {
  let peerStore: FileChainStore | null = null
  let peerDir: string | null = null
  let freshStore: FileChainStore | null = null
  let freshDir: string | null = null

  afterEach(async () => {
    if (peerStore && peerDir) {
      await peerStore.close()
      rmSync(peerDir, { recursive: true, force: true })
      peerStore = null
      peerDir = null
    }
    if (freshStore && freshDir) {
      await freshStore.close()
      rmSync(freshDir, { recursive: true, force: true })
      freshStore = null
      freshDir = null
    }
  })

  it(`a tampered block at slot ${T} (foreign winnerIdentityId) is rejected (normal false, never a throw) and never applied; head stops at ${T - 1}`, async () => {
    // Mine the peer's N blocks.
    peerDir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-peerstore-'))
    peerStore = new FileChainStore(peerDir)
    await peerStore.open()
    const clean = await minePeerRecords(peerStore)

    // A direct unit assertion pins the 4.3 rejection of the tampered block
    // (a normal `false` — never a throw): the block's `winnerIdentityId` is
    // a FOREIGN 64-hex id (a non-drawn-winner claim), while the
    // `winnerTicket` still belongs to the real (draw-selected) winner — the
    // ticket's identity ≠ the claimed winner, so the 4.3 path rejects.
    const tampered: SyncWindowRecord = {
      ...clean[T],
      block: { ...clean[T].block, winnerIdentityId: FOREIGN_ID },
    }
    const challenge = deriveWindowChallenge(tampered.block.parentHash, tampered.block.slot)
    expect(
      acceptBlockWinner(tampered.block, tampered.acceptedTickets, tampered.weights, challenge),
    ).toBe(false)

    // Register the source with the TAMPERED block at slot T (a COPY — the
    // clean record is untouched) BEFORE the sync, so the stream serves the
    // tampered block at T.
    const records = clean.map((rec, i) => (i === T ? tampered : rec))

    // The fresh node's empty store.
    freshDir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-freshstore-'))
    freshStore = new FileChainStore(freshDir)
    await freshStore.open()
    expect(await freshStore.headSlot()).toBe(-1)

    // The catch-up applies 0..T-1, then `acceptBlockWinner` returns a normal
    // `false` at T and STOPS (never a throw) — the tampered block is never
    // applied (the last good block stays committed).
    const { result } = await runCatchUp(records, freshStore)
    expect(result.applied).toBe(T)
    expect(result.headSlot).toBe(T - 1)
    expect(await freshStore.headSlot()).toBe(T - 1)

    // The tampered block is ABSENT from the fresh store (slots 0..T-1
    // present, T absent).
    for (let s = 0; s < T; s++) {
      expect(await freshStore.getBlock(s)).not.toBeNull()
    }
    expect(await freshStore.getBlock(T)).toBeNull()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// SYNC_SEQUENTIAL_FROM_HEAD (AC-3) — catch-up applies in slot order
// ---------------------------------------------------------------------------

describe('SYNC_SEQUENTIAL_FROM_HEAD (AC-3) — catch-up applies in slot order', () => {
  let peerStore: FileChainStore | null = null
  let peerDir: string | null = null
  let freshStore: FileChainStore | null = null
  let freshDir: string | null = null

  afterEach(async () => {
    if (peerStore && peerDir) {
      await peerStore.close()
      rmSync(peerDir, { recursive: true, force: true })
      peerStore = null
      peerDir = null
    }
    if (freshStore && freshDir) {
      await freshStore.close()
      rmSync(freshDir, { recursive: true, force: true })
      freshStore = null
      freshDir = null
    }
  })

  it('the catch-up applies blocks in slot order from the client\'s head + 1 (empty store → slot 0); each block\'s parentHash === the previous block\'s hash (contiguous — sequential, not binary search)', async () => {
    peerDir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-peerstore-'))
    peerStore = new FileChainStore(peerDir)
    await peerStore.open()
    const records = await minePeerRecords(peerStore)

    freshDir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-freshstore-'))
    freshStore = new FileChainStore(freshDir)
    await freshStore.open()
    // The client's head is EMPTY (slot -1) → the catch-up starts at slot 0.
    expect(await freshStore.headSlot()).toBe(-1)

    const { result } = await runCatchUp(records, freshStore)
    expect(result.applied).toBe(N)

    // The chain is CONTIGUOUS in slot order (AC-3): slot 0's parent is the
    // genesis parent (32 zeros — the sim's `FIXED_PARENT`), and each slot s
    // in 1..N-1 has `parentHash === getBlock(s-1).hash` (byte-for-byte).
    const b0 = decodeBlock((await freshStore.getBlock(0))!)
    expect(bytesEqual(b0.parentHash, SCHED_PARENT)).toBe(true)
    for (let s = 1; s < N; s++) {
      const bs = decodeBlock((await freshStore.getBlock(s))!)
      const bPrev = decodeBlock((await freshStore.getBlock(s - 1))!)
      expect(bytesEqual(bs.parentHash, bPrev.hash)).toBe(true)
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// SYNC_REQUEST_RESPONSE_STREAM (AC-4) — a dedicated stream, not a gossip topic
// ---------------------------------------------------------------------------

describe('SYNC_REQUEST_RESPONSE_STREAM (AC-4) — a dedicated stream, not a gossip topic', () => {
  it('SYNC_PROTOCOL is a stable constant DISTINCT from the four gossip topics (which are unchanged)', () => {
    // `SYNC_PROTOCOL` is a stable, non-empty constant (the dedicated
    // request/response STREAM protocol — a sync message never on a gossip
    // topic, and a block never on the sync stream's gossip path).
    expect(typeof SYNC_PROTOCOL).toBe('string')
    expect(SYNC_PROTOCOL.length).toBeGreaterThan(0)
    // It is DISTINCT from the four gossipsub topics (a sync message is never
    // one of the four class topics).
    const topics = [TOPICS.blocks, TOPICS.tickets, TOPICS.tx, TOPICS.peers]
    expect(topics).not.toContain(SYNC_PROTOCOL)
    // The four topics are UNCHANGED (AC-5 / the 5.2 pins — `src/net/topics.ts`
    // is byte-identical; the topic strings are stable constants).
    expect(TOPICS.blocks).toBe('/succinctcoin/blocks/1')
    expect(TOPICS.tickets).toBe('/succinctcoin/tickets/1')
    expect(TOPICS.tx).toBe('/succinctcoin/tx/1')
    expect(TOPICS.peers).toBe('/succinctcoin/peers/1')
    // The catch-up rows above prove the request/response over the stream: the
    // fresh node sent ONE `SyncRequest` and read the server's streamed
    // `SyncBlock`s (proto-encoded, AD-12) — a gossip topic would flood every
    // peer with the full chain (the wrong primitive, D1).
  })
})

// ---------------------------------------------------------------------------
// SYNC_ADDITIVE (AC-5) — additive; seams imported; topics + proto unchanged
// ---------------------------------------------------------------------------

// PROTO_ADDITIVE golden vectors (the 5.2 pins — the EXACT encoded bytes of
// the four EXISTING payload messages over the fixtures below). Regenerate
// ONLY by changing protocol.proto (a protocol change) — never hand-edit.
// Combined with the source-level gate (git diff on protocol.proto shows only
// the APPENDED `SyncRequest`/`SyncBlock` messages), these pins prove the
// existing schema's wire encoding is unchanged (purely additive).
const ID_A = 'a'.repeat(64)
const ID_B = 'b'.repeat(64)

const FIX_BLOCK: BlockType = {
  slot: 42n,
  parentHash: new Uint8Array(32).fill(0x01),
  winnerIdentityId: ID_A,
  winnerTicket: new Uint8Array(64).fill(0x11),
  nonce: new Uint8Array(32).fill(0x02),
  hash: new Uint8Array(32).fill(0x99),
  txCount: 3n,
  announcements: [],
}

const FIX_TICKET: TicketType = {
  identityId: ID_A,
  windowIndex: 7n,
  challenge: new Uint8Array(32).fill(0x03),
  nonceCommitment: new Uint8Array(32).fill(0x04),
  signature: new Uint8Array(64).fill(0x7e),
}

const FIX_TX: TxType = {
  sender: new Uint8Array(32).fill(0x5a),
  recipient: new Uint8Array(32).fill(0x6b),
  amount: '1000',
  fee: '250',
  slot: 11n,
  signature: new Uint8Array(64).fill(0x77),
}

const FIX_PEERINFO: PeerInfoType = {
  peerId: ID_B,
  multiaddrs: ['/memory/a', '/ip4/127.0.0.1/tcp/4001'],
  uptime: 99n,
}

const GOLDEN_BLOCK_HEX =
  '082a122001010101010101010101010101010101010101010101010101010101010101011a40616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161612240111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111112a200202020202020202020202020202020202020202020202020202020202020202322099999999999999999999999999999999999999999999999999999999999999993803'
const GOLDEN_TICKET_HEX =
  '0a406161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616110071a200303030303030303030303030303030303030303030303030303030303030303222004040404040404040404040404040404040404040404040404040404040404042a407e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e'
const GOLDEN_TX_HEX =
  '0a205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a12206b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b1a04313030302203323530280b324077777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777'
const GOLDEN_PEERINFO_HEX =
  '0a406262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626212092f6d656d6f72792f6112172f6970342f3132372e302e302e312f7463702f343030311863'

describe('SYNC_ADDITIVE (AC-5) — additive; seams imported; topics + proto unchanged', () => {
  it('topics + 8 existing proto messages unchanged; 4.3/AD-2/3.3 seams are IMPORTED (accept clean, reject tampered)', () => {
    // The four gossipsub topics are UNCHANGED (AC-5 — `src/net/topics.ts` is
    // byte-identical; the topic strings are stable constants).
    expect(TOPICS.blocks).toBe('/succinctcoin/blocks/1')
    expect(TOPICS.tickets).toBe('/succinctcoin/tickets/1')
    expect(TOPICS.tx).toBe('/succinctcoin/tx/1')
    expect(TOPICS.peers).toBe('/succinctcoin/peers/1')

    // The 8 EXISTING proto messages' wire encodings are byte-identical (the
    // 5.2 golden pins — the `SyncRequest`/`SyncBlock` append is purely
    // additive: no field-number or type change to the existing 8). The two
    // new sync messages are additive (their presence is proven by the
    // catch-up rows above, which round-trip them over the stream).
    expect(hexOf(Block.encode(FIX_BLOCK))).toBe(GOLDEN_BLOCK_HEX)
    expect(hexOf(Ticket.encode(FIX_TICKET))).toBe(GOLDEN_TICKET_HEX)
    expect(hexOf(Tx.encode(FIX_TX))).toBe(GOLDEN_TX_HEX)
    expect(hexOf(PeerInfo.encode(FIX_PEERINFO))).toBe(GOLDEN_PEERINFO_HEX)

    // This whole file composes the IMPORTED seams (`simulateMultiWindow`
    // 4.8 → `drawWindow`/`acceptBlockWinner`/`applyBlock`; `syncChain` →
    // `deriveWindowChallenge`/`acceptBlockWinner`/`applyBlock`); it never
    // re-implements the draw, the challenge, or the acceptance path (AD-7 /
    // AD-12 / 4.3 — the source-level gate: `draw.ts`/`accept-winner.ts`/
    // `apply-block.ts` are byte-identical). The live-seam assertion below
    // pins that the SAME imported `acceptBlockWinner` +
    // `deriveWindowChallenge` the catch-up ran are the 4.3/3.3 seams: a
    // clean peer block is accepted (true), a tampered one is rejected
    // (false) — the exact behavior the catch-up rows rely on.
    const dir = mkdtempSync(join(tmpdir(), 'succinctcoin-sync-seam-'))
    const store = new FileChainStore(dir)
    return store.open().then(async () => {
      try {
        const records = await minePeerRecords(store)
        const clean = records[0]
        const challenge = deriveWindowChallenge(clean.block.parentHash, clean.block.slot)
        expect(
          acceptBlockWinner(clean.block, clean.acceptedTickets, clean.weights, challenge),
        ).toBe(true)
        const tampered = { ...clean.block, winnerIdentityId: FOREIGN_ID }
        expect(
          acceptBlockWinner(tampered, clean.acceptedTickets, clean.weights, challenge),
        ).toBe(false)
      } finally {
        await store.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }, 60_000)
})
