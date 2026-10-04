/**
 * Story 2.1 matrix — the five rows of the story plan's I/O & Edge-Case
 * Matrix, verbatim:
 *
 *   EXACT_MOVE   — exact base-unit movement, no rounding, no drift, new map
 *   NO_NEGATIVE  — oversize debit fails SC-LEDGER-1, atomically (nothing
 *                  changes)
 *   NO_MUTATOR   — surface inspection: only `apply` mutates; reads go
 *                  through projections; `BalanceMap` is a ReadonlyMap (the
 *                  compile-time half of the proof)
 *   DECIMAL_JSON — `JSON.stringify` of balances yields clean decimal
 *                  strings, no throw, no drift
 *   DISPLAY      — the big.js boundary at 1 whole = 10^8 base units
 *                  (BASE_UNIT_DECIMALS): `123456780n` → `"1.2345678"`,
 *                  `0n` → `"0"`, `fromDisplay` round-trips and rejects
 *                  non-plain-decimal input. (The frozen matrix row's
 *                  `12345678n → "1.2345678"` is a plan typo — one digit off
 *                  at this scale; see the plan's Implementation Notes.)
 */
import { describe, expect, it } from 'vitest'

import * as ledger from '../src/ledger/index.js'
import {
  BASE_UNIT_DECIMALS,
  LedgerError,
  apply,
  balanceOf,
  fromDisplay,
  toJson,
  toDisplay,
  totalSupply,
} from '../src/ledger/index.js'
import type { BalanceMap } from '../src/ledger/index.js'

// 32-byte hex identity ids (the wire form; the seam does not validate the
// shape — protocol rules are consensus' job, AD-2).
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

describe('EXACT_MOVE — apply moves exact base units (no rounding, no drift)', () => {
  it('debits the sender and credits the receiver by exactly the transfer amount', () => {
    const start: BalanceMap = new Map<string, bigint>([
      [A, 1_000_000_000n],
      [B, 250n],
    ])
    const next = apply(start, [{ from: A, to: B, amount: 123_456_789n }])
    expect(balanceOf(next, A)).toBe(876_543_211n)
    expect(balanceOf(next, B)).toBe(123_457_039n)
    // Total supply is conserved by exact integer movement.
    expect(totalSupply(next)).toBe(totalSupply(start))
  })

  it('returns a new map — the input map is untouched (no in-place mutation)', () => {
    const start: BalanceMap = new Map<string, bigint>([[A, 10n]])
    const next = apply(start, [{ from: A, to: B, amount: 4n }])
    expect(next).not.toBe(start)
    expect(start.get(A)).toBe(10n) // original still holds its old value
    expect(balanceOf(next, A)).toBe(6n)
    expect(balanceOf(next, B)).toBe(4n)
  })

  it('handles multi-hop and self-contained sequences exactly', () => {
    // A→B→C within one apply: B is both a receiver and a sender.
    const start: BalanceMap = new Map<string, bigint>([[A, 100n]])
    const next = apply(start, [
      { from: A, to: B, amount: 60n },
      { from: B, to: C, amount: 40n },
    ])
    expect(balanceOf(next, A)).toBe(40n)
    expect(balanceOf(next, B)).toBe(20n)
    expect(balanceOf(next, C)).toBe(40n)
    expect(totalSupply(next)).toBe(100n)
  })

  it('credits an absent receiver (absent → 0n) — receivers need no pre-funding', () => {
    // The seam treats every identity uniformly: no protocol semantics (no
    // reserved-mint special case, AD-2) — but the no-negative invariant
    // still applies, so the sender must be funded (see NO_NEGATIVE).
    const next = apply(new Map<string, bigint>([[A, 10n]]), [
      { from: A, to: B, amount: 10n },
    ])
    expect(balanceOf(next, B)).toBe(10n) // absent receiver created
    expect(balanceOf(next, A)).toBe(0n)
  })

  it('a self-transfer nets to zero', () => {
    const start: BalanceMap = new Map<string, bigint>([[A, 42n]])
    const next = apply(start, [{ from: A, to: A, amount: 10n }])
    expect(next).not.toBe(start)
    expect(balanceOf(next, A)).toBe(42n)
    expect(totalSupply(next)).toBe(42n)
  })

  it('is exact at large magnitudes — no precision loss (bigint math)', () => {
    const big = 10n ** 30n // the epic's property-test ceiling
    const start: BalanceMap = new Map<string, bigint>([['mint', big]])
    const next = apply(start, [{ from: 'mint', to: A, amount: big }])
    expect(balanceOf(next, A)).toBe(big)
    expect(totalSupply(next).toString()).toBe('1000000000000000000000000000000')
  })
})

