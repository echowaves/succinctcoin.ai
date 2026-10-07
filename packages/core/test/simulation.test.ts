/**
 * MULTI-NODE SIMULATION — the uptime-only slot-rate matrix (3.7, R1).
 *
 * The sim (src/consensus/sim.ts) is a standalone memory-transport harness that
 * proves the core promise on ONE chain + ONE accepted ticket set per window (no
 * sockets — D1). It imports the pinned seams (`drawWindow` / `deriveWindowChallenge`
 * / `mineBlock` / `applyBlock` / `verifyDraw` / `nextSlotAndParent`) and NEVER
 * re-implements the draw (AD-7) or the challenge (AD-12). This file covers the
 * plan's five I/O-matrix rows, importing from the ROOT barrel only:
 *
 *   SIM_RATE                       the pure 4000-window `drawSchedule`
 *                                  (A=50/B=30/C=20): A's win rate ∈ [0.45, 0.55]
 *                                  (expected 0.5), the EXACT deterministic
 *                                  A-win count pinned, and A strictly beats
 *                                  both B and C.
 *   SIM_FULL_PATH                  3 windows end-to-end on a REAL
 *                                  `FileChainStore`: headSlot()==2; EVERY
 *                                  block's `verifyDraw(...)`===true (independent
 *                                  re-verify from the block's own parent/slot);
 *                                  every winner ∈ {A,B,C}; reward MINT_ID→winner
 *                                  = fromDisplay("12.5"); totalSupply conserved
 *                                  == fromDisplay("21000000").
 *   SIM_NO_WIN_WITHOUT_VALID_TICKET  a block whose winner ticket is the node's
 *                                  VALID per-window ticket → `verifyDraw` true;
 *                                  a FORGED ticket (winner claims a valid
 *                                  identity but a fabricated nonceCommitment not
 *                                  in the accepted set) → `verifyDraw` false
 *                                  (the launch gate rejects).
 *   SIM_HARDWARE_INDEPENDENT        the draw precedes the mine: the block's
 *                                  winnerIdentityId === drawWindow(...)
 *                                  .winnerIdentityId (the draw — not the miner —
 *                                  decided it), and the selection inputs are the
 *                                  fixed uptime weights (no hash-rate term).
 *   SIM_TICKET_CONFORMS             `syntheticTicket` shape: 64-hex identityId,
 *                                  32-byte nonceCommitment, windowIndex===slot,
 *                                  byte-equal challenge, empty signature, and a
 *                                  `Ticket.encode`/`decode` round-trip.
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock anywhere — every commitment
 * and challenge is a pinned `sha256` of public data (the schedule is fully
 * deterministic, so the pinned A-win count is stable across runs/engines).
 * AD-7 discipline: the draw / challenge / fee are imported from the BARREL —
 * the `c^uptime` formula is NEVER re-implemented here.
 *
 * Test hygiene (AD-10): fresh `os.tmpdir()` dir per test (the real
 * `FileChainStore`), closed + `rmSync` in `afterEach`; no real sockets, no new
 * runtime deps.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Block,
  FileChainStore,
  MINT_ID,
  Ticket,
  balanceOf,
  deriveWindowChallenge,
  drawSchedule,
  drawWindow,
  fromDisplay,
  fromJson,
  simulateNetwork,
  simulateWindow,
  syntheticTicket,
  totalSupply,
  verifyDraw,
  windowAcceptedSet,
} from '../src/index.js'
import type { SimNode } from '../src/index.js'

// ---------------------------------------------------------------------------
// Pinned sim parameters (3.7 — EXACTLY as the plan pins them)
// ---------------------------------------------------------------------------

// 64-hex identity ids (spine convention), distinct from the reserved
// MINT_ID (…001) / TRACER_WINNER_ID (…002) / BURN_ID (…003).
const NODE_A: SimNode = { identityId: '0'.repeat(62) + 'aa', uptime: 50n } // always-up
const NODE_B: SimNode = { identityId: '0'.repeat(62) + 'bb', uptime: 30n } // flaky
const NODE_C: SimNode = { identityId: '0'.repeat(62) + 'cc', uptime: 20n } // flaky
const NODES: SimNode[] = [NODE_A, NODE_B, NODE_C]
const NODE_IDS = NODES.map((n) => n.identityId)

// Fixed-emission display params (the genesis emission carries them).
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'
const REWARD = fromDisplay(REWARD_DISPLAY)
const MAX_SUPPLY = fromDisplay(MAX_SUPPLY_DISPLAY)

// SIM_RATE schedule size (pinned): 4000 pure-draw windows.
const RATE_WINDOWS = 4000
// The pinned DETERMINISTIC outcome of the 4000-window schedule (COMMITTED):
// the always-up node A wins exactly 2111 of 4000 (rate 0.52775 — inside the
// [0.45, 0.55] band around the uptime-proportional expected 0.5), B wins 1203,
// C wins 686. Regenerate ONLY by changing the pinned sim parameters (the draw,
// the node ids/weights, or the window count), which is a protocol change (AD-7).
const PINNED_A_WINS = 2111
const PINNED_B_WINS = 1203
const PINNED_C_WINS = 686

// SIM_FULL_PATH window count (pinned): 3 windows through a real FileChainStore.
const FULL_PATH_WINDOWS = 3

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let dir: string
let store: FileChainStore

/** A fresh temp data dir + OPEN `FileChainStore` per test; closed + removed after. */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-sim-'))
  store = new FileChainStore(dir)
  await store.open()
})
afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** One window end-to-end on the per-test store (the memory transport). */
function runWindow() {
  return simulateWindow({
    store,
    rewardDisplay: REWARD_DISPLAY,
    maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
    nodes: NODES,
  })
}

