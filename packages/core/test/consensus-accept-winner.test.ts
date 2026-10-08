/**
 * CONSENSUS ACCEPT-WINNER — the ONE cohesive block-acceptance seam (4.3,
 * E2 / AD-7 / AD-12).
 *
 * A block is accepted **only if** its winner ticket verifies the AD-7 draw
 * **AND** carries a valid AD-12 identity-bound signature — the two checks
 * COMPOSE (neither alone is sufficient). This suite drives real mined blocks
 * (a real PoW via `mineBlock`) whose `winnerTicket` is a **signed** proto
 * `Ticket` (the winner's keypair signs it with the 4.2 `signTicket`) through
 * `acceptBlockWinner`, and proves the signature check is **ADDITIVE** — it
 * composes with `verifyDraw` and closes the epic-3 residual replay (an
 * unselected node that has the winner's PUBLIC ticket fields but not the
 * winner's key is rejected, even though `verifyDraw` alone would pass).
 *
 *   ACCEPT_SIGNED_WINNER         a real mined block whose winner ticket
 *                                verifies the draw AND carries the winner's
 *                                valid AD-12 signature (in the accepted set)
 *                                → `acceptBlockWinner` → true (the full
 *                                positive path; the winner IS the
 *                                draw-selected winner).
 *   ACCEPT_CONFORMS_TO_DRAW      `protoTicketToDrawTicket` returns EXACTLY
 *                                `{ identityId, nonceCommitment }` (the two
 *                                draw-input fields — `challenge`/
 *                                `windowIndex`/`signature` are NOT draw
 *                                inputs); `drawWindow` (IMPORTED, never
 *                                re-implemented) over the conformed set
 *                                selects the same winner the block claims.
 *   ACCEPT_SIG_REJECTS_REJECT    the SAME winner block with the winner
 *                                ticket's signature replaced by EMPTY (the
 *                                unselected node cannot forge it) →
 *                                `acceptBlockWinner` → false WHILE
 *                                `verifyDraw` → true (isolates the signature
 *                                as the reject — the epic-3 residual replay
 *                                is closed in the acceptance path).
 *   ACCEPT_DRAW_GATES_OVER_SIG   a block whose winner ticket carries a VALID
 *                                signature but the draw rejects (a 4th
 *                                identity NOT in the accepted set) →
 *                                `acceptBlockWinner` → false WHILE
 *                                `verifyTicketSignature` → true (isolates
 *                                the draw as the reject — a valid signature
 *                                does NOT override the draw gate).
 *   ACCEPT_TAMPERED_SIG_REJECTED  the real signed winner block with the
 *                                winner ticket's signature (a) one byte
 *                                flipped, (b) truncated to 63 bytes, or
 *                                (c) a FOREIGN identity's `signTicket` over
 *                                the same four fields → each →
 *                                `acceptBlockWinner` false.
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — fixed identity seeds,
 * fixed weights, a fixed (non-zero) parent hash, and each identity's
 * commitment a pinned `sha256` of public data (the sim's `syntheticTicket`
 * pattern). AD-7 discipline: the draw (`drawWindow`), the conformance, the
 * AD-12 digest + signature (`signTicket` / `verifyTicketSignature`), and the
 * 3.4 launch gate (`verifyDraw`) are all IMPORTED from the ROOT barrel —
 * this file NEVER re-implements the draw, the digest, or the signature.
 *
 * Test hygiene (AD-10): no store, no sockets, no new runtime deps — the seam
 * is pure over the passed set + block, so the acceptance outcomes are fully
 * deterministic (reproducible across runs/engines).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Ticket,
  acceptBlockWinner,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  drawWindow,
  mineBlock,
  powCheck,
  protoTicketToDrawTicket,
  signTicket,
  verifyDraw,
  verifyTicketSignature,
} from '../src/index.js'
import type {
  Block as BlockType,
  IdentityKeypair,
  Ticket as ProtoTicket,
  TicketFields,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// fixed deterministic fixture (AD-3: no RNG, no wall clock)
// ---------------------------------------------------------------------------

/** The fixed window the whole matrix runs under (any fixed chain-time slot). */
const SLOT = 7n

/** Fixed uptime weights (draw inputs, AD-7 — one per identity, same order). */
const WEIGHTS: readonly bigint[] = [5n, 3n, 1n]

/**
 * A FIXED 32-byte parent hash with pinned (non-zero) bytes — deliberately NOT
 * the zero parent the draw schedule uses (just any fixed 32 bytes; it makes
 * the window challenge a specific pinned digest).
 */
const PARENT_HASH: Uint8Array<ArrayBuffer> = (() => {
  const p = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) p[i] = (i * 7 + 3) & 0xff
  return p
})()

/** Domain-separation prefix of the per-identity commitment (AD-12 style). */
const COMMIT_DOMAIN = new TextEncoder().encode('SC-ACCEPT-COMMIT/1')

