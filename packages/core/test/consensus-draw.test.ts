/**
 * CONSENSUS DRAW — the AD-7 verifiable public-coin draw matrix (3.3).
 *
 *   DRAW_DETERMINISTIC   the same `(tickets, challenge, weights)` called
 *                        twice → identical result (winner, `cNum`, uptime,
 *                        index).
 *   VECTORS              4 pinned `(ticket set, challenge, weights) →
 *                        winner` cases (≥3 required) — each returns its
 *                        pinned winner identityId + pinned `cNum`. The
 *                        constants below are COMMITTED (computed once from
 *                        the pinned inputs; stable across runs/engines —
 *                        that stability IS the AD-7 guarantee).
 *   PROPORTIONAL_RATE    2 identities (uptime 1 vs 2) over 4000 draws on a
 *                        DETERMINISTIC seeded nonce/challenge schedule (no
 *                        `Math.random` — every commitment and challenge is
 *                        a sha256 of a fixed label): the uptime-2 identity
 *                        wins at the pinned empirical rate — inside the
 *                        plan's wide robust band `[0.60, 0.90]` around the
 *                        AD-7 proportional target (asserted in integer
 *                        math: `winsU2` in `[0.60·N, 0.90·N]`) — and
 *                        strictly more than the uptime-1 identity.
 *   CHALLENGE_PIN        `deriveWindowChallenge(fixedHash32, fixedWindow)`
 *                        = a pinned 32-byte digest (committed constant).
 *   CHALLENGE_FORK_SENSITIVE  same window, two different `lastBlockHash`
 *                        → two different 32-byte challenges (fork-replay
 *                        dead by construction, R2).
 *   CHALLENGE_WINDOW_SENSITIVE  same hash, two window indices → two
 *                        different challenges (chain-time locality).
 *   CHALLENGE_RANGE_GUARD out-of-range `windowIndex` (negative, ≥ 2^64) →
 *                        `DrawError` `SC-CONSENSUS-2` (AD-12 u64be).
 *   DRAW_EMPTY_REJECTS   empty `tickets` (+ empty `weights`) →
 *                        `DrawError` `SC-CONSENSUS-2`.
 *   DRAW_WEIGHT_MISMATCH_REJECTS  `tickets.length !== weights.length` →
 *                        `DrawError` `SC-CONSENSUS-2`.
 *   DRAW_BAD_WEIGHT_REJECTS  weight negative / non-integer / `≥ 2^20` cap →
 *                        `DrawError` `SC-CONSENSUS-2`.
 *   INTERFACE            a `DrawTicket` constructed + passed to
 *                        `drawWindow` via the barrel is accepted;
 *                        `DrawTicket` + `drawWindow` +
 *                        `deriveWindowChallenge` are exported from
 *                        `core/consensus`.
 *
 * AD-7 discipline: the draw is imported from the BARREL only — the
 * `c^uptime` formula is NEVER re-implemented in this file. And there is no
 * floating point anywhere here (the argmin is exact BigInt; even the rate
 * band is asserted with integer math).
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { DrawError, deriveWindowChallenge, drawWindow } from '../src/index.js'
import type { DrawTicket } from '../src/index.js'

// ---- helpers -------------------------------------------------------------

const hex = (buf: Uint8Array): string => Buffer.from(buf).toString('hex')
const fromHex = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(h, 'hex'))
const fill32 = (v: number): Uint8Array<ArrayBuffer> => new Uint8Array(32).fill(v)

/** A sha256 commitment from a fixed label (the deterministic "nonce"). */
const commit = (label: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(label, 'utf8').digest()) as Uint8Array<ArrayBuffer>

// ---- pinned inputs -------------------------------------------------------

// The vector-row challenge: 0x01..0x20 (32 bytes, the golden-vector style
// fixed digest).
const CHALLENGE = fromHex(
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
)

// Vector identities (32-byte hex, spine convention) + their commitments.
const ID_A = '000000000000000000000000000000000000000000000000000000000000000a'
const ID_B = '000000000000000000000000000000000000000000000000000000000000000b'
const ID_D = '000000000000000000000000000000000000000000000000000000000000000d'
const COMMIT_A = fill32(0xa1)
const COMMIT_B = fill32(0xb2)
const COMMIT_D = fill32(0xd4)

