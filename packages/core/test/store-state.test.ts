/**
 * Story 2.3 matrix — the five rows of the story plan's I/O & Edge-Case
 * Matrix, verbatim. Proves the store's balance-state snapshot (AD-5): a
 * canonical JSON document of identity → decimal-string base units, persisted
 * atomically under the existing exclusive lock, and the ledger's inverse
 * decoder `fromJson`.
 *
 *   SNAPSHOT_ROUNDTRIP — random `BalanceMap` (fast-check BigInts 0 … 10³⁰)
 *                        → `toJson` → `saveState` → `close` → `open` →
 *                        `loadState` → `fromJson` is deep-equal to the
 *                        original; the on-disk file is plain decimal (no
 *                        `e+`/`e-`, no JSON numbers)
 *   FLOAT_INT64_REJECT — a raw state file with JSON-number amounts
 *                        (`{"a":1.5}`, `{"a":123}`) → `loadState` rejects
 *                        `SC-STORE-3`
 *   BASE_UNIT_REJECT   — `fromJson` on `"1.5"`, `"1e8"`, `"12a"`, `""`,
 *                        `"-5"` throws `SC-LEDGER-4`
 *   CANONICAL_BYTES    — the same record saved with two key orders is
 *                        byte-identical (deterministic)
 *   ABSENT_VS_EMPTY    — fresh store: `loadState` → `null`; then
 *                        `saveState(toJson(empty map))` → `loadState` → `{}`
 *
 * Test hygiene (AD-10): fresh `os.tmpdir()` dir per test, no real sockets,
 * no new runtime deps. The round-trip is a real `close()`/`open()` cycle
 * against the real `FileChainStore` file engine.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fc from 'fast-check'

import { FileChainStore, StoreError, fromJson, toJson } from '../src/index.js'
import type { BalanceMap } from '../src/index.js'

// The epic's property-test ceiling: balances up to 10³⁰ base units (E1).
const MAX_UNITS = 10n ** 30n

// A balance map: identity ids → base units in [0, 10³⁰]. `fc.dictionary`
// yields a `Record<string, bigint>`; the ledger works on a `Map` (BalanceMap
// is a ReadonlyMap), so convert. (fast-check 4.10.2 has no `hexaString`;
// `fc.string` is the documented equivalent for arbitrary identity ids — the
// seam does not validate id format, protocol rules are consensus' job, AD-2.)
const idArb = fc.string()
const amountArb = fc.bigInt({ min: 0n, max: MAX_UNITS })
const balanceMapArb: fc.Arbitrary<BalanceMap> = fc
  .dictionary(idArb, amountArb)
  .map((rec) => new Map(Object.entries(rec)))

// ---- helpers -------------------------------------------------------------

let dir: string

/** Fresh temp data dir per test; removed after each. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-store-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const stateFile = (d: string): string => join(d, 'state', 'balances.json')

/** Read the on-disk snapshot document as raw text (null if absent). */
function rawState(d: string): string | null {
  try {
    return readFileSync(stateFile(d), 'utf8')
  } catch {
    return null
  }
}

// ---- matrix --------------------------------------------------------------

describe('SNAPSHOT_ROUNDTRIP — random balances ≤ 10³⁰ persist and reload losslessly', () => {
  it('toJson → saveState → close → open → loadState → fromJson is deep-equal (property)', async () => {
    await fc.assert(
      fc.asyncProperty(balanceMapArb, async (balances) => {
        // Isolated sub-dir per run so a real close()/open() cycle is clean.
        const runDir = mkdtempSync(join(dir, 'run-'))
        try {
          const store = new FileChainStore(runDir)
          await store.open()
          await store.saveState(toJson(balances))
          await store.close()

          // The on-disk document's amount *values* are plain decimal: no
          // exponent, no JSON numbers (a float/int64 "column" can never be
          // written — values are decimal strings, AD-5). The exponent ban is
          // on the values, not the whole file: identity ids are arbitrary
          // strings (the seam does not validate id format, AD-2), so a file-
          // level "no e+/e-" check would be a false positive.
          const raw = rawState(runDir)
          expect(raw).not.toBeNull()
          const parsed = JSON.parse(raw!) as Record<string, unknown>
          for (const value of Object.values(parsed)) {
            expect(typeof value).toBe('string') // never a JSON number
            expect(value).toMatch(/^\d+$/) // plain non-negative decimal integer (no e+/e-)
          }

          // Real reopen: load the snapshot and decode it back.
          const re = new FileChainStore(runDir)
          await re.open()
          const loaded = await re.loadState()
          await re.close()

          expect(loaded).not.toBeNull()
          expect(fromJson(loaded!)).toEqual(balances) // no precision loss
        } finally {
          rmSync(runDir, { recursive: true, force: true })
        }
      }),
      { numRuns: 50 },
    )
  })

  it('a 10³⁰ boundary balance round-trips exactly (no exponent, no drift)', async () => {
    const balances: BalanceMap = new Map<string, bigint>([
      ['a'.repeat(64), MAX_UNITS],
      ['b'.repeat(64), MAX_UNITS - 1n],
      ['c'.repeat(64), 0n],
    ])
    const store = new FileChainStore(dir)
    await store.open()
    await store.saveState(toJson(balances))
    await store.close()

    const re = new FileChainStore(dir)
    await re.open()
    const loaded = await re.loadState()
    await re.close()

    expect(fromJson(loaded!)).toEqual(balances)
    // The 10³⁰ value is a 31-char plain decimal — never "1e+30".
    expect(rawState(dir)).toContain('1000000000000000000000000000000')
    expect(rawState(dir)).not.toContain('e+')
  })
})

