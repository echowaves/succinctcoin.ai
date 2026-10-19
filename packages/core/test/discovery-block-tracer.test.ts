/**
 * 8.3 (TRACER) — announcements anchored in blocks + gossiped end to end
 * (epic-bootstrap-free-discovery, CAP-7; AD-3/AD-10/AD-12).
 *
 * The slice this file pins, bottom-up:
 *   APPLY rows    — `applyBlock` validates block field 8 ALL-OR-NOTHING at
 *                   `block.slot` (chain time, AD-3): any invalid blob or an
 *                   over-budget count rejects the WHOLE block with
 *                   `AnnouncementBlockError` (`SC-ANNOUNCE-1`) and NOTHING
 *                   is committed; the post-commit emission hands 8.4 the
 *                   validated records + the originating block key, and a
 *                   throwing listener never unwinds the commit.
 *   LOOP rows     — the integrated slot loop announces itself every window,
 *                   validates gossiped records at the current slot, relays
 *                   each valid record EXACTLY ONCE per (identityId,
 *                   slotStart), and anchors the candidates in blocks. Two
 *                   sequential loop lifetimes over ONE shared store + one
 *                   fake mesh prove both peers' announcements reach
 *                   committed blocks and every blob in every committed
 *                   block validates at that block's own slot.
 *   ADAPTER row   — `AnnouncementEnvelope` round-trips the real adapter
 *                   surface (memory transport, zero sockets, AD-10): decode
 *                   lands on the announcements class with the payload +
 *                   source identity intact.
 *
 * Determinism (AD-3): pinned seeds (`seedFor(i)` = 32 bytes of `0x40 + i`,
 * the 4.8 convention) → `deriveIdentityKeypair`; every slot is chain time;
 * loop waits are BOUNDED polls (iterations), never wall-clock asserts. The
 * fake mesh net is a test double of the adapter extensions (`received` +
 * `sendAnnouncement`) — the ADAPTER row covers the real transport leg.
 */
import { describe, expect, it } from 'vitest'

import {
  AnnouncementBlockError,
  Block,
  MAX_BLOCK_ANNOUNCEMENTS,
  MINT_ID,
  PeerAnnouncement,
  AnnouncementEnvelope,
  Ticket,
  applyBlock,
  createNetAdapter,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  fromDisplay,
  signPeerAnnouncement,
  signedTicket,
  syncChain,
  validatePeerAnnouncement,
} from '../src/index.js'
// The loop seam is package-internal (the root barrel deliberately does not
// export it — core-surface pins that); the tracer drives it directly, via
// the consensus sub-barrel (established test-import precedent).
import { createNodeLoop } from '../src/consensus/index.js'
import type {
  BalanceMap,
  Block as BlockMsg,
  IdentityKeypair,
  NetAdapter,
  PeerAnnouncement as PeerAnnouncementMsg,
  ReceivedEnvelope,
  StorePort,
  SyncBlock,
  SyncClient,
  TopicClass,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// pinned fixtures (deterministic — AD-3)
// ---------------------------------------------------------------------------

const TEST_CHAIN = 'succinctcoin-test'
const ADDR_A = '/ip6/2001:db8:a00:1::/tcp/9001'
const ADDR_B = '/ip6/2001:db8:a00:2::/tcp/9002'
const REWARD_BASE_UNITS = fromDisplay('12.5')

function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}
const KEY_A: IdentityKeypair = deriveIdentityKeypair(seedFor(0))
const KEY_B: IdentityKeypair = deriveIdentityKeypair(seedFor(1))
const KEY_C: IdentityKeypair = deriveIdentityKeypair(seedFor(2))

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** A wire-native signed announcement + its canonical blob (encode→decode
 *  round-tripped, exactly what the gossip path delivers). */
