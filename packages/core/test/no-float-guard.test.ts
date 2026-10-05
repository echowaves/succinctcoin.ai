/**
 * Story 2.5 matrix — a single standing guard for the three AD-5 invariants
 * that the plan's I/O & Edge-Case Matrix pins:
 *
 *   BIG_JS_ONLY_BOUNDARY — `big.js` is imported by exactly two modules in
 *                          `src/`: `ledger/fee.ts` (the fee boundary) and
 *                          `ledger/display.ts` (the display boundary). The
 *                          scan matches IMPORT STATEMENTS only — every
 *                          doc comment that *mentions* "big.js" in prose
 *                          (fee.ts, display.ts, ledger.ts, the `big-js.d.ts`
 *                          shim) must never be flagged.
 *   NO_FLOAT_IN_LEDGER   — the ledger's comment-stripped source (minus the
 *                          `*.d.ts` shim, which declares big.js's own
 *                          `number | string | Big` engine surface) contains
 *                          no `number` type, no `Number(`, no `Math.`, no
 *                          float literal, no exponential literal. Scope is
 *                          the ledger only: the store's `Number(b.slot)` is
 *                          a slot index, not money.
 *   JSON_STRINGIFY_BALANCE — `JSON.stringify(toJson(map))` never throws and
 *                          never drifts: every value is a plain decimal base
 *                          unit string (`/^\d+$/`, no float, no e-notation).
 *
 * Test-only: the guard scans source and exercises `toJson` but edits nothing.
 * If a scan fails, the fix is in the offending source (a future story), not
 * by weakening this guard.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import fc from 'fast-check'

import { toJson } from '../src/ledger/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')
const ledgerDir = join(srcDir, 'ledger')

/**
 * Recursively collect every `.ts` file under `dir` (same shape as
 * `no-ui-imports.test.ts`).
 */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Remove block and line comments (both preserved as blank lines so line
 * structure is intact). Safe for this codebase because no string or template
 * literal contains a comment marker (verified across `src/`); the block
 * regex is non-greedy so a comment body that contains a slash never swallows
 * past its real close.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** `dir`-relative path with `/` separators (stable for assertion messages). */
