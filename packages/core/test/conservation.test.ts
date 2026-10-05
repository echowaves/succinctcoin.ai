/**
 * Story 2.4 matrix — the four rows of the story plan's I/O & Edge-Case
 * Matrix, verbatim. Proves the ledger's money invariants over **long
 * random closed-system transaction sequences** through the existing seam,
 * exactly as epic 3's `applyBlock` will drive it (compute the fee with
 * `computeFee`, then apply the transfers):
 *
 *   CONSERVATION_SUPPLY — a random closed-system sequence of valid txs
 *                         (fee burned) leaves `totalSupply` identical
 *                         before and after the whole sequence (asserted
 *                         at every step)
 *   FEE_EXACT           — the burn account's balance equals
 *                         `Σ computeFee(amount, rate)` exactly;
 *                         circulating supply (excl. burn) drops by
 *                         exactly that sum
 *   NO_NEGATIVE         — a valid sequence keeps every balance ≥ 0
 *                         throughout; a deliberately over-drawing tx
 *                         throws `SC-LEDGER-1` and leaves all balances
 *                         unchanged (atomic; a separate deterministic
 *                         case, not a data-dependent branch of the
 *                         property)
 *   PERSISTED_ROUNDTRIP — the final state round-trips `toJson` →
 *                         `saveState` → close → `open` → `loadState` →
 *                         `fromJson` with a **real** close/open cycle,
 *                         deep-equal to the final in-memory balances;
 *                         every persisted value a plain decimal string
 *                         (no precision loss)
 *
 * Closed system (the ticket's `unknown`, settled in Design Notes): no
 * mining/reward credit (mining is epic 3); every fee is burned to a
 * dedicated burn identity that only receives, never sends. The fixed
 * rate `"0.001"` (plain decimal, [0,1)) matches the 2.2 fixed-rate
 * decision — provenance is deferred to the consensus epic.
 *
 * Flake-free by construction: a sender is picked with balance > 0 and
 * an amount in [0, ⌊balance/2⌋], so amount + fee ≤ 2·amount ≤ balance
 * (fee < amount for amount ≥ 1 since rate < 1; fee = 0 for amount = 0)
 * — every applied tx is valid. When no regular identity is funded the
 * step is a **no-op** (a fully-burned closed system is a valid terminal
 * state, all invariants hold trivially; the only data-dependent branch,
 * invariant-preserving).
 *
 * Test hygiene (AD-10): fresh `os.tmpdir()` dir per test, no real
 * sockets, no new runtime deps. The persisted half runs against the
 * real `FileChainStore` file engine (async I/O) → `fc.asyncProperty`
 * (this is why the story runs after 2.3). Initial balances are capped
 * at 10³⁰ (E1 ceiling per value); supply never increases (no mining),
 * so every value stays ≤ its initial balance and the round-trip stays
 * within E1.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fc from 'fast-check'

import {
  FileChainStore,
  LedgerError,
  apply,
  balanceOf,
  computeFee,
  fromJson,
  toJson,
  totalSupply,
} from '../src/index.js'
import type { BalanceMap } from '../src/index.js'

// ---- harness -------------------------------------------------------------

// The epic's property-test ceiling: balances up to 10³⁰ base units (E1).
const MAX_UNITS = 10n ** 30n

// Fixed fee rate, plain decimal in [0,1) — the 2.2 fixed-rate decision;
// `computeFee` never rejects it (provenance lands with the consensus epic).
const RATE = '0.001'

// The burn identity: receives every fee, never sends. The seam does not
// validate id format (protocol rules are consensus' job, AD-2).
const BURN = 'burn'

// One random closed-system scenario: N regular identities (id-0 … id-N-1)
// with initial balances in [0, 10³⁰], plus a stream of raw random picks
// (3 per step: sender pick, amount pick, receiver pick) driving the steps.
// The amount bound is runtime-dependent (⌊balance/2⌋), so the step data is
// generated raw and derived at simulation time.
interface Scenario {
  readonly n: number
  readonly balances: readonly bigint[]
  readonly picks: readonly number[]
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.integer({ min: 2, max: 6 }),
    fc.array(fc.integer({ min: 0, max: 0x7fffffff }), { minLength: 3, maxLength: 180 }),
  )
  .chain(([n, picks]) =>
    fc
      .array(fc.bigInt({ min: 0n, max: MAX_UNITS }), { minLength: n, maxLength: n })
      .map((balances): Scenario => ({ n, balances, picks })),
  )

// One closed-system run through the seam.
interface SimResult {
  readonly initial: BalanceMap
  readonly final: BalanceMap
  readonly totalFees: bigint
  /** The balance map before the run and after each step (≥ 2 entries). */
  readonly trajectory: readonly BalanceMap[]
}

