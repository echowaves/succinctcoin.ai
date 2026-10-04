/**
 * `core/ledger/display` — the display-conversion boundary (AD-5, 2nd of the
 * two big.js boundaries; the 1st — fee = amount × rate — lands in 2.2).
 *
 * This is the ONLY file in `src/ledger/` that imports `big.js` in this
 * story (2.5's import scan will pin that). The conversion is pure decimal
 * math: divide by `10 ** BASE_UNIT_DECIMALS` via big.js — never `/` on
 * numbers (floating-point is banned from the ledger), never `BigInt` on the
 * wire (raw BigInt is banned from JSON).
 *
 * Why big.js at all: base units are already exact integers, but the
 * *display* form is a decimal — the one place a fraction exists in the
 * ledger — and AD-5 says exact-decimal money is recorded via big.js at
 * every boundary where a decimal exists. The integer path (the `apply`
 * seam) stays pure `bigint` arithmetic, big.js-free.
 *
 * `toFixed()` (no argument) is used for the string form: `Big#toString()`
 * switches to exponential notation for large magnitudes (e.g. `1e+22` at
 * 10³⁰ base units), which is not the plain decimal form the UI and the
 * round-trip expect; `toFixed()` always returns the full plain decimal,
 * and since display values have at most `BASE_UNIT_DECIMALS` fractional
 * digits it is exact — no rounding happens.
 */
import Big from 'big.js'

import { BASE_UNIT_DECIMALS, LedgerError } from './ledger.js'

/** One whole coin, in base units: `10 ** BASE_UNIT_DECIMALS` (a big.js value). */
const WHOLE = new Big(1).times(`1e${BASE_UNIT_DECIMALS}`)

/**
 * Base units → human decimal string (whole coins, up to
 * `BASE_UNIT_DECIMALS` fractional digits). `123456780n` → `"1.2345678"`;
 * `0n` → `"0"`. Pure; no float involved.
 */
export function toDisplay(baseUnits: bigint): string {
  return new Big(baseUnits.toString(10)).div(WHOLE).toFixed()
}

/**
 * Human decimal string → base units (the inverse of `toDisplay`).
 * Accepts plain decimal strings only (`"1.2345678"` → `123456780n`);
 * exponential notation (`"1e8"`) is REJECTED — big.js would otherwise
 * silently parse it, a drift vector for a display/wire boundary that must
 * be plain decimal. Fractional parts longer than `BASE_UNIT_DECIMALS`
 * digits are rejected (a sub-base-unit amount the ledger cannot represent,
 * not a rounding opportunity). Malformed input (non-decimal, exponential,
 * or sub-base precision) throws `LedgerError` (`SC-LEDGER-2`).
 */
export function fromDisplay(s: string): bigint {
  // Plain decimal only: optional sign, integer part, optional fractional
  // part. Rejects e-notation, empty, and garbage BEFORE big.js sees it
  // (big.js accepts `1e5` and throws a plain Error, not a typed one).
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new LedgerError(
      `SC-LEDGER-2: fromDisplay: not a plain decimal string: ${JSON.stringify(s)}`,
      'SC-LEDGER-2',
    )
  }
  const whole = new Big(s)
  const baseUnits = whole.times(WHOLE)
  // `toFixed(0)` is a plain decimal integer string; the input is exactly in
  // base units iff it equals its own integer-string form (big.js accepts a
  // string operand). (big.js has no `neq`; negation is `!eq()`.)
  const intStr = baseUnits.toFixed(0)
  if (!baseUnits.eq(intStr)) {
    throw new LedgerError(
      `SC-LEDGER-2: fromDisplay: ${s} has more than ${BASE_UNIT_DECIMALS} fractional digits`,
      'SC-LEDGER-2',
    )
  }
  // `BigInt` parses the (plain decimal) integer string, including a leading
  // `-`, natively.
  return BigInt(intStr)
}
