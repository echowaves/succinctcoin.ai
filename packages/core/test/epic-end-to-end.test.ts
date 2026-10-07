/**
 * EPIC 3 CLOSING END-TO-END SUITE — the full Done-when as ONE integrated,
 * headless, memory-transport scenario (3.9).
 *
 * This suite proves ALL FIVE Done-when checks of epic-equal-node-mining green
 * together, over ONE shared mined run (20 windows on a real `FileChainStore`)
 * + the pinned 4000-window pure `drawSchedule` for the rate. It COMPOSES the
 * existing seams (`simulateNetwork` / `drawSchedule` / `verifyDraw` /
 * `mineBlock` / `applyBlock` / `blockDigest` / `powCheck` / `windowAcceptedSet`
 * / `deriveWindowChallenge`) imported from the ROOT barrel only — it NEVER
 * re-implements the draw (AD-7), the challenge (AD-12), or the fee (AD-5).
 *
 * Matrix rows (one per Done-when):
 *
 *   E2E_R1_RATE_HW_INDEPENDENT       Done-when #1: the pinned 4000-window
 *                                    `drawSchedule` yields A's win count ==
 *                                    2111 (band [1800,2200]), A strictly
 *                                    beats B and C; over the mined run, EVERY
 *                                    block's winner === `drawWindow(...)`
 *                                    output (the draw, not the miner, chose
 *                                    it; selection inputs carry no hash-rate
 *                                    term).
 *   E2E_R2_NO_WIN_WITHOUT_VALID_TICKET  Done-when #2: a valid per-window
 *                                    ticket → `verifyDraw` true; a FORGED
 *                                    ticket (valid identity, fabricated
 *                                    nonceCommitment not in the accepted set,
 *                                    windowIndex+challenge correct) →
 *                                    `verifyDraw` false.
 *   E2E_R2_LAUNCH_GATE               Done-when #3: a PoW-valid block claiming
 *                                    the NON-draw-winner (re-encoded with
 *                                    that node's valid per-window ticket) →
 *                                    `verifyDraw` false; the actual draw
 *                                    winner → true.
 *   E2E_R3_POW_IMPORT_AND_MINING     Done-when #4: the per-attempt path of
 *                                    `src/consensus/miner.ts` has NO big.js,
 *                                    no keccak, no Math./transcendental, no
 *                                    protons-encode import (AD-6); AND the
 *                                    mined run produced all 20 blocks (each
 *                                    mineBlock completed).
 *   E2E_R3_E1_HASH_COUNTER_ROUNDTRIP  Done-when #5: for EVERY mined block,
 *                                    `powCheck` true, `blockDigest`
 *                                    byte-equals stored `hash`, and the
 *                                    counter round-trips through the
 *                                    8-byte u64be re-encoding.
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — every commitment and
 * challenge is a pinned sha256 of public data. AD-7 discipline: the draw /
 * challenge / fee are imported from the BARREL — never re-implemented.
 *
 * Test hygiene: one shared `FileChainStore` in a `mkdtemp` dir (opened in
 * `beforeAll`, closed + `rmSync` in `afterAll`); no real sockets, no new
 * runtime deps.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  Ticket,
  balanceOf,
  blockDigest,
  deriveWindowChallenge,
  drawSchedule,
  drawWindow,
  fromDisplay,
  fromJson,
  powCheck,
  simulateNetwork,
  totalSupply,
  verifyDraw,
  windowAcceptedSet,
} from '../src/index.js'
import type { SimNode } from '../src/index.js'

// ---------------------------------------------------------------------------
// Pinned sim parameters (3.7 — EXACTLY as the plan pins them; D2)
// ---------------------------------------------------------------------------

// 64-hex identity ids (spine convention), distinct from the reserved
// MINT_ID (…001) / TRACER_WINNER_ID (…002) / BURN_ID (…003).
const NODE_A: SimNode = { identityId: '0'.repeat(62) + 'aa', uptime: 50n } // always-up
const NODE_B: SimNode = { identityId: '0'.repeat(62) + 'bb', uptime: 30n } // flaky
const NODE_C: SimNode = { identityId: '0'.repeat(62) + 'cc', uptime: 20n } // flaky
const NODES: SimNode[] = [NODE_A, NODE_B, NODE_C]
const NODE_IDS = NODES.map((n) => n.identityId)

// Fixed-emission display params.
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'
const REWARD = fromDisplay(REWARD_DISPLAY)
const MAX_SUPPLY = fromDisplay(MAX_SUPPLY_DISPLAY)

// Rate schedule size (pinned): 4000 pure-draw windows.
const RATE_WINDOWS = 4000
// The pinned DETERMINISTIC outcome of the 4000-window schedule:
const PINNED_A_WINS = 2111
const PINNED_B_WINS = 1203
const PINNED_C_WINS = 686

// Mined run window count (pinned): 20 windows through a real FileChainStore.
const MINED_WINDOWS = 20

// ---------------------------------------------------------------------------
// Shared mined run (ONE run, shared by all rows)
// ---------------------------------------------------------------------------

let dir: string
let store: FileChainStore
let minedRun: Array<{ block: Block; winnerId: string; verify: boolean }>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-e2e-'))
  store = new FileChainStore(dir)
  await store.open()
  minedRun = await simulateNetwork({
    store,
    rewardDisplay: REWARD_DISPLAY,
    maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    nodes: NODES,
    windows: MINED_WINDOWS,
  })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Byte-wise equality for two `Uint8Array`s. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** A pinned 32-byte digest from a fixed label (deterministic, AD-3). */