function makeAnnouncement(
  keypair: IdentityKeypair,
  slotStart: bigint,
  slotEnd: bigint,
  opts: { addrs?: string[]; chainId?: string; corruptSig?: boolean } = {},
): { record: PeerAnnouncementMsg; blob: Uint8Array<ArrayBuffer> } {
  const addrs = opts.addrs ?? [ADDR_A]
  const chainId = opts.chainId ?? TEST_CHAIN
  const signature = signPeerAnnouncement(keypair, {
    identityId: keypair.identityId, // the signer overrides it — same value
    multiaddrs: addrs,
    slotStart,
    slotEnd,
    chainId,
  })
  if (opts.corruptSig === true) signature[0] ^= 0x01
  const record = PeerAnnouncement.decode(
    PeerAnnouncement.encode({
      identityId: keypair.identityId,
      multiaddrs: [...addrs],
      slotStart,
      slotEnd,
      chainId,
      signature,
    }),
  ) as PeerAnnouncementMsg
  return { record, blob: PeerAnnouncement.encode(record) }
}

function treasuryBalances(): BalanceMap {
  return new Map<string, bigint>([[MINT_ID, fromDisplay('21000000')]])
}

/** A minimal block carrying `announcements` (applyBlock checks no PoW). */
function blockWithAnnouncements(slot: bigint, announcements: Uint8Array<ArrayBuffer>[]): BlockMsg {
  return {
    slot,
    parentHash: new Uint8Array(32),
    winnerIdentityId: KEY_A.identityId,
    winnerTicket: new Uint8Array(0),
    nonce: new Uint8Array(8),
    hash: new Uint8Array(32).fill(0xab),
    txCount: 0n,
    announcements,
  }
}

// ---------------------------------------------------------------------------
// in-memory StorePort fake (AD-10 — no sockets, no disk)
// ---------------------------------------------------------------------------

function makeStore(): StorePort & { blocks: Map<number, BlockMsg>; commits: number } {
  const blocks = new Map<number, BlockMsg>()
  let state: Record<string, string> | null = null
  let commits = 0
  return {
    blocks,
    get commits() {
      return commits
    },
    async open() {},
    async close() {},
    async commit(block: unknown) {
      const b = block as BlockMsg
      blocks.set(Number(b.slot), b)
      commits += 1
    },
    async headSlot() {
      let head = -1
      for (const slot of blocks.keys()) head = Math.max(head, slot)
      return head
    },
    async getBlock(slot: number) {
      const b = blocks.get(slot)
      return b === undefined ? null : Block.encode(b)
    },
    async saveState(doc: Record<string, string>) {
      state = doc
    },
    async loadState() {
      return state
    },
  }
}

// ---------------------------------------------------------------------------
// fake mesh net (the loop's adapter-extension surface: received + announce)
// ---------------------------------------------------------------------------

function makeMeshNet() {
  const received = new Map<TopicClass, ReceivedEnvelope[]>([
    ['blocks', []],
    ['tickets', []],
    ['tx', []],
    ['peers', []],
    ['announcements', []],
  ])
  const net = {
    received,
    announcementSends: [] as string[],
    peer: null as { received: Map<TopicClass, ReceivedEnvelope[]>; announcementSends: string[] } | null,
    async start() {},
    async stop() {},
    async sendBlock(_block: unknown) {},
    async sendTicket(_ticket: unknown) {},
    async sendTx(_tx: unknown) {},
    async peers() {
      return [] as string[]
    },
    async sendAnnouncement(announcement: PeerAnnouncementMsg) {
      net.announcementSends.push(`${announcement.identityId}:${announcement.slotStart}`)
      // mesh delivery: to the peer's inbox only (gossipsub never echoes).
      const inbox = net.peer?.received.get('announcements')
      if (inbox !== undefined) {
        inbox.push({ sourcePeerId: announcement.identityId, payload: announcement })
      }
    },
  }
  return net
}

