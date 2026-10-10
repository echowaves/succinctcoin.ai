/**
 * EPIC 4 CLOSING END-TO-END SUITE — the full Done-when as ONE integrated,
 * headless, memory-transport scenario (4.10).
 *
 * This suite proves ALL FIVE Done-when checks of epic-operator-identity
 * (CAP-2) green together, over ONE shared headless memory-transport context:
 * a single REAL `FileChainStore` (single-writer chain, no sockets — AD-10)
 * for the mined-path row + the PURE `multiDrawSchedule` (no store) for the
 * rate / cap / lapsed / rental rows + the offline gate row. It COMPOSES the
 * already-built epic-4 identity seams (verifier 4.1, signature 4.2,
 * acceptance 4.3, cap 4.4, uptime 4.5, re-attestation 4.6) with the 4.8
 * multi-identity harness (`simulateMultiNetwork` / `multiDrawSchedule` /
 * `eligibleSignedSet` / `buildCappedSet` / `signedTicket`) and 3.3's
 * `drawWindow` + 3.4's `verifyDraw` — imported from the ROOT barrel only,
 * NEVER re-implementing the draw (AD-7). TEST-ONLY: no source is added.
 *
 * Matrix rows (one per Done-when, the plan's table):
 *
 *   E2E4_R1_CAP_THROUGHPUT          Done-when #1 (R1+R2): (a) the cap — one
 *                                   identity submitting 3 tickets/window
 *                                   collapses to ONE share: the 3-ticket /
 *                                   window `multiDrawSchedule` is
 *                                   byte-identical to the 1-ticket schedule
 *                                   (extra tickets are dead weight, dropped
 *                                   by `buildCappedSet` before the draw);
 *                                   (b) the N× — a distinct operator running
 *                                   N gate-verified persons wins ~N×: the
 *                                   N=3 aggregate ∈ [2×, 3×] the N=1
 *                                   aggregate (EXACT BigInt cross-multiply)
 *                                   and the operator's total draw weight =
 *                                   N × L EXACT (3 × L for N=3).
 *   E2E4_R2_WINNER_PUBLIC_REJECT    Done-when #2 (E2, AD-12): over the shared
 *                                   real-store `simulateMultiNetwork` run,
 *                                   EVERY mined block's winner is accepted
 *                                   from PUBLIC data (`acceptBlockWinner ===
 *                                   true`, re-deriving challenge =
 *                                   `deriveWindowChallenge(block.parentHash,
 *                                   block.slot)`); a non-drawn-winner claim →
 *                                   false; the winner's public fields with an
 *                                   EMPTY signature → `acceptBlockWinner`
 *                                   false while `verifyDraw` alone is true;
 *                                   a FOREIGN identity's signature → false.
 *   E2E4_R3_LAPSED_STOPS_K          Done-when #3 (R4): an identity with
 *                                   `attestedUntilWindow = D` (100n) is
 *                                   EXCLUDED from the accepted set from D+1
 *                                   onward; re-attesting at W (120n)
 *                                   re-includes it with the monotonic
 *                                   deadline max(D, reattestationWindow(W, K))
 *                                   = max(100n, 220n) = 220n. X wins 32 in
 *                                   [0..D], 0 in the lapsed band [D+1..W-1],
 *                                   27 re-included in [W..run-end].
 *   E2E4_R4_GATE_OFFLINE_NO_BLOB    Done-when #4 (R3, AD-4): the offline
 *                                   verifier round-trips
 *                                   (`issueGateCredential` →
 *                                   `createOfflineGateVerifier().verify` →
 *                                   valid); a non-accepted gateId → valid:false;
 *                                   the proto `Ticket` has NO blob field; a
 *                                   comment-stripped src/** `.blob` scan
 *                                   resolves to EXACTLY
 *                                   ['identity/gate-verifier.ts'].
 *   E2E4_R5_RENTAL_LINEAR           Done-when #5 (R1, accepted limitation):
 *                                   the SAME 3 operator identityIds grouped
 *                                   two GENUINELY-different array ORDERINGS
 *                                   (guarded non-identical + same sorted
 *                                   multiset) yield BYTE-IDENTICAL aggregate
 *                                   win counts (operator-blind), and the
 *                                   aggregate is LINEAR in distinct-identity
 *                                   count (N identities → N×, not N²/√N).
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — the SAME pinned 4.8
 * fixture (32-byte seeds filled `0x40+i`, `deriveIdentityKeypair`, every
 * challenge `deriveWindowChallenge`, every ticket the 4.2 `signTicket` over
 * the EXACT AD-12 digest). The pinned counts are the EXACT 4.8 integers,
 * stable across runs (AD-3/AD-5).
 * AD-5 discipline: NO `big.js`, NO float — every "~N×" / "linear" /
 * "≤ one share" assertion is an EXACT integer count or an exact BigInt
 * cross-multiplication (never a `number` rate).
 * AD-7 discipline: the draw (`drawWindow`), the challenge
 * (`deriveWindowChallenge`), the cap (`buildCappedSet`), the uptime
 * (`computeUptimeWeight`), the signature (`signTicket`), the acceptance
 * (`acceptBlockWinner`), the eligibility
 * (`isEligibleAtWindow`/`reattestationWindow`), and the gate
 * (`issueGateCredential`/`createOfflineGateVerifier`) are all IMPORTED from
 * the ROOT barrel — this file NEVER re-implements them.
 *
 * Test hygiene (AD-10): a fresh `os.tmpdir()` dir for the REAL
 * `FileChainStore` (the 3.9 pattern), closed + `rmSync` after each test; the
 * schedule rows are pure (no store). No real sockets, no new runtime deps.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FileChainStore,
  Ticket,
  acceptBlockWinner,
  buildCappedSet,
  computeUptimeWeight,
  createOfflineGateVerifier,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  drawWindow,
  eligibleSignedSet,
  isEligibleAtWindow,
  issueGateCredential,
  loadGenesis,
  multiDrawSchedule,
  reattestationWindow,
  signedTicket,
  signTicket,
  simulateMultiNetwork,
  verifyDraw,
} from '../src/index.js'
import type {
  Block as BlockType,
  MultiSimIdentity,
  Ticket as ProtoTicket,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Pinned sim parameters (REUSE 4.8 EXACTLY — D8; deterministic, AD-3/AD-5)
// ---------------------------------------------------------------------------

/** The repo-root `config/genesis.json` path (test dir → core → packages → root). */
const GENESIS_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'config',
  'genesis.json',
)