function labeledCommit(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(label, 'utf8').digest())
}

/**
 * Independently re-derive a window's challenge + accepted set from the block's
 * OWN `parentHash` + `slot` (the 3.4 verifier contract).
 */
function reverifyInputs(block: Block) {
  const challenge = deriveWindowChallenge(block.parentHash, block.slot)
  const { tickets, weights, protoTickets } = windowAcceptedSet(
    NODES,
    block.slot,
    block.parentHash,
    challenge,
  )
  return { challenge, tickets, weights, protoTickets }
}

/**
 * The 8-byte u64be re-encoding of a `nonce` field: decode the bytes as a
 * big-endian bigint, then re-encode as 8-byte u64be. The result must
 * byte-equal the original (the counter round-trips through the canonical
 * encoding).
 */
function u64beRoundtrip(nonce: Uint8Array): Uint8Array {
  let v = 0n
  for (let i = 0; i < nonce.length; i++) v = (v << 8n) | BigInt(nonce[i])
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, v, false)
  return buf
}

/** Remove block and line comments (preserving line structure). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** An idiomatic import-form pattern for a given module specifier. */
function importPattern(module: string): RegExp {
  return new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*|import\\s+|require\\s*\\(\\s*)["']${module}["']`,
  )
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

describe('EPIC 3 CLOSING END-TO-END — full Done-when (3.9)', () => {
  it('E2E_R1_RATE_HW_INDEPENDENT: pinned rate + every mined winner == drawWindow output', async () => {
    // Part A — the pinned 4000-window pure draw schedule (Done-when #1, rate).
    const schedule = drawSchedule(NODES, RATE_WINDOWS)
    expect(schedule).toHaveLength(RATE_WINDOWS)

    let a = 0
    let b = 0
    let c = 0
    for (const r of schedule) {
      if (r.winnerId === NODE_A.identityId) a++
      else if (r.winnerId === NODE_B.identityId) b++
      else if (r.winnerId === NODE_C.identityId) c++
      else throw new Error(`E2E_R1: unexpected winner ${r.winnerId}`)
    }

    // Exact deterministic win counts (pinned, AD-3).
    expect(a).toBe(PINNED_A_WINS)
    expect(b).toBe(PINNED_B_WINS)
    expect(c).toBe(PINNED_C_WINS)
    expect(a + b + c).toBe(RATE_WINDOWS)

    // A's win rate is inside [0.45, 0.55] (integer math: [1800, 2200]).
    expect(a).toBeGreaterThanOrEqual(1800)
    expect(a).toBeLessThanOrEqual(2200)

    // The always-up node strictly beats both flaky nodes.
    expect(a).toBeGreaterThan(b)
    expect(a).toBeGreaterThan(c)

    // Part B — over the mined run: EVERY block's winner equals the drawWindow
    // output re-derived from the block's OWN parentHash + slot (the 3.4
    // verifier contract). The draw, not the miner, chose it; the selection
    // inputs carry no hash-rate term.
    expect(minedRun).toHaveLength(MINED_WINDOWS)
    const wins = new Map<string, number>()
    for (const { block } of minedRun) {
      const { challenge, tickets, weights } = reverifyInputs(block)
      const draw = drawWindow(tickets, challenge, weights)
      expect(
        block.winnerIdentityId,
        `mined block slot=${block.slot} winner != drawWindow output`,
      ).toBe(draw.winnerIdentityId)
      expect(NODE_IDS).toContain(block.winnerIdentityId)
      // The selection inputs are the FIXED uptime weights (no hash-rate term).
      expect([...weights]).toEqual([50n, 30n, 20n])
      wins.set(block.winnerIdentityId, (wins.get(block.winnerIdentityId) ?? 0) + 1)
    }

    // The shared mined run also grounds R4/R5: chain time (no wall clock) and
    // the single mutation path (`applyBlock`) credited each winner the fixed
    // reward, conserving totalSupply.
    expect(await store.headSlot()).toBe(MINED_WINDOWS - 1)
    const doc = await store.loadState()
    expect(doc).not.toBeNull()
    const balances = fromJson(doc as Record<string, string>)
    for (const node of NODES) {
      const w = wins.get(node.identityId) ?? 0
      expect(balanceOf(balances, node.identityId)).toBe(BigInt(w) * REWARD)
    }
    expect(balanceOf(balances, MINT_ID)).toBe(MAX_SUPPLY - BigInt(MINED_WINDOWS) * REWARD)
    expect(totalSupply(balances)).toBe(MAX_SUPPLY)
  })

  it('E2E_R2_NO_WIN_WITHOUT_VALID_TICKET: valid ticket verifies; forged commitment rejected', () => {
    // Use the first mined block.
    const { block } = minedRun[0]
    const { challenge, tickets, weights } = reverifyInputs(block)

    // VALID — the block's winner ticket is the node's real per-window ticket:
    // the 3.4 launch gate accepts.
    expect(verifyDraw(block, tickets, weights, challenge)).toBe(true)

    // FORGED — the winner claims a VALID identity but carries a fabricated
    // nonceCommitment NOT in the accepted set. windowIndex + challenge are
    // left CORRECT (matching the window), isolating the commitment-binding as
    // the sole reason for rejection.
    const forgedCommitment = labeledCommit('SC-E2E-FORGED-COMMIT/1')
    const decoded = Ticket.decode(block.winnerTicket)
    const forgedTicket = {
      identityId: decoded.identityId,
      windowIndex: decoded.windowIndex,
      challenge: new Uint8Array(decoded.challenge),
      nonceCommitment: forgedCommitment,
      signature: new Uint8Array(0),
    }
    const forgedBlock: Block = { ...block, winnerTicket: Ticket.encode(forgedTicket) }

    // The launch gate REJECTS the forged commitment (normal false, not error).
    expect(verifyDraw(forgedBlock, tickets, weights, challenge)).toBe(false)

    // Sanity: the forged commitment is genuinely absent from the accepted set.
    expect(
      tickets.some(
        (t) =>
          t.identityId === forgedTicket.identityId &&
          bytesEqual(t.nonceCommitment, forgedCommitment),
      ),
    ).toBe(false)
  })

  it('E2E_R2_LAUNCH_GATE: a non-selected node cannot produce a valid block', () => {
    // Use the first mined block.
    const { block } = minedRun[0]
    const actualWinner = block.winnerIdentityId
    const { challenge, tickets, weights, protoTickets } = reverifyInputs(block)

    // The ACTUAL draw winner verifies (the legitimate block).
    expect(verifyDraw(block, tickets, weights, challenge)).toBe(true)

    // Forged claim: pick a DIFFERENT node (one the draw did NOT select for
    // this window), re-encode that node's VALID per-window ticket into
    // `winnerTicket` + set `winnerIdentityId` to that node. The block is
    // still PoW-valid (same nonce/hash), but the draw did not select this
    // node — so `verifyDraw` must reject.
    const otherIdx = NODES.findIndex((n) => n.identityId !== actualWinner)
    expect(otherIdx).toBeGreaterThanOrEqual(0)
    const otherNode = NODES[otherIdx]
    const otherProtoTicket = protoTickets[otherIdx]

    const forgedClaimBlock: Block = {
      ...block,
      winnerIdentityId: otherNode.identityId,
      winnerTicket: Ticket.encode(otherProtoTicket),
    }

    // The launch gate REJECTS: a non-selected node cannot produce a valid
    // block (the re-derived draw winner != the claimed identity).
    expect(verifyDraw(forgedClaimBlock, tickets, weights, challenge)).toBe(false)
  })

  it('E2E_R3_POW_IMPORT_AND_MINING: miner.ts per-attempt path is sha256+counter only; all blocks mined', () => {
    // Part A — the per-attempt-path import/lint scan of src/consensus/miner.ts.
    const srcPath = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'src',
      'consensus',
      'miner.ts',
    )
    const src = readFileSync(srcPath, 'utf8')
    const stripped = stripComments(src)

    // (1) NO big.js import.
    expect(stripped, 'big.js import in miner.ts').not.toMatch(importPattern('big\\.js'))
    // (2) NO pure-JS keccak import — any quoted module specifier containing
    //     "keccak" (the bare `keccak` form AND package-qualified pure-JS
    //     keccak such as `@noble/hashes/sha3` / `js-sha3`). The per-attempt
    //     path must hash with `node:crypto` sha256 only.
    expect(stripped, 'keccak import in miner.ts').not.toMatch(/["'][\w@/.*-]*keccak["']/)
    // (3) NO Math. / transcendental (Math.log, Math.pow, Math.random, …).
    expect(stripped, 'Math.* usage in miner.ts').not.toMatch(/\bMath\./)
    // (4) NO Number() constructor (float conversion).
    expect(stripped, 'Number() in miner.ts').not.toMatch(/\bNumber\(/)
    // (5) NO protons encode value-import (only type imports from proto are
    //     allowed — the per-attempt path must not call Block.encode /
    //     Ticket.encode).
    expect(
      stripped,
      'protons value-import from proto in miner.ts',
    ).not.toMatch(/import\s+(?!type\b)[\w{},\s]+\s+from\s+["']\.\.\/proto\/index\.js["']/)

    // The loop DOES reference the 3.1 PoW seam (node:crypto sha256).
    expect(stripped).toMatch(/from\s+["']\.\/pow\.js["']/)
    expect(stripped).toMatch(/\bpowCheck\b/)
    expect(stripped).toMatch(/\bblockDigest\b/)

    // Part B — the mined run produced ALL blocks (each mineBlock completed =
    // ≥1 hash/slot reachable at the fixed N=16 target).
    expect(minedRun).toHaveLength(MINED_WINDOWS)
    for (const { block } of minedRun) {
      expect(powCheck(block)).toBe(true)
    }
  })

  it('E2E_R3_E1_HASH_COUNTER_ROUNDTRIP: every block passes powCheck, digest matches, counter round-trips', () => {
    expect(minedRun).toHaveLength(MINED_WINDOWS)
    for (const { block } of minedRun) {
      // powCheck passes (≥16 leading zero bits in sha256(canonical bytes)).
      expect(powCheck(block), `powCheck failed for slot=${block.slot}`).toBe(true)

      // blockDigest(block) byte-equals the stored block.hash.
      const digest = blockDigest(block)
      expect(
        bytesEqual(block.hash, digest),
        `hash mismatch for slot=${block.slot}`,
      ).toBe(true)

      // The counter round-trips: the 8-byte u64be re-encoding of the nonce
      // field equals the stored nonce (the counter is a field of the canonical
      // bytes the hash is over).
      expect(
        bytesEqual(block.nonce, u64beRoundtrip(block.nonce)),
        `counter round-trip failed for slot=${block.slot}`,
      ).toBe(true)
    }
  })
})