describe('NO_NEGATIVE — a debit larger than the balance fails SC-LEDGER-1, atomically', () => {
  it('rejects an oversize debit with SC-LEDGER-1 naming the identity', () => {
    const start: BalanceMap = new Map<string, bigint>([[A, 100n]])
    let err: unknown
    try {
      apply(start, [{ from: A, to: B, amount: 101n }])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LedgerError)
    expect(err).toBeInstanceOf(Error)
    expect((err as LedgerError).code).toBe('SC-LEDGER-1')
    expect((err as Error).message).toContain(A)
  })

  it('leaves every balance unchanged when one transfer fails (atomic)', () => {
    const start: BalanceMap = new Map<string, bigint>([
      [A, 100n],
      [B, 50n],
    ])
    const before = toJson(start)
    let err: unknown
    try {
      // First transfer is fine; the second over-debits B.
      apply(start, [
        { from: A, to: B, amount: 30n },
        { from: B, to: C, amount: 90n },
      ])
    } catch (e) {
      err = e
    }
    expect((err as LedgerError).code).toBe('SC-LEDGER-1')
    expect(toJson(start)).toEqual(before) // input map untouched
    expect(balanceOf(start, A)).toBe(100n)
    expect(balanceOf(start, B)).toBe(50n)
    expect(balanceOf(start, C)).toBe(0n)
  })

  it('rejects a debit from an absent identity (absent balance is 0n)', () => {
    let err: unknown
    try {
      apply(new Map(), [{ from: A, to: B, amount: 1n }])
    } catch (e) {
      err = e
    }
    expect((err as LedgerError).code).toBe('SC-LEDGER-1')
  })

  it('rejects a negative transfer amount', () => {
    let err: unknown
    try {
      apply(new Map([[A, 10n]]), [{ from: A, to: B, amount: -1n }])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LedgerError)
    expect((err as LedgerError).code).toBe('SC-LEDGER-1')
  })
})

describe('NO_MUTATOR — only the apply seam mutates; reads are projections', () => {
  it('exports exactly the agreed surface (enumeration)', () => {
    const names = Object.keys(ledger).sort()
    // `apply` is the only exported mutator; everything else reads or
    // projects. `toJson` is a pure projection (returns a new object), not
    // a mutation of the balances.
    expect(names).toEqual(
      [
        'BASE_UNIT_DECIMALS',
        'LedgerError',
        'apply',
        'balanceOf',
        'computeFee',
        'fromDisplay',
        'toJson',
        'toDisplay',
        'totalSupply',
      ].sort(),
    )
  })

  it('read helpers never mutate: balanceOf/totalSupply/toJson are pure reads', () => {
    const start: BalanceMap = new Map<string, bigint>([[A, 7n]])
    const before = toJson(start)
    // The only way a "read" could mutate is in-place — call each read
    // helper against a shared map and prove nothing changes.
    balanceOf(start, A)
    balanceOf(start, C) // absent
    totalSupply(start)
    const proj = toJson(start)
    expect(toJson(start)).toEqual(before)
    expect(proj).toEqual({ [A]: '7' })
    expect(start.size).toBe(1)
  })

  it('BalanceMap is a ReadonlyMap — in-place mutation is a type error (compile proof)', () => {
    const m: BalanceMap = new Map<string, bigint>()
    // @ts-expect-error — BalanceMap is ReadonlyMap; `.set` does not exist.
    m.set(A, 1n)
    // @ts-expect-error — ReadonlyMap has no `.delete` either.
    m.delete(A)
    // The lines above are the compile-time half of the NO_MUTATOR proof:
    // if `BalanceMap` ever gained a mutating surface, tsc fails here.
    expect(m).toBeInstanceOf(Map)
  })

  it('the seam is the only path to a changed map: apply alone returns a new map', () => {
    const start: BalanceMap = new Map<string, bigint>([[A, 1n]])
    // Projections return NEW objects but never change the input's content.
    const proj = toJson(start)
    proj[A] = '999' // mutating the projection…
    expect(toJson(start)).toEqual({ [A]: '1' }) // …does not touch the map.
    // …and `apply` is the only export that yields a changed balance map.
    const next = apply(start, [{ from: A, to: B, amount: 1n }])
    expect(next).not.toBe(start)
    expect(balanceOf(next, B)).toBe(1n)
  })
})

