/**
 * CONSENSUS VERIFY-DRAW — the draw-verification seam + launch-gate matrix
 * (3.4, R2: verifiable election).
 *
 *   VERIFY_ACCEPT_SELECTED   a block mined via the rewired `mineAndApply`
 *                            (sole ticket) + its ticket set → `verifyDraw`
 *                            returns true (winner verified).
 *   VERIFY_REJECT_UNSELECTED  (LAUNCH GATE) a PoW-valid block whose
 *                            `winnerIdentityId` is an identity NOT selected
 *                            by the draw over the accepted 2-ticket set →
 *                            `verifyDraw` returns false (no error — a
 *                            reject is the normal outcome); the SAME block
 *                            claiming the ACTUAL draw winner (with that
 *                            winner's ticket in the set) returns true.
 *   VERIFY_REJECT_BAD_TICKET  a `winnerTicket` that does not decode to a
 *                            proto `Ticket` (garbage / truncated bytes) →
 *                            `DrawError` `SC-CONSENSUS-2` (the seam's only
 *                            throw path); a decodable ticket whose
 *                            `identityId` ≠ `winnerIdentityId` → false
 *                            (no error).
 *   CHALLENGE_MATCHES_SLOT   the challenge `mineAndApply` mines under is
 *                            `deriveWindowChallenge(parentHash, slot)` —
 *                            recomputed from the mined block's OWN
 *                            `parentHash` + `slot`, and the block verifies
 *                            against exactly it (a wrong slot's challenge
 *                            verifies false).
 *   LATE_TICKET_NO_INVALIDATE  a block already verified against set S still
 *                            verifies against S after a late ticket is
 *                            admitted to a LARGER set — verification is a
 *                            pure function of the set passed (AD-7
 *                            accepted-set boundary rule).
 *   REJECT_NONWINNER_IN_MULTISET  a 2-ticket set where the block's
 *                            `winnerIdentityId` is the NON-draw-winner
 *                            (though PoW-valid) → `verifyDraw` returns
 *                            false.
 *   MINE_AND_APPLY_DRAW   `mineAndApply` on an empty store, then the block
 *                            is verified against the node's ticket set →
 *                            `winnerIdentityId` = the draw winner and
 *                            `verifyDraw` returns true; a multi-ticket
 *                            draw (`otherTickets`) mines for the draw
 *                            winner's ticket.
 *
 * AD-7 discipline: `drawWindow` is imported from the BARREL only — the
 * `c^uptime` formula is NEVER re-implemented in this file. Test hygiene
 * (AD-10): fresh `os.tmpdir()` dir per test (the real `FileChainStore`,
 * mirroring the tracer/store tests' setup/teardown), no real sockets, no
 * new runtime deps.
 */
import { createHash } from 'node:crypto'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Block,
  DrawError,
  TRACER_WINNER_ID,
  Ticket,
  deriveWindowChallenge,
  drawWindow,
  mineAndApply,
  mineBlock,
  powCheck,
  verifyDraw,
} from '../src/index.js'
import { FileChainStore } from '../src/index.js'
import type { Block as BlockType, DrawTicket } from '../src/index.js'

// ---- helpers -------------------------------------------------------------

let dir: string

/** Fresh temp data dir per test; removed after each (store-test pattern). */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-verifydraw-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** An open `FileChainStore` on the per-test temp dir. */
function openStore(): FileChainStore {
  return new FileChainStore(dir)
}

/** Fixed-emission display params (the tracer's own inputs). */
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'

/** A 32-byte-hex id (exactly 64 hex chars, spine convention) from a byte pattern. */
const idOf = (hi: number, lo: number): string =>
  '0'.repeat(60) + hi.toString(16).padStart(2, '0') + lo.toString(16).padStart(2, '0')

/** Two accepted-set identities (distinct from MINT_ID/TRACER_WINNER_ID). */
const ID_X = idOf(0x01, 0x10)
const ID_Y = idOf(0x02, 0x20)

