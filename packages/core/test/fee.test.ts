/**
 * Story 2.2 matrix — the four rows of the story plan's I/O & Edge-Case
 * Matrix, verbatim:
 *
 *   FEE_EXACT    — seeded inputs yield exact fees; the fee sum displays
 *                  exactly (never a float artifact like
 *                  0.30000000000000004); pure (same input twice → same
 *                  result). The frozen row's literal "0.3" is read as
 *                  testing.md's canonical 0.1+0.2 drift example, not a
 *                  scale pin — at the fixed 10^8 scale the seeded sum
 *                  displays "0.03" (see the plan's Implementation Notes).
 *   FEE_TRUNCATE — `1n × "0.1"` truncates toward zero → `0n` (dust is
 *                  dropped, not credited)
 *   FEE_REJECT   — rate `"1"`, `"-0.1"`, `"1e-3"`, `"abc"`; amount `-5n`
 *                  all throw `SC-LEDGER-3`
 *   NO_FLOAT     — a seeded fee moved via `apply` as an ordinary
 *                  base-unit transfer → `toJson` clean decimal strings,
 *                  `toDisplay` clean; a throw or artifact fails the test
 */
import { describe, expect, it } from 'vitest'

import {
  LedgerError,
  apply,
  balanceOf,
  computeFee,
  toJson,
  toDisplay,
  totalSupply,
} from '../src/ledger/index.js'
import type { BalanceMap } from '../src/ledger/index.js'

// 32-byte hex identity ids (the wire form; the seam does not validate the
// shape — protocol rules are consensus' job, AD-2).
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('FEE_EXACT — seeded inputs yield exact decimal fees, no float drift', () => {
  it('10000000n × "0.1" → 1000000n; 20000000n × "0.1" → 2000000n', () => {
    expect(computeFee(10_000_000n, '0.1')).toBe(1_000_000n)
    expect(computeFee(20_000_000n, '0.1')).toBe(2_000_000n)
  })

  it('the 0.1+0.2 drift case: the fee sum displays exactly, never a float artifact', () => {
    // The row's seeded pair (the frozen row's "0.1 + 0.2 → 0.3" canonical
    // drift case, at the fixed scale 1 whole = 10^8 base units): fee1 =
    // 0.1 × 10_000_000 → 1_000_000n = 0.01 whole; fee2 = 0.1 ×
    // 20_000_000 → 2_000_000n = 0.02 whole. Their sum displays exactly
    // "0.03" — a float summing the canonical 0.1+0.2 pair would yield
    // 0.30000000000000004.
    const fee1 = computeFee(10_000_000n, '0.1')
    const fee2 = computeFee(20_000_000n, '0.1')
    expect(toDisplay(fee1)).toBe('0.01')
    expect(toDisplay(fee2)).toBe('0.02')
    const sum = fee1 + fee2 // 3_000_000n = 0.03 whole
    expect(toDisplay(sum)).toBe('0.03')
    // The witness: the canonical float drift pair does drift (proving the
    // boundary is what keeps the ledger clean) — and the boundary's
    // output never carries the artifact.
    expect(String(0.1 + 0.2)).toBe('0.30000000000000004')
    expect(toDisplay(sum)).not.toBe('0.30000000000000004')
  })

  it('is pure: the same input called twice gives the same result', () => {
    expect(computeFee(10_000_000n, '0.1')).toBe(computeFee(10_000_000n, '0.1'))
    expect(computeFee(20_000_000n, '0.1')).toBe(computeFee(20_000_000n, '0.1'))
    // Repeated calls cannot accumulate state or drift.
    expect(computeFee(1_234_567_890n, '0.001')).toBe(1_234_567n)
    expect(computeFee(1_234_567_890n, '0.001')).toBe(1_234_567n)
  })

  it('stays exact at the 10^30 property-test ceiling (plain decimal, no exponent)', () => {
    // 10^30 base units × 0.1 = exactly 10^29 base units.
    expect(computeFee(10n ** 30n, '0.1')).toBe(10n ** 29n)
    // 10^30 × 0.125 = 1.25 × 10^29 exactly (a literal with 28+ digits is
    // easy to miscount; the expression is unambiguous).
    expect(computeFee(10n ** 30n, '0.125')).toBe(125n * 10n ** 27n)
  })

  it('rate "0" and whole-integer products are exact', () => {
    expect(computeFee(10_000_000n, '0')).toBe(0n)
    // Product that lands on an exact integer: no truncation needed.
    expect(computeFee(10n, '0.5')).toBe(5n)
  })
})

