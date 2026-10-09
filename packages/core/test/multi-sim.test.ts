/**
 * MULTI-IDENTITY SIMULATION — the acceptance cap + uptime + re-attestation
 * matrix (4.8, R1/R2).
 *
 * The sim (src/consensus/multi-sim.ts) is the epic-4 generalization of
 * 3.7's `sim.ts`: a multi-identity memory-transport harness that wires
 * epic-4's **signed tickets** (4.2, AD-12), the **uptime** seam (4.5), the
 * **acceptance cap** (4.4), and the **re-attestation** seam (4.6) into
 * epic-3's draw/acceptance path — composing with the **IMPORTED**
 * `drawWindow` (3.3, AD-7) and `acceptBlockWinner` (4.3: `verifyDraw` +
 * `verifyTicketSignature`). It proves the honest, enforceable R1/R2 model
 * (registration-design R1: "the protocol can never know who an 'operator'
 * is"):
 *
 *   MSIM_R1_CAP_PER_IDENTITY         one identity A submitting 3 DISTINCT
 *                                    signed tickets in a window (3 distinct
 *                                    pinned commitments) + B + C:
 *                                    `buildCappedSet` (4.4) collapses A to
 *                                    ONE ticket (keep-first) — A's weight
 *                                    counted ONCE; the capped set's weight
 *                                    slots = 3 (distinct identities), not
 *                                    5 (raw tickets); over a pinned 4000-
 *                                    window schedule, A's win count with
 *                                    3 tickets/window === A's win count
 *                                    with 1 ticket/window (the extra
 *                                    tickets are pure dead weight, dropped
 *                                    before the draw) — R1.
 *   MSIM_R2_N_PERSONS_NX             the PURE `multiDrawSchedule` over a
 *                                    fixed background (3 identities, weight
 *                                    L) + the operator's N identities
 *                                    (each weight L, fully up): the
 *                                    operator's aggregate win-rate scales
 *                                    ~N× in distinct-identity count (each
 *                                    new distinct identity adds one full
 *                                    uptime share — N=3 ≈ 2–3× the N=1
 *                                    aggregate, integer band); the
 *                                    operator's total draw weight = N × L
 *                                    (EXACT) — R2, the IMPORTED
 *                                    `drawWindow` (AD-7) decides.
 *   MSIM_RENTAL_LINEAR_PER_IDENTITY  the SAME 3 operator identityIds grouped
 *                                    two ways — "one operator, 3 identities"
 *                                    vs "3 operators, 1 each": the accepted
 *                                    set and the operator's aggregate win
 *                                    counts are IDENTICAL (operator-blind);
 *                                    the aggregate is a LINEAR function of
 *                                    distinct-identity count (N identities →
 *                                    N×, not N² or √N) — identity rental is
 *                                    linear-cost (the accepted limitation).
 *   MSIM_LAPSED_STOPS_K              an identity with `attestedUntilWindow =
 *                                    D` is excluded from the accepted set
 *                                    from `D+1` onward (`isEligibleAtWindow`
 *                                    false — its win count stops increasing
 *                                    after `D`); re-attesting at `W`
 *                                    re-includes it with the monotonic
 *                                    deadline `max(D, W + K)` (the 4.6
 *                                    lesson) — all chain-time (AD-3).
 *   MSIM_WINNER_PUBLIC_VERIFY        the full `simulateMultiNetwork` on a
 *                                    REAL `FileChainStore` with REAL signed
 *                                    tickets (AD-12): EVERY mined block's
 *                                    winner is accepted from PUBLIC data
 *                                    (`acceptBlockWinner === true`); an
 *                                    unselected node's block is REJECTED —
 *                                    (a) a non-drawn winner claim → false;
 *                                    (b) the winner's public ticket fields
 *                                    with an EMPTY signature → false even
 *                                    though `verifyDraw` alone passes;
 *                                    (c) with a FOREIGN identity's
 *                                    signature → false (the 3.4/3.7
 *                                    residual replay closed end-to-end by
 *                                    the AD-12 signature).
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — fixed 32-byte seeds →
 * keypairs (the IMPORTED `deriveIdentityKeypair`), every challenge =
 * `deriveWindowChallenge`, every commitment = a pinned per-(identity, slot,
 * parent) `sha256` of public data (domain-separated
 * `"SC-MULTISIM-COMMIT/1"`), every signature = deterministic Ed25519 (the
 * IMPORTED `signTicket` over the EXACT AD-12 digest). The pinned winner
 * counts are EXACT integers, stable across runs (verified 2-run).
 * AD-5 discipline: NO `big.js`, NO float — every "~N×" / "linear" /
 * "≤ one share" assertion is an EXACT integer count / cross-multiplied
 * weight comparison (never a `number` rate).
 * AD-7 discipline: the draw (`drawWindow`), the cap (`applyAcceptanceCap`
 * via `buildCappedSet`), the uptime (`computeUptimeWeight`), the
 * eligibility (`isEligibleAtWindow` / `reattestationWindow`), the signature
 * (`signTicket`), and the acceptance (`acceptBlockWinner`) are all IMPORTED
 * from the ROOT barrel — this file NEVER re-implements the draw, the
 * signature, the cap, or the uptime (the R1 3-ticket schedule only COMPOSES
 * them: `signedTicket` ×3 → `buildCappedSet` → `drawWindow` — the same
 * composition the module's `multiDrawSchedule` performs over the eligible
 * set).
 *
 * Test hygiene (AD-10): a fresh `os.tmpdir()` dir for the REAL
 * `FileChainStore` in the full-path row (as 3.7's `simulation.test.ts`
 * does), closed + `rmSync` in `afterEach`; the rate rows are pure (no
 * store). No real sockets, no new runtime deps.
 */
