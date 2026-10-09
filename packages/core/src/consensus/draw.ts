/**
 * `core/consensus` — the AD-7 verifiable public-coin draw (3.3).
 *
 * The draw is the ONE pinned way a window's winner is selected (AD-7):
 *
 *   - `drawWindow(tickets, challenge, weights)` — winner = argmin `c^W`
 *     over the window's ticket set, where `c = c_num / 2^256 ∈ (0,1]` and
 *     `c_num = sha256(nonceCommitment ‖ challenge) as 256-bit int + 1n`.
 *     Higher uptime `W` ⇒ higher win probability (`W = 0` ⇒ `c^0 = 1`, the
 *     worst priority, so a zero-uptime identity never wins over any
 *     `W > 0` — except the measure-zero exact tie, which the tie-break
 *     resolves by `identityId`).
 *   - `deriveWindowChallenge(lastBlockHash, windowIndex)` — the 32-byte
 *     per-window challenge: `sha256(utf8("SC-CHALLENGE/1") ‖ lastBlockHash
 *     ‖ u64be(windowIndex))`. Domain-separated, AD-12 u64be; the
 *     `lastBlockHash` term makes a fork change the challenge (fork-replay
 *     dead by construction, R2) and the `windowIndex` term gives chain-time
 *     window locality.
 *
 * The argmin is computed EXACTLY with BigInt — no `Math.log`/`Math.pow`/
 * `Number(...)`/float literal (those are not correctly-rounded per
 * IEEE-754 and would risk a fork), no `big.js` (the AD-5 boundary guard
 * pins big.js to `ledger/display.ts` + `ledger/fee.ts` only), and no RNG
 * other than the committed nonces, no network-position term, no wall clock
 * (AD-3). Any node reproduces the identical winner from public data.
 *
 * The input `DrawTicket` is a lightweight draw-input interface that maps
 * to the existing proto `Ticket` (1.4, AD-12 — the proto message is NOT
 * redefined here); epic 4 (4.3,
 * `protoTicketToDrawTicket`) conforms real tickets to it.
 */
import { createHash } from 'node:crypto'

/**
 * The draw's input ticket (AD-7): the two fields the draw consumes out of
 * the proto `Ticket` (1.4). `identityId` travels as a 32-byte hex string
 * (spine convention); `nonceCommitment` is the commitment to the PoW
 * nonce (the draw's only randomness source). The proto `windowIndex`,
 * `challenge`, and `signature` fields are owned by verification (3.4 /
 * 4.3), not the draw.
 */
export interface DrawTicket {
  /** 32-byte hex identity id of the minter (spine convention). */
  identityId: string
  /** Commitment to the PoW nonce (draw input, AD-7). */
  nonceCommitment: Uint8Array
}

/**
 * The draw result: the selected winner + the exact public data that
 * reproduces the selection (any node recomputes it from the block).
 */
export interface DrawResult {
  /** The winning identity (32-byte hex, spine convention). */
  winnerIdentityId: string
  /**
   * The winner's exact `c` as its 256-bit numerator: `c = cNum / 2^256`
   * with `cNum = sha256(nonceCommitment ‖ challenge) as 256-bit int + 1n`
   * (so `c ∈ (0,1]` — the `+1` excludes 0, which would make `c^W = 0`
   * dominate every draw). The denominator `2^256` is implicit.
   */
  cNum: bigint
  /** The winner's uptime weight `W` (the exponent in `c^W`). */
  uptime: bigint
  /** The winning ticket's index into the `tickets` input. */
  index: number
}

/** Draw / challenge-derivation programming error. */
export class DrawError extends Error {
  readonly code = 'SC-CONSENSUS-2' as const
  constructor(message: string) {
    super(message)
    this.name = 'DrawError'
  }
}

// 2^256 — the implicit denominator of every c (the digest's bit width).
const D_256 = 256n

/**
 * Uptime-weight cap: a weight must be `< 2^20` (programming guard —
 * realistic values are ≤ the lookback window L = 50, so this only catches
 * a bug, never honest data).
 */
const WEIGHT_CAP = 1n << 20n

/**
 * The domain-separation prefix of the per-window challenge derivation
 * (`"SC-CHALLENGE/1"` — a versioned domain tag, AD-12 style).
 */
const CHALLENGE_DOMAIN = new TextEncoder().encode('SC-CHALLENGE/1')

/** Read a byte string as a big-endian integer (MSB first). */
function bytesToBig(buf: Uint8Array): bigint {
  let v = 0n
  for (let i = 0; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i])
  return v
}

/**
 * Encode one `unsigned` int64 value as 8-byte big-endian (AD-12 digest
 * form). The range guard mirrors `pow.ts`'s `u64be`: a value outside
 * `[0, 2^64)` is a programming error, not data.
 *
 * @throws {DrawError} `SC-CONSENSUS-2` if `v` is outside the u64be range.
 */
function u64be(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) {
    throw new DrawError(`SC-CONSENSUS-2: windowIndex ${v} is outside the u64be range`)
  }
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, v, false) // big-endian
  return buf
}

/**
 * Concatenate byte parts into one fresh `Uint8Array` (no aliasing of the
 * inputs).
 */
