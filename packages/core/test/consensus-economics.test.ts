/**
 * CONSENSUS ECONOMICS — the 3.6 economic-model matrix (reward + fees in
 * `applyBlock`): the seven rows of the story plan's I/O & Edge-Case
 * Matrix, verbatim.
 *
 *   REWARD_CREDIT                the winner is credited the reward, the
 *                                mint is debited, `totalSupply` is
 *                                conserved (the 3.2/3.5 behavior —
 *                                backward compatible)
 *   FEE_COMPUTED_AT_BOUNDARY     the fee = `computeFee(amount, FEE_RATE)`
 *                                EXACTLY (the 2.2 boundary — asserted
 *                                against an independent call); the
 *                                recipient gets the FULL amount (not
 *                                amount − fee); the sender loses
 *                                amount + fee; `totalSupply` conserved
 *   FEE_BURNED_DESTINATION       the fee lands in `BURN_ID` (burn — NOT
 *                                the winner): the winner's balance = the
 *                                block reward ONLY
 *   TOTAL_SUPPLY_CONSERVED_      a SEQUENCE of N blocks, each with a tx,
 *   SEQUENCE                     through a REAL `FileChainStore`: at
 *                                EVERY step `totalSupply` is invariant;
 *                                afterwards `BURN_ID` = Σ fees, the
 *                                winner = Σ rewards, and circulating
 *                                (excl. mint + burn) = initial + Σ
 *                                rewards − Σ fees
 *   FEE_RATE_NAMED_ORIGIN        the fee equals `computeFee(amount,
 *                                FEE_RATE)` using the IMPORTED named
 *                                constant (one named origin — not an
 *                                inline test constant)
 *   NO_TXS_NO_FEE                a 0-tx block (the tracer path) behaves
 *                                exactly as 3.2/3.5: reward credit only,
 *                                no fee, `BURN_ID` untouched
 *   OVERDRAW_REJECTS             a tx whose amount + fee exceeds the
 *                                sender's balance throws `SC-LEDGER-1`
 *                                BEFORE `store.commit`/`saveState`
 *                                (atomic — ledger first)
 *
 * `applyBlock` does NOT re-check PoW (that is `mineBlock`'s job, 3.2), so
 * the blocks are constructed directly with valid field types — no mining.
 * The simple rows use a fake no-op `StorePort` that records its
 * `commit`/`saveState` calls (the atomic-ordering proof); the sequence
 * row uses a real `FileChainStore` in a temp dir (the full
 * `commit`+`saveState` path, mirroring the store-test setup/teardown).
 * Test hygiene (AD-10): fresh `os.tmpdir()` dir, no real sockets, no new
 * runtime deps. Imports from the root barrel only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BURN_ID,
  FEE_RATE,
  FileChainStore,
  MINT_ID,
  TRACER_WINNER_ID,
  applyBlock,
  balanceOf,
  computeFee,
  fromDisplay,
  totalSupply,
} from '../src/index.js'
import type { BalanceMap, Block, StorePort } from '../src/index.js'

// Economic parameters (display form, as the genesis emission carries them —
// the same values 3.2/3.5 pin): the reward + the treasury's max supply.
const REWARD_BASE = fromDisplay('12.5')
const MAX_SUPPLY_BASE = fromDisplay('21000000')

// 64-hex identity ids (protocol-shaped; the ledger seam does not validate
// id format — protocol rules are consensus' job, AD-2). Distinct from the
// reserved MINT_ID (…001) / TRACER_WINNER_ID (…002) / BURN_ID (…003).
const SENDER_1 = '0'.repeat(60) + '0a0b'
const SENDER_2 = '0'.repeat(60) + '0a0c'
const RECIPIENT = '0'.repeat(60) + '0a0d'

// A funded sender balance (10^10 base units) — far above every amount +
// fee this file applies, except the deliberate over-draw row.
const FUND = 10_000_000_000n

let dir: string

/** Fresh temp data dir per test; removed after each (store-test pattern). */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-economics-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake no-op `StorePort` that records its `commit`/`saveState` calls —
 * the atomic-ordering witness: `applyBlock` must run the ledger FIRST, and
 * an over-draw must leave both counters at zero.
 */
class FakeStore implements StorePort {
  commits = 0
  saveStates = 0
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async commit(): Promise<void> {
    this.commits += 1
  }
  async headSlot(): Promise<number> {
    return -1
  }
  async getBlock(): Promise<Uint8Array | null> {
    return null
  }
  async saveState(): Promise<void> {
    this.saveStates += 1
  }
  async loadState(): Promise<Record<string, string> | null> {
    return null
  }
}

/**
 * A directly-constructed block with valid field types: `applyBlock` does
 * NOT re-check PoW (3.2's `mineBlock` owns that), so the nonce/hash may be
 * zero. `txCount` is 0n — `applyBlock` consumes the `txs` VIEW, not the
 * block's `txCount`.
 */