/** Bounded poll (iterations, not wall-clock asserts — AD-3 discipline). */
async function waitFor(cond: () => boolean, maxPolls = 400): Promise<boolean> {
  for (let i = 0; i < maxPolls; i += 1) {
    if (cond()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return cond()
}

// ---------------------------------------------------------------------------
// APPLY rows — all-or-nothing block validation + post-commit emission
// ---------------------------------------------------------------------------

describe('8.3 applyBlock — announcements anchored in blocks (SC-ANNOUNCE-1)', () => {
  const discovery = { expectedChainId: TEST_CHAIN }

  it('APPLY_VALID: valid blobs commit; the emission carries records + block key', async () => {
    const store = makeStore()
    const a = makeAnnouncement(KEY_A, 0n, 32n)
    const b = makeAnnouncement(KEY_B, 0n, 32n, { addrs: [ADDR_B] })
    const block = blockWithAnnouncements(5n, [a.blob, b.blob])
    const emitted: { ids: string[]; blockHashHex: string; slot: bigint }[] = []

    await applyBlock({
      store,
      block,
      balances: treasuryBalances(),
      rewardBaseUnits: REWARD_BASE_UNITS,
      mintId: MINT_ID,
      discovery: {
        ...discovery,
        onAnnouncements: (records, ctx) => {
          emitted.push({ ids: records.map((r) => r.identityId), ...ctx })
        },
      },
    })

    expect(store.commits).toBe(1)
    expect(emitted).toHaveLength(1)
    expect([...emitted[0].ids].sort()).toEqual([KEY_A.identityId, KEY_B.identityId].sort())
    expect(emitted[0].blockHashHex).toBe(hex(block.hash))
    expect(emitted[0].slot).toBe(5n)
  })

  it('APPLY_FORGED: one corrupt signature rejects the WHOLE block; nothing commits', async () => {
    const store = makeStore()
    const good = makeAnnouncement(KEY_A, 0n, 32n)
    const forged = makeAnnouncement(KEY_B, 0n, 32n, { addrs: [ADDR_B], corruptSig: true })
    await expect(
      applyBlock({
        store,
        block: blockWithAnnouncements(5n, [good.blob, forged.blob]),
        balances: treasuryBalances(),
        rewardBaseUnits: REWARD_BASE_UNITS,
        mintId: MINT_ID,
        discovery,
      }),
    ).rejects.toThrow(/SC-ANNOUNCE-1/)
    expect(store.commits).toBe(0)
  })

  it('APPLY_EXPIRED: freshness is judged at block.slot — a stale window rejects', async () => {
    const store = makeStore()
    const stale = makeAnnouncement(KEY_A, 0n, 4n) // expired long before slot 5
    const err = await applyBlock({
      store,
      block: blockWithAnnouncements(5n, [stale.blob]),
      balances: treasuryBalances(),
      rewardBaseUnits: REWARD_BASE_UNITS,
      mintId: MINT_ID,
      discovery,
    }).then(
      () => null,
      (e: unknown) => e as AnnouncementBlockError,
    )
    expect(err).toBeInstanceOf(AnnouncementBlockError)
    expect(err?.code).toBe('SC-ANNOUNCE-1')
    expect(err?.message).toContain('expired')
    expect(store.commits).toBe(0)
  })

  it('APPLY_CHAIN_MISMATCH: a record from another chain rejects the block', async () => {
    const store = makeStore()
    const foreign = makeAnnouncement(KEY_A, 0n, 32n, { chainId: 'other-chain' })
    await expect(
      applyBlock({
        store,
        block: blockWithAnnouncements(5n, [foreign.blob]),
        balances: treasuryBalances(),
        rewardBaseUnits: REWARD_BASE_UNITS,
        mintId: MINT_ID,
        discovery,
      }),
    ).rejects.toBeInstanceOf(AnnouncementBlockError)
    expect(store.commits).toBe(0)
  })

  it('APPLY_OVER_BUDGET: more than MAX_BLOCK_ANNOUNCEMENTS blobs rejects (count first)', async () => {
    const store = makeStore()
    const junk = new Uint8Array([0xff]) // never decoded — the count gate fires first
    const blobs = Array.from({ length: MAX_BLOCK_ANNOUNCEMENTS + 1 }, () => junk)
    await expect(
      applyBlock({
        store,
        block: blockWithAnnouncements(5n, blobs),
        balances: treasuryBalances(),
        rewardBaseUnits: REWARD_BASE_UNITS,
        mintId: MINT_ID,
        discovery,
      }),
    ).rejects.toThrow(/budget/)
    expect(store.commits).toBe(0)
  })

  it('APPLY_NO_CONTEXT: announcements without a discovery scope reject', async () => {
    const store = makeStore()
    const a = makeAnnouncement(KEY_A, 0n, 32n)
    await expect(
      applyBlock({
        store,
        block: blockWithAnnouncements(5n, [a.blob]),
        balances: treasuryBalances(),
        rewardBaseUnits: REWARD_BASE_UNITS,
        mintId: MINT_ID,
      }),
    ).rejects.toThrow(/SC-ANNOUNCE-1/)
    expect(store.commits).toBe(0)
  })

  it('APPLY_UNDECODABLE + EMPTY_TAIL: junk blob rejects; empty announcements need no context', async () => {
    const store = makeStore()
    await expect(
      applyBlock({
        store,
        block: blockWithAnnouncements(5n, [new Uint8Array([0xff, 0xff, 0xff])]),
        balances: treasuryBalances(),
        rewardBaseUnits: REWARD_BASE_UNITS,
        mintId: MINT_ID,
        discovery,
      }),
    ).rejects.toThrow(/not a decodable PeerAnnouncement/)

    // the pre-8.3 path is untouched: no announcements, no context — applies.
    const clean = makeStore()
    await applyBlock({
      store: clean,
      block: blockWithAnnouncements(5n, []),
      balances: treasuryBalances(),
      rewardBaseUnits: REWARD_BASE_UNITS,
      mintId: MINT_ID,
    })
    expect(clean.commits).toBe(1)
  })

  it('APPLY_EMIT_THROW: a throwing listener never unwinds the committed block', async () => {
    const store = makeStore()
    const a = makeAnnouncement(KEY_A, 0n, 32n)
    await applyBlock({
      store,
      block: blockWithAnnouncements(5n, [a.blob]),
      balances: treasuryBalances(),
      rewardBaseUnits: REWARD_BASE_UNITS,
      mintId: MINT_ID,
      discovery: {
        expectedChainId: TEST_CHAIN,
        onAnnouncements: () => {
          throw new Error('listener bug')
        },
      },
    })
    expect(store.commits).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// LOOP rows — announce / validate / relay-once / anchor (two lifetimes, one store)
// ---------------------------------------------------------------------------

describe('8.3 node loop — announcements gossiped + anchored end to end', () => {
  it('LOOP_TWO_NODE_TRACER: both identities reach committed blocks; every blob validates at its block slot', async () => {
    const store = makeStore()
    const netA = makeMeshNet()
    const netB = makeMeshNet()
    netA.peer = netB
    netB.peer = netA

    const emissions: { ids: string[]; blockHashHex: string; slot: bigint }[] = []
    const loopOpts = (identity: IdentityKeypair, addrs: string[], net: ReturnType<typeof makeMeshNet>) => ({
      store,
      net,
      identity,
      rewardBaseUnits: REWARD_BASE_UNITS,
      maxSupplyDisplay: '21000000',
      mintId: MINT_ID,
      lookbackL: 50n,
      emitBlockApplied: () => {},
      tickMs: 5,
      chainId: TEST_CHAIN,
      announceAddresses: () => addrs,
      onAnnouncements: (records: { identityId: string }[], ctx: { blockHashHex: string; slot: bigint }) => {
        emissions.push({ ids: records.map((r) => r.identityId), ...ctx })
      },
    })

    // lifetime A — two windows, announcing only itself.
    const loopA = createNodeLoop(loopOpts(KEY_A, [ADDR_A], netA))
    expect(await waitFor(() => store.blocks.size >= 2)).toBe(true)
    loopA.stop()

    // lifetime B — two more windows; A's still-fresh announcements arrive via
    // the mesh inbox (relayed once), B anchors its own alongside.
    const loopB = createNodeLoop(loopOpts(KEY_B, [ADDR_B], netB))
    expect(await waitFor(() => store.blocks.size >= 4)).toBe(true)
    loopB.stop()

    // every committed block: all blobs validate AT THAT BLOCK'S SLOT.
    const announced = new Set<string>()
    let sawBoth = false
    for (const [slotNumber, block] of store.blocks) {
      const slot = BigInt(slotNumber)
      for (const blob of block.announcements) {
        const record = PeerAnnouncement.decode(blob)
        const verdict = validatePeerAnnouncement(record, { currentSlot: slot, expectedChainId: TEST_CHAIN })
        expect(verdict.ok).toBe(true)
        announced.add(record.identityId)
      }
      const ids = new Set(block.announcements.map((b) => PeerAnnouncement.decode(b).identityId))
      if (ids.size === 2) sawBoth = true
    }
    expect(sawBoth).toBe(true) // at least one block anchors BOTH identities
    expect(announced).toEqual(new Set([KEY_A.identityId, KEY_B.identityId]))

    // the emission is the 8.4 handoff: records + originating block key.
    expect(emissions.length).toBeGreaterThan(0)
    for (const e of emissions) {
      const committed = store.blocks.get(Number(e.slot))
      expect(committed).toBeDefined()
      expect(e.blockHashHex).toBe(hex(committed?.hash ?? new Uint8Array()))
    }

    // relay exactly once per (identityId, slotStart): the set B relayed is
    // EXACTLY the distinct A-keys B's inbox held — every key once, no key
    // twice, even though the inbox was re-processed every window.
    const relayedA = netB.announcementSends.filter((k) => k.startsWith(`${KEY_A.identityId}:`))
    const inboxAKeys = new Set(
      (netB.received.get('announcements') ?? [])
        .map((env) => env.payload as PeerAnnouncementMsg)
        .filter((rec) => rec.identityId === KEY_A.identityId)
        .map((rec) => `${rec.identityId}:${rec.slotStart}`),
    )
    expect(relayedA.length).toBe(inboxAKeys.size)
    expect(new Set(relayedA)).toEqual(inboxAKeys)
  }, 30_000)

  it('LOOP_RELAY_NEVER_FORGED: a forged gossiped record never relays and never anchors', async () => {
    const store = makeStore()
    const net = makeMeshNet()
    // pre-seed the loop's inbox with a forgery of C that is fresh at the
    // loop's slots (0..32) — ONLY the signature gate can stop it, so this
    // row fails loudly if the relay-gate validation were weakened.
    const forged = makeAnnouncement(KEY_C, 0n, 32n, {
      addrs: ['/ip6/2001:db8:a09:909::/tcp/9009'],
      corruptSig: true,
    })
    net.received.get('announcements')?.push({ sourcePeerId: KEY_C.identityId, payload: forged.record })

    const loop = createNodeLoop({
      store,
      net,
      identity: KEY_A,
      rewardBaseUnits: REWARD_BASE_UNITS,
      maxSupplyDisplay: '21000000',
      mintId: MINT_ID,
      lookbackL: 50n,
      emitBlockApplied: () => {},
      tickMs: 5,
      chainId: TEST_CHAIN,
      announceAddresses: () => [ADDR_A],
    })
    expect(await waitFor(() => store.blocks.size >= 3)).toBe(true)
    loop.stop()

    // the forgery is never relayed (C's key appears in no send)…
    expect(net.announcementSends.filter((k) => k.startsWith(`${KEY_C.identityId}:`))).toEqual([])
    // …and never anchored: C appears in no committed block, while A (the
    // loop's own identity) does — the pipeline itself is alive.
    let sawA = false
    for (const block of store.blocks.values()) {
      const ids = block.announcements.map((b) => PeerAnnouncement.decode(b).identityId)
      expect(ids).not.toContain(KEY_C.identityId)
      if (ids.includes(KEY_A.identityId)) sawA = true
    }
    expect(sawA).toBe(true)
  }, 30_000)

  it('LOOP_NO_CHAINID: without a chainId the loop is byte-for-byte pre-8.3 (no announcements, no sends)', async () => {
    const store = makeStore()
    const net = makeMeshNet()
    const loop = createNodeLoop({
      store,
      net,
      identity: KEY_A,
      rewardBaseUnits: REWARD_BASE_UNITS,
      maxSupplyDisplay: '21000000',
      mintId: MINT_ID,
      lookbackL: 50n,
      emitBlockApplied: () => {},
      tickMs: 5,
      announceAddresses: () => [ADDR_A],
    })
    expect(await waitFor(() => store.blocks.size >= 2)).toBe(true)
    loop.stop()
    expect(net.announcementSends).toEqual([])
    for (const block of store.blocks.values()) expect(block.announcements).toEqual([])
  }, 30_000)
})

// ---------------------------------------------------------------------------
// SYNC rows — catch-up applies announcement-bearing blocks (review finding 1)
// ---------------------------------------------------------------------------

describe('8.3 syncChain — catch-up through announcement-bearing blocks', () => {
  /** One draw-passing, announcement-bearing window frame (A alone wins). */
  function syncFrame(slot: bigint): SyncBlock {
    const parentHash = new Uint8Array(32).fill(Number(slot) + 1)
    const challenge = deriveWindowChallenge(parentHash, slot)
    const ticket = signedTicket(KEY_A, slot, parentHash, challenge)
    const { blob } = makeAnnouncement(KEY_B, 0n, 32n, { addrs: [ADDR_B] })
    const block: BlockMsg = {
      slot,
      parentHash,
      winnerIdentityId: KEY_A.identityId,
      winnerTicket: Ticket.encode(ticket),
      nonce: new Uint8Array(8),
      hash: new Uint8Array(32).fill(Number(slot) + 2),
      txCount: 0n,
      announcements: [blob],
    }
    return { block, acceptedTickets: [ticket], weights: [0n] }
  }

  function syncClient(frames: SyncBlock[]): SyncClient {
    return {
      syncFrom: () => ({
        async *[Symbol.asyncIterator]() {
          for (const frame of frames) yield frame
        },
      }),
    }
  }

  it('SYNC_ANNOUNCED_CATCHUP: with the chain scope, announcement-bearing blocks sync + emit', async () => {
    const store = makeStore()
    const emitted: string[][] = []
    const result = await syncChain({
      client: syncClient([syncFrame(0n), syncFrame(1n)]),
      peer: '/memory/sync-peer',
      store,
      rewardDisplay: '12.5',
      maxSupplyDisplay: '21000000',
      discovery: {
        expectedChainId: TEST_CHAIN,
        onAnnouncements: (records, ctx) => {
          expect(ctx.slot).toBe(BigInt(store.blocks.size - 1))
          emitted.push(records.map((r) => r.identityId))
        },
      },
    })
    expect(result.applied).toBe(2)
    expect(emitted).toEqual([[KEY_B.identityId], [KEY_B.identityId]])
    for (const block of store.blocks.values()) expect(block.announcements).toHaveLength(1)
  })

  it('SYNC_NO_SCOPE: without a discovery context an announcement-bearing block rejects SC-ANNOUNCE-1 (nothing half-applied)', async () => {
    const store = makeStore()
    await expect(
      syncChain({
        client: syncClient([syncFrame(0n), syncFrame(1n)]),
        peer: '/memory/sync-peer',
        store,
        rewardDisplay: '12.5',
        maxSupplyDisplay: '21000000',
      }),
    ).rejects.toThrow(/SC-ANNOUNCE-1/)
    expect(store.commits).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ADAPTER row — the real gossipsub envelope leg (memory transport, AD-10)
// ---------------------------------------------------------------------------

describe('8.3 adapter — AnnouncementEnvelope round-trips on its own class topic', () => {
  it('ENVELOPE_ROUNDTRIP: sendAnnouncement lands decoded on the peer, source identity intact', async () => {
    const a: NetAdapter = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/ann-a',
      protocolIdentityId: KEY_A.identityId,
    })
    const b: NetAdapter = createNetAdapter({
      transport: 'memory',
      listenAddress: '/memory/ann-b',
      protocolIdentityId: KEY_B.identityId,
    })
    await a.start()
    await b.start()
    try {
      await b.dial('/memory/ann-a')
      const { record } = makeAnnouncement(KEY_A, 0n, 32n)

      // first-publish subscribe race: bounded retry (the 5.2 pattern).
      for (let i = 0; ; i += 1) {
        try {
          await a.sendAnnouncement(record)
          break
        } catch (err) {
          if (i >= 400) throw err
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }

      const landed = await waitFor(() => (b.received.get('announcements')?.length ?? 0) >= 1)
      expect(landed).toBe(true)
      const env = b.received.get('announcements')?.[0]
      expect(env?.sourcePeerId).toBe(KEY_A.identityId)
      const payload = env?.payload as PeerAnnouncementMsg
      expect(payload.identityId).toBe(KEY_A.identityId)
      expect(payload.chainId).toBe(TEST_CHAIN)
      expect(PeerAnnouncement.encode(payload)).toEqual(PeerAnnouncement.encode(record))

      // the envelope is its own proto message (AD-12): payload + source wire.
      const wire = AnnouncementEnvelope.encode({ announcement: record, sourcePeerId: KEY_A.identityId })
      expect(AnnouncementEnvelope.decode(wire).announcement?.identityId).toBe(KEY_A.identityId)
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 30_000)
})