/** Byte-wise equality for two `Uint8Array`s (challenge / commitment binding). */
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

/** Independently re-derive a window's challenge + accepted set from the block's OWN `parentHash` + `slot` (the 3.4 verifier contract). */
function reverifyInputs(block: Block) {
  const challenge = deriveWindowChallenge(block.parentHash, block.slot)
  const { tickets, weights } = windowAcceptedSet(NODES, block.slot, block.parentHash, challenge)
  return { challenge, tickets, weights }
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

describe('MULTI-NODE SIMULATION — the uptime-only slot rate (3.7, R1)', () => {
  it('SIM_RATE: over 4000 pure-draw windows A wins at its uptime-proportional rate (pinned)', () => {
    const schedule = drawSchedule(NODES, RATE_WINDOWS)
    expect(schedule).toHaveLength(RATE_WINDOWS)

    let a = 0
    let b = 0
    let c = 0
    for (const r of schedule) {
      if (r.winnerId === NODE_A.identityId) a++
      else if (r.winnerId === NODE_B.identityId) b++
      else if (r.winnerId === NODE_C.identityId) c++
      else throw new Error(`SIM_RATE: unexpected winner ${r.winnerId}`)
    }

    // The EXACT deterministic win counts (pinned, AD-3 — stable across runs).
    expect(a).toBe(PINNED_A_WINS)
    expect(b).toBe(PINNED_B_WINS)
    expect(c).toBe(PINNED_C_WINS)
    expect(a + b + c).toBe(RATE_WINDOWS)

    // A's win rate is inside the ±5% band [0.45, 0.55] around the
    // uptime-proportional expected rate 0.5 (asserted in INTEGER math — no
    // float): A_wins ∈ [0.45·W, 0.55·W] = [1800, 2200].
    expect(a).toBeGreaterThanOrEqual(1800)
    expect(a).toBeLessThanOrEqual(2200)

    // The always-up node (highest uptime) strictly beats both flaky nodes.
    expect(a).toBeGreaterThan(b)
    expect(a).toBeGreaterThan(c)
  })

  it('SIM_FULL_PATH: 3 windows end-to-end on a real FileChainStore — head, verify, reward, conservation', async () => {
    const results = await simulateNetwork({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
      nodes: NODES,
      windows: FULL_PATH_WINDOWS,
    })
    expect(results).toHaveLength(FULL_PATH_WINDOWS)

    // The chain advanced exactly one block per window.
    expect(await store.headSlot()).toBe(FULL_PATH_WINDOWS - 1)

    // The winner of every window is one of the simulated nodes, and the block's
    // claimed winner matches it.
    const wins = new Map<string, number>()
    for (const r of results) {
      expect(r.block.winnerIdentityId).toBe(r.winnerId)
      expect(NODE_IDS).toContain(r.winnerId)
      wins.set(r.winnerId, (wins.get(r.winnerId) ?? 0) + 1)

      // EVERY committed block passes the 3.4 launch gate — verified BOTH by the
      // sim's own re-verify AND independently re-derived from the block's OWN
      // parentHash + slot (the verifier contract: the challenge is recomputed
      // from the block, never trusted).
      expect(r.verify).toBe(true)
      const { challenge, tickets, weights } = reverifyInputs(r.block)
      expect(verifyDraw(r.block, tickets, weights, challenge)).toBe(true)
    }

    // The reward is the fixed-emission `MINT_ID → winner = fromDisplay("12.5")`
    // for EVERY window: each winner's final balance == (windows it won) · reward
    // (it starts at 0 and only ever receives the reward), the mint is debited
    // exactly the total reward, and totalSupply is CONSERVED == maxSupply.
    const doc = await store.loadState()
    expect(doc).not.toBeNull()
    const balances = fromJson(doc as Record<string, string>)
    for (const node of NODES) {
      const w = wins.get(node.identityId) ?? 0
      expect(balanceOf(balances, node.identityId)).toBe(BigInt(w) * REWARD)
    }
    expect(balanceOf(balances, MINT_ID)).toBe(MAX_SUPPLY - BigInt(FULL_PATH_WINDOWS) * REWARD)
    expect(totalSupply(balances)).toBe(MAX_SUPPLY)
  })

  it('SIM_NO_WIN_WITHOUT_VALID_TICKET: a valid winner ticket verifies; a forged commitment is rejected', async () => {
    const r = await runWindow()

    // VALID — the block's winner ticket is the node's real per-window ticket:
    // the 3.4 launch gate accepts (both the sim's re-verify and an independent
    // verifyDraw over the accepted set).
    expect(r.verify).toBe(true)
    expect(verifyDraw(r.block, r.tickets, r.weights, r.challenge)).toBe(true)

    // FORGED — the winner claims a VALID identity but carries a fabricated
    // nonceCommitment that is NOT in the accepted set. windowIndex + challenge
    // are left CORRECT (matching the window), so the ONLY difference from the
    // valid ticket is the commitment — isolating the launch gate's
    // commitment-binding as the reason for rejection.
    const forgedCommitment = labeledCommit('SC-SIM-FORGED-COMMIT/1')
    const forgedTicket = {
      identityId: r.block.winnerIdentityId,
      windowIndex: r.block.slot,
      challenge: new Uint8Array(r.challenge),
      nonceCommitment: forgedCommitment,
      signature: new Uint8Array(0),
    }
    const forgedBlock: Block = { ...r.block, winnerTicket: Ticket.encode(forgedTicket) }

    // The launch gate REJECTS a forged commitment (a normal `false`, not an
    // error — the block cannot win a slot without a valid per-slot ticket).
    expect(verifyDraw(forgedBlock, r.tickets, r.weights, r.challenge)).toBe(false)

    // Sanity: the forged commitment is genuinely absent from the accepted set
    // (so the rejection is the binding, not some other check).
    expect(
      r.tickets.some(
        (t) => t.identityId === forgedTicket.identityId && bytesEqual(t.nonceCommitment, forgedCommitment),
      ),
    ).toBe(false)
  })

  it('SIM_HARDWARE_INDEPENDENT: the draw — not the miner — selected the winner', async () => {
    const r = await runWindow()

    // Independently re-derive the window's draw from the block's OWN parent/slot
    // (the 3.4 verifier contract) and run the ONE pinned draw over the accepted
    // set — the miner runs only AFTER the winner is chosen (D3).
    const { challenge, tickets, weights } = reverifyInputs(r.block)
    const draw1 = drawWindow(tickets, challenge, weights)
    const draw2 = drawWindow(tickets, challenge, weights) // deterministic (AD-3)

    // The draw is pure over (tickets, challenge, weights) — same inputs ⇒ same
    // winner, on every node.
    expect(draw1.winnerIdentityId).toBe(draw2.winnerIdentityId)

    // The block's winner is EXACTLY the draw's output (the draw — not the
    // miner — decided it); and it is one of the simulated nodes.
    expect(draw1.winnerIdentityId).toBe(r.block.winnerIdentityId)
    expect(NODE_IDS).toContain(r.block.winnerIdentityId)

    // The selection inputs carry NO hash-rate term: the weights are the nodes'
    // FIXED uptime inputs (in node order), and the draw consumed the winner's
    // uptime as the `c^uptime` exponent.
    expect([...weights]).toEqual([50n, 30n, 20n])
    const winnerNode = NODES.find((n) => n.identityId === r.block.winnerIdentityId)
    expect(winnerNode).toBeDefined()
    expect(draw1.uptime).toBe(winnerNode!.uptime)
  })

  it('SIM_TICKET_CONFORMS: the synthetic ticket conforms to the proto Ticket / 3.3 DrawTicket', () => {
    // A fixed window (non-zero slot so the int64 round-trip is exercised).
    const slot = 7n
    const parentHash = new Uint8Array(32)
    const challenge = deriveWindowChallenge(parentHash, slot)

    const t = syntheticTicket(NODE_A, slot, parentHash, challenge)

    // 64-hex identity id (spine convention).
    expect(t.identityId).toMatch(/^[0-9a-f]{64}$/)
    // 32-byte nonce commitment.
    expect(t.nonceCommitment.byteLength).toBe(32)
    // windowIndex === slot.
    expect(t.windowIndex).toBe(slot)
    // challenge byte-equals the input.
    expect(bytesEqual(t.challenge, challenge)).toBe(true)
    // empty signature (epic 4 verifies it — the epic-3 convention).
    expect(t.signature.byteLength).toBe(0)

    // The commitment is a PINNED sha256 of public data (AD-3): same inputs →
    // same bytes; a different node (different identity) → a different bytes.
    const again = syntheticTicket(NODE_A, slot, parentHash, challenge)
    expect(bytesEqual(again.nonceCommitment, t.nonceCommitment)).toBe(true)
    const other = syntheticTicket(NODE_B, slot, parentHash, challenge)
    expect(bytesEqual(other.nonceCommitment, t.nonceCommitment)).toBe(false)

    // proto `Ticket` encode/decode round-trips byte-for-byte.
    const enc = Ticket.encode(t)
    const dec = Ticket.decode(enc)
    expect(dec.identityId).toBe(t.identityId)
    expect(dec.windowIndex).toBe(slot)
    expect(dec.nonceCommitment.byteLength).toBe(32)
    expect(bytesEqual(dec.nonceCommitment, t.nonceCommitment)).toBe(true)
    expect(bytesEqual(dec.challenge, t.challenge)).toBe(true)
    expect(dec.signature.byteLength).toBe(0)
  })
})