function makeBlock(slot: bigint, parentHash: Uint8Array<ArrayBuffer>, winner: string): Block {
  return {
    slot,
    parentHash,
    winnerIdentityId: winner,
    winnerTicket: new Uint8Array(0),
    nonce: new Uint8Array(8),
    hash: new Uint8Array(32),
    txCount: 0n,
  }
}

/** Pre-funded treasury balances (the closed system `applyBlock` credits). */
function treasuryBalances(): BalanceMap {
  return new Map<string, bigint>([[MINT_ID, MAX_SUPPLY_BASE]])
}

// ---- matrix --------------------------------------------------------------

describe('REWARD_CREDIT — the winner is credited, the mint debited, totalSupply conserved', () => {
  it('winner += reward, mint -= reward, totalSupply unchanged; block committed + snapshot saved', async () => {
    const store = new FakeStore()
    const block = makeBlock(0n, new Uint8Array(32), TRACER_WINNER_ID)

    const after = await applyBlock({
      store,
      block,
      balances: treasuryBalances(),
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
    })

    expect(balanceOf(after, TRACER_WINNER_ID)).toBe(REWARD_BASE)
    expect(balanceOf(after, MINT_ID)).toBe(MAX_SUPPLY_BASE - REWARD_BASE)
    expect(totalSupply(after)).toBe(MAX_SUPPLY_BASE) // conserved (closed system)
    // The single apply ran, then the commit + snapshot (AD-2 ordering).
    expect(store.commits).toBe(1)
    expect(store.saveStates).toBe(1)
  })
})

describe('FEE_COMPUTED_AT_BOUNDARY — the fee is the 2.2 boundary output, exactly', () => {
  it('burn = computeFee(amount, FEE_RATE) exactly; recipient += amount (FULL); sender -= amount + fee; totalSupply conserved', async () => {
    const amount = 1_234_567_890n
    const fee = computeFee(amount, FEE_RATE)
    const balances = new Map<string, bigint>([
      [MINT_ID, MAX_SUPPLY_BASE],
      [SENDER_1, FUND],
    ])
    const block = makeBlock(0n, new Uint8Array(32), TRACER_WINNER_ID)

    const after = await applyBlock({
      store: new FakeStore(),
      block,
      balances,
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
      txs: [{ from: SENDER_1, to: RECIPIENT, amount }],
    })

    // The burn delta equals an INDEPENDENT `computeFee` call (the 2.2
    // boundary's output — not re-implemented, not inlined).
    expect(balanceOf(after, BURN_ID)).toBe(computeFee(amount, FEE_RATE))
    // The recipient gets the FULL amount — NOT amount − fee.
    expect(balanceOf(after, RECIPIENT)).toBe(amount)
    // The sender loses amount + fee.
    expect(balanceOf(after, SENDER_1)).toBe(FUND - amount - fee)
    // Within-supply transfers: totalSupply conserved.
    expect(totalSupply(after)).toBe(MAX_SUPPLY_BASE + FUND)
  })
})

describe('FEE_BURNED_DESTINATION — the fee burns to BURN_ID, never to the winner', () => {
  it('BURN_ID = Σ fees (one tx here); the winner = the block reward ONLY (not reward + fee)', async () => {
    const amount = 500_000_000n
    const fee = computeFee(amount, FEE_RATE)
    expect(fee).toBeGreaterThan(0n) // a non-zero fee
    const balances = new Map<string, bigint>([
      [MINT_ID, MAX_SUPPLY_BASE],
      [SENDER_1, FUND],
    ])
    const block = makeBlock(0n, new Uint8Array(32), TRACER_WINNER_ID)

    const after = await applyBlock({
      store: new FakeStore(),
      block,
      balances,
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
      txs: [{ from: SENDER_1, to: RECIPIENT, amount }],
    })

    // The fee lands in the burn identity (Σ fees over the one tx).
    expect(balanceOf(after, BURN_ID)).toBe(fee)
    // The winner's balance is the reward ONLY — never reward + fees
    // (uptime-only R1: the reward must not depend on network traffic).
    expect(balanceOf(after, TRACER_WINNER_ID)).toBe(REWARD_BASE)
  })
})

