/**
 * `core/consensus` public surface — the E1 PoW seam (difficulty / target
 * adjustment spike) + the tracer (3.2): the per-attempt mining loop
 * (`mineBlock`, AD-6 hot path), the chain-time slot derivation
 * (`nextSlotAndParent`, AD-3), the single mutation path (`applyBlock`,
 * AD-2), and the one-block end-to-end tracer (`mineAndApply`).
 * `drawWindow` (AD-7) lands at 3.3/3.4 (it replaces the tracer's fixed
 * winner + placeholder ticket). Additive surface — `createCore` untouched.
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