/** A sha256 commitment from a fixed label (the deterministic "nonce"). */
const commit = (label: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(label, 'utf8').digest()) as Uint8Array<ArrayBuffer>

const COMMIT_X = commit('verifydraw:ticket:X')
const COMMIT_Y = commit('verifydraw:ticket:Y')
const COMMIT_LATE = commit('verifydraw:ticket:LATE')

/**
 * The tracer's OWN deterministic nonceCommitment (slot-loop.ts's
 * `tracerTicket`): `sha256("SC-TRACER-COMMIT/1" ‖ parentHash ‖ u64be(slot))`.
 * This is the tracer's commitment scheme, NOT the draw formula — the draw
 * (`drawWindow`) is still imported and never re-implemented here.
 */
function tracerCommitment(
  slot: bigint,
  parentHash: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const domain = new TextEncoder().encode('SC-TRACER-COMMIT/1')
  const noncePart = new Uint8Array(8)
  new DataView(noncePart.buffer).setBigUint64(0, slot, false) // u64be
  return new Uint8Array(
    createHash('sha256')
      .update(domain)
      .update(parentHash)
      .update(noncePart)
      .digest(),
  ) as Uint8Array<ArrayBuffer>
}

const TICKET_X: DrawTicket = { identityId: ID_X, nonceCommitment: COMMIT_X }
const TICKET_Y: DrawTicket = { identityId: ID_Y, nonceCommitment: COMMIT_Y }

/** A fixed 32-byte challenge (the golden-vector style fixed digest). */
const CHALLENGE: Uint8Array<ArrayBuffer> = Uint8Array.from(
  createHash('sha256').update('verifydraw:fixed:challenge', 'utf8').digest(),
) as Uint8Array<ArrayBuffer>

/**
 * Build a PROTO `Ticket` for an identity (the block's `winnerTicket` wire
 * form, AD-12) — `signature` empty (this epic-3 harness predates 4.2's
 * signature; 4.3/4.8 verify a real one). The `challenge`
 * defaults to the fixed test challenge.
 */
function protoTicket(
  identityId: string,
  commitment: Uint8Array<ArrayBuffer>,
  slot: bigint,
  challenge: Uint8Array<ArrayBuffer> = CHALLENGE,
) {
  return {
    identityId,
    windowIndex: slot,
    challenge,
    nonceCommitment: commitment,
    signature: new Uint8Array(0),
  }
}

/**
 * Mine a PoW-valid block for a claimed winner + its encoded proto ticket
 * (the forged-block builder: PoW passes — the draw is what fails).
 */
function mineClaimedBlock(
  slot: bigint,
  parentHash: Uint8Array<ArrayBuffer>,
  claimedId: string,
  ticket: ReturnType<typeof protoTicket>,
): BlockType {
  return mineBlock({
    slot,
    parentHash,
    winnerIdentityId: claimedId,
    winnerTicket: Ticket.encode(ticket),
    txCount: 0n,
  })
}

const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && Array.from(a).every((v, i) => v === b[i])

/** Run the rewired tracer on a fresh store and return the mined block. */
async function mineTracerBlock(): Promise<{ block: BlockType; store: FileChainStore }> {
  const store = openStore()
  await store.open()
  const { block } = await mineAndApply({
    store,
    rewardDisplay: REWARD_DISPLAY,
    maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
  })
  return { block, store }
}

// ---- matrix --------------------------------------------------------------