import { mkdtempSync, rmSync } from 'node:fs'
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
  deriveIdentityKeypair,
  deriveWindowChallenge,
  drawWindow,
  eligibleSignedSet,
  isEligibleAtWindow,
  loadGenesis,
  multiDrawSchedule,
  protoTicketToDrawTicket,
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
// Pinned sim parameters (4.8, D8 — the ticket's `unknown`, a build decision)
// ---------------------------------------------------------------------------

/** The repo-root `config/genesis.json` path (test dir → packages/core → repo root). */
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

/** The PURE rate-schedule window count (pinned, D8 — matching 3.7's 4000). */
const RATE_WINDOWS = 4000
/** The full-path window count (pinned): 3 windows through a real FileChainStore. */
const FULL_PATH_WINDOWS = 3
/** The lapsed-identity run size (pinned): 200 chain windows. */
const LAPSE_RUN = 200
/** The lapse point (pinned): D = 100 — X is eligible THROUGH D, lapses at D+1. */
const LAPSE_D = 100n
/** The re-attest point (pinned): W = 120 — after the lapsed phase (101..119). */
const REATTEST_W = 120n

/**
 * Fixed identity seeds (4.2-style, no RNG): a 32-byte value filled with
 * `0x40 + i` (distinct from the reserved MINT/BURN/TRACER ids and from
 * each other). `deriveIdentityKeypair` (IMPORTED) maps each seed
 * deterministically to a keypair (the same seed → the same keypair, so the
 * whole fixture is reproducible — AD-3/AD-10).
 */
function seedFor(i: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + i)
}

/** A 32 zero-byte parent (the PURE rate schedule's fixed parent, AD-3 — the module's `FIXED_PARENT`). */
const SCHED_PARENT = new Uint8Array(32)