describe('TOTAL_SUPPLY_CONSERVED_SEQUENCE — totalSupply invariant over a sequence of mined blocks (real FileChainStore)', () => {
  it(`N=25 blocks, one tx each: totalSupply conserved at EVERY step; BURN_ID = Σ fees; winner = Σ rewards`, async () => {
    const store = new FileChainStore(dir)
    await store.open()
    try {
      const N = 25
      const initial = new Map<string, bigint>([
        [MINT_ID, MAX_SUPPLY_BASE],
        [SENDER_1, FUND],
        [SENDER_2, FUND],
      ])
      const initialTotal = totalSupply(initial) // maxSupply + 2·FUND
      const initialCirculating = totalSupply(initial) - balanceOf(initial, MINT_ID) - balanceOf(initial, BURN_ID)

      let balances: BalanceMap = initial
      let totalFees = 0n
      let parentHash: Uint8Array<ArrayBuffer> = new Uint8Array(32)

      for (let i = 0; i < N; i++) {
        const sender = i % 2 === 0 ? SENDER_1 : SENDER_2
        const amount = 10_000_000n + 100_000n * BigInt(i)
        const block = makeBlock(BigInt(i), parentHash, TRACER_WINNER_ID)
        balances = await applyBlock({
          store,
          block,
          balances,
          rewardBaseUnits: REWARD_BASE,
          mintId: MINT_ID,
          txs: [{ from: sender, to: RECIPIENT, amount }],
        })
        // The CONSERVATION_SUPPLY invariant, asserted at EVERY step: the
        // reward (mint → winner) and the fee (sender → BURN_ID) are both
        // within-supply transfers, so the total is invariant.
        expect(totalSupply(balances)).toBe(initialTotal)
        totalFees += computeFee(amount, FEE_RATE)
        parentHash = block.hash
      }

      // Afterwards: the burn account holds exactly Σ fees over the whole
      // sequence, and the winner holds exactly Σ rewards.
      expect(balanceOf(balances, BURN_ID)).toBe(totalFees)
      expect(balanceOf(balances, TRACER_WINNER_ID)).toBe(BigInt(N) * REWARD_BASE)
      // Circulating supply (excl. mint + burn) = initial circulating +
      // Σ rewards − Σ fees (the reward credit is within-supply too; only
      // fees leave circulation).
      const circulating =
        totalSupply(balances) - balanceOf(balances, MINT_ID) - balanceOf(balances, BURN_ID)
      expect(circulating).toBe(initialCirculating + BigInt(N) * REWARD_BASE - totalFees)
    } finally {
      await store.close()
    }
  })
})

describe('FEE_RATE_NAMED_ORIGIN — the fee rate is the single imported named constant', () => {
  it('the applied fee equals computeFee(amount, FEE_RATE) with the imported FEE_RATE (one named origin)', async () => {
    const amount = 987_654_321n
    const balances = new Map<string, bigint>([
      [MINT_ID, MAX_SUPPLY_BASE],
      [SENDER_2, FUND],
    ])
    const block = makeBlock(0n, new Uint8Array(32), TRACER_WINNER_ID)

    const after = await applyBlock({
      store: new FakeStore(),
      block,
      balances,
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
      txs: [{ from: SENDER_2, to: RECIPIENT, amount }],
    })

    // The rate in use is the IMPORTED `FEE_RATE` named constant (one named
    // origin — not an inline literal): the burn delta equals
    // `computeFee(amount, FEE_RATE)` for the barrel-exported constant.
    expect(balanceOf(after, BURN_ID)).toBe(computeFee(amount, FEE_RATE))
    // And the named constant is the 2.2 fee-boundary form: a plain decimal
    // in [0,1) with the settled value (a protocol constant — a change is a
    // protocol version bump).
    expect(FEE_RATE).toMatch(/^\d+(\.\d+)?$/)
    expect(FEE_RATE).toBe('0.001')
  })
})

describe('NO_TXS_NO_FEE — backward compat: a 0-tx block behaves exactly as 3.2/3.5', () => {
  it('reward credit only; no fee; BURN_ID untouched; totalSupply conserved', async () => {
    const store = new FakeStore()
    const block = makeBlock(0n, new Uint8Array(32), TRACER_WINNER_ID)

    // `txs` omitted entirely (the tracer's `mineAndApply` path).
    const after = await applyBlock({
      store,
      block,
      balances: treasuryBalances(),
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
    })

    expect(balanceOf(after, TRACER_WINNER_ID)).toBe(REWARD_BASE)
    expect(balanceOf(after, MINT_ID)).toBe(MAX_SUPPLY_BASE - REWARD_BASE)
    expect(balanceOf(after, BURN_ID)).toBe(0n) // untouched — no fee
    expect(totalSupply(after)).toBe(MAX_SUPPLY_BASE) // conserved
    expect(store.commits).toBe(1)
    expect(store.saveStates).toBe(1)
  })
})

describe('OVERDRAW_REJECTS — an over-drawing tx throws SC-LEDGER-1 before commit (atomic)', () => {
  it('amount + fee > sender balance → SC-LEDGER-1; the fake store never saw commit/saveState', async () => {
    const amount = 4_000_000n
    const fee = computeFee(amount, FEE_RATE)
    // The sender holds LESS than amount + fee (the over-draw), but the
    // mint is funded — so the ONLY failing debit is the sender's.
    const balances = new Map<string, bigint>([
      [MINT_ID, MAX_SUPPLY_BASE],
      [SENDER_1, amount + fee - 2_000n],
    ])
    const store = new FakeStore()
    const block = makeBlock(0n, new Uint8Array(32), TRACER_WINNER_ID)

    const err: unknown = await applyBlock({
      store,
      block,
      balances,
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
      txs: [{ from: SENDER_1, to: RECIPIENT, amount }],
    }).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-LEDGER-1')
    // Atomic ordering (AD-2): ledger FIRST — the store never ran.
    expect(store.commits).toBe(0)
    expect(store.saveStates).toBe(0)
  })
})
