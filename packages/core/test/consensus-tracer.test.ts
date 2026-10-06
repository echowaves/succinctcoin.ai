/**
 * CONSENSUS TRACER — the one-block tracer matrix (3.2: R3/R4/R5 + the
 * per-attempt-path guard).
 *
 *   MINE_BLOCK        mineBlock returns a block whose u64be counter makes
 *                     `powCheck` true and `hash = blockDigest(block)`.
 *   APPLY_REWARD      applyBlock credits the reward to the winner through
 *                     the ledger `apply` seam (winner += reward,
 *                     mint -= reward, totalSupply unchanged), commits the
 *                     block, and saves the balance snapshot.
 *   PERSIST_RELOAD    a committed block + saved balances survive a real
 *                     `FileChainStore` close/open in a temp dir:
 *                     `getBlock` decodes, the recomputed hash matches the
 *                     stored hash, `powCheck` is true, and `loadState`
 *                     balances match.
 *   CHAIN_TIME_SLOT   nextSlotAndParent from the store: empty → slot 0 +
 *                     32 zero bytes; non-empty → head+1 + the head block's
 *                     stored hash (chain time, never the wall clock).
 *   MINING_PATH_GUARD the per-attempt mining path (miner.ts) imports no
 *                     big.js and no keccak (AD-6) — the only byte work per
 *                     attempt is the 3.1 PoW seam (node:crypto sha256).
 *
 * Test hygiene (AD-10): fresh `os.tmpdir()` dir per test (the real
 * `FileChainStore`, mirroring the store tests' setup/teardown), no real
 * sockets, no new runtime deps.
 */
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  TRACER_WINNER_ID,
  apply,
  applyBlock,
  balanceOf,
  blockDigest,
  fromDisplay,
  fromJson,
  mineAndApply,
  mineBlock,
  nextSlotAndParent,
  powCheck,
  totalSupply,
  toJson,
} from '../src/index.js'
import type { BalanceMap } from '../src/index.js'

// Fixed-emission parameters (display form, as the genesis emission carries
// them): the tracer's reward + the treasury's max supply. The one-time
// `fromDisplay` conversion (AD-5 big.js boundary) happens in the tracer
// itself — these are the DISPLAY inputs.
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'
const REWARD_BASE = fromDisplay(REWARD_DISPLAY)
const MAX_SUPPLY_BASE = fromDisplay(MAX_SUPPLY_DISPLAY)

// ---- helpers -------------------------------------------------------------

let dir: string

/** Fresh temp data dir per test; removed after each (store-test pattern). */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-tracer-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** An open `FileChainStore` on the per-test temp dir. */
function openStore(): FileChainStore {
  const store = new FileChainStore(dir)
  return store
}

/** A block template for direct `mineBlock` calls (R3 input shape). */
function template(slot: bigint, parentHash: Uint8Array<ArrayBuffer>) {
  return {
    slot,
    parentHash,
    winnerIdentityId: TRACER_WINNER_ID,
    winnerTicket: new Uint8Array(0),
    txCount: 0n,
  }
}

/** Pre-funded treasury balances (the closed system `applyBlock` credits). */
function fundedBalances(): BalanceMap {
  return new Map<string, bigint>([[MINT_ID, MAX_SUPPLY_BASE]])
}

const hex = (buf: Uint8Array): string => Buffer.from(buf).toString('hex')
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && Array.from(a).every((v, i) => v === b[i])

// ---- matrix --------------------------------------------------------------

describe('MINE_BLOCK — mineBlock returns a pow-passing, digested block (R3)', () => {
  it('the counter (u64be nonce field) makes powCheck true and hash = blockDigest', () => {
    const block = mineBlock(template(0n, new Uint8Array(32)))

    // The counter is the nonce field in 8-byte u64be form (3.1).
    expect(block.nonce.byteLength).toBe(8)
    // The PoW check passes on the returned block.
    expect(powCheck(block)).toBe(true)
    // The stored hash is exactly sha256(canonical bytes) — recomputing the
    // digest from the block's fields reproduces it.
    expect(block.hash.byteLength).toBe(32)
    expect(eqBytes(block.hash, blockDigest(block))).toBe(true)
    // The template fields pass through unchanged.
    expect(block.slot).toBe(0n)
    expect(block.winnerIdentityId).toBe(TRACER_WINNER_ID)
    expect(block.winnerTicket.byteLength).toBe(0)
    expect(block.txCount).toBe(0n)
  })

  it('mining twice from the same template yields pow-passing blocks (counters may differ)', () => {
    const a = mineBlock(template(3n, new Uint8Array(32)))
    const b = mineBlock(template(3n, new Uint8Array(32)))
    expect(powCheck(a)).toBe(true)
    expect(powCheck(b)).toBe(true)
    // Each hash is the digest of its own block (self-consistent).
    expect(eqBytes(a.hash, blockDigest(a))).toBe(true)
    expect(eqBytes(b.hash, blockDigest(b))).toBe(true)
  })
})