/** K = genesis `reattestationK` and L = genesis `uptimeLookbackL` (from genesis). */
const GENESIS = await loadGenesis(GENESIS_PATH)
const K = BigInt(GENESIS.reattestationK) // 100 (chain-time windows)
const L = BigInt(GENESIS.uptimeLookbackL) // 50 (chain-time windows)
expect(K).toBe(100n) // the D8 pin (a genesis change is a protocol change)
expect(L).toBe(50n)

/** Fixed-emission display params (the genesis emission carries them). */
const REWARD_DISPLAY = '12.5'
const MAX_SUPPLY_DISPLAY = '21000000'

/** The PURE rate-schedule window count (pinned, matching 4.8). */
const RATE_WINDOWS = 4000
/** The mined-path window count (pinned): 5 windows through the real store. */
const MINED_WINDOWS = 5
/** The lapsed-identity run size (pinned, 4.8): 200 chain windows. */
const LAPSE_RUN = 200
/** The lapse point (pinned, 4.8): D = 100 — X is eligible THROUGH D, lapses at D+1. */
const LAPSE_D = 100n
/** The re-attest point (pinned, 4.8): W = 120 — after the lapsed phase [101..119]. */
const REATTEST_W = 120n
/** The re-attested deadline (pinned, 4.8): max(D, W + K) = max(100n, 220n) = 220n. */
const REATTEST_DEADLINE = 220n

/**
 * Fixed identity seeds (4.2-style, no RNG): a 32-byte value filled with
 * `0x40 + i` (distinct from the reserved MINT/BURN/TRACER ids and from each
 * other). `deriveIdentityKeypair` (IMPORTED) maps each seed deterministically
 * to a keypair (same seed → same keypair, so the whole fixture is
 * reproducible — AD-3/AD-10).
 */
function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

/** A 32 zero-byte parent (the PURE rate schedule's fixed parent, AD-3). */
const SCHED_PARENT = new Uint8Array(32)

/**
 * Build a gate-verified sim identity from a seed (REUSE 4.8 EXACTLY): the
 * IMPORTED `deriveIdentityKeypair` keypair, an attestation deadline far
 * beyond any sim window (fully un-lapsed), and a `validWindows` history
 * covering every window of a `RATE_WINDOWS`-long schedule — so its 4.5
 * weight is `L` (fully up) at every window `≥ L`.
 */
function makeIdentity(seedIndex: number): MultiSimIdentity {
  return {
    keypair: deriveIdentityKeypair(seedFor(seedIndex)),
    attestedUntilWindow: 100000n,
    validWindows: Array.from({ length: RATE_WINDOWS }, (_, w) => BigInt(w)),
  }
}

/** The fixed background: 3 fully-up gate-verified identities (weight `L`). */
const BG = [makeIdentity(0), makeIdentity(1), makeIdentity(2)]
/** The operator's identities (fully up, weight `L`): N=1 and N=3 sets. */
const OP1 = [makeIdentity(3)]
const OP3 = [makeIdentity(3), makeIdentity(4), makeIdentity(5)]

/** The identity ids (for winner-tallying). */
const OP3_IDS = OP3.map((id) => id.keypair.identityId)
const OP1_ID = OP1[0].keypair.identityId

// ---------------------------------------------------------------------------
// Pinned DETERMINISTIC outcomes (the SAME 4.8 integers — EXACT, 2-run stable;
// the schedule is a pinned sha256/Ed25519 of public data, so it is
// reproducible across runs/engines — AD-7: the draw is never re-implemented,
// only composed here).
// ---------------------------------------------------------------------------

