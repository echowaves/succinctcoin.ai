/**
 * CONSENSUS ACCEPTANCE-CAP — the acceptance cap (4.4, R1: the enforceable
 * form of the registration design's "one valid ticket per identity per
 * chain-window").
 *
 * The cap is a PURE pre-draw filter on a window's RAW accepted set
 * (`applyAcceptanceCap`): when the set carries more than one ticket for the
 * same `identityId`, the extra tickets are DROPPED — the identity earns no
 * extra eligibility (no extra draw weight), so its draw odds do not scale
 * with its ticket count; combined with 3.6's FIXED reward (the winner earns
 * the constant `rewardBaseUnits`, independent of identity count), the reward
 * never scales with identity count (R1).
 *
 *   CAP_DEDUPES_SECOND_TICKET     an accepted set where identity A has 3
 *                                 tickets (same window) + B (1) + C (1) = 5
 *                                 input tickets → `applyAcceptanceCap` →
 *                                 exactly ONE ticket for A (the 2nd + 3rd
 *                                 dropped); the result = A once + B once + C
 *                                 once = 3 tickets (from 5 input).
 *   CAP_FIRST_OCCURRENCE_WINS     identity A at input indices 0, 2, 4
 *                                 (distinct commitments), B at 1, C at 3 →
 *                                 the FIRST (index-0) A ticket is kept (its
 *                                 exact commitment); the index-2 and index-4
 *                                 A tickets are dropped; kept order = input
 *                                 order `[A(0), B, C]` (deterministic).
 *   CAP_DISTINCT_IDENTITIES_UNCHANGED  an all-DISTINCT accepted set (B, C,
 *                                 A — one each; the epic-3 sim shape) →
 *                                 `applyAcceptanceCap` is a NO-OP: same
 *                                 length, same order, byte-identical tickets
 *                                 (ADDITIVE — epic-3's distinct-identity
 *                                 accepted sets are unaffected).
 *   CAP_PRE_DRAW_FILTER           the CAPPED set (A once + B + C) fed to the
 *                                 IMPORTED `drawWindow` (AD-7, never
 *                                 re-implemented) over the capped weights →
 *                                 the draw selects a winner among the capped
 *                                 identities; a dropped A-duplicate's
 *                                 commitment does NOT affect the draw — the
 *                                 capped draw == the draw over the
 *                                 de-duplicated identities only.
 *   CAP_ONE_ELIGIBILITY_EACH      A with 3 tickets (3 aligned `5n` weight
 *                                 slots) + B (1× `3n`) + C (1× `1n`) →
 *                                 after the cap, A contributes exactly ONE
 *                                 draw weight (one surviving ticket —
 *                                 counted once, not 3×); the total number of
 *                                 draw-weight slots = the number of DISTINCT
 *                                 identities (3), not the number of input
 *                                 tickets (5).
 *
 * AD-3 discipline: NO `Math.random`, NO wall clock — fixed identity seeds,
 * fixed weights, a fixed (non-zero) parent hash, and every commitment a
 * pinned `sha256` of public data (the 4.3 `accept-winner` fixture pattern).
 * AD-7 discipline: the draw (`drawWindow`), the conformance
 * (`protoTicketToDrawTicket`), the AD-12 signature (`signTicket`), and the
 * challenge (`deriveWindowChallenge`) are all IMPORTED from the ROOT barrel —
 * this file NEVER re-implements the draw or the cap.
 *
 * Test hygiene (AD-10): no store, no sockets, no new runtime deps — the cap
 * is pure over the passed set, so the outcomes are fully deterministic
 * (reproducible across runs/engines).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  applyAcceptanceCap,
  deriveIdentityKeypair,
  deriveWindowChallenge,
  drawWindow,
  protoTicketToDrawTicket,
  signTicket,
} from '../src/index.js'
import type {
  IdentityKeypair,
  Ticket as ProtoTicket,
  TicketFields,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// fixed deterministic fixture (AD-3: no RNG, no wall clock)
// ---------------------------------------------------------------------------

/** The fixed window the whole matrix runs under (any fixed chain-time slot). */
const SLOT = 7n

/**
 * A FIXED 32-byte parent hash with pinned (non-zero) bytes — deliberately NOT
 * the zero parent the draw schedule uses (just any fixed 32 bytes; it makes
 * the window challenge a specific pinned digest).
 */