describe('FLOAT_INT64_REJECT — JSON-number amounts die on loadState (SC-STORE-3)', () => {
  it.each([
    ['{"a":1.5}', 'a float amount'],
    ['{"a":123}', 'an int64 amount'],
    ['{"a":1e8}', 'an exponent amount'],
  ])('a raw state file holding %s is rejected', async (doc) => {
    // Write a malformed document directly (bypassing saveState, which is
    // storage-agnostic and only ever given decimal strings).
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(stateFile(dir), doc)

    const store = new FileChainStore(dir)
    await store.open()
    const err: unknown = await store.loadState().catch((e) => e)
    await store.close()

    expect(err).toBeInstanceOf(StoreError)
    expect((err as { code: string }).code).toBe('SC-STORE-3')
    expect((err as Error).message).toContain('SC-STORE-3')
  })

  it('a non-object document (JSON array) is also SC-STORE-3', async () => {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(stateFile(dir), '["a","b"]')

    const store = new FileChainStore(dir)
    await store.open()
    const err: unknown = await store.loadState().catch((e) => e)
    await store.close()

    expect((err as { code?: string }).code).toBe('SC-STORE-3')
  })
})

describe('BASE_UNIT_REJECT — fromJson rejects non-plain-decimal / negative values (SC-LEDGER-4)', () => {
  it.each(['1.5', '1e8', '12a', '', '-5'])('fromJson rejects %j', (bad) => {
    let err: unknown
    try {
      fromJson({ a: bad })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-LEDGER-4')
    expect((err as Error).message).toContain('SC-LEDGER-4')
  })

  it('fromJson accepts a plain non-negative decimal integer', () => {
    expect(fromJson({ a: '123' })).toEqual(new Map([['a', 123n]]))
    expect(fromJson({ a: '0' })).toEqual(new Map([['a', 0n]]))
    expect(fromJson({})).toEqual(new Map())
  })
})

describe('CANONICAL_BYTES — the same record saved with two key orders is byte-identical', () => {
  it('saveState is deterministic (sorted keys) regardless of input order', async () => {
    const store = new FileChainStore(dir)
    await store.open()

    const doc1: Record<string, string> = { a: '1', b: '2', c: '3' }
    const doc2: Record<string, string> = { c: '3', a: '1', b: '2' }

    await store.saveState(doc1)
    const bytes1 = readFileSync(stateFile(dir))

    await store.saveState(doc2)
    const bytes2 = readFileSync(stateFile(dir))

    await store.close()

    expect(bytes1.equals(bytes2)).toBe(true)
    // The canonical form sorts keys: a, b, c.
    expect(rawState(dir)).toBe('{"a":"1","b":"2","c":"3"}')
  })
})

describe('ABSENT_VS_EMPTY — null means "no snapshot yet"; {} means "state exists, zero balances"', () => {
  it('a fresh store loads null; an empty-map snapshot loads {}', async () => {
    const store = new FileChainStore(dir)
    await store.open()

    // No snapshot written yet.
    expect(await store.loadState()).toBeNull()
    expect(rawState(dir)).toBeNull()

    // Save the empty map's snapshot: an empty document, not an absent one.
    await store.saveState(toJson(new Map()))
    expect(rawState(dir)).toBe('{}')
    expect(await store.loadState()).toEqual({})

    await store.close()
  })
})