describe('VERIFY_ACCEPT_SELECTED — a sole-ticket traced block verifies (R2)', () => {
  it('mineAndApply (sole ticket) → the block carries the node’s encoded Ticket and verifyDraw is true', async () => {
    const { block, store } = await mineTracerBlock()

    // The single-node draw: the sole ticket wins its own draw, so the
    // block STILL mines for TRACER_WINNER_ID (3.2 invariance) — but now
    // carries a NON-EMPTY encoded proto Ticket.
    expect(block.winnerIdentityId).toBe(TRACER_WINNER_ID)
    expect(block.winnerTicket.byteLength).toBeGreaterThan(0)
    expect(powCheck(block)).toBe(true)

    // The winnerTicket decodes to the node's ticket (the identity agrees).
    const nodeTicket = Ticket.decode(block.winnerTicket)
    expect(nodeTicket.identityId).toBe(TRACER_WINNER_ID)

    // The challenge the verifier recomputes from the block's own
    // parentHash + slot.
    const challenge = deriveWindowChallenge(block.parentHash, block.slot)

    // Verified against the node's ticket set (the sole ticket, weight 1n).
    expect(
      verifyDraw(block, [{ identityId: nodeTicket.identityId, nonceCommitment: nodeTicket.nonceCommitment }], [1n], challenge),
    ).toBe(true)
    await store.close()
  })
})

describe('VERIFY_REJECT_UNSELECTED — the launch gate: an unselected node cannot pass (R2)', () => {
  it('a PoW-valid block claiming the NON-draw-winner identity over the 2-ticket set → false; the actual winner → true', () => {
    // The accepted set + the ONE pinned draw pick the winner (AD-7,
    // imported — never re-implemented).
    const tickets: DrawTicket[] = [TICKET_X, TICKET_Y]
    const weights = [1n, 1n]
    const draw = drawWindow(tickets, CHALLENGE, weights)
    const winner = draw.winnerIdentityId
    const loser = winner === ID_X ? ID_Y : ID_X
    const loserCommit = winner === ID_X ? COMMIT_Y : COMMIT_X
    expect(winner).not.toEqual(loser)

    // Forged block: PoW-valid, claims the UNSELECTED identity, carries a
    // valid-looking ticket for that identity — PoW is NOT what fails.
    const forged = mineClaimedBlock(0n, new Uint8Array(32), loser, protoTicket(loser, loserCommit, 0n))
    expect(powCheck(forged)).toBe(true)
    expect(Ticket.decode(forged.winnerTicket).identityId).toBe(loser)
    // The launch gate: verifyDraw REJECTS the unselected block (a normal
    // false — no error).
    expect(verifyDraw(forged, tickets, weights, CHALLENGE)).toBe(false)

    // The SAME construction for the ACTUAL draw winner (with the winner's
    // ticket in the set) is ACCEPTED.
    const winnerTicket = winner === ID_X ? TICKET_X : TICKET_Y
    const winnerCommit = winner === ID_X ? COMMIT_X : COMMIT_Y
    const accepted = mineClaimedBlock(0n, new Uint8Array(32), winner, protoTicket(winner, winnerCommit, 0n))
    expect(powCheck(accepted)).toBe(true)
    expect(verifyDraw(accepted, tickets, weights, CHALLENGE)).toBe(true)
  })

  it('the STRONGEST forgery: claiming the winner’s identity with a commitment NOT in the accepted set → false (the binding closes it)', () => {
    const tickets: DrawTicket[] = [TICKET_X, TICKET_Y]
    const weights = [1n, 1n]
    const draw = drawWindow(tickets, CHALLENGE, weights)
    const winner = draw.winnerIdentityId

    // Fabricated commitment (not in the set) for the WINNER's identity —
    // the identity claim is correct, but the ticket is not one the window
    // accepted, so the set-binding rejects it.
    const forgedCommit = commit('forged:commitment:winner')
    const forged = mineClaimedBlock(0n, new Uint8Array(32), winner, protoTicket(winner, forgedCommit, 0n))
    expect(powCheck(forged)).toBe(true)
    expect(Ticket.decode(forged.winnerTicket).identityId).toBe(winner)
    expect(verifyDraw(forged, tickets, weights, CHALLENGE)).toBe(false)

    // An EMPTY commitment (lenient decode → empty bytes) is also not the
    // window's ticket → false.
    const emptyCommit = mineClaimedBlock(0n, new Uint8Array(32), winner, protoTicket(winner, new Uint8Array(0), 0n))
    expect(verifyDraw(emptyCommit, tickets, weights, CHALLENGE)).toBe(false)

    // A TRUNCATED ticket that retains the winner's identityId (field 1)
    // but drops the commitment (lenient decode → empty commitment) →
    // not the window's ticket → false. (length prefix derived from the id.)
    const truncated = mineClaimedBlock(0n, new Uint8Array(32), winner, protoTicket(winner, winner === ID_X ? COMMIT_X : COMMIT_Y, 0n))
    truncated.winnerTicket = new Uint8Array([0x0a, winner.length, ...Buffer.from(winner, 'utf8')])
    expect(Ticket.decode(truncated.winnerTicket).identityId).toBe(winner)
    expect(verifyDraw(truncated, tickets, weights, CHALLENGE)).toBe(false)
  })
})