const PARENT_HASH: Uint8Array<ArrayBuffer> = (() => {
  const p = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) p[i] = (i * 7 + 3) & 0xff
  return p
})()

/** Domain-separation prefix of the per-identity commitment (AD-12 style). */
const COMMIT_DOMAIN = new TextEncoder().encode('SC-ACCEPT-CAP-COMMIT/1')

/** The window challenge `deriveWindowChallenge(parentHash, slot)` (AD-12). */
const CHALLENGE: Uint8Array<ArrayBuffer> = toBuffered(
  deriveWindowChallenge(PARENT_HASH, SLOT),
)

/** Copy a `Uint8Array` into the ArrayBuffer-backed form the proto requires (TS 5.9). */
function toBuffered(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.byteLength)
  out.set(src)
  return out
}

/**
 * The per-identity commitment (the sim's `syntheticTicket` pattern):
 * `sha256("SC-ACCEPT-CAP-COMMIT/1" ‖ utf8(identityId) ‖ u64be(SLOT) ‖
 * PARENT_HASH)` — 32 bytes, a PINNED sha256 of public data (no RNG / wall
 * clock). A distinct commitment per identity.
 */
function commitmentFor(identityId: string): Uint8Array<ArrayBuffer> {
  const idBytes = new TextEncoder().encode(identityId)
  const slotPart = new Uint8Array(8)
  new DataView(slotPart.buffer).setBigUint64(0, SLOT, false) // u64be, AD-12
  const digest = createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(idBytes)
    .update(slotPart)
    .update(PARENT_HASH)
    .digest()
  return toBuffered(digest)
}

/**
 * A SIGNED proto `Ticket` for the fixed window: the 4.2 `signTicket` over
 * the EXACT AD-12 fields (`windowIndex` / `challenge` / `nonceCommitment`),
 * bound to the identity's derived keypair.
 */
function signedTicket(kp: IdentityKeypair): ProtoTicket {
  const commitment = commitmentFor(kp.identityId)
  const fields: TicketFields = {
    windowIndex: SLOT,
    challenge: CHALLENGE,
    nonceCommitment: commitment,
  }
  return {
    identityId: kp.identityId,
    windowIndex: SLOT,
    challenge: CHALLENGE,
    nonceCommitment: commitment,
    signature: toBuffered(signTicket(kp, fields)),
  }
}

// Fixed identity seeds (4.2's derivation — the same seed always yields the
// same keypair, so the whole fixture is reproducible):
//   A = the 0x00..0x1f gradient; B = 0x42-filled; C = 0x99-filled.
const KP_A = deriveIdentityKeypair(Uint8Array.from({ length: 32 }, (_, i) => i))
const KP_B = deriveIdentityKeypair(new Uint8Array(32).fill(0x42))
const KP_C = deriveIdentityKeypair(new Uint8Array(32).fill(0x99))

const ID_A = KP_A.identityId
const ID_B = KP_B.identityId
const ID_C = KP_C.identityId

// Identity A's THREE distinct commitments — the real-attack shape: same
// identity, DIFFERENT commitments, hoping for multiple draw weights (D2).
// The base commitment is the fixture's pinned sha256; the 2nd/3rd are pinned
// sha256's of the base + a distinct per-index salt byte (all public data —
// no RNG / wall clock).
function altCommitment(kp: IdentityKeypair, salt: number): Uint8Array<ArrayBuffer> {
  const base = commitmentFor(kp.identityId)
  const saltPart = new Uint8Array(1)
  saltPart[0] = salt
  const digest = createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(new TextEncoder().encode('SC-ACCEPT-CAP-ALT/1'))
    .update(base)
    .update(saltPart)
    .digest()
  return toBuffered(digest)
}

/** A's three SIGNED tickets with DISTINCT commitments (same window). */
const A_TICKET_0 = signedTicket(KP_A)
const A_TICKET_1: ProtoTicket = {
  ...A_TICKET_0,
  nonceCommitment: altCommitment(KP_A, 1),
  signature: toBuffered(
    signTicket(KP_A, {
      windowIndex: SLOT,
      challenge: CHALLENGE,
      nonceCommitment: altCommitment(KP_A, 1),
    }),
  ),
}
const A_TICKET_2: ProtoTicket = {
  ...A_TICKET_0,
  nonceCommitment: altCommitment(KP_A, 2),
  signature: toBuffered(
    signTicket(KP_A, {
      windowIndex: SLOT,
      challenge: CHALLENGE,
      nonceCommitment: altCommitment(KP_A, 2),
    }),
  ),
}
const B_TICKET = signedTicket(KP_B)
const C_TICKET = signedTicket(KP_C)