/** The window challenge `deriveWindowChallenge(parentHash, slot)` (AD-12). */
const CHALLENGE: Uint8Array<ArrayBuffer> = toBuffered(
  deriveWindowChallenge(PARENT_HASH, SLOT),
)

/** Copy a `Uint8Array` into the ArrayBuffer-backed form the proto requires (TS 5.9). */
function toBuffered(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.byteLength)
  out.set(src)
  return out
}

/**
 * The per-identity commitment (the sim's `syntheticTicket` pattern):
 * `sha256("SC-ACCEPT-COMMIT/1" ‖ utf8(identityId) ‖ u64be(SLOT) ‖ PARENT_HASH)`
 * — 32 bytes, a PINNED sha256 of public data (no RNG / wall clock).
 */
function commitmentFor(identityId: string): Uint8Array<ArrayBuffer> {
  const idBytes = new TextEncoder().encode(identityId)
  const slotPart = new Uint8Array(8)
  new DataView(slotPart.buffer).setBigUint64(0, SLOT, false) // u64be, AD-12
  const digest = createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(idBytes)
    .update(slotPart)
    .update(PARENT_HASH)
    .digest()
  return toBuffered(digest)
}

/**
 * One identity's SIGNED proto `Ticket` for the fixed window: the 4.2
 * `signTicket` over the EXACT AD-12 fields (`windowIndex` / `challenge` /
 * `nonceCommitment`), bound to the identity's derived keypair.
 */
function signedTicket(kp: IdentityKeypair): ProtoTicket {
  const commitment = commitmentFor(kp.identityId)
  const fields: TicketFields = {
    windowIndex: SLOT,
    challenge: CHALLENGE,
    nonceCommitment: commitment,
  }
  return {
    identityId: kp.identityId,
    windowIndex: SLOT,
    challenge: CHALLENGE,
    nonceCommitment: commitment,
    signature: toBuffered(signTicket(kp, fields)),
  }
}

// Fixed identity seeds (4.2's derivation — the same seed always yields the
// same keypair, so the whole fixture is reproducible): a 0x00..0x1f gradient
// + two 0x42/0x99-filled for the accepted set, and a 0x55-filled 4th identity
// (the "foreign" / outsider used by the draw-gates-over-sig + foreign-sig rows).
const KP_A = deriveIdentityKeypair(Uint8Array.from({ length: 32 }, (_, i) => i))
const KP_B = deriveIdentityKeypair(new Uint8Array(32).fill(0x42))
const KP_C = deriveIdentityKeypair(new Uint8Array(32).fill(0x99))
const KP_OUT = deriveIdentityKeypair(new Uint8Array(32).fill(0x55))

// The accepted set (in identity order, aligned with WEIGHTS) + the conformed
// draw-input set + the ONE pinned draw (IMPORTED — never re-implemented, AD-7).
const ACCEPTED: ProtoTicket[] = [signedTicket(KP_A), signedTicket(KP_B), signedTicket(KP_C)]
const CONFORMED = ACCEPTED.map(protoTicketToDrawTicket)
const DRAW = drawWindow(CONFORMED, CHALLENGE, WEIGHTS)
const WINNER_ID = DRAW.winnerIdentityId
const WINNER_TICKET = ACCEPTED[DRAW.index]

// The 4th identity (the outsider / foreign key) — NOT in the accepted set.
const TICKET_OUT = signedTicket(KP_OUT)
const OUT_ID = KP_OUT.identityId

/** Mine a real PoW-valid block for a claimed winner + its encoded proto ticket. */
function mineFor(claimedId: string, ticket: ProtoTicket): BlockType {
  return mineBlock({
    slot: SLOT,
    parentHash: PARENT_HASH,
    winnerIdentityId: claimedId,
    winnerTicket: Ticket.encode(ticket),
    txCount: 0n,
  })
}

// The real signed winner block + the outsider's (validly signed) block.
const WINNER_BLOCK = mineFor(WINNER_ID, WINNER_TICKET)
const OUT_BLOCK = mineFor(OUT_ID, TICKET_OUT)