describe('APPLY_REWARD — applyBlock credits through the ledger apply seam (R5)', () => {
  it('winner += reward, mint -= reward, totalSupply unchanged; block committed + snapshot saved', async () => {
    const store = openStore()
    await store.open()
    const block = mineBlock(template(0n, new Uint8Array(32)))
    const before = fundedBalances()

    const after = await applyBlock({
      store,
      block,
      balances: before,
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
    })

    // The reward moved through the ledger seam: closed system.
    expect(balanceOf(after, TRACER_WINNER_ID)).toBe(REWARD_BASE)
    expect(balanceOf(after, MINT_ID)).toBe(MAX_SUPPLY_BASE - REWARD_BASE)
    expect(totalSupply(after)).toBe(MAX_SUPPLY_BASE) // unchanged (no new mint path)
    // The input map is untouched (the seam is pure, AD-2).
    expect(balanceOf(before, TRACER_WINNER_ID)).toBe(0n)

    // The block was committed to the store at its slot.
    expect(await store.headSlot()).toBe(0)
    const stored = await store.getBlock(0)
    expect(stored).not.toBeNull()
    expect(hex(stored!)).toBe(hex(Block.encode(block))) // byte-identity

    // The snapshot was saved (decimal-string document, AD-5).
    const doc = await store.loadState()
    expect(doc).not.toBeNull()
    expect(doc![MINT_ID]).toBe((MAX_SUPPLY_BASE - REWARD_BASE).toString(10))
    expect(doc![TRACER_WINNER_ID]).toBe(REWARD_BASE.toString(10))
    await store.close()
  })

  it('an unfunded reward (mint balance below the reward) throws SC-LEDGER-1 and commits nothing', async () => {
    const store = openStore()
    await store.open()
    const block = mineBlock(template(0n, new Uint8Array(32)))
    const poor = new Map<string, bigint>([[MINT_ID, REWARD_BASE - 1n]])

    const err: unknown = await applyBlock({
      store,
      block,
      balances: poor,
      rewardBaseUnits: REWARD_BASE,
      mintId: MINT_ID,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('SC-LEDGER-1')
    // Nothing committed, no snapshot saved (ledger first, AD-2 ordering).
    expect(await store.headSlot()).toBe(-1)
    expect(await store.getBlock(0)).toBeNull()
    expect(await store.loadState()).toBeNull()
    await store.close()
  })
})

describe('PERSIST_RELOAD — a mined block + balances survive close/open (R5)', () => {
  it('mineAndApply on a real FileChainStore, close, reopen: block re-decodes, hash matches, powCheck true, balances match', async () => {
    const store = openStore()
    await store.open()
    const { block, balances } = await mineAndApply({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    // The first (only) block is slot 0, parent = 32 zero bytes.
    expect(block.slot).toBe(0n)
    expect(block.parentHash.every((b) => b === 0)).toBe(true)
    await store.close()

    // Reopen the SAME dir (a fresh store instance — the lock was released).
    const re = new FileChainStore(dir)
    await re.open()

    // The block re-decodes from the stored wire bytes.
    expect(await re.headSlot()).toBe(0)
    const bytes = await re.getBlock(0)
    expect(bytes).not.toBeNull()
    const decoded = Block.decode(bytes!)
    expect(decoded.slot).toBe(block.slot)
    expect(decoded.winnerIdentityId).toBe(TRACER_WINNER_ID)
    // The recomputed hash matches the stored hash and the PoW passes.
    expect(eqBytes(decoded.hash, block.hash)).toBe(true)
    expect(eqBytes(decoded.hash, blockDigest(decoded))).toBe(true)
    expect(powCheck(decoded)).toBe(true)

    // The saved balances match the state applyBlock returned.
    const doc = await re.loadState()
    expect(doc).not.toBeNull()
    const reloaded = fromJson(doc!)
    expect(totalSupply(reloaded)).toBe(MAX_SUPPLY_BASE)
    expect(balanceOf(reloaded, TRACER_WINNER_ID)).toBe(balanceOf(balances, TRACER_WINNER_ID))
    expect(balanceOf(reloaded, MINT_ID)).toBe(balanceOf(balances, MINT_ID))
    expect(toJson(reloaded)).toEqual(toJson(balances))
    await re.close()
  })

  it('a second mineAndApply on the reopened chain extends it: slot 1, parent = head hash, balances carry forward', async () => {
    const store = openStore()
    await store.open()
    const first = await mineAndApply({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    await store.close()

    const re = new FileChainStore(dir)
    await re.open()
    const second = await mineAndApply({
      store: re,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    // The chain extended by one block, parent = the first block's hash.
    expect(second.block.slot).toBe(1n)
    expect(eqBytes(second.block.parentHash, first.block.hash)).toBe(true)
    // Balances carried forward: the winner was credited twice.
    expect(balanceOf(second.balances, TRACER_WINNER_ID)).toBe(REWARD_BASE * 2n)
    expect(totalSupply(second.balances)).toBe(MAX_SUPPLY_BASE)
    expect(powCheck(second.block)).toBe(true)
    await re.close()
  })
})

describe('CHAIN_TIME_SLOT — nextSlotAndParent derives from the store head (R4)', () => {
  it('empty chain (head -1) → slot 0 + 32 zero bytes', async () => {
    const store = openStore()
    await store.open()
    const { slot, parentHash } = await nextSlotAndParent(store)
    expect(slot).toBe(0n)
    expect(parentHash.byteLength).toBe(32)
    expect(parentHash.every((b) => b === 0)).toBe(true)
    await store.close()
  })

  it('non-empty chain → slot = head + 1, parent = the head block\'s stored hash', async () => {
    const store = openStore()
    await store.open()
    const { block } = await mineAndApply({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })

    const { slot, parentHash } = await nextSlotAndParent(store)
    expect(slot).toBe(1n)
    expect(eqBytes(parentHash, block.hash)).toBe(true)
    await store.close()
  })
})

describe('mineAndApply — the one-block tracer end-to-end', () => {
  it('absent snapshot → mint pre-funded with maxSupply; reward credited; totalSupply = maxSupply', async () => {
    const store = openStore()
    await store.open()
    const { block, balances } = await mineAndApply({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    expect(powCheck(block)).toBe(true)
    expect(balanceOf(balances, MINT_ID)).toBe(MAX_SUPPLY_BASE - REWARD_BASE)
    expect(balanceOf(balances, TRACER_WINNER_ID)).toBe(REWARD_BASE)
    expect(totalSupply(balances)).toBe(MAX_SUPPLY_BASE)
    await store.close()
  })

  it('an existing snapshot is carried forward (no re-mint)', async () => {
    const store = openStore()
    await store.open()
    const seeded = apply(fundedBalances(), [
      { from: MINT_ID, to: 'abc', amount: 12345n },
    ])
    await store.saveState(toJson(seeded))

    const { balances } = await mineAndApply({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    })
    // The pre-existing balance survived; only the reward moved this time.
    expect(balanceOf(balances, 'abc')).toBe(12345n)
    expect(balanceOf(balances, TRACER_WINNER_ID)).toBe(REWARD_BASE)
    expect(totalSupply(balances)).toBe(MAX_SUPPLY_BASE)
    await store.close()
  })
})

// ---------------------------------------------------------------------------
// MINING_PATH_GUARD — AD-6: the per-attempt mining path references only
// node:crypto sha256 (via the 3.1 PoW seam) + an integer counter. NO
// big.js, NO keccak. The scan is over miner.ts's IMPORT STATEMENTS (the
// same comment-stripping discipline as no-float-guard.test.ts); big.js may
// appear in the package ONLY for the one-time reward conversion, outside
// the per-attempt loop.
// ---------------------------------------------------------------------------

// The idiomatic import forms in an ESM NodeNext codebase (mirrors
// no-float-guard.test.ts's specifier regex, generalized to module names).
function importPattern(module: string): RegExp {
  return new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*|import\\s+|require\\s*\\(\\s*)["']${module}["']`,
  )
}
const FORBIDDEN_MINING_PATH = [importPattern('big\\.js'), importPattern('keccak')]

/** Remove block and line comments (no-op for code; strips prose mentions). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

describe('MINING_PATH_GUARD — the per-attempt mining path imports no big.js/keccak (AD-6)', () => {
  it('miner.ts (the per-attempt loop) has no big.js or keccak import statement', () => {
    // The guard scans the mining loop file itself — the per-attempt path.
    // (Vitest runs the TS source directly — no dist — so scan the .ts file.)
    const srcPath = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'src',
      'consensus',
      'miner.ts',
    )
    const src = readFileSync(srcPath, 'utf8')
    const stripped = stripComments(src)
    for (const pattern of FORBIDDEN_MINING_PATH) {
      expect(stripped, `forbidden import in miner.ts: ${pattern}`).not.toMatch(pattern)
    }
    // And the loop does the per-attempt byte work through the 3.1 seam
    // (powCheck/blockDigest), which is node:crypto sha256.
    expect(stripped).toMatch(/from\s+["']\.\/pow\.js["']/)
    expect(stripped).toMatch(/\bpowCheck\b/)
    expect(stripped).toMatch(/\bblockDigest\b/)
  })

  it('a comment mentioning big.js is NOT flagged, a real import IS (self-test)', () => {
    // Prose mentions must never trip the guard.
    const prose = stripComments('/* uses big.js for display, keccak elsewhere */\n// big.js only here\n')
    expect(FORBIDDEN_MINING_PATH.some((p) => p.test(prose))).toBe(false)
    // A real import statement is flagged.
    const real = 'import Big from "big.js"'
    expect(FORBIDDEN_MINING_PATH[0].test(real)).toBe(true)
  })
})