describe('VERIFY_REJECT_BAD_TICKET — malformed / mismatched tickets', () => {
  it.each([
    // A `bytes` field (identityId, field 1) whose length prefix
    // (4294967295) overruns the buffer — the codec's reader throws.
    ['overlong length-prefixed field', new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f])],
    // A tag with an invalid wire type (wire 7 is not a valid proto wire
    // type) — the codec's reader throws.
    ['invalid wire type byte', new Uint8Array(64).map((_, i) => i)],
  ])('winnerTicket that fails Ticket.decode (%s) → DrawError SC-CONSENSUS-2 (the only throw path)', (_, bad) => {
    const block = mineClaimedBlock(0n, new Uint8Array(32), ID_X, protoTicket(ID_X, COMMIT_X, 0n))
    block.winnerTicket = new Uint8Array(bad) // overwrite the encoded ticket

    // `verifyDraw` THROWS (synchronously) — the seam's only error path.
    let thrown: unknown
    try {
      verifyDraw(block, [TICKET_X], [1n], CHALLENGE)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(DrawError)
    expect((thrown as { code: string }).code).toBe('SC-CONSENSUS-2')
  })

  it('a decodable ticket whose identityId ≠ the block’s winnerIdentityId → false (no error)', () => {
    // The block CLAIMS ID_X but CARRIES ID_Y's ticket — a block cannot
    // claim a ticket it does not own.
    const block = mineClaimedBlock(0n, new Uint8Array(32), ID_X, protoTicket(ID_Y, COMMIT_Y, 0n))
    expect(Ticket.decode(block.winnerTicket).identityId).toBe(ID_Y)
    expect(verifyDraw(block, [TICKET_X, TICKET_Y], [1n, 1n], CHALLENGE)).toBe(false)
  })

  it('empty ticket bytes decode to a proto3 default ticket (identityId "") ≠ the claimed winner → false (no error)', () => {
    // protons decode is LENIENT (proto3): an empty buffer decodes to all
    // default fields rather than throwing. The decoded ticket's identityId
    // ("" ≠ the claimed id) is the reject — a normal false.
    const block = mineClaimedBlock(0n, new Uint8Array(32), ID_X, protoTicket(ID_X, COMMIT_X, 0n))
    block.winnerTicket = new Uint8Array(0)
    expect(Ticket.decode(block.winnerTicket).identityId).toBe('')
    expect(verifyDraw(block, [TICKET_X], [1n], CHALLENGE)).toBe(false)
  })
})

