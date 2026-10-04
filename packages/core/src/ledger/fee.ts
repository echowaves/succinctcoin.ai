/**
 * `core/ledger/fee` — the fee boundary (AD-5, 1st of the two big.js
 * boundaries; the 2nd — display conversion — lives in `display.ts`).
 *
 * The fee is `amount × rate` computed exactly once per transaction (R2).
 * "Exactly once" is the CALLER's contract: epic 3's `applyBlock` calls
 * `computeFee` once per tx and moves the result through the `apply` seam
 * as an ordinary base-unit transfer. Because `computeFee` is pure and
 * deterministic, any recomputation is idempotent and fee drift can never
 * fork consensus.
 *
 * This is the only other file in `src/ledger/` (besides `display.ts`)
 * that imports `big.js` — after this story 2.5's import scan finds
 * big.js in exactly these two modules (it scans import statements, not
 * prose comments). The product converts back to integer base units
 * INSIDE the boundary: big.js never leaves it. The integer path
 * (`apply` in `ledger.ts`) stays pure `bigint`, big.js-free.
 *
 * Rounding = truncation toward zero: never overcharge the sender,
 * identical on every node (consensus-critical), dust dropped and
 * credited nowhere (destination semantics are 2.4's decision).
 */
import Big from 'big.js'

import { LedgerError } from './ledger.js'

/**
 * Plain-decimal rate form: unsigned integer part, optional fractional
 * part. Deliberately local to `fee.ts` (not shared with `display.ts`'s
 * signed pattern): a fee rate has no sign — anything ≥ 1 is rejected by
 * the range check below and a negative rate is malformed — so the fee's
 * grammar is stricter than the display's, and no third module references
 * big.js' parsing contract.
 */
const PLAIN_DECIMAL_RATE = /^\d+(\.\d+)?$/

/**
 * Compute the transaction fee in integer base units: `amount` (base
 * units, `bigint`) × `rate` (a plain-decimal string in [0,1)),
 * truncated toward zero.
 *
 * Pure and deterministic — the same input always yields the same result
 * (R2's "exactly once" is the caller's contract; this purity makes any
 * recomputation idempotent).
 *
 * Validation runs BEFORE big.js sees the input: big.js silently parses
 * exponential notation (`1e-3`) — the same drift vector 2.1 closed in
 * `fromDisplay` — so the plain-decimal regex comes first; then
 * `0 ≤ rate < 1` (a fee ≥ the whole amount is economic nonsense and
 * would overdraw at `apply` anyway, so it is rejected early with a
 * clearer error); then `amount ≥ 0`.
 *
 * Rejections throw `LedgerError` with `SC-LEDGER-3` (the fee-boundary
 * code — distinct from `SC-LEDGER-1`, the no-negative invariant, and
 * `SC-LEDGER-2`, the display boundary).
 */
export function computeFee(amount: bigint, rate: string): bigint {
  if (amount < 0n) {
    throw new LedgerError(
      `SC-LEDGER-3: computeFee: negative amount: ${amount} base units`,
      'SC-LEDGER-3',
    )
  }
  if (!PLAIN_DECIMAL_RATE.test(rate)) {
    throw new LedgerError(
      `SC-LEDGER-3: computeFee: not a plain decimal rate: ${JSON.stringify(rate)}`,
      'SC-LEDGER-3',
    )
  }
  // The regex has guaranteed a plain decimal, so big.js parsing is safe
  // here (no exponential-notation vector remains).
  if (new Big(rate).gte(1)) {
    throw new LedgerError(
      `SC-LEDGER-3: computeFee: rate outside [0,1): ${rate}`,
      'SC-LEDGER-3',
    )
  }
  // Exact decimal multiply (big.js multiplication is exact — no precision
  // limit; DECIMAL_PLACES applies only to div/mod/pow), then back to
  // integer base units. `toFixed()` (no argument) is the full plain
  // decimal — `toString()` would go exponential at large magnitudes (2.1
  // probe-verified). big.js 7.0.1 ships NO `trunc()` (probe-verified
  // method surface), so truncation toward zero is the string cut at the
  // decimal point: exact, because both operands are validated non-
  // negative and the product string is exact — everything after `.` is
  // sub-base-unit dust, dropped, never credited. `BigInt` parses the
  // plain decimal integer string natively.
  const plain = new Big(amount.toString()).times(rate).toFixed()
  const dot = plain.indexOf('.')
  return BigInt(dot === -1 ? plain : plain.slice(0, dot))
}