// The winner's AD-12 fields (reused to forge foreign/tampered signatures).
const WINNER_FIELDS: TicketFields = {
  windowIndex: SLOT,
  challenge: CHALLENGE,
  nonceCommitment: WINNER_TICKET.nonceCommitment,
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

describe('ACCEPT-WINNER — the cohesive acceptance seam (4.3, E2 / AD-7 / AD-12)', () => {
  it('ACCEPT_SIGNED_WINNER: a real mined block whose winner ticket verifies the draw AND carries a valid AD-12 signature → acceptBlockWinner true (the winner is the draw-selected winner)', () => {
    // It is a REAL mined block (a real PoW) and it claims the draw winner.
    expect(powCheck(WINNER_BLOCK)).toBe(true)
    expect(WINNER_BLOCK.winnerIdentityId).toBe(DRAW.winnerIdentityId)

    // The FULL positive path: the real ticket conforms to the draw, the draw
    // verifies, and the signature verifies (composed).
    expect(acceptBlockWinner(WINNER_BLOCK, ACCEPTED, WEIGHTS, CHALLENGE)).toBe(true)
  })

  it('ACCEPT_CONFORMS_TO_DRAW: protoTicketToDrawTicket is EXACTLY { identityId, nonceCommitment }, and the draw over the conformed set selects the same winner the block claims', () => {
    // The conformance maps to the TWO draw-input fields only (AD-7) — no more
    // (challenge/windowIndex/signature are owned by verification, not the draw).
    const conformed = protoTicketToDrawTicket(WINNER_TICKET)
    expect(Object.keys(conformed).sort()).toEqual(['identityId', 'nonceCommitment'])
    expect(conformed).toEqual({
      identityId: WINNER_TICKET.identityId,
      nonceCommitment: WINNER_TICKET.nonceCommitment,
    })

    // The draw (IMPORTED, never re-implemented) over the conformed set selects
    // the SAME winner the block claims — the conformance never re-derives it.
    expect(drawWindow(CONFORMED, CHALLENGE, WEIGHTS).winnerIdentityId).toBe(
      WINNER_BLOCK.winnerIdentityId,
    )
  })

  it('ACCEPT_SIG_REJECTS_REJECT: the winner block with an EMPTY signature → acceptBlockWinner false WHILE verifyDraw true (isolates the signature — the epic-3 residual replay closed in the acceptance path)', () => {
    // Same winner block, but the winner ticket's signature is EMPTY — an
    // unselected node cannot forge it (the draw gate alone would pass).
    const emptySigTicket: ProtoTicket = { ...WINNER_TICKET, signature: new Uint8Array(0) }
    const emptySigBlock = mineFor(WINNER_ID, emptySigTicket)

    // The draw gate still PASSES (valid commitment, correct window binding) —
    // isolating the signature as the sole reason for rejection.
    expect(verifyDraw(emptySigBlock, CONFORMED, WEIGHTS, CHALLENGE)).toBe(true)

    // But the ACCEPTANCE path REJECTS (the AD-12 signature gate composes in).
    expect(acceptBlockWinner(emptySigBlock, ACCEPTED, WEIGHTS, CHALLENGE)).toBe(false)
  })

  it('ACCEPT_DRAW_GATES_OVER_SIG: a VALID signature whose ticket is NOT in the accepted set → acceptBlockWinner false WHILE verifyTicketSignature true (isolates the draw — a valid signature does NOT override the draw gate)', () => {
    // The outsider's ticket is VALIDLY signed by the outsider's OWN key —
    // the signature gate passes on its own.
    const outFields: TicketFields = {
      windowIndex: SLOT,
      challenge: CHALLENGE,
      nonceCommitment: TICKET_OUT.nonceCommitment,
    }
    expect(verifyTicketSignature(OUT_ID, outFields, TICKET_OUT.signature)).toBe(true)

    // But the outsider is NOT in the accepted set → the draw gate rejects, so
    // the acceptance path rejects even though the signature is valid.
    expect(acceptBlockWinner(OUT_BLOCK, ACCEPTED, WEIGHTS, CHALLENGE)).toBe(false)
  })

  it('ACCEPT_TAMPERED_SIG_REJECTED: the real signed winner block with the signature (a) one byte flipped, (b) truncated to 63 bytes, or (c) a FOREIGN identity signTicket over the same four fields → each → acceptBlockWinner false', () => {
    // (a) one byte flipped (a valid 64-byte signature, corrupted).
    const flipped = Uint8Array.from(WINNER_TICKET.signature)
    flipped[0] ^= 0xff
    const flippedBlock = mineFor(WINNER_ID, { ...WINNER_TICKET, signature: flipped })
    expect(acceptBlockWinner(flippedBlock, ACCEPTED, WEIGHTS, CHALLENGE)).toBe(false)

    // (b) truncated to 63 bytes (a malformed Ed25519 signature).
    const truncated = toBuffered(WINNER_TICKET.signature.slice(0, 63))
    const truncatedBlock = mineFor(WINNER_ID, { ...WINNER_TICKET, signature: truncated })
    expect(acceptBlockWinner(truncatedBlock, ACCEPTED, WEIGHTS, CHALLENGE)).toBe(false)

    // (c) a FOREIGN identity's key over the SAME four AD-12 fields (a valid
    //     64-byte signature by a key that is NOT the winner's).
    const foreignSig = toBuffered(signTicket(KP_OUT, WINNER_FIELDS))
    const foreignBlock = mineFor(WINNER_ID, { ...WINNER_TICKET, signature: foreignSig })
    expect(acceptBlockWinner(foreignBlock, ACCEPTED, WEIGHTS, CHALLENGE)).toBe(false)
  })
})