describe('CHALLENGE_MATCHES_SLOT — the verifier recomputes deriveWindowChallenge(parentHash, slot)', () => {
  it('the challenge mineAndApply used IS the challenge the verifier recomputes from the block’s own parentHash + slot', async () => {
    const { block, store } = await mineTracerBlock()

    // The verifier's view: recompute the challenge from the mined block's
    // OWN fields — deriveWindowChallenge(block.parentHash, block.slot).
    const challenge = deriveWindowChallenge(block.parentHash, block.slot)
    const nodeTicket = Ticket.decode(block.winnerTicket)

    // THE PIN: the challenge mineAndApply baked into the ticket is byte-
    // equal to the challenge the verifier recomputes from the block's own
    // (parentHash, slot) — a single source, no separate challenge channel.
    expect(eqBytes(challenge, nodeTicket.challenge)).toBe(true)

    // The block verifies against exactly that recomputed challenge. (A
    // single-ticket set always re-derives to its own winner, so `true`
    // here is the acceptance pin — the challenge-agreement pin above is
    // what makes the challenge load-bearing, not the single-ticket draw.)
    expect(
      verifyDraw(block, [{ identityId: nodeTicket.identityId, nonceCommitment: nodeTicket.nonceCommitment }], [1n], challenge),
    ).toBe(true)

    // And the challenge is genuinely slot-bound (a different slot, same
    // parent, is a different challenge — so the recompute cannot be a
    // no-op constant).
    expect(
      eqBytes(challenge, deriveWindowChallenge(block.parentHash, block.slot + 1n)),
    ).toBe(false)
    await store.close()
  })
})

describe('LATE_TICKET_NO_INVALIDATE — the accepted-set boundary rule (AD-7)', () => {
  it('a block verified against set S still verifies against S after a late ticket exists (pure over the passed set)', async () => {
    // Mine the block with the SOLE ticket set S = {X}.
    const { block, store } = await mineTracerBlock()
    const challenge = deriveWindowChallenge(block.parentHash, block.slot)
    const nodeTicket = Ticket.decode(block.winnerTicket)
    const setS: DrawTicket[] = [
      { identityId: nodeTicket.identityId, nonceCommitment: nodeTicket.nonceCommitment },
    ]
    // Verified against S — true.
    expect(verifyDraw(block, setS, [1n], challenge)).toBe(true)

    // A ticket arrives LATE (after the window boundary). It belongs to the
    // NEXT window's set, NOT S — the block was accepted against S, so it is
    // re-verified against S (which never gains the late ticket) → still true.
    const lateTicket: DrawTicket = { identityId: ID_Y, nonceCommitment: COMMIT_LATE }
    const setWithLate: DrawTicket[] = [...setS, lateTicket]
    // The late ticket is genuinely a different ticket (not the traced one).
    expect(lateTicket.identityId).not.toBe(nodeTicket.identityId)
    expect(setWithLate.length).toBe(2)
    // The RULE: the block, verified against its acceptance set S, stays
    // valid — the late ticket never retroactively invalidates it.
    expect(verifyDraw(block, setS, [1n], challenge)).toBe(true)
    expect(verifyDraw(block, setS, [1n], challenge)).toBe(true) // re-verify, same verdict

    // LOAD-BEARING (proves purity): the verifier's verdict is a function of
    // the set it is handed. The SAME block, verified against a set that does
    // NOT contain its own ticket (the late ticket, not the traced one), is
    // rejected by the set-binding — so the acceptance above is load-bearing
    // (S actually contains the block's ticket), not a constant `true`.
    expect(verifyDraw(block, [lateTicket], [1n], challenge)).toBe(false)
    await store.close()
  })
})

describe('REJECT_NONWINNER_IN_MULTISET — a 2-ticket set, block claims the non-winner', () => {
  it('the block’s winnerIdentityId is the NON-draw-winner (PoW-valid) → false', () => {
    const tickets: DrawTicket[] = [TICKET_X, TICKET_Y]
    const weights = [1n, 3n]
    const draw = drawWindow(tickets, CHALLENGE, weights)
    const winner = draw.winnerIdentityId
    const nonWinner = winner === ID_X ? ID_Y : ID_X
    const nonWinnerCommit = winner === ID_X ? COMMIT_Y : COMMIT_X

    // PoW-valid block claiming the NON-winner.
    const block = mineClaimedBlock(
      1n,
      new Uint8Array(32).fill(0xab),
      nonWinner,
      protoTicket(nonWinner, nonWinnerCommit, 1n),
    )
    expect(powCheck(block)).toBe(true)
    expect(Ticket.decode(block.winnerTicket).identityId).toBe(nonWinner)
    expect(nonWinner).not.toEqual(winner)
    expect(verifyDraw(block, tickets, weights, CHALLENGE)).toBe(false)
  })
})