function rel(dir: string, p: string): string {
  return p.slice(dir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// BIG_JS_ONLY_BOUNDARY
// ---------------------------------------------------------------------------

// The idiomatic import forms in an ESM NodeNext codebase (mirrors
// `no-ui-imports.test.ts`'s specifier regex, specialized to the module
// literal `big.js`): static `from "x"` / `import "x"`, dynamic
// `import("x")` (with or without an inner space), and CJS `require("x")`.
// `declare module 'big.js'` (the shim) contains none of these prefixes, so
// the ambient declaration never matches.
const BIG_JS_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']big\.js["']/

describe('BIG_JS_ONLY_BOUNDARY — big.js imported only by ledger/fee.ts + ledger/display.ts', () => {
  it('scans src/** import statements and finds big.js in exactly the two boundary modules', () => {
    const files = tsFiles(srcDir)
    expect(files.length).toBeGreaterThan(0)
    const offenders = files
      .filter((f) => BIG_JS_IMPORT.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(
      offenders,
      `big.js import statements found in:\n${offenders.join('\n')}\nexpected exactly ledger/fee.ts + ledger/display.ts`,
    ).toEqual(['ledger/display.ts', 'ledger/fee.ts'])
  })

  it('a comment that mentions big.js is NOT flagged, but a real import IS (self-test)', () => {
    // Prose comments (the fee.ts / display.ts / ledger.ts / shim doc
    // comments all say so) must never be flagged.
    expect(stripComments('/* the only decimal engine is big.js here */\n// import Big from "big.js"')).not.toMatch(BIG_JS_IMPORT)
    // The shim's ambient declaration is not an import statement.
    expect(stripComments("declare module 'big.js' { export default class Big {} }")).not.toMatch(BIG_JS_IMPORT)
    // A real import statement (any idiomatic form) IS an offender.
    expect(BIG_JS_IMPORT.test("import Big from 'big.js'")).toBe(true)
    expect(BIG_JS_IMPORT.test('import Big from "big.js"')).toBe(true)
    expect(BIG_JS_IMPORT.test("const Big = require('big.js')")).toBe(true)
    expect(BIG_JS_IMPORT.test('const B = await import("big.js")')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NO_FLOAT_IN_LEDGER
// ---------------------------------------------------------------------------

// Floating-point in the ledger: the `number` primitive type (`\b` stops it
// matching camelCase ids like `someNumber`), `Number(`, the `Math.` namespace,
// a float literal (`1.5`), or an exponential literal (`1e8` / `1e+8` / `1E-3`).
// `number` does not match `number(` — the next char is a non-word `(`, so the
// `\b` after `r` is not a boundary.
const FLOAT_IN_LEDGER = /\bnumber\b|\bNumber\(|\bMath\.|\d+\.\d+|\d+[eE][+-]?\d+/

describe('NO_FLOAT_IN_LEDGER — no floating-point type/literal in comment-stripped ledger source (excl *.d.ts)', () => {
  it('scans src/ledger/*.ts (minus *.d.ts) and finds no float type or literal', () => {
    const files = tsFiles(ledgerDir).filter((f) => !f.endsWith('.d.ts'))
    expect(files.length).toBeGreaterThan(0)
    // The `big-js.d.ts` shim declares big.js's own `number | string | Big`
    // engine surface — that is the engine's type, not ledger arithmetic — so
    // it is excluded from the scan.
    expect(tsFiles(ledgerDir).some((f) => f.endsWith('big-js.d.ts'))).toBe(true)
    const offenders = files
      .filter((f) => FLOAT_IN_LEDGER.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(ledgerDir, f))
      .sort()
    expect(offenders, `floating-point type/literal found in ledger source:\n${offenders.join('\n')}`).toEqual([])
  })

  it('float patterns are caught in code but NOT in comments (self-test)', () => {
    // Real floating-point constructs ARE offenders.
    expect(FLOAT_IN_LEDGER.test('const x: number = 1.5')).toBe(true)
    expect(FLOAT_IN_LEDGER.test('Number("5")')).toBe(true)
    expect(FLOAT_IN_LEDGER.test('Math.floor(1)')).toBe(true)
    expect(FLOAT_IN_LEDGER.test('const r = 1e8')).toBe(true)
    expect(FLOAT_IN_LEDGER.test('const r = 1e+8')).toBe(true)
    // camelCase identifiers containing "number" are NOT (word boundary).
    expect(FLOAT_IN_LEDGER.test('const someNumber = 5n')).toBe(false)
    // The same constructs inside comments are NOT (comment-stripped first).
    expect(FLOAT_IN_LEDGER.test(stripComments('/* a number like 1.5, via Number("5") and Math.floor, and 1e8 */'))).toBe(false)
    expect(FLOAT_IN_LEDGER.test(stripComments('// never `/` on numbers (float 1.5) — big.js instead'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// JSON_STRINGIFY_BALANCE
// ---------------------------------------------------------------------------

// The property ceiling: balances up to 10³⁰ base units (matches the 2.4
// conservation property, E1).
const MAX_UNITS = 10n ** 30n

describe('JSON_STRINGIFY_BALANCE — JSON.stringify(toJson(map)) never throws and never drifts', () => {
  // A deterministic map spanning the scale the plan names: 0, 1, a mid
  // value (a whole coin = 10⁸ base units), and a 10³⁰-scale value.
  const DETERMINISTIC = new Map<string, bigint>([
    ['id-zero', 0n],
    ['id-one', 1n],
    ['id-whole', 10n ** 8n],
    ['id-huge', 123456789012345678901234567890n], // ~1.2e29, 10³⁰-scale
  ])

  it('a deterministic map stringifies without throwing, round-trips exactly, and every value is a plain decimal integer string', () => {
    // `JSON.stringify` of a raw BigInt map throws `TypeError` (BigInt is not
    // JSON-serializable) — `toJson` is what avoids that by projecting every
    // balance to a decimal string BEFORE stringify. The `toJson` output is
    // both safe (no BigInt to throw on) and drift-free (the decimal form is
    // exact, so `JSON.parse` returns it byte-for-byte).
    expect(() => JSON.stringify(Object.fromEntries(DETERMINISTIC))).toThrow(TypeError)

    const doc = toJson(DETERMINISTIC)
    const serialized = JSON.stringify(doc) // must not throw (no BigInt inside)
    expect(serialized).not.toBeNull()
    expect(JSON.parse(serialized)).toEqual(doc) // never drifts
    for (const value of Object.values(doc)) {
      expect(value).toMatch(/^\d+$/) // plain non-negative decimal base units: no float, no e-notation
    }
  })

  it('property: for random balances ≤ 10³⁰, stringify(toJson) never throws, round-trips exactly, and all values are plain decimals', () => {
    const idArb = fc.string().filter((id) => id !== '__proto__')
    const mapArb = fc
      .dictionary(idArb, fc.bigInt({ min: 0n, max: MAX_UNITS }))
      .map((rec) => new Map(Object.entries(rec)))
    return fc.assert(
      fc.property(mapArb, (balances) => {
        const doc = toJson(balances)
        const serialized = JSON.stringify(doc) // must not throw
        expect(JSON.parse(serialized)).toEqual(doc) // never drifts
        for (const value of Object.values(doc)) {
          if (!/^\d+$/.test(value)) return false
        }
        return true
      }),
    )
  })
})