const TICKET_A: DrawTicket = { identityId: ID_A, nonceCommitment: COMMIT_A }
const TICKET_B: DrawTicket = { identityId: ID_B, nonceCommitment: COMMIT_B }
const TICKET_D: DrawTicket = { identityId: ID_D, nonceCommitment: COMMIT_D }

// Pinned winners (COMMITTED constants — regenerate ONLY by changing the
// pinned inputs above, which is a protocol change, AD-7).
const V1_WINNER = ID_A
const V1_CNUM = 0x56d9b60cb04bafceb7a1e0fe8358f65b7190e126d22dfd0872af567005d59440n
const V2_WINNER = ID_B
const V2_CNUM = 0x6f272958355793ea50b1c1faed920cec5dfd7882cf5697aa247bbf5a75e80757n
const V3_WINNER = ID_B
const V3_CNUM = 0x6f272958355793ea50b1c1faed920cec5dfd7882cf5697aa247bbf5a75e80757n
const V4_WINNER = ID_A
const V4_CNUM = 0x56d9b60cb04bafceb7a1e0fe8358f65b7190e126d22dfd0872af567005d59440n

// Pinned per-window challenge digests (COMMITTED constants):
//   sha256(utf8("SC-CHALLENGE/1") ‖ 32×0x00 ‖ u64be(index)).
const CHALLENGE_PIN_W0 =
  'b4b20c6fc05fc7faa8e35d62dd98441125c682557ace2cd4379a29a09022351f'
const CHALLENGE_PIN_W1 =
  'a6941f8bd710a00474d72063c8a40e84e1b73cb644726034d80b2b3cecfcb0d0'

// Proportional-rate identities (uptime 1 vs 2) — distinct 32-byte hex ids.
const ID_UPTIME_1 = '0000000000000000000000000000000000000000000000000000000000000001'
const ID_UPTIME_2 = '0000000000000000000000000000000000000000000000000000000000000002'
const PROP_DRAWS = 4000
// The pinned deterministic outcome of the schedule below (COMMITTED):
// uptime-2 wins exactly 2696 of 4000 draws (share 0.674 — inside the
// plan's robust band [0.60, 0.90]).
const PROP_WINS_U2 = 2696
const PROP_WINS_U1 = PROP_DRAWS - PROP_WINS_U2

// ---- matrix --------------------------------------------------------------