/** Byte-equality of the two proto byte fields (the no-op proof, D3). */
function sameTicket(a: ProtoTicket, b: ProtoTicket): boolean {
  return (
    a.identityId === b.identityId &&
    a.windowIndex === b.windowIndex &&
    bytesEq(a.challenge, b.challenge) &&
    bytesEq(a.nonceCommitment, b.nonceCommitment) &&
    bytesEq(a.signature, b.signature)
  )
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

describe('ACCEPTANCE-CAP — one valid ticket per identity per window (4.4, R1)', () => {
  it('CAP_DEDUPES_SECOND_TICKET: A(3) + B(1) + C(1) = 5 input tickets → exactly ONE ticket for A (the 2nd + 3rd dropped) → 3 tickets (A once + B once + C once)', () => {
    // The raw accepted set: A's three distinct-commitment tickets (indices
    // 0, 2, 4) interleaved with B (1) and C (3) — 5 input tickets.
    const raw = {
      tickets: [A_TICKET_0, B_TICKET, A_TICKET_1, C_TICKET, A_TICKET_2],
      weights: [5n, 3n, 5n, 1n, 5n],
    }
    const capped = applyAcceptanceCap(raw)

    // Exactly ONE ticket per identity survives — 3 from 5.
    expect(capped.tickets).toHaveLength(3)
    expect(capped.tickets.map((t) => t.identityId)).toEqual([ID_A, ID_B, ID_C])
    // The kept A ticket is the FIRST one (index 0) — its exact commitment.
    expect(bytesEq(capped.tickets[0].nonceCommitment, A_TICKET_0.nonceCommitment)).toBe(
      true,
    )
    // The aligned weights survive with their tickets (same-order contract).
    expect(capped.weights).toEqual([5n, 3n, 1n])
  })

  it('CAP_FIRST_OCCURRENCE_WINS: A at input indices 0, 2, 4 (distinct commitments), B at 1, C at 3 → the FIRST (index-0) A ticket is kept (its exact commitment); index-2 / index-4 A dropped; kept order = input order [A(0), B, C]', () => {
    const raw = { tickets: [A_TICKET_0, B_TICKET, A_TICKET_1, C_TICKET, A_TICKET_2] }
    const capped = applyAcceptanceCap({ tickets: raw.tickets, weights: [5n, 3n, 5n, 1n, 5n] })

    // The index-0 A ticket survives — byte-identical (ALL five proto fields),
    // so its exact commitment (and signature) is the one drawn over.
    expect(sameTicket(capped.tickets[0], A_TICKET_0)).toBe(true)
    // The index-2 and index-4 A tickets are DROPPED (their distinct
    // commitments are not present in the capped set).
    const keptCommitments = capped.tickets.map((t) => bytesEq(t.nonceCommitment, A_TICKET_1.nonceCommitment)).some(Boolean)
    expect(keptCommitments).toBe(false)
    const keptThird = capped.tickets.map((t) => bytesEq(t.nonceCommitment, A_TICKET_2.nonceCommitment)).some(Boolean)
    expect(keptThird).toBe(false)
    // Kept order = input order (deterministic, AD-3): [A(0), B, C].
    expect(capped.tickets.map((t) => t.identityId)).toEqual([ID_A, ID_B, ID_C])
  })

  it('CAP_DISTINCT_IDENTITIES_UNCHANGED: an all-distinct accepted set (B, C, A — one each; the epic-3 sim shape) → the cap is a NO-OP: same length, same order, byte-identical tickets (ADDITIVE — epic-3 stays green)', () => {
    // The epic-3 sim shape: one ticket per node, all distinct identities —
    // deliberately NOT in identity order (B, C, A) to prove order is kept.
    const raw = { tickets: [B_TICKET, C_TICKET, A_TICKET_0], weights: [3n, 1n, 5n] }
    const capped = applyAcceptanceCap(raw)

    // NO-OP: same length, same (input) order, byte-identical tickets.
    expect(capped.tickets).toHaveLength(3)
    expect(capped.tickets.map((t) => t.identityId)).toEqual([ID_B, ID_C, ID_A])
    expect(sameTicket(capped.tickets[0], B_TICKET)).toBe(true)
    expect(sameTicket(capped.tickets[1], C_TICKET)).toBe(true)
    expect(sameTicket(capped.tickets[2], A_TICKET_0)).toBe(true)
    // And the aligned weights pass through untouched.
    expect(capped.weights).toEqual([3n, 1n, 5n])
  })

  it('CAP_PRE_DRAW_FILTER: the CAPPED set (A once + B + C) fed to the IMPORTED drawWindow over the capped weights → the draw selects among the capped identities; a dropped A-duplicate commitment does NOT affect the draw (the capped draw == the draw over the de-duplicated identities only)', () => {
    // The cap (a pre-draw filter) runs on the accepted set FIRST…
    const capped = applyAcceptanceCap({
      tickets: [A_TICKET_0, B_TICKET, A_TICKET_1, C_TICKET, A_TICKET_2],
      weights: [5n, 3n, 5n, 1n, 5n],
    })

    // …then the ONE pinned draw (IMPORTED from the root barrel — AD-7, never
    // re-implemented) over the CONFORMED capped set + capped weights.
    const conformedCapped = capped.tickets.map(protoTicketToDrawTicket)
    const cappedDraw = drawWindow(conformedCapped, CHALLENGE, capped.weights)

    // The draw selects a winner AMONG THE CAPPED identities (one each)…
    expect([ID_A, ID_B, ID_C]).toContain(cappedDraw.winnerIdentityId)

    // …and the capped draw == the draw over the de-duplicated identities
    // ONLY (the three first-occurrence tickets, same weights): the dropped
    // A-duplicates (their distinct commitments) do NOT enter the draw —
    // the cap is a pre-draw filter, `drawWindow` unchanged.
    const dedupOnly = drawWindow(
      [A_TICKET_0, B_TICKET, C_TICKET].map(protoTicketToDrawTicket),
      CHALLENGE,
      [5n, 3n, 1n],
    )
    expect(cappedDraw.winnerIdentityId).toBe(dedupOnly.winnerIdentityId)
    expect(cappedDraw.cNum).toBe(dedupOnly.cNum)
    expect(cappedDraw.uptime).toBe(dedupOnly.uptime)
    expect(cappedDraw.index).toBe(dedupOnly.index)
  })

  it('CAP_ONE_ELIGIBILITY_EACH: A with 3 tickets (3 aligned 5n weight slots) + B (1× 3n) + C (1× 1n) → after the cap, A contributes exactly ONE draw weight; the total draw-weight slots = the number of DISTINCT identities (3), not the number of input tickets (5)', () => {
    const raw = {
      tickets: [A_TICKET_0, B_TICKET, A_TICKET_1, C_TICKET, A_TICKET_2],
      weights: [5n, 3n, 5n, 1n, 5n],
    }
    const capped = applyAcceptanceCap(raw)

    // Exactly ONE draw-weight slot per DISTINCT identity — 3 slots, not the
    // 5 input tickets (the two dropped A-duplicates contribute NO weight).
    expect(capped.weights).toHaveLength(3)
    expect(capped.tickets).toHaveLength(3)

    // A's weight is counted ONCE (its one surviving ticket's aligned weight)
    // — not 3× the 5n.
    const aSlots = capped.tickets.filter((t) => t.identityId === ID_A)
    expect(aSlots).toHaveLength(1)
    const aWeightSlots = capped.tickets
      .map((t, i) => ({ id: t.identityId, w: capped.weights[i] }))
      .filter((x) => x.id === ID_A)
    expect(aWeightSlots).toEqual([{ id: ID_A, w: 5n }])

    // The surviving set is the one-ticket-per-identity set the draw consumes
    // — each identity's draw odds come from its ONE ticket only (with 3.6's
    // fixed reward, the reward never scales with identity count — R1).
    expect(
      capped.tickets.map((t, i) => ({ id: t.identityId, w: capped.weights[i] })),
    ).toEqual([
      { id: ID_A, w: 5n },
      { id: ID_B, w: 3n },
      { id: ID_C, w: 1n },
    ])
  })
})