describe('FEE_TRUNCATE — truncation toward zero (dust dropped, never rounded up)', () => {
  it('computeFee(1n, "0.1") → 0n (exact product is 0.1 base units)', () => {
    // 1 base unit × 0.1 = 0.1 base units: sub-base-unit dust. Truncate,
    // never round up — dust is dropped, not credited (destination
    // semantics are 2.4's decision).
    expect(computeFee(1n, '0.1')).toBe(0n)
  })

  it('never rounds up: 19n × "0.1" = 1.9 → 1n, not 2n', () => {
    expect(computeFee(19n, '0.1')).toBe(1n)
  })

  it('truncation is deterministic across repeated calls', () => {
    expect(computeFee(1n, '0.1')).toBe(computeFee(1n, '0.1'))
    expect(computeFee(1n, '0.1')).toBe(0n)
  })
})

describe('FEE_REJECT — malformed rates and negative amounts throw SC-LEDGER-3', () => {
  it.each(['1', '-0.1', '1e-3', 'abc'])('rejects rate %j', (rate) => {
    let err: unknown
    try {
      computeFee(10_000_000n, rate)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LedgerError)
    expect(err).toBeInstanceOf(Error)
    expect((err as LedgerError).code).toBe('SC-LEDGER-3')
  })

  it('rejects a negative amount', () => {
    let err: unknown
    try {
      computeFee(-5n, '0.1')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LedgerError)
    expect(err).toBeInstanceOf(Error)
    expect((err as LedgerError).code).toBe('SC-LEDGER-3')
  })

  it('rejects rates ≥ 1 and malformed shapes with SC-LEDGER-3 (typed, not bare Error)', () => {
    // Every rejection carries the fee-boundary code — distinct from
    // SC-LEDGER-1 (invariant) and SC-LEDGER-2 (display).
    for (const rate of ['1', '-0.1', '1e-3', 'abc', '1.1', '0.', '', '.5']) {
      try {
        computeFee(10_000_000n, rate)
        expect.unreachable()
      } catch (e) {
        expect((e as LedgerError).code).toBe('SC-LEDGER-3')
      }
    }
  })
})

describe('NO_FLOAT — a fee moved via apply stays clean in toJson/toDisplay', () => {
  it('seeded fee → apply (base-unit transfer) → toJson: clean decimal, no artifact', () => {
    // The fee for a 10_000_000n transfer at 0.1, computed once (R2) and
    // moved as an ordinary base-unit transfer to a fee-destination id.
    const fee = computeFee(10_000_000n, '0.1')
    expect(fee).toBe(1_000_000n)
    const start: BalanceMap = new Map<string, bigint>([[A, 10_000_000n]])
    const next = apply(start, [{ from: A, to: B, amount: fee }])
    // The persisted form: exact bigint-backed decimal strings.
    const json = JSON.stringify(toJson(next))
    expect(json).toBe(`{"${A}":"9000000","${B}":"1000000"}`)
    // No float artifact anywhere in the encoding.
    expect(json).not.toContain('0.30000000000000004')
    expect(json).not.toContain('e-')
    expect(json).not.toContain('e+')
    // Round-trips losslessly through JSON (decimal string → BigInt exact).
    const parsed = JSON.parse(json) as Record<string, string>
    expect(BigInt(parsed[A])).toBe(9_000_000n)
    expect(BigInt(parsed[B])).toBe(1_000_000n)
  })

  it('toDisplay of post-fee balances is a clean decimal string', () => {
    const fee = computeFee(10_000_000n, '0.1')
    const start: BalanceMap = new Map<string, bigint>([[A, 10_000_000n]])
    const next = apply(start, [{ from: A, to: B, amount: fee }])
    expect(toDisplay(balanceOf(next, A))).toBe('0.09')
    expect(toDisplay(balanceOf(next, B))).toBe('0.01')
    // The 0.09 + 0.01 = 0.1 whole identity holds exactly (supply
    // conserved, no drift): 10_000_000 base units = 0.1 whole.
    expect(totalSupply(next)).toBe(10_000_000n)
    expect(toDisplay(totalSupply(next))).toBe('0.1')
  })

  it('the fee of the fee itself: chained fees stay clean (idempotent purity)', () => {
    // Recomputing the same fee (idempotent by purity) and moving it again
    // keeps every balance an exact bigint — the float drift vector never
    // enters the ledger.
    const fee1 = computeFee(10_000_000n, '0.1')
    const start: BalanceMap = new Map<string, bigint>([[A, 10_000_000n]])
    const next = apply(start, [{ from: A, to: B, amount: fee1 }])
    const fee2 = computeFee(balanceOf(next, A), '0.1') // 9_000_000 × 0.1
    expect(fee2).toBe(900_000n)
    const next2 = apply(next, [{ from: A, to: B, amount: fee2 }])
    expect(toDisplay(balanceOf(next2, A))).toBe('0.081')
    expect(toDisplay(balanceOf(next2, B))).toBe('0.019')
    // The persisted form is a clean decimal string — 1_000_000 + 900_000
    // = 1_900_000 base units, exactly.
    expect(toJson(next2)[B]).toBe('1900000')
    expect(toDisplay(totalSupply(next2))).toBe('0.1') // supply conserved
  })
})