// E2E4_R1 — the 1-ticket schedule over A + B + C (4000 windows): the exact
// per-identity win counts (the 3-ticket schedule is byte-identical to it).
const PINNED_R1_A_WINS = 1330
const PINNED_R1_B_WINS = 1313
const PINNED_R1_C_WINS = 1357
// E2E4_R1 — the operator's aggregate win counts (3-identity background + N
// operator identities, 4000 windows): the N=1 total and the N=3 total.
const PINNED_R1_N1_WINS = 1007
const PINNED_R1_N3_TOTAL_WINS = 2031
// E2E4_R3 — the lapsed identity X (deadline D = 100, re-attests at W = 120 →
// deadline max(D, W + K) = 220) over the 200-window lapsed run: X's wins in
// [0..D], X's wins in [W..end] of the re-attested run (0 in [D+1..W-1]).
const PINNED_R3_X_PRE = 32
const PINNED_R3_X_POST = 27

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

/** Tally one winner id per schedule row into a `Map` of counts. */
function tally(schedule: Array<{ winnerId: string; slot: bigint }>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of schedule) {
    counts.set(r.winnerId, (counts.get(r.winnerId) ?? 0) + 1)
  }
  return counts
}

/** Per-identity counts for the N=3 operator identities, in `OP3` order. */
function op3Counts(counts: Map<string, number>): [number, number, number] {
  return [
    counts.get(OP3_IDS[0]) ?? 0,
    counts.get(OP3_IDS[1]) ?? 0,
    counts.get(OP3_IDS[2]) ?? 0,
  ]
}

/** The operator's aggregate win count over `ids`. */
function opTotal(counts: Map<string, number>, ids: ReadonlyArray<string>): number {
  return ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0)
}

/**
 * The RAW multi-ticket schedule (the R1 cap case): the `multiDrawSchedule`
 * composition over a RAW accepted set where the identities in `multi` submit
 * 3 DISTINCT signed tickets per window (3 distinct pinned commitments, weight
 * counted per ticket) and the others 1: per window, `signedTicket` (×3) →
 * `buildCappedSet` (4.4 — the cap collapses each multi-ticket identity to its
 * FIRST ticket) → `drawWindow` (AD-7, the conformed set) → the winner. Same
 * `SCHED_PARENT` + slot = window index as `multiDrawSchedule` (AD-3).
 * COMPOSES the imported seams only — never re-implements the draw / cap /
 * signature.
 */
function rawMultiTicketSchedule(
  ids: ReadonlyArray<MultiSimIdentity>,
  windows: number,
  lookbackL: bigint,
  multi: ReadonlyArray<MultiSimIdentity>,
): Array<{ winnerId: string; slot: bigint }> {
  const out: Array<{ winnerId: string; slot: bigint }> = []
  for (let w = 0; w < windows; w++) {
    const slot = BigInt(w)
    const challenge = deriveWindowChallenge(SCHED_PARENT, slot)
    const rawTickets: ProtoTicket[] = []
    const rawWeights: bigint[] = []
    for (const id of ids) {
      const count = multi.some((m) => m.keypair.identityId === id.keypair.identityId) ? 3 : 1
      for (let k = 0n; k < BigInt(count); k++) {
        rawTickets.push(signedTicket(id.keypair, slot, SCHED_PARENT, challenge, k))
        rawWeights.push(computeUptimeWeight(id.validWindows, slot, lookbackL))
      }
    }
    const capped = buildCappedSet(rawTickets, rawWeights)
    const draw = drawWindow(
      capped.tickets.map((t) => ({ identityId: t.identityId, nonceCommitment: t.nonceCommitment })),
      challenge,
      capped.weights,
    )
    out.push({ winnerId: draw.winnerIdentityId, slot })
  }
  return out
}

// ---------------------------------------------------------------------------
// source-scan helpers (the 4.1 `GATE_NO_BLOB_LEAK` / 4.7 pattern, verbatim)
// ---------------------------------------------------------------------------

/** Recursively collect every `.ts` file under `dir`. */
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
 * literal contains a comment marker (verified across `src/`).
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

const SRC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

/**
 * A `.blob` READ: a dot + the `blob` identifier, with no following word char
 * (so `.blobx` is not a match) and not a call (so `.blob(...)` is not a
 * match). `cred.blob` / `cred?.blob` match; a TYPE DECLARATION `blob:
 * Uint8Array` (ports.ts) does not (no dot); prose "the blob" (no dot) does
 * not. (Self-tested inside the E2E4_R4 row.)
 */
const BLOB_READ = /\.blob(?![\w(])/

// ---------------------------------------------------------------------------
// ONE integrated headless memory-transport scenario (the 3.9 pattern): a
// single REAL `FileChainStore` (single-writer chain, no sockets — AD-10) for
// the mined-path row (E2E4_R2) + the PURE `multiDrawSchedule` (no store) for
// the schedule rows (E2E4_R1 / R3 / R5) + the offline gate row (E2E4_R4).
// ---------------------------------------------------------------------------

let dir: string
let store: FileChainStore

/** A fresh temp data dir + OPEN `FileChainStore` per test; closed + removed after. */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-epic4-e2e-'))
  store = new FileChainStore(dir)
  await store.open()
})
afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

