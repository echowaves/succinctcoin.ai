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