/** Initial state: the scenario's regular identities + the burn at 0n. */
function initialBalances(scenario: Scenario): BalanceMap {
  const m = new Map<string, bigint>()
  for (let i = 0; i < scenario.n; i++) m.set(`id-${i}`, scenario.balances[i])
  m.set(BURN, 0n)
  return m
}

/**
 * Simulate the scenario: each step picks a sender with balance > 0, an
 * amount in [0, ⌊balance/2⌋] (so amount + fee can never overdraw), a
 * receiver, computes `fee = computeFee(amount, RATE)`, and applies
 * `[{sender→receiver, amount}, {sender→burn, fee}]` through the seam —
 * the mutation path `applyBlock` will own in epic 3. A step with no
 * funded sender is a no-op (fully-burned terminal state).
 */
function simulate(scenario: Scenario): SimResult {
  const regular: string[] = []
  for (let i = 0; i < scenario.n; i++) regular.push(`id-${i}`)

  const initial = initialBalances(scenario)
  const trajectory: BalanceMap[] = [initial]
  let balances = initial
  let totalFees = 0n

  for (let s = 0; s + 3 <= scenario.picks.length; s += 3) {
    const funded = regular.filter((id) => balanceOf(balances, id) > 0n)
    if (funded.length === 0) {
      trajectory.push(balances) // no-op: nothing left to move
      continue
    }
    const senderPick = scenario.picks[s]
    const amountPick = scenario.picks[s + 1]
    const receiverPick = scenario.picks[s + 2]

    const sender = funded[senderPick % funded.length]
    const half = balanceOf(balances, sender) / 2n
    const amount = BigInt(amountPick) % (half + 1n)
    const receiver = regular[receiverPick % regular.length]
    const fee = computeFee(amount, RATE)

    balances = apply(balances, [
      { from: sender, to: receiver, amount },
      { from: sender, to: BURN, amount: fee },
    ])
    totalFees += fee
    trajectory.push(balances)
  }

  return { initial, final: balances, totalFees, trajectory }
}

// ---- hygiene -------------------------------------------------------------

let dir: string