describe('EPIC 4 CLOSING END-TO-END — full Done-when (4.10)', () => {
  it('E2E4_R1_CAP_THROUGHPUT: the cap collapses one identity to ONE share (3-ticket ≡ 1-ticket); a distinct operator running N gate-verified persons wins ~N× (N=3 ∈ [2×,3×] N=1), total draw weight N × L EXACT (Done-when #1, R1+R2)', () => {
    const a = OP1[0]
    const b = BG[0]
    const c = BG[1]

    // (a) THE CAP — one window: A submits 3 DISTINCT signed tickets (3
    // distinct pinned commitments — the ticket index is part of the
    // domain-separated commitment) + B + C each submit 1. The RAW aligned
    // set has 5 tickets (weight L each, counted per ticket); the 4.4 cap
    // (IMPORTED via `buildCappedSet`) collapses it to 3 weight slots (the
    // DISTINCT identity count) — A's weight counted ONCE (R1: "one share,
    // not more") — then the IMPORTED `drawWindow` (AD-7) runs over the capped
    // set. The 3 tickets are byte-different (distinct commitments) and each
    // is REAL + SIGNED (AD-12: a 64-byte Ed25519 signature, the 4.2
    // `signTicket`, imported).
    const slot = 60n // w ≥ L: all identities fully up → weight L each
    const challenge = deriveWindowChallenge(SCHED_PARENT, slot)
    const tA0 = signedTicket(a.keypair, slot, SCHED_PARENT, challenge, 0n)
    const tA1 = signedTicket(a.keypair, slot, SCHED_PARENT, challenge, 1n)
    const tA2 = signedTicket(a.keypair, slot, SCHED_PARENT, challenge, 2n)
    const tB = signedTicket(b.keypair, slot, SCHED_PARENT, challenge, 0n)
    const tC = signedTicket(c.keypair, slot, SCHED_PARENT, challenge, 0n)
    expect(bytesEqual(tA0.nonceCommitment, tA1.nonceCommitment)).toBe(false)
    expect(bytesEqual(tA1.nonceCommitment, tA2.nonceCommitment)).toBe(false)
    for (const t of [tA0, tA1, tA2, tB, tC]) {
      expect(t.signature.byteLength).toBe(64)
    }
    const capped = buildCappedSet([tA0, tA1, tA2, tB, tC], [L, L, L, L, L])
    // The capped set has EXACTLY 3 weight slots (the DISTINCT identity
    // count), not 5 — A's draw weight is counted ONCE (keep-FIRST: A
    // survives with tA0; the dropped tA1/tA2 are in NO slot).
    expect(capped.tickets).toHaveLength(3)
    expect(capped.weights).toEqual([L, L, L])
    expect(capped.tickets[0].identityId).toBe(a.keypair.identityId)
    expect(bytesEqual(capped.tickets[0].nonceCommitment, tA0.nonceCommitment)).toBe(true)
    expect(capped.tickets[1].identityId).toBe(b.keypair.identityId)
    expect(capped.tickets[2].identityId).toBe(c.keypair.identityId)
    for (const dropped of [tA1, tA2]) {
      expect(
        capped.tickets.some((k) => bytesEqual(k.nonceCommitment, dropped.nonceCommitment)),
      ).toBe(false)
    }
    const draw = drawWindow(
      capped.tickets.map((t) => ({ identityId: t.identityId, nonceCommitment: t.nonceCommitment })),
      challenge,
      capped.weights,
    )
    expect([a.keypair.identityId, b.keypair.identityId, c.keypair.identityId]).toContain(
      draw.winnerIdentityId,
    )

    // Over the pinned 4000-window schedule: the 3-ticket/window schedule is
    // BYTE-IDENTICAL to the 1-ticket schedule — the raw 3-tickets/window set
    // collapses under the cap to the SAME one-ticket-per-identity set, so the
    // IMPORTED draw sees identical inputs and yields the identical winner at
    // EVERY window (an identity's extra tickets earn NO extra eligibility).
    const oneTicket = multiDrawSchedule([a, b, c], RATE_WINDOWS, L)
    const threeTicket = rawMultiTicketSchedule([a, b, c], RATE_WINDOWS, L, [a])
    expect(threeTicket).toEqual(oneTicket)
    for (let w = 0; w < RATE_WINDOWS; w++) {
      expect(threeTicket[w].winnerId).toBe(oneTicket[w].winnerId)
    }
    const counts = tally(oneTicket)
    expect(counts.get(a.keypair.identityId) ?? 0).toBe(PINNED_R1_A_WINS)
    expect(counts.get(b.keypair.identityId) ?? 0).toBe(PINNED_R1_B_WINS)
    expect(counts.get(c.keypair.identityId) ?? 0).toBe(PINNED_R1_C_WINS)
    expect(
      (counts.get(a.keypair.identityId) ?? 0) +
        (counts.get(b.keypair.identityId) ?? 0) +
        (counts.get(c.keypair.identityId) ?? 0),
    ).toBe(RATE_WINDOWS)

    // (b) THE N× — against the fixed background (3 identities, weight L each,
    // fully up), the operator's N=1 vs N=3 (each weight L, fully up) over the
    // pinned 4000-window PURE schedule (the IMPORTED `drawWindow` decides —
    // AD-7): the N=3 aggregate ∈ [2×, 3×] the N=1 aggregate (EXACT BigInt
    // cross-multiplication — no float, AD-5).
    const schedN1 = multiDrawSchedule([...BG, ...OP1], RATE_WINDOWS, L)
    const schedN3 = multiDrawSchedule([...BG, ...OP3], RATE_WINDOWS, L)
    expect(schedN1).toHaveLength(RATE_WINDOWS)
    expect(schedN3).toHaveLength(RATE_WINDOWS)
    const n1 = opTotal(tally(schedN1), [OP1_ID])
    const n3Per = op3Counts(tally(schedN3))
    const n3Total = n3Per[0] + n3Per[1] + n3Per[2]
    expect(n1).toBe(PINNED_R1_N1_WINS)
    expect(n3Total).toBe(PINNED_R1_N3_TOTAL_WINS)
    expect(2n * BigInt(n1) <= BigInt(n3Total) && BigInt(n3Total) <= 3n * BigInt(n1)).toBe(true)

    // The operator's total draw weight in the accepted set = N × L (EXACT) —
    // each distinct identity contributes one full uptime share (4.5's
    // `computeUptimeWeight`, imported — the weight is a derived INPUT to the
    // draw, AD-7).
    const setN3 = eligibleSignedSet([...BG, ...OP3], slot, SCHED_PARENT, challenge, L)
    const opWeights3 = setN3.weights.slice(BG.length) // the operator's 3 weights
    expect(opWeights3).toEqual([L, L, L])
    expect(opWeights3.reduce((s, w) => s + w, 0n)).toBe(3n * L)
    const setN1 = eligibleSignedSet([...BG, ...OP1], slot, SCHED_PARENT, challenge, L)
    expect(setN1.weights[setN1.weights.length - 1]).toBe(1n * L)
    // The 4.5 weight is DERIVED from the lookback (not a fixed input): a
    // fresh identity ramps from zero.
    expect(computeUptimeWeight([], slot, L)).toBe(0n)
    expect(computeUptimeWeight([slot - 1n], slot, L)).toBe(1n)
  }, 60_000)

  it('E2E4_R2_WINNER_PUBLIC_REJECT: over the shared real-store run, EVERY mined-block winner is accepted from PUBLIC data; a non-drawn winner AND an empty / FOREIGN signature are REJECTED (Done-when #2, E2 / AD-12)', async () => {
    // The full `simulateMultiNetwork` (the shared REAL `FileChainStore`
    // memory transport — ONE chain, single-writer, no sockets — AD-10) with
    // REAL signed tickets (AD-12): 5 windows, the 3 operator identities.
    const identities = OP3
    const results = await simulateMultiNetwork({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
      identities,
      lookbackL: L,
      windows: MINED_WINDOWS,
    })
    expect(results).toHaveLength(MINED_WINDOWS)
    expect(await store.headSlot()).toBe(MINED_WINDOWS - 1)

    // EVERY mined block's winner is accepted from PUBLIC data (the 4.3 seam:
    // `verifyDraw` + `verifyTicketSignature`) — verified BOTH by the sim's
    // own accept AND independently re-derived from the block's OWN
    // parentHash + slot (the verifier contract: the challenge is recomputed
    // from the block, never trusted — "public-coin draw").
    for (const r of results) {
      expect(r.accept).toBe(true)
      expect(r.block.winnerIdentityId).toBe(r.winnerId)
      const challenge = deriveWindowChallenge(r.block.parentHash, r.block.slot)
      const { tickets, weights, protoTickets } = eligibleSignedSet(
        identities,
        r.block.slot,
        r.block.parentHash,
        challenge,
        L,
      )
      const capped = buildCappedSet(protoTickets, weights)
      const conformed = capped.tickets.map((t) => ({
        identityId: t.identityId,
        nonceCommitment: t.nonceCommitment,
      }))
      expect(verifyDraw(r.block, conformed, capped.weights, challenge)).toBe(true)
      expect(acceptBlockWinner(r.block, capped.tickets, capped.weights, challenge)).toBe(true)
    }

    // Window 0's block + accepted set for the rejection cases.
    const w0 = results[0]
    const challenge0 = deriveWindowChallenge(w0.block.parentHash, w0.block.slot)
    const set0 = eligibleSignedSet(
      identities,
      w0.block.slot,
      w0.block.parentHash,
      challenge0,
      L,
    )
    const capped0 = buildCappedSet(set0.protoTickets, set0.weights)
    const conformed0 = capped0.tickets.map((t) => ({
      identityId: t.identityId,
      nonceCommitment: t.nonceCommitment,
    }))
    const winnerIdx = capped0.tickets.findIndex((t) => t.identityId === w0.winnerId)
    const winnerTicket0 = capped0.tickets[winnerIdx]

    // (a) A block claiming a NON-drawn winner (another identity's OWN
    // validly signed ticket for the window, but the draw did NOT select it) →
    // `acceptBlockWinner === false` — the draw gate rejects (a node not
    // selected by the draw cannot win a slot, even with a valid signature).
    const otherIdx = winnerIdx === 0 ? 1 : 0 // a non-drawn identity
    const otherTicket = capped0.tickets[otherIdx]
    const otherBlock: BlockType = {
      ...w0.block,
      winnerIdentityId: otherTicket.identityId,
      winnerTicket: Ticket.encode(otherTicket),
    }
    expect(acceptBlockWinner(otherBlock, capped0.tickets, capped0.weights, challenge0)).toBe(false)

    // (b) The winner's PUBLIC ticket fields with an EMPTY signature (an
    // unselected node that does not hold the winner's key) →
    // `acceptBlockWinner === false` EVEN THOUGH `verifyDraw` alone passes
    // (the draw gate is satisfied — the 3.4/3.7 residual replay is closed by
    // the AD-12 signature gate).
    const emptySigTicket = { ...winnerTicket0, signature: new Uint8Array(0) }
    const emptySigBlock: BlockType = {
      ...w0.block,
      winnerTicket: Ticket.encode(emptySigTicket),
    }
    expect(verifyDraw(emptySigBlock, conformed0, capped0.weights, challenge0)).toBe(true)
    expect(
      acceptBlockWinner(emptySigBlock, capped0.tickets, capped0.weights, challenge0),
    ).toBe(false)

    // (c) The winner's public ticket fields with a FOREIGN identity's
    // signature (signed by a key that does not own the winner's identityId) →
    // `acceptBlockWinner === false` — the signature gate verifies the
    // winner's OWN key over the EXACT AD-12 digest (4.2, imported) EVEN
    // THOUGH `verifyDraw` alone passes.
    const foreign = deriveIdentityKeypair(new Uint8Array(32).fill(0x55))
    const foreignSig = signTicket(foreign, {
      windowIndex: winnerTicket0.windowIndex,
      challenge: winnerTicket0.challenge,
      nonceCommitment: winnerTicket0.nonceCommitment,
    })
    const foreignSigTicket = { ...winnerTicket0, signature: new Uint8Array(foreignSig) }
    const foreignSigBlock: BlockType = {
      ...w0.block,
      winnerTicket: Ticket.encode(foreignSigTicket),
    }
    expect(verifyDraw(foreignSigBlock, conformed0, capped0.weights, challenge0)).toBe(true)
    expect(
      acceptBlockWinner(foreignSigBlock, capped0.tickets, capped0.weights, challenge0),
    ).toBe(false)
  })

  it('E2E4_R3_LAPSED_STOPS_K: a lapsed identity is excluded from D+1 onward (win count stops after D); re-attesting at W re-includes it with the monotonic deadline max(D, W + K) = 220n (Done-when #3, R4, chain-time)', () => {
    // The pure seams (4.6, imported — chain-time, AD-3):
    expect(isEligibleAtWindow(LAPSE_D, LAPSE_D)).toBe(true) // inclusive through D
    expect(isEligibleAtWindow(LAPSE_D, LAPSE_D + 1n)).toBe(false) // lapses at D + 1
    expect(reattestationWindow(REATTEST_W, K)).toBe(REATTEST_W + K) // the raw cadence W + K
    // The 4.6 lesson: an EARLY re-attest (W well before the old deadline)
    // yields W + K < oldDeadline — the sim applies max(oldDeadline, W + K)
    // for a guaranteed-MONOTONIC deadline (a pure W + K can shorten).
    const oldDeadline = 300n
    const earlyW = 150n
    expect(reattestationWindow(earlyW, K)).toBe(250n)
    expect(reattestationWindow(earlyW, K) < oldDeadline).toBe(true) // W + K < D
    const monotonic =
      oldDeadline > reattestationWindow(earlyW, K)
        ? oldDeadline
        : reattestationWindow(earlyW, K)
    expect(monotonic).toBe(oldDeadline) // max(D, W + K) — never shrinks

    // The schedule: X (seed 0) is eligible THROUGH D = 100 (lapses at 101),
    // re-attests at W = 120 → deadline max(D, W + K) = max(100n, 220n) = 220n
    // (monotonic). B (seed 1) + C (seed 2) stay fully up throughout (weight L
    // each). All chain-time — no wall clock (AD-3).
    const xLapsed: MultiSimIdentity = {
      keypair: deriveIdentityKeypair(seedFor(0)),
      attestedUntilWindow: LAPSE_D, // eligible through D, lapses at D + 1
      validWindows: Array.from({ length: LAPSE_RUN }, (_, w) => BigInt(w)),
    }
    const xReattested: MultiSimIdentity = {
      ...xLapsed,
      attestedUntilWindow:
        LAPSE_D > reattestationWindow(REATTEST_W, K)
          ? LAPSE_D
          : reattestationWindow(REATTEST_W, K), // max(D, W + K) = 220 (monotonic)
    }
    expect(xLapsed.attestedUntilWindow).toBe(LAPSE_D)
    expect(xReattested.attestedUntilWindow).toBe(REATTEST_DEADLINE)
    const b = BG[1]
    const c = BG[2]
    const xId = xLapsed.keypair.identityId

    // The 200-window LAPSED run: X's deadline (100) is below every slot in
    // [101..199] → the 4.6 gate EXCLUDES X from the accepted set there — its
    // ticket is not in the set, so it CANNOT win (R4: "a node whose
    // re-attestation lapses stops producing valid tickets").
    const lapsedRun = multiDrawSchedule([xLapsed, b, c], LAPSE_RUN, L)
    const xPreWins = lapsedRun.filter((r) => r.slot <= LAPSE_D && r.winnerId === xId).length
    const xLapsedPhaseWins = lapsedRun.filter((r) => r.slot > LAPSE_D && r.winnerId === xId).length
    // X's win count STOPS increasing after D: EXACTLY 0 wins in the lapsed
    // band [D+1 .. W-1] (and beyond) — the cumulative count is flat.
    expect(xLapsedPhaseWins).toBe(0)
    expect(lapsedRun.filter((r) => r.winnerId === xId).length).toBe(xPreWins)
    expect(xPreWins).toBe(PINNED_R3_X_PRE)

    // The RE-ATTESTED run (the same 200 windows, X's deadline
    // max(D, W + K) = 220n): X is re-included from W = 120 — its tickets are
    // in the accepted set again, so it wins again in [W .. run-end]. That is
    // the SAME window range the LAPSED run won exactly 0 in — the
    // lapsed-vs-re-included contrast is apples-to-apples (R4).
    const reattstRun = multiDrawSchedule([xReattested, b, c], LAPSE_RUN, L)
    const xPostWins = reattstRun
      .filter((r) => r.slot >= REATTEST_W && r.winnerId === xId).length
    expect(xPostWins).toBe(PINNED_R3_X_POST)
    expect(xPostWins).toBeGreaterThan(0) // re-inclusion is real, not vacuous
    // Sanity: every window has exactly one winner (the draw never skips).
    expect(lapsedRun).toHaveLength(LAPSE_RUN)
    expect(reattstRun).toHaveLength(LAPSE_RUN)
  }, 60_000)

  it('E2E4_R4_GATE_OFFLINE_NO_BLOB: the offline verifier round-trips (a non-accepted gateId → valid:false); the proto Ticket carries NO blob field; the comment-stripped src/** .blob scan is EXACTLY the single identity/gate-verifier.ts module (Done-when #4, R3 / AD-4)', async () => {
    // (a) — the OFFLINE verifier round-trip: `issueGateCredential` →
    //      `createOfflineGateVerifier().verify` → the exact port shape (the
    //      accepted-gate registry comes from the validated genesis `gates`).
    const verifier = createOfflineGateVerifier({
      acceptedGates: GENESIS.gates,
    })
    const identityId = OP3_IDS[0]
    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId,
      attestedUntilWindow: 100000,
    })
    const v = await verifier.verify(cred, 50)
    expect(v).toEqual({ valid: true, identityId, attestedUntilWindow: 100000 })

    // A NON-accepted gateId → the normal reject (must-hold (c): gates enter
    // only via the accepted registry — never auto-valid).
    const rogue = issueGateCredential({
      gateId: 'rogue-gate',
      identityId,
      attestedUntilWindow: 100000,
    })
    expect(await verifier.verify(rogue, 50)).toEqual({
      valid: false,
      identityId: '',
      attestedUntilWindow: 0,
    })

    // (b) — the GENERATED proto `Ticket` message type carries NO
    //      credential-blob field: the field set is EXACTLY the five
    //      identity/draw fields (AD-4 — a Ticket never carries the blob).
    //      Type-level: a blob field added to the proto would fail this
    //      assignment (a new property on the object literal).
    const t: ProtoTicket = {
      identityId,
      windowIndex: 7n,
      challenge: new Uint8Array(32),
      nonceCommitment: new Uint8Array(32),
      signature: new Uint8Array(64),
    }
    type NoBlobField = 'blob' extends keyof ProtoTicket ? never : true
    const noBlobField: NoBlobField = true
    expect(noBlobField).toBe(true)
    expect(Object.keys(t).sort()).toEqual([
      'challenge',
      'identityId',
      'nonceCommitment',
      'signature',
      'windowIndex',
    ])
    expect('blob' in t).toBe(false)
    expect('credentialBlob' in t).toBe(false)

    // (c) — a comment-stripped source scan of src/**/*.ts: the ONLY module
    //      that READS the credential blob (`.blob`) is the verifier
    //      (`identity/gate-verifier.ts`) — `ports.ts` declares the field
    //      type but reads no blob (AD-4: the verifier is the single
    //      credential reader).
    const files = tsFiles(SRC_DIR)
    expect(files.length).toBeGreaterThan(0)
    const readers = files
      .filter((f) => BLOB_READ.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(SRC_DIR, f))
      .sort()
    expect(
      readers,
      `modules reading .blob in src/:\n${readers.join('\n')}\nexpected exactly identity/gate-verifier.ts`,
    ).toEqual(['identity/gate-verifier.ts'])

    // Scan self-test (same row): the pattern matches `.blob` reads, not
    // declarations, calls, longer identifiers, prose, or comments.
    expect(BLOB_READ.test('const b = cred.blob')).toBe(true)
    expect(BLOB_READ.test('return c?.blob')).toBe(true)
    expect(BLOB_READ.test('blob: Uint8Array')).toBe(false) // a declaration (no dot)
    expect(BLOB_READ.test('const b = file.blob()')).toBe(false) // a method call
    expect(BLOB_READ.test('const b = x.blobx')).toBe(false) // a longer identifier
    expect(BLOB_READ.test('the blob is opaque')).toBe(false) // prose, no dot
    expect(BLOB_READ.test(stripComments('// const b = cred.blob'))).toBe(false) // comments stripped
  })

  it('E2E4_R5_RENTAL_LINEAR: the SAME 3 operator identityIds grouped two genuinely-different orderings yield BYTE-IDENTICAL aggregate win counts (operator-blind); the aggregate is LINEAR in distinct-identity count (Done-when #5, R1, the accepted limitation)', () => {
    // The SAME 3 distinct operator identityIds, grouped two GENUINELY-
    // different ways: (a) "one operator, 3 identities" — background first,
    // then the operator's 3 identities; (b) "3 operators, 1 each" — the SAME
    // 3 identities FIRST (reversed) then the background (reversed). The
    // protocol sees only DISTINCT identityIds (no operator concept, no
    // array-order concept): the per-identity commitment is keyed on
    // (identityId, slot, ticketIndex, parent) — NOT position — and the draw's
    // tie-break is by identityId — NOT position — so a permuted schedule MUST
    // yield the identical winner at every window. Comparing two genuinely
    // different orderings is what makes this non-tautological.
    const groupingOneOperator: MultiSimIdentity[] = [...BG, ...OP3] // one "operator"'s 3 identities
    const groupingThreeOperators: MultiSimIdentity[] = [
      ...OP3.slice().reverse(), // the SAME 3 identityIds — three "operators", different order
      ...BG.slice().reverse(),
    ]
    // Guards against the row degrading to a self-comparison: the two inputs
    // are genuinely DIFFERENT orderings (not element-identical)…
    expect(
      groupingThreeOperators.map((id) => id.keypair.identityId),
    ).not.toEqual(groupingOneOperator.map((id) => id.keypair.identityId))
    // …but the SAME multiset of distinct identityIds.
    expect([...groupingThreeOperators.map((id) => id.keypair.identityId)].sort()).toEqual(
      [...groupingOneOperator.map((id) => id.keypair.identityId)].sort(),
    )

    // BYTE-IDENTICAL: the SAME winner at EVERY window (operator-blind) — the
    // accepted set is the same set of distinct identityIds with the same
    // per-identity weights (order carries no information the protocol can
    // see — the draw is the IMPORTED `drawWindow`, AD-7).
    const schedA = multiDrawSchedule(groupingOneOperator, RATE_WINDOWS, L)
    const schedB = multiDrawSchedule(groupingThreeOperators, RATE_WINDOWS, L)
    expect(schedB).toEqual(schedA)
    for (let w = 0; w < RATE_WINDOWS; w++) {
      expect(schedB[w].winnerId).toBe(schedA[w].winnerId)
    }
    const counts = tally(schedA)
    const per = op3Counts(counts)
    const total = per[0] + per[1] + per[2]
    expect(total).toBe(PINNED_R1_N3_TOTAL_WINS) // the R1 N=3 aggregate (the same 4.8 pin)

    // LINEAR: the operator's aggregate is a function of the DISTINCT-identity
    // count — N identities → N × (one full share), not N² or √N: the N=3
    // aggregate sits in the linear band [2×, 3×] of the N=1 aggregate (the
    // exact weight-proportional expectation is 2× — N² would be ≈ 9×, √N ≈
    // 1.7×), and the per-identity shares sum EXACTLY to the aggregate (no
    // operator-level pooling — identity rental is linear-cost: a per-identity
    // floor, NOT per-operator equality — the accepted limitation).
    const n1 = opTotal(tally(multiDrawSchedule([...BG, ...OP1], RATE_WINDOWS, L)), [OP1_ID])
    expect(n1).toBe(PINNED_R1_N1_WINS)
    expect(2n * BigInt(n1) <= BigInt(total) && BigInt(total) <= 3n * BigInt(n1)).toBe(true)
    for (const share of per) {
      expect(2n * BigInt(share) >= BigInt(n1) && BigInt(share) <= BigInt(n1)).toBe(true)
    }
    expect(per[0] + per[1] + per[2]).toBe(total)
  }, 60_000)
})
