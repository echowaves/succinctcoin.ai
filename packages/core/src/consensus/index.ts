/**
 * `core/consensus` public surface — the E1 PoW seam (difficulty / target
 * adjustment spike). The slot loop, `drawWindow` (AD-7), and `applyBlock`
 * wiring (AD-2) land in later stories of this epic; this barrel re-exports
 * only what exists so far (additive surface, `createCore` untouched).
 */
export {
  POW_TARGET_LEADING_ZERO_BITS,
  PowError,
  blockDigest,
  canonicalBlockBytes,
  leadingZeroBits,
  powCheck,
} from './pow.js'
