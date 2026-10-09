/**
 * `core/consensus` — draw verification (3.4, R2: the verifiable-election
 * seam + the launch gate).
 *
 * `verifyDraw(block, tickets, weights, challenge)` is the ONE place a
 * block's claimed winner is checked against the AD-7 draw:
 *
 *   1. decode `block.winnerTicket` with the protons `Ticket` codec (AD-12
 *      wire form) — a corrupt/malformed ticket is a malformed BLOCK, and
 *      this is the seam's ONLY throw path (`DrawError` `SC-CONSENSUS-2`);
 *   2. require `ticket.identityId === block.winnerIdentityId` (a block
 *      cannot claim a ticket it does not own);
 *   3. bind the winner ticket to the accepted set (identity + commitment)
 *      and to the block's window (windowIndex + challenge) — an unselected
 *      node cannot fabricate a ticket the window did not accept;
 *   4. re-derive the window's winner with the ONE pinned draw —
 *      `drawWindow`, IMPORTED from `./draw.js` (AD-7: the `c^uptime`
 *      formula is never re-implemented) — over the accepted ticket set;
 *   5. accept iff the re-derived winner === `block.winnerIdentityId`.
 *
 * A reject is a normal `false`, NOT an error — like the 65535/65536 PoW
 * outcome, a draw reject is an expected result (the launch gate: an
 * unselected node's block is rejected, not an exception). Verification is
 * a PURE function of the set passed (AD-7 accepted-set boundary rule): a
 * ticket arriving late is simply not in the set handed to the verifier, so
 * it cannot retroactively invalidate an already-accepted block.
 *
 * No `big.js`, no float (AD-5), no wall clock, no RNG (AD-3) — the only
 * byte work is the protons decode plus the imported draw's sha256 per
 * ticket.
 */
import type { Block, Ticket as ProtoTicket } from '../proto/index.js'
import { Ticket } from '../proto/index.js'
import { DrawError, drawWindow } from './draw.js'
import type { DrawTicket } from './draw.js'

/**
 * Verify a block's claimed winner against the AD-7 draw (3.4).
 *
 * @param block — the block to verify; its `winnerIdentityId` +
 *   `winnerTicket` are the claim.
 * @param tickets — the ACCEPTED ticket set for the window (AD-7: tickets
 *   accepted at or before the previous window's last block). Verification
 *   is a pure function of this set — a late ticket is simply not in it.
 * @param weights — the non-negative integer uptime weights, one per ticket
 *   in the SAME order as `tickets` (draw inputs, AD-7).
 * @param challenge — the window's challenge, the CALLER'S responsibility:
 *   recompute it as `deriveWindowChallenge(block.parentHash, block.slot)`.
 *   The seam RECEIVES it (it does not recompute); a block whose winner
 *   ticket's `challenge` field differs from it verifies false.
 *
 * @returns true iff the decoded `winnerTicket`'s `identityId` equals
 *   `block.winnerIdentityId`, the winner ticket is one the accepted set
 *   actually carries (identity + commitment, window-bound), AND the
 *   re-derived draw winner equals `block.winnerIdentityId`. `false` is a
 *   normal reject (launch gate).
 *
 * @throws {DrawError} `SC-CONSENSUS-2` iff `block.winnerTicket` is not a
 *   decodable proto `Ticket` (a malformed block) — the ONLY error path.
 *   (Programming errors in the ticket set itself — empty set, weight
 *   length mismatch — surface as `drawWindow`'s own `DrawError`.)
 */

/** Byte-wise equality for two `Uint8Array`s (the challenge / commitment binding). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function verifyDraw(
  block: Block,
  tickets: ReadonlyArray<DrawTicket>,
  weights: ReadonlyArray<bigint>,
  challenge: Uint8Array,
): boolean {
  // 1 — decode the winner ticket (AD-12 wire form). The ONLY throw path:
  //    ticket bytes that fail `Ticket.decode` are a malformed block.
  let winnerTicket: ProtoTicket
  try {
    winnerTicket = Ticket.decode(block.winnerTicket)
  } catch (err) {
    throw new DrawError(
      `SC-CONSENSUS-2: block winnerTicket is not a decodable proto Ticket: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // 2 — a block cannot claim a ticket it does not own.
  if (winnerTicket.identityId !== block.winnerIdentityId) {
    return false
  }

  // 3 — the winner ticket must be one the window ACTUALLY ACCEPTED: bound
  //    to the accepted set by (identityId, nonceCommitment) AND to the
  //    block's window (windowIndex + challenge). Without this, an
  //    unselected node — the draw winner is public — could claim the
  //    winner's identity with a fabricated / empty / truncated commitment
  //    and pass. (Replaying the winner's EXACT public ticket is the
  //    residual case closed by 4.3's `acceptBlockWinner`, which composes
  //    `verifyDraw` with the identity-bound `verifyTicketSignature` (4.2,
  //    AD-12).
  const inAcceptedSet = tickets.some(
    (t) =>
      t.identityId === winnerTicket.identityId &&
      bytesEqual(t.nonceCommitment, winnerTicket.nonceCommitment),
  )
  if (!inAcceptedSet) return false
  if (winnerTicket.windowIndex !== block.slot) return false
  if (!bytesEqual(winnerTicket.challenge, challenge)) return false

  // 4 — re-derive the AD-7 winner over the accepted set (IMPORTED — the
  //    `c^uptime` formula is never re-implemented).
  const draw = drawWindow(tickets, challenge, weights)

  // 5 — accept iff the draw selected the block's claimed winner.
  return draw.winnerIdentityId === block.winnerIdentityId
}