describe('MINE_AND_APPLY_DRAW — the rewired tracer mines a verifiable block (R2)', () => {
  it('mineAndApply on a fresh store → winnerIdentityId = the draw winner and verifyDraw is true', async () => {
    const { block, store } = await mineTracerBlock()

    // The draw over the node's ticket set (recomputed from the block's own
    // fields — the verifier's view) selects TRACER_WINNER_ID.
    const challenge = deriveWindowChallenge(block.parentHash, block.slot)
    const nodeTicket = Ticket.decode(block.winnerTicket)
    const draw = drawWindow(
      [{ identityId: nodeTicket.identityId, nonceCommitment: nodeTicket.nonceCommitment }],
      challenge,
      [1n],
    )
    expect(draw.winnerIdentityId).toBe(TRACER_WINNER_ID)
    expect(block.winnerIdentityId).toBe(draw.winnerIdentityId)

    // The mined block verifies against the node's ticket set.
    expect(verifyDraw(block, [{ identityId: nodeTicket.identityId, nonceCommitment: nodeTicket.nonceCommitment }], [1n], challenge)).toBe(true)
    await store.close()
  })

  it('a multi-ticket draw (otherTickets) mines for the draw winner and carries the winner’s Ticket (window-bound)', async () => {
    const store = openStore()
    await store.open()
    // A FRESH empty store ⇒ the first block's window is deterministic
    // (slot 0, parent = 32 zero bytes — the 3.2 tracer invariant), so the
    // window challenge + the tracer's commitment are knowable BEFORE
    // mining. The other node's proto ticket must carry that window's
    // challenge for the window-binding (verifyDraw) to hold.
    const parent = new Uint8Array(32)
    const slot = 0n
    // `deriveWindowChallenge` returns a bare `Uint8Array` (ArrayBufferLike);
    // `protoTicket`/`OtherTicket.ticket` need the ArrayBuffer-backed form
    // (the TS 5.9 typed-array generic) — copy it (same bytes, the 3.2 bridge).
    const challenge: Uint8Array<ArrayBuffer> = Uint8Array.from(deriveWindowChallenge(parent, slot))
    const other = {
      ticket: protoTicket(ID_X, COMMIT_X, slot, challenge),
      weight: 50n, // high uptime — the draw is proportional to it
    }

    const { block } = await mineAndApply({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
      otherTickets: [other],
      weight: 1n,
    })

    // The block's window is exactly the precomputed one (fresh store).
    expect(block.slot).toBe(0n)
    expect(block.parentHash.every((b) => b === 0)).toBe(true)

    // The accepted set = the tracer's ticket (its deterministic
    // commitment) + the other node's ticket.
    const nodeCommitment = tracerCommitment(slot, parent)
    const nodeTicket = Ticket.decode(block.winnerTicket)
    const acceptedSet: DrawTicket[] = [
      { identityId: TRACER_WINNER_ID, nonceCommitment: nodeCommitment },
      { identityId: ID_X, nonceCommitment: COMMIT_X },
    ]
    const draw = drawWindow(acceptedSet, challenge, [1n, 50n])
    // The block mines for the DRAW winner and carries the winner's Ticket.
    expect(block.winnerIdentityId).toBe(draw.winnerIdentityId)
    expect(nodeTicket.identityId).toBe(draw.winnerIdentityId)

    // The mined block verifies against the FULL accepted set — INCLUDING
    // the window-binding (the winner ticket's challenge + windowIndex must
    // match the block's window). A ticket with the WRONG window challenge
    // (the old, pre-binding fixture) would now be rejected.
    expect(verifyDraw(block, acceptedSet, [1n, 50n], challenge)).toBe(true)
    expect(
      verifyDraw(block, acceptedSet, [1n, 50n], deriveWindowChallenge(parent, 1n)),
    ).toBe(false)
    await store.close()
  })
})
