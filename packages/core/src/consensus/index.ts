/**
 * `core/consensus` public surface — the E1 PoW seam (difficulty / target
 * adjustment spike) + the tracer (3.2): the per-attempt mining loop
 * (`mineBlock`, AD-6 hot path), the chain-time slot derivation
 * (`nextSlotAndParent`, AD-3), the single mutation path (`applyBlock`,
 * AD-2), and the one-block end-to-end tracer (`mineAndApply`).
 * The AD-7 verifiable public-coin draw (`drawWindow` +
 * `deriveWindowChallenge`, 3.3) is re-exported here; 3.4 wires it into the
 * tracer (replacing the fixed winner + placeholder ticket) and adds the
 * verification seam (`verifyDraw` + the launch gate). 3.5 wired the boot
 * path — `createCore().start()` calls `mineAndApply`.
 */
export {
  POW_TARGET_LEADING_ZERO_BITS,
  PowError,
  blockDigest,
  canonicalBlockBytes,
  leadingZeroBits,
  powCheck,
} from './pow.js'
export { MINT_ID, TRACER_WINNER_ID, mineBlock } from './miner.js'
export type { BlockTemplate } from './miner.js'
// Economic-model constants (3.6): the named fee rate (ONE origin — a
// genesis field is a protocol change inception deferred) + the reserved
// receive-only burn identity. A protocol version bump to change (AD-7/AD-12).
export { BURN_ID, FEE_RATE } from './economics.js'
export { applyBlock } from './apply-block.js'
export type { ApplyBlockParams, BlockTx } from './apply-block.js'
export { mineAndApply, nextSlotAndParent } from './slot-loop.js'
export type { OtherTicket } from './slot-loop.js'
// Draw verification (3.4, R2): the thin seam over the pinned `drawWindow`
// (AD-7 — imported, never re-implemented) that checks a block's claimed
// winner against the accepted ticket set — the launch gate.
export { verifyDraw } from './verify-draw.js'
// AD-7 verifiable public-coin draw (3.3): the ONE pinned draw + per-window
// challenge derivation + the draw-input ticket interface. 3.4 rewired the
// tracer's winner to it (replacing the 3.2 fixed winner).
export { DrawError, deriveWindowChallenge, drawWindow } from './draw.js'
export type { DrawResult, DrawTicket } from './draw.js'
// Multi-node memory-transport simulation (3.7, R1): the standalone harness
// proving the uptime-only slot rate — it imports the pinned seams
// (`drawWindow` / `deriveWindowChallenge` / `mineBlock` / `applyBlock` /
// `verifyDraw` / `nextSlotAndParent`) and never re-implements the draw
// (AD-7) or the challenge (AD-12). NOT wired into `createCore` — additive
// surface only.
export {
  drawSchedule,
  simulateNetwork,
  simulateWindow,
  syntheticTicket,
  windowAcceptedSet,
} from './sim.js'
export type { SimNode } from './sim.js'
// Block-acceptance seam (4.3, E2 / AD-7 / AD-12): the conformance of a real
// proto `Ticket` to the draw input set (`protoTicketToDrawTicket`, AD-7 — the
// draw is imported, never re-implemented) + the ONE cohesive acceptance-path
// seam (`acceptBlockWinner`) — a block is accepted iff the winner ticket
// verifies the AD-7 draw (`verifyDraw`, unchanged) AND carries a valid AD-12
// identity-bound signature. Additive: composes with `verifyDraw`, never
// weakens it.
export { acceptBlockWinner, protoTicketToDrawTicket } from './accept-winner.js'
// Acceptance cap (4.4, R1): the PURE pre-draw filter on a window's accepted
// set — at most ONE ticket per identityId per window (keep-first, input
// order, AD-3). A NEW standalone filter applied UPSTREAM of the draw: it
// does not change `drawWindow` (AD-7), `acceptBlockWinner` (4.3), or the
// sim (4.8 wires it into the multi-identity accepted-set construction).
export { applyAcceptanceCap } from './acceptance-cap.js'
export type { AcceptedSet, CappedSet } from './acceptance-cap.js'
// Uptime-weight derivation (4.5, R2): the PURE derivation of an identity's
// draw weight from its ticket history — the COUNT of distinct valid windows
// in the `L` windows strictly before the current one (ramp from zero, moving
// lookback window; AD-3 chain-time, AD-5 integer bigint). A NEW standalone
// derivation applied where the accepted-set weights are built: it does not
// change `drawWindow` (AD-7 — the weight is a derived INPUT to the draw),
// `acceptance-cap` (4.4), or the sim (4.8 wires it into the multi-identity
// accepted-set weight construction).
export { computeUptimeWeight } from './uptime.js'
// Multi-identity memory-transport simulation (4.8, R1/R2): the standalone
// harness that generalizes 3.7's `sim.ts` into the epic-4 multi-identity
// accepted set — SIGNED tickets (4.2, AD-12), uptime-derived weights (4.5),
// re-attestation eligibility (4.6), and the acceptance cap (4.4) —
// composing with the IMPORTED `drawWindow` (AD-7, never re-implemented)
// and `acceptBlockWinner` (4.3: `verifyDraw` + `verifyTicketSignature`).
// The keypair is a CORE-INTERNAL sim value (AD-11 — the module never reads
// `.secret`; it signs via `signTicket`). NOT wired into `createCore` —
// additive surface only.
export {
  buildCappedSet,
  eligibleSignedSet,
  multiDrawSchedule,
  signedTicket,
  simulateMultiNetwork,
  simulateMultiWindow,
} from './multi-sim.js'
export type { MultiSimIdentity, MultiSimWindowResult, WindowAcceptedSet } from './multi-sim.js'