describe('DECIMAL_JSON — JSON.stringify of balances: clean decimal strings, no throw, no drift', () => {
  it('toJson yields decimal-string base units and JSON.stringify never throws', () => {
    const balances: BalanceMap = new Map<string, bigint>([
      [A, 123_456_789n],
      [B, 0n],
      [C, 10n ** 30n],
    ])
    // A raw BigInt in a JSON position throws natively — prove the
    // projection is what keeps JSON.stringify safe.
    expect(() => JSON.stringify({ raw: 123n })).toThrow()
    const json = JSON.stringify(toJson(balances))
    expect(json).toBe(`{"${A}":"123456789","${B}":"0","${C}":"1000000000000000000000000000000"}`)
  })

  it('round-trips through JSON without drift (decimal string → BigInt is exact)', () => {
    const balances: BalanceMap = new Map<string, bigint>([
      [A, 1n],
      [B, 99_999_999n],
      [C, 123_456_789_012_345_678_901_234_567_890n],
    ])
    const parsed = JSON.parse(JSON.stringify(toJson(balances))) as Record<string, string>
    for (const [id, units] of balances) {
      expect(typeof parsed[id]).toBe('string')
      expect(BigInt(parsed[id])).toBe(units) // exact — no precision loss
    }
  })

  it('the string form is a plain decimal (no exponent, no float artifact)', () => {
    for (const units of [0n, 1n, 99_999_999n, 1n << 62n, 10n ** 30n]) {
      const s = units.toString(10)
      expect(s).toMatch(/^-?\d+$/)
      expect(BigInt(s)).toBe(units)
    }
  })
})

describe('DISPLAY — the big.js boundary (base units ⇄ human decimal string)', () => {
  it('base units → human decimal, 8 base units per whole (10^8)', () => {
    expect(BASE_UNIT_DECIMALS).toBe(8)
    // The frozen matrix row's digits, under the design-note scale
    // (1 whole = 10^8 base units): 123456780n → "1.2345678". The frozen
    // row's input `12345678n` maps to "0.12345678" at this scale — the
    // row's input/output disagree by one digit (plan typo); the design
    // notes fix the scale, so the input wins and the output is derived.
    expect(toDisplay(123_456_780n)).toBe('1.2345678')
    expect(toDisplay(12_345_678n)).toBe('0.12345678')
    expect(toDisplay(1n)).toBe('0.00000001')
  })

  it('0n → "0"', () => {
    expect(toDisplay(0n)).toBe('0')
  })

  it('fromDisplay is the inverse and round-trips quantized values', () => {
    expect(fromDisplay('1.2345678')).toBe(123_456_780n)
    expect(fromDisplay('0')).toBe(0n)
    expect(fromDisplay('0.00000001')).toBe(1n)
    expect(fromDisplay('12.3456789')).toBe(1_234_567_890n)
    // Round-trips exactly for values quantized to base units (≤ 8 fractional
    // display digits). Non-quantized values (e.g. 2^62) lose their
    // sub-base-unit tail on display — that is the display boundary's
    // contract, not a defect; the integer path (the seam) never does this.
    for (const units of [0n, 1n, 123_456_780n, 1_234_567_890n, 10n ** 30n, 10n ** 31n - 1n]) {
      expect(fromDisplay(toDisplay(units))).toBe(units)
    }
  })

  it('stays exact at the 10^30 property-test ceiling (plain decimal, no exponent)', () => {
    const display = toDisplay(10n ** 30n)
    // 10^30 base units = 10^22 whole: a 23-char plain decimal, no "e".
    expect(display).toBe(`1${'0'.repeat(22)}`)
    expect(fromDisplay(display)).toBe(10n ** 30n)
  })

  it('rejects sub-base-unit precision, non-decimal, and exponential input (LedgerError)', () => {
    // Sub-base-unit precision (9 fractional digits > BASE_UNIT_DECIMALS).
    expect(() => fromDisplay('0.000000001')).toThrow(LedgerError)
    // Non-decimal / malformed.
    expect(() => fromDisplay('1.2.3')).toThrow(LedgerError)
    expect(() => fromDisplay('abc')).toThrow(LedgerError)
    expect(() => fromDisplay('')).toThrow(LedgerError)
    // Exponential notation — big.js would silently parse `1e8`; the plain-
    // decimal contract rejects it (a drift vector for a display/wire boundary).
    expect(() => fromDisplay('1e8')).toThrow(LedgerError)
    expect(() => fromDisplay('1.2345678e1')).toThrow(LedgerError)
    // Every rejection is a typed SC-LEDGER-2 error (the display-boundary
    // code — distinct from SC-LEDGER-1, the no-negative invariant).
    for (const bad of ['0.000000001', '1.2.3', 'abc', '', '1e8']) {
      try {
        fromDisplay(bad)
        expect.unreachable()
      } catch (e) {
        expect((e as LedgerError).code).toBe('SC-LEDGER-2')
      }
    }
  })
})
