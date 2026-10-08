/**
 * `core/consensus` — the block-acceptance seam (4.3, E2 / AD-7 / AD-12).
 *
 * A block is accepted **only if** its winner ticket verifies the AD-7 draw
 * **AND** carries a valid AD-12 identity-bound signature. The two checks are
 * **ONE cohesive acceptance-path seam** — `acceptBlockWinner` — and they
 * **compose**: neither alone is sufficient. This is the place the
 * **epic-3 residual replay** (3.4/3.7 note) is closed in the acceptance path:
 * an unselected node that has the winner's PUBLIC ticket fields (a valid
 * commitment, so the draw gate passes) but does **not** hold the winner's key
 * cannot produce a valid signature, so its block is rejected even though
 * `verifyDraw` alone would have accepted it.
 *
 * The seam is **ADDITIVE** — it composes with epic-3's `verifyDraw` and never
 * weakens it:
 *
 *   - `protoTicketToDrawTicket(ticket)` — the **conformance** (AD-7): a real
 *     proto `Ticket` maps to the draw input set `DrawTicket { identityId,
 *     nonceCommitment }`. The draw consumes EXACTLY these two fields; the
 *     proto's `challenge`/`windowIndex`/`signature` are owned by verification,
 *     not the draw (AD-7). The draw is IMPORTED (`drawWindow`), never
 *     re-implemented.
 *   - `acceptBlockWinner(block, acceptedTickets, weights, challenge)` — the
 *     **ONE cohesive acceptance-path seam**: it (a) conforms `acceptedTickets`
 *     to `DrawTicket[]`, (b) calls `verifyDraw` (the draw gate, IMPORTED from
 *     `./verify-draw.js` — UNCHANGED), (c) decodes `block.winnerTicket` with
 *     the protons `Ticket` codec (the same decode `verifyDraw` uses — a corrupt
 *     ticket is a malformed block, the seam's ONLY throw path, `DrawError`
 *     `SC-CONSENSUS-2`), and (d) verifies the winner ticket's AD-12 signature
 *     via `verifyTicketSignature` (IMPORTED from `../identity/index.js` — the
 *     digest is never re-implemented). It returns `true` iff BOTH hold.
 *
 * Reject convention (D4, like `verifyDraw`): a reject is a NORMAL `false` —
 * the draw rejects OR the signature fails (including an empty / foreign /
 * tampered signature). The ONLY throw is a `block.winnerTicket` that fails
 * `Ticket.decode` (a malformed block) → `DrawError` `SC-CONSENSUS-2`.
 *
 * No `big.js`, no float (AD-5), no RNG, no wall clock (AD-3) — the only byte
 * work is the protons decode plus the imported draw's sha256 per ticket.
 */
import type { Block, Ticket as ProtoTicket } from '../proto/index.js'
import { Ticket } from '../proto/index.js'
import { DrawError } from './draw.js'
import type { DrawTicket } from './draw.js'
import { verifyDraw } from './verify-draw.js'
import { verifyTicketSignature } from '../identity/index.js'

/**
 * The conformance (AD-7): map a real proto `Ticket` to the draw input set.
 *
 * The draw (`drawWindow`) consumes EXACTLY two fields out of the proto
 * `Ticket` — `identityId` + `nonceCommitment`. The proto's `windowIndex`,
 * `challenge`, and `signature` are owned by VERIFICATION (3.4 / 4.2), not the
 * draw. This maps one ticket; it does NOT compute the draw (AD-7: the draw is
 * imported, never re-implemented).
 */
export function protoTicketToDrawTicket(ticket: ProtoTicket): DrawTicket {
  return { identityId: ticket.identityId, nonceCommitment: ticket.nonceCommitment }
}

/**
 * The ONE cohesive block-acceptance seam (4.3, E2 / AD-7 / AD-12).
 *
 * A block's claimed winner is accepted iff **both** gates hold — they compose,
 * and neither alone is sufficient:
 *
 *   1. the **draw gate** — `verifyDraw(block, conformed, weights, challenge)`
 *      (IMPORTED, UNCHANGED, the 3.4 launch gate): the winner ticket verifies
 *      the AD-7 draw over the accepted set;
 *   2. the **signature gate** — `verifyTicketSignature(winner.identityId,
 *      { windowIndex, challenge, nonceCommitment }, winner.signature)`
 *      (IMPORTED from the identity module, 4.2): the winner's own key signed
 *      its ticket over the EXACT AD-12 digest.
 *
 * @param block — the block to accept; its `winnerIdentityId` + `winnerTicket`
 *   are the claim.
 * @param acceptedTickets — the ACCEPTED proto `Ticket` set for the window
 *   (AD-7 boundary rule); conformed to the draw input set internally.
 * @param weights — the non-negative integer uptime weights, one per ticket in
 *   the SAME order as `acceptedTickets` (draw inputs, AD-7).
 * @param challenge — the window's challenge, the CALLER'S responsibility:
 *   `deriveWindowChallenge(block.parentHash, block.slot)` (received, not
 *   recomputed — the `verifyDraw` convention).
 *
 * @returns `true` iff the draw gate AND the signature gate both pass. A
 *   reject (either gate fails — including an empty / foreign / tampered
 *   signature) is a NORMAL `false`.
 *
 * @throws {DrawError} `SC-CONSENSUS-2` iff `block.winnerTicket` is not a
 *   decodable proto `Ticket` (a malformed block) — the seam's ONLY error path
 *   (the same single throw path as `verifyDraw`).
 */
export function acceptBlockWinner(
  block: Block,
  acceptedTickets: ReadonlyArray<ProtoTicket>,
  weights: ReadonlyArray<bigint>,
  challenge: Uint8Array,
): boolean {
  // (a) conform the accepted set to the draw input set (AD-7 conformance —
  //     the two draw-input fields only; the draw is never re-implemented).
  const conformed = acceptedTickets.map(protoTicketToDrawTicket)

  // (b) the draw gate — `verifyDraw`, UNCHANGED (the 3.4 launch gate). A
  //     malformed `winnerTicket` throws `DrawError SC-CONSENSUS-2` here —
  //     the seam's only throw path.
  const drawOk = verifyDraw(block, conformed, weights, challenge)

  // (c) decode the winner ticket (AD-12 wire form) to read its signature
  //     fields — the SAME protons decode `verifyDraw` uses. A corrupt ticket
  //     is a malformed block: let `DrawError SC-CONSENSUS-2` propagate (the
  //     seam's only throw path). (Reachable only for a decodable ticket —
  //     `verifyDraw` above has already decoded it — but the decode is the
  //     seam's documented error path, not an assumption about `verifyDraw`.)
  let winner: ProtoTicket
  try {
    winner = Ticket.decode(block.winnerTicket)
  } catch (err) {
    throw new DrawError(
      `SC-CONSENSUS-2: block winnerTicket is not a decodable proto Ticket: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // (d) the AD-12 signature gate (4.2, IMPORTED — the digest is never
  //     re-implemented): the winner's OWN key must have signed its ticket
  //     fields. `winner.windowIndex` is a proto `int64` bigint — the
  //     verifier's `coerceWindow` accepts `number | bigint`, so pass it
  //     directly. A reject (empty / foreign / tampered) is a normal `false`.
  const sigOk = verifyTicketSignature(
    winner.identityId,
    {
      windowIndex: winner.windowIndex,
      challenge: winner.challenge,
      nonceCommitment: winner.nonceCommitment,
    },
    winner.signature,
  )

  // Both gates must hold — they compose; neither alone suffices (D2).
  return drawOk && sigOk
}