function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * The digest → c mapping (pinned): `c_num = sha256(commitment ‖ challenge)
 * as a 256-bit int + 1n`, so `c = c_num / 2^256 ∈ (0,1]`.
 *
 * The commitment comes FIRST, then the challenge (the pinned byte order).
 * The `+1n` excludes the all-zero digest (which would map to `c = 0` and
 * make `c^W = 0` dominate every draw).
 */
function cNumOf(nonceCommitment: Uint8Array, challenge: Uint8Array): bigint {
  const digest = new Uint8Array(
    createHash('sha256').update(concat([nonceCommitment, challenge])).digest(),
  )
  return bytesToBig(digest) + 1n
}

/**
 * Exact compare of `c_a^W_a` vs `c_b^W_b` — pure integer math, no
 * transcendental, no rounding:
 *
 *   `c_a^W_a < c_b^W_b  ⟺  c_num_a^{W_a} · 2^{256·W_b} < c_num_b^{W_b} ·
 *   2^{256·W_a}`
 *
 * (multiplying both sides by the positive common denominator
 * `2^{256(W_a+W_b)}`). Each side is a BigInt of ≈ `256·(W_a + W_b)` bits —
 * trivial for realistic uptime weights (bounded by lookback L = 50).
 *
 * @returns -1 if `aVal < bVal`, 0 if exactly equal, 1 if `aVal > bVal`.
 */
function compareExact(
  aCnum: bigint,
  aW: bigint,
  bCnum: bigint,
  bW: bigint,
): -1 | 0 | 1 {
  const left = aCnum ** aW * (1n << D_256 * bW)
  const right = bCnum ** bW * (1n << D_256 * aW)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * The pinned draw (AD-7): winner = argmin `c^W` over the ticket set, with
 * the exact-BigInt comparison (no float — bit-identical on every node) and
 * the tie-break to the SMALLER `identityId` (32-byte hex string) on an
 * exact equality (measure zero, but defined so every node picks the same
 * identity).
 *
 * `weights[i]` is `tickets[i]`'s non-negative integer uptime weight
 * (`W ≥ 0`; `W = 0` ⇒ `c^0 = 1`, the worst priority). Weights are INPUTS —
 * deriving a weight from the lookback-L valid-ticket count (AD-7) happens
 * where the accepted-ticket set is built (4.5/4.8), not here.
 *
 * Pure function: same `(tickets, challenge, weights)` ⇒ same winner, on
 * every node, with no RNG source other than the committed nonces.
 *
 * @throws {DrawError} `SC-CONSENSUS-2` if `tickets.length !==
 *   weights.length`, the ticket set is empty, or a weight is non-integer
 *   / negative / `≥ 2^20`.
 */
export function drawWindow(
  tickets: ReadonlyArray<DrawTicket>,
  challenge: Uint8Array,
  weights: ReadonlyArray<bigint>,
): DrawResult {
  if (tickets.length !== weights.length) {
    throw new DrawError(
      `SC-CONSENSUS-2: tickets.length (${tickets.length}) !== weights.length (${weights.length})`,
    )
  }
  if (tickets.length === 0) {
    throw new DrawError('SC-CONSENSUS-2: drawWindow requires a non-empty ticket set')
  }
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]
    if (typeof w !== 'bigint') {
      throw new DrawError(
        `SC-CONSENSUS-2: weight[${i}] must be an integer (bigint), got ${typeof w}`,
      )
    }
    if (w < 0n) {
      throw new DrawError(`SC-CONSENSUS-2: weight[${i}] = ${w} is negative`)
    }
    if (w >= WEIGHT_CAP) {
      throw new DrawError(`SC-CONSENSUS-2: weight[${i}] = ${w} is ≥ the 2^20 cap`)
    }
  }

  // One sha256 per ticket — the draw's only per-ticket work (the
  // commitment + challenge are public; no wall clock, no peer position).
  const cnums = new Array<bigint>(tickets.length)
  for (let i = 0; i < tickets.length; i++) {
    cnums[i] = cNumOf(tickets[i].nonceCommitment, challenge)
  }

  // Linear scan for the argmin; ties break to the smaller identityId.
  let best = 0
  for (let i = 1; i < tickets.length; i++) {
    const cmp = compareExact(cnums[i], weights[i], cnums[best], weights[best])
    if (
      cmp < 0 ||
      (cmp === 0 && tickets[i].identityId < tickets[best].identityId)
    ) {
      best = i
    }
  }

  return {
    winnerIdentityId: tickets[best].identityId,
    cNum: cnums[best],
    uptime: weights[best],
    index: best,
  }
}

/**
 * The per-window challenge (AD-7 / AD-12):
 *
 *   `sha256(utf8("SC-CHALLENGE/1") ‖ lastBlockHash ‖ u64be(windowIndex))`
 *
 * — a 32-byte digest. Domain-separated by the versioned `"SC-CHALLENGE/1"`
 * tag; `lastBlockHash` (32 bytes) makes a fork change the challenge
 * (fork-replay dead by construction, R2); `windowIndex` (u64be, AD-12)
 * gives chain-time window locality.
 *
 * @throws {DrawError} `SC-CONSENSUS-2` if `windowIndex` is outside the
 *   u64be range `[0, 2^64)`.
 */
export function deriveWindowChallenge(
  lastBlockHash: Uint8Array,
  windowIndex: bigint,
): Uint8Array {
  const parts = [CHALLENGE_DOMAIN, lastBlockHash, u64be(windowIndex)]
  return new Uint8Array(createHash('sha256').update(concat(parts)).digest())
}