/**
 * Build a gate-verified sim identity from a seed: the IMPORTED
 * `deriveIdentityKeypair` keypair (the AD-11 core-internal sim value), an
 * attestation deadline far beyond any sim window (fully un-lapsed), and a
 * `validWindows` history covering every window of a `RATE_WINDOWS`-long
 * schedule — so its 4.5 weight is `L` (fully up) at every window `≥ L`
 * (the ramp from zero at windows `< L` is the 4.5 feature, identical
 * across all rate rows).
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
// Pinned DETERMINISTIC outcomes (D7 — EXACT integers, 2-run stable; the
// schedule is a pinned sha256/Ed25519 of public data, so it is reproducible
// across runs/engines — regenerate ONLY by changing the pinned sim
// parameters (the draw, the seeds, the window count), which is a protocol
// change (AD-7)).
// ---------------------------------------------------------------------------

// MSIM_R1 — the 1-ticket and 3-ticket schedules for A (over A + B + C,
// 4000 windows) yield the IDENTICAL per-window winner and the same
// per-identity win counts (the extra tickets are dead weight, dropped
// before the draw):
const PINNED_R1_A_WINS = 1330
const PINNED_R1_B_WINS = 1313
const PINNED_R1_C_WINS = 1357

// MSIM_R2 — the operator's aggregate win count (3-identity background + N
// operator identities, 4000 windows): the N=1 total, the N=3 total, and
// the N=3 per-identity counts (in `OP3` order):
const PINNED_R2_OP_N1_WINS = 1007
const PINNED_R2_OP_N3_TOTAL_WINS = 2031
const PINNED_R2_OP_N3_WINS: [number, number, number] = [678, 677, 676]

// MSIM_R4 — the lapsed identity X (deadline D = 100, re-attests at
// W = 120 → deadline max(D, W + K) = 220): X's wins in the eligible phase
// [0..100] of the 200-window lapsed run, X's wins in the 80-window
// re-attested run, and B/C's per-phase counts [0..100] / [101..199]:
const PINNED_R4_X_PRE = 32
const PINNED_R4_X_POST = 27
const PINNED_R4_B_PHASES: [number, number] = [37, 54]
const PINNED_R4_C_PHASES: [number, number] = [32, 45]

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let dir: string
let store: FileChainStore

/** A fresh temp data dir + OPEN `FileChainStore` per test; closed + removed after. */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'succinctcoin-multi-sim-'))
  store = new FileChainStore(dir)
  await store.open()
})
afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

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
 * The RAW multi-ticket schedule (the R1 cap case) — the `multiDrawSchedule`
 * composition over a RAW accepted set where the identities in `multi`
 * submit 3 DISTINCT signed tickets per window (3 distinct pinned
 * commitments, weight counted per ticket) and the others 1: per window,
 * `signedTicket` (×3) → `buildCappedSet` (4.4 — the cap collapses each
 * multi-ticket identity to its FIRST ticket) → `drawWindow` (AD-7, the
 * conformed set) → the winner. Same `FIXED_PARENT` + slot = window index
 * as `multiDrawSchedule` (AD-3 — fully deterministic). COMPOSES the
 * imported seams only — never re-implements the draw / cap / signature.
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
    const draw = drawWindow(capped.tickets.map(protoTicketToDrawTicket), challenge, capped.weights)
    out.push({ winnerId: draw.winnerIdentityId, slot })
  }
  return out
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

