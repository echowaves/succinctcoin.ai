/**
 * `core/ledger` public surface (AD-2/AD-5, story 2.1).
 *
 * The only mutation path is the `apply` seam — balances are read via
 * `balanceOf`/`totalSupply` (projections) and serialized via `toJson`
 * (decimal-string base units, AD-5). `toDisplay`/`fromDisplay` are the
 * big.js display boundary. No other mutator exists here; epic 3's
 * `applyBlock` is the caller of the seam, not a ledger export.
 */
export {
  BASE_UNIT_DECIMALS,
  LedgerError,
  apply,
  balanceOf,
  toJson,
  totalSupply,
} from './ledger.js'
export type { BalanceMap, Transfer } from './ledger.js'
export { fromDisplay, toDisplay } from './display.js'
export { computeFee } from './fee.js'