/** Fresh temp data dir per test; removed after each. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-conservation-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---- matrix --------------------------------------------------------------

describe('CONSERVATION_SUPPLY — totalSupply is invariant over a random closed-system sequence', () => {
  it('apply only moves units: totalSupply is identical at every step of the sequence (property)', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const sim = simulate(scenario)
        const supply = totalSupply(sim.initial)
        for (const snapshot of sim.trajectory) {
          expect(totalSupply(snapshot)).toBe(supply)
        }
      }),
    )
  })
})

describe('FEE_EXACT — burned fees exactly account for the circulating-supply drop', () => {
  it('the burn balance equals Σ computeFee exactly; circulating supply drops by exactly that sum (property)', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const sim = simulate(scenario)
        // The burn identity starts at 0 and only ever receives the fee
        // legs — its balance is the exact fee sum, no drift.
        expect(balanceOf(sim.final, BURN)).toBe(sim.totalFees)
        // Circulating supply (excl. burn) drops by exactly that sum:
        // the amount leg stays inside the circulating pool, only the
        // fee leg leaves it.
        const circulatingBefore = totalSupply(sim.initial) // burn starts 0n
        const circulatingAfter = totalSupply(sim.final) - balanceOf(sim.final, BURN)
        expect(circulatingAfter).toBe(circulatingBefore - sim.totalFees)
      }),
    )
  })
})

describe('NO_NEGATIVE — every balance stays ≥ 0; over-draw is atomic (SC-LEDGER-1)', () => {
  it('every balance of a valid closed-system sequence stays ≥ 0 throughout (property)', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        for (const snapshot of simulate(scenario).trajectory) {
          for (const units of snapshot.values()) {
            expect(units < 0n).toBe(false)
          }
        }
      }),
    )
  })

  it('a deliberately over-drawing tx throws SC-LEDGER-1 and leaves all balances unchanged (atomic)', () => {
    // Atomicity case (NOT a realistic fee): a two-leg apply from the same
    // sender where the first leg (60n) fits in the 100n balance but the
    // second leg (41n) over-draws what the first left behind
    // (60n + 41n = 101n > 100n), so the whole apply must fail. 41n is
    // hand-picked to over-draw — it is NOT computeFee(60n, "0.001") (that
    // is 0n, since 60 × 0.001 truncates). The point is the seam's
    // atomicity: a failing leg voids the entire apply, including the first
    // leg's 60n credit.
    const start = new Map<string, bigint>([
      ['id-0', 100n],
      ['id-1', 5n],
      [BURN, 0n],
    ])
    let err: unknown
    try {
      apply(start, [
        { from: 'id-0', to: 'id-1', amount: 60n },
        { from: 'id-0', to: BURN, amount: 41n },
      ])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LedgerError)
    expect((err as LedgerError).code).toBe('SC-LEDGER-1')
    expect((err as Error).message).toContain('id-0')
    // Atomic: every balance is unchanged — the receiver's 60n credit
    // was never applied either.
    expect(totalSupply(start)).toBe(105n)
    expect(balanceOf(start, 'id-0')).toBe(100n)
    expect(balanceOf(start, 'id-1')).toBe(5n)
    expect(balanceOf(start, BURN)).toBe(0n)
  })
})

describe('PERSISTED_ROUNDTRIP — the final state survives a real store close/open with no precision loss', () => {
  it('toJson → saveState → close → open → loadState → fromJson is deep-equal to the final in-memory balances (property, async)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { final } = simulate(scenario)

        // Isolated sub-dir per run so a real close()/open() cycle is clean.
        const runDir = mkdtempSync(join(dir, 'run-'))
        try {
          const store = new FileChainStore(runDir)
          await store.open()
          await store.saveState(toJson(final))
          await store.close()

          // Every persisted amount *value* is a plain decimal string:
          // no exponent, no JSON number (a float/int64 "column" can
          // never be written — values are decimal strings, AD-5). The
          // ban is on the values, not the whole file: identity ids are
          // arbitrary labels the seam does not validate (AD-2).
          const raw = readFileSync(join(runDir, 'state', 'balances.json'), 'utf8')
          const parsed = JSON.parse(raw) as Record<string, unknown>
          for (const value of Object.values(parsed)) {
            expect(typeof value).toBe('string') // never a JSON number
            expect(value).toMatch(/^\d+$/) // plain non-negative decimal (no e+/e-)
          }

          // Real reopen: load the snapshot and decode it back.
          const reopened = new FileChainStore(runDir)
          await reopened.open()
          const loaded = await reopened.loadState()
          await reopened.close()

          expect(loaded).not.toBeNull()
          expect(fromJson(loaded!)).toEqual(final) // no precision loss
        } finally {
          rmSync(runDir, { recursive: true, force: true })
        }
      }),
      { numRuns: 25 },
    )
  })
})