describe('CONSENSUS DRAW — the AD-7 public-coin draw (3.3)', () => {
  it('DRAW_DETERMINISTIC: the same inputs called twice give an identical result', () => {
    const tickets = [TICKET_A, TICKET_B, TICKET_D]
    const weights = [1n, 2n, 1n]

    const r1 = drawWindow(tickets, CHALLENGE, weights)
    const r2 = drawWindow(tickets, CHALLENGE, weights)

    expect(r2).toEqual(r1)
    expect(r2.winnerIdentityId).toBe(r1.winnerIdentityId)
    expect(r2.cNum).toBe(r1.cNum)
    expect(r2.uptime).toBe(r1.uptime)
    expect(r2.index).toBe(r1.index)
  })

  it('VECTORS: four pinned (ticket set, challenge, weights) → winner cases return their pinned winners', () => {
    // V1 — equal weights (1,1): the lower c wins (here ID_A).
    const v1 = drawWindow([TICKET_A, TICKET_B], CHALLENGE, [1n, 1n])
    expect(v1.winnerIdentityId).toBe(V1_WINNER)
    expect(v1.cNum).toBe(V1_CNUM)
    expect(v1.uptime).toBe(1n)
    expect(v1.index).toBe(0)

    // V2 — uptimes (1,2,1): the higher-uptime identity ID_B wins.
    const v2 = drawWindow([TICKET_A, TICKET_B, TICKET_D], CHALLENGE, [1n, 2n, 1n])
    expect(v2.winnerIdentityId).toBe(V2_WINNER)
    expect(v2.cNum).toBe(V2_CNUM)
    expect(v2.uptime).toBe(2n)
    expect(v2.index).toBe(1)

    // V3 — uptimes (0,1): W=0 ⇒ c^0 = 1 (worst priority) — the zero-uptime
    // identity ID_A never wins over W>0.
    const v3 = drawWindow([TICKET_A, TICKET_B], CHALLENGE, [0n, 1n])
    expect(v3.winnerIdentityId).toBe(V3_WINNER)
    expect(v3.cNum).toBe(V3_CNUM)
    expect(v3.uptime).toBe(1n)
    expect(v3.index).toBe(1)

    // V4 — equal weights (3,3,3): the plain argmin c across all three.
    const v4 = drawWindow([TICKET_A, TICKET_B, TICKET_D], CHALLENGE, [3n, 3n, 3n])
    expect(v4.winnerIdentityId).toBe(V4_WINNER)
    expect(v4.cNum).toBe(V4_CNUM)
    expect(v4.uptime).toBe(3n)
    expect(v4.index).toBe(0)
  })

  it('PROPORTIONAL_RATE: over 4000 seeded draws, uptime-2 wins in the plan band and strictly more than uptime-1', () => {
    // Deterministic seeded schedule (no Math.random): for draw k, the
    // lastBlockHash, challenge (via deriveWindowChallenge), and both
    // commitments are sha256 of fixed labels — reproducible on every node.
    let winsU2 = 0
    for (let k = 0; k < PROP_DRAWS; k++) {
      const tag = `window-${k}`
      const lastHash = commit(`${tag}:lastBlockHash`)
      const challenge = deriveWindowChallenge(lastHash, BigInt(k))
      const tickets: ReadonlyArray<DrawTicket> = [
        { identityId: ID_UPTIME_1, nonceCommitment: commit(`ticket-A-${k}`) },
        { identityId: ID_UPTIME_2, nonceCommitment: commit(`ticket-B-${k}`) },
      ]
      if (drawWindow(tickets, challenge, [1n, 2n]).index === 1) winsU2++
    }

    const winsU1 = PROP_DRAWS - winsU2
    // The pinned deterministic outcome (schedule stability, AD-7).
    expect(winsU2).toBe(PROP_WINS_U2)
    // The plan's robust band [0.60, 0.90] — integer math: winsU2 in
    // [0.60·4000, 0.90·4000] = [2400, 3600].
    expect(BigInt(winsU2) * 100n).toBeGreaterThanOrEqual(60n * BigInt(PROP_DRAWS))
    expect(BigInt(winsU2) * 100n).toBeLessThanOrEqual(90n * BigInt(PROP_DRAWS))
    // Strictly more wins than the uptime-1 identity.
    expect(winsU2).toBeGreaterThan(winsU1)
  })

  it('CHALLENGE_PIN: deriveWindowChallenge(fixedHash32, fixedWindow) = the pinned 32-byte digest', () => {
    const ch0 = deriveWindowChallenge(fill32(0x00), 0n)
    expect(ch0.byteLength).toBe(32)
    expect(hex(ch0)).toBe(CHALLENGE_PIN_W0)

    const ch1 = deriveWindowChallenge(fill32(0x00), 1n)
    expect(ch1.byteLength).toBe(32)
    expect(hex(ch1)).toBe(CHALLENGE_PIN_W1)
  })

  it('CHALLENGE_FORK_SENSITIVE: same window, two different lastBlockHash → two different challenges', () => {
    const forkA = deriveWindowChallenge(fill32(0x11), 5n)
    const forkB = deriveWindowChallenge(fill32(0x22), 5n)
    expect(forkA.byteLength).toBe(32)
    expect(forkB.byteLength).toBe(32)
    expect(hex(forkA)).not.toBe(hex(forkB))
  })

  it('CHALLENGE_WINDOW_SENSITIVE: same hash, two window indices → two different challenges', () => {
    const a = deriveWindowChallenge(fill32(0x33), 1n)
    const b = deriveWindowChallenge(fill32(0x33), 2n)
    expect(hex(a)).not.toBe(hex(b))
  })

  it('CHALLENGE_RANGE_GUARD: an out-of-range windowIndex is a DrawError SC-CONSENSUS-2 (AD-12 u64be)', () => {
    const hash = fill32(0x44)
    // A range guard mirrors pow.ts's u64be: the out-of-range windowIndex is
    // a programming error, not data.
    for (const bad of [-1n, 1n << 64n, (1n << 64n) + 7n]) {
      const err: unknown = ((): unknown => {
        try {
          return deriveWindowChallenge(hash, bad)
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(DrawError)
      expect((err as { code?: string }).code).toBe('SC-CONSENSUS-2')
    }
    // The in-range boundary values are accepted (32-byte challenges).
    expect(deriveWindowChallenge(hash, 0n).byteLength).toBe(32)
    expect(deriveWindowChallenge(hash, (1n << 64n) - 1n).byteLength).toBe(32)
  })

  it('DRAW_EMPTY_REJECTS: empty tickets (+ empty weights) throws DrawError SC-CONSENSUS-2', () => {
    const err: unknown = ((): unknown => {
      try {
        return drawWindow([], CHALLENGE, [])
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(DrawError)
    expect((err as { code?: string }).code).toBe('SC-CONSENSUS-2')
  })

  it('DRAW_WEIGHT_MISMATCH_REJECTS: tickets.length !== weights.length throws DrawError SC-CONSENSUS-2', () => {
    const assertBadWeights = (weights: ReadonlyArray<bigint>) => {
      const err: unknown = ((): unknown => {
        try {
          drawWindow([TICKET_A, TICKET_B], CHALLENGE, weights)
          return undefined
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(DrawError)
      expect((err as { code?: string }).code).toBe('SC-CONSENSUS-2')
    }
    // 2 tickets, 1 weight.
    assertBadWeights([1n])
    // 2 tickets, 3 weights.
    assertBadWeights([1n, 1n, 1n])
  })

  it('DRAW_BAD_WEIGHT_REJECTS: a negative / non-integer / ≥ 2^20 weight throws DrawError SC-CONSENSUS-2', () => {
    const assertBadWeight = (weights: ReadonlyArray<bigint>) => {
      const err: unknown = ((): unknown => {
        try {
          drawWindow([TICKET_A, TICKET_B], CHALLENGE, weights)
          return undefined
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(DrawError)
      expect((err as { code?: string }).code).toBe('SC-CONSENSUS-2')
    }
    // Negative.
    assertBadWeight([-1n, 1n])
    // At the cap (weights must be < 2^20).
    assertBadWeight([1n << 20n, 1n])
    // Above the cap.
    assertBadWeight([1n << 21n, 1n])
    // Non-integer (a number where a bigint is required — a programming
    // error the guard rejects rather than silently coerces).
    assertBadWeight([1, 1n] as unknown as ReadonlyArray<bigint>)
  })

  it('INTERFACE: a DrawTicket built per the interface is accepted by drawWindow via the barrel', () => {
    // Constructed from the barrel-exported `DrawTicket` type only — the
    // proto `Ticket` (1.4) maps to this shape via 4.3's
    // `protoTicketToDrawTicket` without re-inventing the proto message (AD-12).
    const ticket: DrawTicket = {
      identityId: '1111111111111111111111111111111111111111111111111111111111111111',
      nonceCommitment: commit('interface-ticket'),
    }
    const solo = drawWindow([ticket], CHALLENGE, [1n])
    expect(solo.winnerIdentityId).toBe(ticket.identityId)
    expect(solo.index).toBe(0)
    expect(solo.uptime).toBe(1n)
    expect(solo.cNum > 0n).toBe(true) // c ∈ (0,1] ⇒ cNum ∈ [1, 2^256]

    // The barrel exports the value surface (the type surface is proven by
    // this file compiling against it).
    expect(typeof drawWindow).toBe('function')
    expect(typeof deriveWindowChallenge).toBe('function')
    expect(DrawError.prototype).toBeInstanceOf(Error)
  })
})
