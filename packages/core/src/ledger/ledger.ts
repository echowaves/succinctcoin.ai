/**
 * `core/ledger` — the exact-money core (AD-5, story 2.1).
 *
 * Balances are **integer base units** (`bigint`) in memory: one whole =
 * `10 ** BASE_UNIT_DECIMALS` base units. 8 base units per whole is a
 * code-level decision (Bitcoin-style scale), named here so 2.2 (fee
 * boundary), 2.3 (store encoding) and 2.4 (property tests) all inherit the
 * same constant.
 *
 * AD-5: amounts are `bigint` in memory and decimal strings on wire/JSON —
 * raw `BigInt` is banned from JSON (`JSON.stringify(123n)` throws natively).
 * The in-memory form never drifts (integer math); the decimal-string form is
 * produced by `toJson` (this file) for wire/JSON/disk. Floating-point is
 * banned from the ledger — the only decimal engine is big.js, confined to
 * the display boundary in `display.ts` (this story's 2nd AD-5 boundary; the
 * 1st — fee = amount × rate — lands in 2.2).
 *
 * AD-2: the seam is the ledger's ONLY mutation path. `apply` is pure — no
 * hidden state, no I/O, deterministic. Epic 3's `applyBlock` owns the state
 * (the `BalanceMap` it threads), the store, and the ordering; the ledger
 * performs arithmetic + invariant checks only and never re-validates
 * protocol rules. Credits (mining rewards) are just transfers from a
 * reserved mint id — data in, data out, no protocol semantics here.
 */

/** Base units per whole coin (8 decimals, Bitcoin-style; see module doc). */
export const BASE_UNIT_DECIMALS = 8

/**
 * One identity's balance, in integer base units. Absent identities are
 * implicitly `0n` (`balanceOf`); the map stores only identities that have
 * held a non-zero balance.
 */
export type BalanceMap = ReadonlyMap<string, bigint>

/**
 * One movement of exact base units. `from`/`to` are identity ids (32-byte
 * hex on the wire; the seam does not validate id format — protocol rules
 * are consensus' job, AD-2). `amount` is a non-negative integer count of
 * base units.
 */
export interface Transfer {
  from: string
  to: string
  amount: bigint
}

/**
 * Ledger error. Carries the spine's `{ code, message }` shape:
 *   - `SC-LEDGER-1` — the no-negative-balance invariant: a debit that would
 *     push a balance below zero, naming the identity + shortfall.
 *   - `SC-LEDGER-2` — the display boundary (`fromDisplay`): a display string
 *     that is not a plain decimal in base units (exponential notation,
 *     sub-base-unit precision, or malformed). Kept distinct from the
 *     invariant so a caller handling "balance went negative" never sees a
 *     "bad display string".
 *   - `SC-LEDGER-3` — the fee boundary (`computeFee`, `fee.ts`): a rate or
 *     amount outside the fee boundary's contract (non-plain-decimal rate,
 *     rate outside [0,1), negative amount). Kept distinct so a caller
 *     handling "balance went negative" never sees a "bad rate".
 *   - `SC-LEDGER-4` — the state-decode boundary (`fromJson`): a persisted
 *     balance value that is not a plain non-negative decimal-integer string
 *     (exponential notation, fractional, non-decimal, empty, or negative).
 *     A persisted balance is ≥ 0 by invariant, so a negative string is
 *     corruption, not data. Kept distinct so a caller handling "balance went
 *     negative" or "bad display string" never sees "corrupt on-disk state".
 */
export class LedgerError extends Error {
  readonly code: 'SC-LEDGER-1' | 'SC-LEDGER-2' | 'SC-LEDGER-3' | 'SC-LEDGER-4'
  constructor(
    message: string,
    code: 'SC-LEDGER-1' | 'SC-LEDGER-2' | 'SC-LEDGER-3' | 'SC-LEDGER-4' = 'SC-LEDGER-1',
  ) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}

/**
 * The ledger's single mutation seam (AD-2). Pure: moves exact base units
 * between identities and returns a NEW `BalanceMap` — the input map is
 * never mutated, in place or by reference aliasing.
 *
 * No-negative-balance is enforced atomically: every debit is validated
 * against the running totals BEFORE any transfer is applied. The first
 * failing debit throws `SC-LEDGER-1` (naming the identity) and the
 * original map is untouched — atomicity is structural, because the new map
 * is built only after validation completes.
 *
 * `amount` must be a non-negative integer (base units); a negative amount
 * or a debit that would make a balance negative fails the whole apply with
 * `SC-LEDGER-1`. An empty `transfers` list yields a new map with identical
 * content — still a new object, still through the seam. A self-transfer
 * (`from === to`) nets to zero.
 */
