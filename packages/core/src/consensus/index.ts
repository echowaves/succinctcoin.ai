/**
 * `core/consensus` public surface — the E1 PoW seam (difficulty / target
 * adjustment spike) + the tracer (3.2): the per-attempt mining loop
 * (`mineBlock`, AD-6 hot path), the chain-time slot derivation
 * (`nextSlotAndParent`, AD-3), the single mutation path (`applyBlock`,
 * AD-2), and the one-block end-to-end tracer (`mineAndApply`).
 * The AD-7 verifiable public-coin draw (`drawWindow` +
 * `deriveWindowChallenge`, 3.3) is re-exported here; 3.4 wires it into the
 * tracer (replacing the fixed winner + placeholder ticket). Additive
 * surface — `createCore` untouched.
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
export { applyBlock } from './apply-block.js'
export type { ApplyBlockParams } from './apply-block.js'
export { mineAndApply, nextSlotAndParent } from './slot-loop.js'
// AD-7 verifiable public-coin draw (3.3): the ONE pinned draw + per-window
// challenge derivation + the draw-input ticket interface. 3.4 wires the
// tracer's winner to it; the tracer's fixed winner (3.2) is untouched here.
export { DrawError, deriveWindowChallenge, drawWindow } from './draw.js'
export type { DrawResult, DrawTicket } from './draw.js'