describe('MULTI-IDENTITY SIMULATION — the acceptance cap + uptime + re-attestation (4.8, R1/R2)', () => {
  it('MSIM_R1_CAP_PER_IDENTITY: the acceptance cap collapses A to ONE ticket — A wins exactly its ONE share with 3 tickets/window as with 1 (R1)', () => {
    const a = OP1[0]
    const b = BG[0]
    const c = BG[1]

    // The cap over ONE window: A submits 3 DISTINCT signed tickets (3
    // distinct pinned commitments — the ticket index is part of the
    // domain-separated commitment) + B + C each submit 1. The RAW aligned
    // set has 5 tickets (weight L each — counted per ticket); the 4.4 cap
    // (IMPORTED via `buildCappedSet`) collapses it to 3 weight slots
    // (distinct identities) — A's weight counted ONCE (R1: "one share, not
    // more"), then the IMPORTED `drawWindow` (AD-7) runs over the capped set.
    const slot = 60n // w ≥ L: all identities fully up → weight L each
    const challenge = deriveWindowChallenge(SCHED_PARENT, slot)
    const tA0 = signedTicket(a.keypair, slot, SCHED_PARENT, challenge, 0n)
    const tA1 = signedTicket(a.keypair, slot, SCHED_PARENT, challenge, 1n)
    const tA2 = signedTicket(a.keypair, slot, SCHED_PARENT, challenge, 2n)
    const tB = signedTicket(b.keypair, slot, SCHED_PARENT, challenge, 0n)
    const tC = signedTicket(c.keypair, slot, SCHED_PARENT, challenge, 0n)

    // The 3 tickets are byte-different (distinct commitments) — so the cap
    // (keep-first over identityId), not an exact-duplicate check, collapses
    // them; and each is REAL + SIGNED (AD-12: a 64-byte Ed25519 signature
    // over the EXACT AD-12 digest — the 4.2 `signTicket`, imported).
    expect(bytesEqual(tA0.nonceCommitment, tA1.nonceCommitment)).toBe(false)
    expect(bytesEqual(tA1.nonceCommitment, tA2.nonceCommitment)).toBe(false)
    expect(bytesEqual(tA0.nonceCommitment, tA2.nonceCommitment)).toBe(false)
    for (const t of [tA0, tA1, tA2, tB, tC]) {
      expect(t.signature.byteLength).toBe(64)
    }

    const capped = buildCappedSet([tA0, tA1, tA2, tB, tC], [L, L, L, L, L])

    // The capped set has EXACTLY 3 weight slots (the DISTINCT identity
    // count), not 5 (the raw ticket count) — A's draw weight is counted
    // ONCE (its slot-eligibility is one share, not more).
    expect(capped.tickets).toHaveLength(3)
    expect(capped.weights).toEqual([L, L, L])
    // keep-FIRST: A survives with its FIRST ticket (tA0), B and C keep
    // theirs; the dropped duplicates (tA1, tA2) are in NO slot.
    expect(capped.tickets[0].identityId).toBe(a.keypair.identityId)
    expect(bytesEqual(capped.tickets[0].nonceCommitment, tA0.nonceCommitment)).toBe(true)
    expect(capped.tickets[1].identityId).toBe(b.keypair.identityId)
    expect(capped.tickets[2].identityId).toBe(c.keypair.identityId)
    for (const dropped of [tA1, tA2]) {
      expect(
        capped.tickets.some((k) => bytesEqual(k.nonceCommitment, dropped.nonceCommitment)),
      ).toBe(false)
    }
    // The draw (IMPORTED — AD-7) runs over the CAPPED set: one of the 3
    // distinct identities wins — never a dropped duplicate.
    const draw = drawWindow(
      capped.tickets.map(protoTicketToDrawTicket),
      challenge,
      capped.weights,
    )
    expect([a.keypair.identityId, b.keypair.identityId, c.keypair.identityId]).toContain(
      draw.winnerIdentityId,
    )

    // Over the pinned 4000-window schedule: A's win count with
    // 3 tickets/window === A's win count with 1 ticket/window — the raw
    // 3-tickets/window set collapses under the cap to the SAME
    // one-ticket-per-identity set as the 1-ticket schedule, so the
    // IMPORTED draw sees identical inputs and yields the identical winner
    // at EVERY window (the extra tickets are pure dead weight, dropped
    // before the draw — an identity's extra tickets earn NO extra
    // eligibility).
    const oneTicket = multiDrawSchedule([a, b, c], RATE_WINDOWS, L)
    const threeTicket = rawMultiTicketSchedule([a, b, c], RATE_WINDOWS, L, [a])
    expect(threeTicket).toEqual(oneTicket)
    for (let w = 0; w < RATE_WINDOWS; w++) {
      expect(threeTicket[w].winnerId).toBe(oneTicket[w].winnerId)
    }
    const counts = tally(oneTicket)
    const threeCounts = tally(threeTicket)
    expect(counts.get(a.keypair.identityId) ?? 0).toBe(threeCounts.get(a.keypair.identityId) ?? 0)
    expect(counts.get(a.keypair.identityId) ?? 0).toBe(PINNED_R1_A_WINS)
    expect(counts.get(b.keypair.identityId) ?? 0).toBe(PINNED_R1_B_WINS)
    expect(counts.get(c.keypair.identityId) ?? 0).toBe(PINNED_R1_C_WINS)
    expect(
      (counts.get(a.keypair.identityId) ?? 0) +
        (counts.get(b.keypair.identityId) ?? 0) +
        (counts.get(c.keypair.identityId) ?? 0),
    ).toBe(RATE_WINDOWS)
  }, 60_000)

  it('MSIM_R2_N_PERSONS_NX: N DISTINCT gate-verified identities add a full share each — the operator wins ~N× (N=3 ≈ 2–3× N=1), total weight N × L EXACT (R2)', () => {
    // Against the fixed background (3 identities, weight L each, fully up),
    // the operator's N=1 vs N=3 (each weight L, fully up) over the pinned
    // 4000-window PURE schedule (the IMPORTED `drawWindow` decides — AD-7:
    // never re-implemented).
    const schedN1 = multiDrawSchedule([...BG, ...OP1], RATE_WINDOWS, L)
    const schedN3 = multiDrawSchedule([...BG, ...OP3], RATE_WINDOWS, L)
    expect(schedN1).toHaveLength(RATE_WINDOWS)
    expect(schedN3).toHaveLength(RATE_WINDOWS)

    const n1 = opTotal(tally(schedN1), [OP1_ID])
    const n3Per = op3Counts(tally(schedN3))
    const n3Total = n3Per[0] + n3Per[1] + n3Per[2]
    expect(n1).toBe(PINNED_R2_OP_N1_WINS)
    expect(n3Per).toEqual(PINNED_R2_OP_N3_WINS)
    expect(n3Total).toBe(PINNED_R2_OP_N3_TOTAL_WINS)

    // ~N× (EXACT integer cross-multiplication — no float, AD-5): the
    // operator's aggregate win-rate scales ~N× in its distinct-identity
    // count — each new distinct identity adds one full uptime share. The
    // exact weight-proportional expectation is 2× (weight share 3L/6L =
    // 1/2 at N=3 vs L/4L = 1/4 at N=1); the integer band [2×, 3×] is a
    // pin-drift guard around the pinned exact counts (not a flake
    // absorber) and separates LINEAR growth from flat (1×) or
    // superlinear (≥ 4×).
    expect(2n * BigInt(n1) <= BigInt(n3Total) && BigInt(n3Total) <= 3n * BigInt(n1)).toBe(true)
    // Each of the 3 distinct identities earns ≈ one share of the
    // aggregate — within an integer band of the N=1 share (each ≈ the
    // N=1 share, within the band): each share ∈ [n1/2, n1].
    for (const share of n3Per) {
      expect(
        2n * BigInt(share) >= BigInt(n1) && BigInt(share) <= BigInt(n1),
      ).toBe(true)
    }

    // The operator's total draw weight in the accepted set = N × L (EXACT)
    // — each new distinct identity contributes one full uptime share
    // (4.5's `computeUptimeWeight`, imported — the weight is a derived
    // INPUT to the draw, AD-7).
    const slot = 60n // w ≥ L: fully up → weight L each
    const challenge = deriveWindowChallenge(SCHED_PARENT, slot)
    const setN3 = eligibleSignedSet([...BG, ...OP3], slot, SCHED_PARENT, challenge, L)
    const opWeights3 = setN3.weights.slice(BG.length) // the operator's 3 weights
    expect(opWeights3).toEqual([L, L, L])
    expect(opWeights3.reduce((s, w) => s + w, 0n)).toBe(3n * L)
    const setN1 = eligibleSignedSet([...BG, ...OP1], slot, SCHED_PARENT, challenge, L)
    expect(setN1.weights[setN1.weights.length - 1]).toBe(1n * L)
    // The 4.5 weight is DERIVED from the lookback (not a fixed input like
    // 3.7's `SimNode.uptime`): a fresh identity ramps from zero.
    expect(computeUptimeWeight([], slot, L)).toBe(0n)
    expect(computeUptimeWeight([slot - 1n], slot, L)).toBe(1n)
    expect(computeUptimeWeight(Array.from({ length: 50 }, (_, i) => slot - 50n + BigInt(i)), slot, L)).toBe(L)
  }, 60_000)

  it('MSIM_RENTAL_LINEAR_PER_IDENTITY: the SAME identityIds grouped "one operator / N" vs "N operators / 1 each" are IDENTICAL (operator-blind) and LINEAR in distinct-identity count (the accepted limitation)', () => {
    // The SAME 3 distinct operator identityIds, grouped two ways:
    //   (a) ONE operator running 3 gate-verified persons;
    //   (b) 3 operators, each running 1 person.
    // The protocol sees only DISTINCT identityIds — there is no operator
    // concept — so the accepted set and the operator's aggregate win
    // counts are IDENTICAL in (a) and (b) (operator-blind).
    //
    // The two groupings contain the SAME set of 6 distinct identityIds
    // (each with the same per-identity weight `L`), but in a DIFFERENT
    // ORDER: (a) = background first, then the operator's 3 identities;
    // (b) = the same 3 identities FIRST (reversed) then the background
    // (reversed) — i.e. "the 3 operators' 1 person each" presented in a
    // different order than "one operator's 3 persons". The protocol sees
    // only the DISTINCT identityIds (no operator concept, no array-order
    // concept): the per-identity commitment is keyed on
    // (identityId, slot, ticketIndex, parent) — NOT position — and the
    // draw's tie-break is by identityId — NOT position — so a permuted
    // schedule MUST yield the identical winner at every window. Comparing
    // two genuinely different orderings is what makes this non-tautological
    // (if the commitment or the tie-break ever depended on array position,
    // the two schedules would diverge and this assertion would fail).
    const groupingOneOperator: MultiSimIdentity[] = [...BG, ...OP3] // one "operator"'s 3 identities
    const groupingThreeOperators: MultiSimIdentity[] = [
      ...OP3.slice().reverse(), // the SAME 3 identityIds — three "operators", different order
      ...BG.slice().reverse(),
    ]
    const schedA = multiDrawSchedule(groupingOneOperator, RATE_WINDOWS, L)
    const schedB = multiDrawSchedule(groupingThreeOperators, RATE_WINDOWS, L)

    // The two inputs are genuinely DIFFERENT orderings (guards against the
    // row degrading back to a self-comparison): the arrays are not
    // element-identical.
    expect(
      groupingThreeOperators.map((id) => id.keypair.identityId),
    ).not.toEqual(groupingOneOperator.map((id) => id.keypair.identityId))
    // …but the SAME multiset of distinct identityIds.
    expect(
      [...groupingThreeOperators.map((id) => id.keypair.identityId)].sort(),
    ).toEqual([...groupingOneOperator.map((id) => id.keypair.identityId)].sort())

    // IDENTICAL: the SAME winner at EVERY window — the accepted set is the
    // same set of distinct identityIds with the same per-identity weights
    // (order carries no information the protocol can see — the draw is the
    // IMPORTED `drawWindow` — AD-7).
    expect(schedB).toEqual(schedA)
    for (let w = 0; w < RATE_WINDOWS; w++) {
      expect(schedB[w].winnerId).toBe(schedA[w].winnerId)
    }
    const counts = tally(schedA)
    const per = op3Counts(counts)
    const total = per[0] + per[1] + per[2]
    expect(total).toBe(PINNED_R2_OP_N3_TOTAL_WINS) // the R2 N=3 aggregate

    // LINEAR: the operator's aggregate is a function of the
    // DISTINCT-identity count — N identities → N × (one full share), not
    // N² or √N: the N=3 aggregate sits in the linear band [2×, 3×] of the
    // N=1 aggregate (the exact weight-proportional expectation is 2× — N²
    // would be ≈ 9×, √N ≈ 1.7×), and the per-identity shares sum EXACTLY
    // to the aggregate (no operator-level pooling — identity rental is
    // linear-cost: a per-identity floor, NOT per-operator equality — the
    // accepted limitation, R2 / registration-design "Known, accepted
    // limitations").
    const n1 = PINNED_R2_OP_N1_WINS
    expect(2n * BigInt(n1) <= BigInt(total) && BigInt(total) <= 3n * BigInt(n1)).toBe(true)
    for (const share of per) {
      expect(2n * BigInt(share) >= BigInt(n1) && BigInt(share) <= BigInt(n1)).toBe(true)
    }
    expect(per[0] + per[1] + per[2]).toBe(total)
  }, 60_000)

  it('MSIM_LAPSED_STOPS_K: a lapsed identity is excluded from D+1 onward (win count stops after D); re-attesting at W re-includes it with the monotonic deadline max(D, W + K) (R4, chain-time)', () => {
    // The pure seams (4.6, imported — chain-time, AD-3):
    expect(isEligibleAtWindow(LAPSE_D, LAPSE_D)).toBe(true) // inclusive through D
    expect(isEligibleAtWindow(LAPSE_D, LAPSE_D + 1n)).toBe(false) // lapses at D + 1
    expect(reattestationWindow(REATTEST_W, K)).toBe(REATTEST_W + K) // the raw cadence W + K
    // The 4.6 lesson: an EARLY re-attest (W well before the old deadline)
    // yields W + K < oldDeadline — the sim applies max(oldDeadline, W + K)
    // for a guaranteed-MONOTONIC deadline (a pure W + K can shorten on an
    // early re-attest).
    const oldDeadline = 300n
    const earlyW = 150n
    expect(reattestationWindow(earlyW, K)).toBe(250n)
    expect(reattestationWindow(earlyW, K) < oldDeadline).toBe(true) // W + K < D
    const monotonic =
      oldDeadline > reattestationWindow(earlyW, K)
        ? oldDeadline
        : reattestationWindow(earlyW, K)
    expect(monotonic).toBe(oldDeadline) // max(D, W + K) — never shrinks

    // The schedule: X (seed 0) is eligible THROUGH D = 100 (lapses at
    // 101), re-attests at W = 120 → deadline max(D, W + K) = 220
    // (monotonic — the sim's D5 wiring: `max(oldDeadline,
    // reattestationWindow(W, K))`). B (seed 1) + C (seed 2) stay fully up
    // throughout (weight L each). All chain-time — no wall clock (AD-3).
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
    expect(xLapsed.attestedUntilWindow).toBe(100n)
    expect(xReattested.attestedUntilWindow).toBe(220n)
    const b = BG[1]
    const c = BG[2]
    const xId = xLapsed.keypair.identityId
    const bId = b.keypair.identityId
    const cId = c.keypair.identityId

    // The 200-window LAPSED run: X's deadline (100) is below every slot in
    // [101..199] → the 4.6 gate EXCLUDES X from the accepted set there —
    // its ticket is not in the set, so it CANNOT win (R4: "a node whose
    // re-attestation lapses stops producing valid tickets").
    const lapsedRun = multiDrawSchedule([xLapsed, b, c], LAPSE_RUN, L)
    const xPreWins = lapsedRun.filter((r) => r.slot <= LAPSE_D && r.winnerId === xId).length
    const xLapsedPhaseWins = lapsedRun
      .filter((r) => r.slot > LAPSE_D && r.winnerId === xId).length
    // X's win count STOPS increasing after D: EXACTLY 0 wins in the lapsed
    // phase [101..199] — the cumulative count is flat from D onward.
    expect(xLapsedPhaseWins).toBe(0)
    expect(lapsedRun.filter((r) => r.winnerId === xId).length).toBe(xPreWins)
    expect(xPreWins).toBe(PINNED_R4_X_PRE)

    // The RE-ATTESTED run (the same 200 windows, X's deadline
    // max(D, W + K) = 220): X is re-included from W = 120 — its tickets
    // are in the accepted set again, so it wins again in the re-included
    // stretch [120..199]. That is the SAME window range the LAPSED run won
    // exactly 0 in (X lapsed at 101) — the lapsed-vs-re-included contrast
    // is apples-to-apples (the lapsed identity's throughput resumes once
    // re-attested, R4).
    const reattstRun = multiDrawSchedule([xReattested, b, c], LAPSE_RUN, L)
    const xPostWins = reattstRun
      .filter((r) => r.slot >= REATTEST_W && r.winnerId === xId).length
    expect(xPostWins).toBe(PINNED_R4_X_POST)
    expect(xPostWins).toBeGreaterThan(0) // re-inclusion is real, not vacuous

    // The background's per-phase win counts (B, C) — pinned EXACT (they
    // keep winning through both phases; X's freed share goes to them while
    // lapsed — their phase-2 share rises from 1/3 to 1/2 of the set):
    const phaseCounts = (
      run: Array<{ winnerId: string; slot: bigint }>,
      id: string,
    ): [number, number] => [
      run.filter((r) => r.slot <= LAPSE_D && r.winnerId === id).length,
      run.filter((r) => r.slot > LAPSE_D && r.winnerId === id).length,
    ]
    expect(phaseCounts(lapsedRun, bId)).toEqual(PINNED_R4_B_PHASES)
    expect(phaseCounts(lapsedRun, cId)).toEqual(PINNED_R4_C_PHASES)
    // Sanity: every window has exactly one winner (the draw never skips).
    expect(lapsedRun).toHaveLength(LAPSE_RUN)
  }, 60_000)

  it('MSIM_WINNER_PUBLIC_VERIFY: every mined block winner is accepted from PUBLIC data; a non-drawn winner AND an empty/foreign signature are REJECTED (the residual replay is closed end-to-end)', async () => {
    // The full `simulateMultiNetwork` (real `FileChainStore` memory
    // transport) with REAL signed tickets (AD-12): 3 windows, the 3
    // operator identities (fully up), attested far ahead.
    const identities = OP3
    const results = await simulateMultiNetwork({
      store,
      rewardDisplay: REWARD_DISPLAY,
      maxSupplyDisplay: MAX_SUPPLY_DISPLAY,
      identities,
      lookbackL: L,
      windows: FULL_PATH_WINDOWS,
    })
    expect(results).toHaveLength(FULL_PATH_WINDOWS)
    expect(await store.headSlot()).toBe(FULL_PATH_WINDOWS - 1)

    // EVERY mined block's winner is accepted from PUBLIC data (the 4.3
    // seam: `verifyDraw` + `verifyTicketSignature`) — verified BOTH by the
    // sim's own accept AND independently re-derived from the block's OWN
    // parentHash + slot (the verifier contract: the challenge is
    // recomputed from the block, never trusted — R2 "public-coin draw").
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
    const set0 = eligibleSignedSet(identities, w0.block.slot, w0.block.parentHash, challenge0, L)
    const capped0 = buildCappedSet(set0.protoTickets, set0.weights)
    const conformed0 = capped0.tickets.map((t) => ({
      identityId: t.identityId,
      nonceCommitment: t.nonceCommitment,
    }))
    const winnerIdx = capped0.tickets.findIndex((t) => t.identityId === w0.winnerId)
    const winnerTicket0 = capped0.tickets[winnerIdx]

    // (a) A block claiming a NON-drawn winner (another identity's OWN
    //     validly signed ticket for the window, but the draw did NOT
    //     select it) → `acceptBlockWinner === false` — the draw gate
    //     rejects (a node not selected by the draw cannot win a slot, even
    //     with a valid signature).
    const otherIdx = winnerIdx === 0 ? 1 : 0 // a non-drawn identity
    const otherTicket = capped0.tickets[otherIdx]
    const otherBlock: BlockType = {
      ...w0.block,
      winnerIdentityId: otherTicket.identityId,
      winnerTicket: Ticket.encode(otherTicket),
    }
    expect(acceptBlockWinner(otherBlock, capped0.tickets, capped0.weights, challenge0)).toBe(false)

    // (b) The winner's PUBLIC ticket fields with an EMPTY signature (an
    //     unselected node that does not hold the winner's key) →
    //     `acceptBlockWinner === false` EVEN THOUGH `verifyDraw` alone
    //     passes (the draw gate is satisfied — the 3.4/3.7 residual replay
    //     is closed by the AD-12 signature gate).
    const emptySigTicket = { ...winnerTicket0, signature: new Uint8Array(0) }
    const emptySigBlock: BlockType = {
      ...w0.block,
      winnerTicket: Ticket.encode(emptySigTicket),
    }
    expect(verifyDraw(emptySigBlock, conformed0, capped0.weights, challenge0)).toBe(true)
    expect(acceptBlockWinner(emptySigBlock, capped0.tickets, capped0.weights, challenge0)).toBe(false)

    // (c) The winner's public ticket fields with a FOREIGN identity's
    //     signature (signed by a key that does not own the winner's
    //     identityId) → `acceptBlockWinner === false` — the signature gate
    //     verifies the winner's OWN key over the EXACT AD-12 digest (4.2,
    //     imported — a foreign key cannot forge it) EVEN THOUGH
    //     `verifyDraw` alone passes.
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
    expect(acceptBlockWinner(foreignSigBlock, capped0.tickets, capped0.weights, challenge0)).toBe(false)
  })
})