export function apply(balances: BalanceMap, transfers: readonly Transfer[]): BalanceMap {
  // Pass 1 — validate every debit against the running totals. `running`
  // models the balance as transfers would net it (credits count toward
  // covering later debits within the same apply).
  const running = new Map<string, bigint>()
  const get = (id: string): bigint => running.get(id) ?? balances.get(id) ?? 0n
  for (const t of transfers) {
    if (t.amount < 0n) throw negativeError(t.from, -t.amount)
    const after = get(t.from) - t.amount
    if (after < 0n) throw negativeError(t.from, -after)
    running.set(t.from, after)
    running.set(t.to, get(t.to) + t.amount)
  }

  // Pass 2 — materialize the new map (validation proved nothing goes
  // negative, so the subtractions here cannot fail).
  const next = new Map(balances)
  for (const t of transfers) {
    next.set(t.from, (next.get(t.from) ?? 0n) - t.amount)
    next.set(t.to, (next.get(t.to) ?? 0n) + t.amount)
  }
  return next
}

/** A debit that would push `id`'s balance below zero (by `shortfall`). */
function negativeError(id: string, shortfall: bigint): LedgerError {
  return new LedgerError(
    `SC-LEDGER-1: debit would make balance of ${id} negative ` +
      `(shortfall ${shortfall} base units)`,
  )
}

/** Read helper (projection, not a mutator): the balance of `id`, or `0n`. */
export function balanceOf(balances: BalanceMap, id: string): bigint {
  return balances.get(id) ?? 0n
}

/** Read helper (projection, not a mutator): total supply in base units. */
export function totalSupply(balances: BalanceMap): bigint {
  let total = 0n
  for (const units of balances.values()) total += units
  return total
}

/**
 * JSON/wire boundary (AD-5): the JSON-safe projection of a balance map —
 * identity id → decimal-string base units. `JSON.stringify` of the result
 * never throws (no `BigInt` in it) and never drifts (the decimal form is
 * exact; `BigInt(s)` round-trips it losslessly).
 *
 * The projection is built on a null-prototype object, so a reserved
 * own-property id (`__proto__` — unreachable in the 32-byte-hex protocol id
 * space, but legal at this seam) becomes an ordinary own data property
 * instead of hitting the `Object.prototype.__proto__` setter and being
 * silently dropped. `fromJson` reads it back via `Object.entries`, so the
 * `toJson` → `fromJson` round-trip is symmetric for every id.
 */
export function toJson(balances: BalanceMap): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const [id, units] of balances) out[id] = units.toString(10)
  return out
}

/**
 * JSON/wire boundary (AD-5) — the `toJson` inverse: a canonical state
 * document (`identity → decimal-string base units`, as persisted by the
 * store's `saveState`) → a new `BalanceMap`. Pure — no I/O, no mutation of
 * any input.
 *
 * Every value is validated against the plain non-negative decimal-integer
 * grammar (`/^\d+$/`) BEFORE `BigInt` parsing: exponential notation (`"1e8"`),
 * fractional (`"1.5"`), non-decimal (`"12a"`), empty (`""`), and negative
 * (`"-5"`) strings all throw `SC-LEDGER-4` — the state-decode boundary. A
 * persisted balance is ≥ 0 by invariant (the ledger cannot produce a
 * negative), so a negative string is corruption, not data. Document *shape*
 * (object of string→string) is the store's guard (`SC-STORE-3`); this
 * boundary guards the value *semantics*.
 */
export function fromJson(doc: Record<string, string>): BalanceMap {
  const out = new Map<string, bigint>()
  for (const [id, units] of Object.entries(doc)) {
    if (!/^\d+$/.test(units)) {
      throw new LedgerError(
        `SC-LEDGER-4: fromJson: balance of ${id} is not a plain non-negative ` +
          `decimal-integer base-unit string: ${JSON.stringify(units)}`,
        'SC-LEDGER-4',
      )
    }
    out.set(id, BigInt(units))
  }
  return out
}
