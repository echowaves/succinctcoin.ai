/**
 * `core/consensus` — the multi-identity memory-transport simulation (4.8,
 * R1/R2: the acceptance cap + uptime + re-attestation).
 *
 * The module generalizes 3.7's `sim.ts` (fixed uptime + empty signature)
 * into the epic-4 multi-identity harness: **signed tickets** (4.2, AD-12),
 * **uptime-derived weights** (4.5, `computeUptimeWeight`), **re-attestation
 * eligibility** (4.6, `isEligibleAtWindow` / `reattestationWindow`), and
 * the **acceptance cap** (4.4, `applyAcceptanceCap`) — composing with the
 * **IMPORTED** `drawWindow` (3.3, AD-7 — the draw is never re-implemented)
 * and `acceptBlockWinner` (4.3, which composes `verifyDraw` +
 * `verifyTicketSignature`).
 *
 * What the sim proves (the honest, enforceable R1/R2 model —
 * `registration-design.md` R1: "the protocol can never know who an
 * 'operator' is"):
 *
 *   - **R1 — the acceptance cap bounds a SINGLE identity to one share.**
 *     An identity that submits extra tickets in a window is collapsed to
 *     one (keep-first, 4.4), so its draw weight is counted ONCE — its
 *     slot-eligibility is one share, not more. Over a pinned schedule, an
 *     identity's win count with 3 tickets/window === its win count with
 *     1 ticket/window (the extra tickets are pure dead weight, dropped
 *     before the draw).
 *   - **R2 — N DISTINCT gate-verified identities add a full share each
 *     (uptime), LINEARLY and OPERATOR-BLINDLY.** Against a fixed
 *     background of other identities, an operator's throughput scales with
 *     its distinct-identity count (each new distinct identity contributes
 *     one full uptime share, the operator's total draw weight = N × L).
 *     The protocol sees only distinct `identityId`s, not operators — the
 *     "identity rental is linear-cost (per-identity floor, not
 *     per-operator equality)" accepted limitation.
 *
 * Determinism (AD-3, D7): NO `Math.random`, NO wall clock. Every
 * challenge = `deriveWindowChallenge` (pinned sha256), every commitment = a
 * pinned per-(identity, slot, parent) sha256 of public data (domain-
 * separated, `"SC-MULTISIM-COMMIT/1"`), every signature = deterministic
 * Ed25519 (the 4.2 `signTicket` over the EXACT AD-12 digest). The rate
 * rows consume the PURE `multiDrawSchedule` (no mining / no store) over
 * `FIXED_PARENT` (32 zeros) + slot = window index — fully reproducible
 * (the 3.3 `PROPORTIONAL_RATE` / 3.7 `SIM_RATE` precedent).
 *
 * AD-11 (D3): the sim identity carries its keypair as a CORE-INTERNAL sim
 * value (`MultiSimIdentity.keypair`) — the module NEVER reads `.secret`
 * directly; it calls `signTicket(keypair, fields)` (the identity module's
 * OWN single reader, guarded by 4.7). The keypair is never projected onto
 * a `ReadPeer` / `ReadBlock` / `CoreEvents[K]` public-surface type (the
 * sim is a core validation harness, not the read-API surface).
 *
 * NOT wired into `createCore` — a standalone validation harness (like
 * 3.7's `sim.ts`). Additive surface only.
 */
import { createHash } from 'node:crypto'
import type { Block, Ticket as ProtoTicket } from '../proto/index.js'
import { Ticket } from '../proto/index.js'
import type { StorePort } from '../ports.js'
import type { BalanceMap } from '../ledger/index.js'
import { fromDisplay, fromJson } from '../ledger/index.js'
import { MINT_ID, mineBlock } from './miner.js'
import { applyBlock } from './apply-block.js'
import { deriveWindowChallenge, drawWindow } from './draw.js'
import type { DrawTicket } from './draw.js'
import { acceptBlockWinner } from './accept-winner.js'
import { applyAcceptanceCap } from './acceptance-cap.js'
import type { CappedSet } from './acceptance-cap.js'
import { computeUptimeWeight } from './uptime.js'
import { isEligibleAtWindow } from '../identity/index.js'
import type { IdentityKeypair } from '../identity/index.js'
import { signTicket } from '../identity/index.js'
import { nextSlotAndParent } from './slot-loop.js'

/**
 * A simulated gate-verified identity (4.8, D3): the AD-11 keypair (for
 * signing — CORE-INTERNAL, never on the public read-API surface), its
 * re-attestation deadline (chain-time window, 4.6), and its valid-ticket
 * history (the window indices at which it had a valid ticket — the 4.5
 * uptime-weight input).
 *
 * `attestedUntilWindow` is the 4.1/4.6 deadline: the identity is eligible
 * for the accepted set at window `w` iff `isEligibleAtWindow(
 * attestedUntilWindow, w)` (inclusive through the deadline, lapses at
 * deadline + 1). Re-attesting at window `W` extends the deadline to
 * `max(oldDeadline, reattestationWindow(W, K))` — the guaranteed-monotonic
 * form (the 4.6 lesson: a pure `W + K` can shorten on an early re-attest).
 */
export interface MultiSimIdentity {
  /** The identity's Ed25519 keypair (AD-11, core-internal; signing only). */
  keypair: IdentityKeypair
  /** The re-attestation deadline (chain-time window, 4.6; eligible through it). */
  attestedUntilWindow: bigint
  /** The window indices at which the identity had a VALID ticket (4.5 weight input). */
  validWindows: ReadonlyArray<bigint>
}

/**
 * The window's accepted set (AD-7): for each eligible identity, its
 * `DrawTicket` (the two fields the draw consumes), its uptime weight, and
 * its SIGNED proto `Ticket` (the AD-12 wire form).
 *
 * Built in `identities` order (only the ELIGIBLE ones), so
 * `tickets[i]` / `weights[i]` / `protoTickets[i]` all refer to the same
 * eligible identity — the ordering `drawWindow` requires (same-order
 * tickets + weights).
 */
export interface WindowAcceptedSet {
  /** Each eligible identity's draw-input ticket (`identityId` + `nonceCommitment`). */
  tickets: DrawTicket[]
  /** Each eligible identity's uptime weight (4.5), in the SAME order. */
  weights: bigint[]
  /** Each eligible identity's SIGNED proto `Ticket`, in the SAME order. */
  protoTickets: ProtoTicket[]
}

/**
 * One window end-to-end (draw → mine → apply → accept).
 */
export interface MultiSimWindowResult {
  /** The mined + committed block (its `winnerTicket` carries the winner's SIGNED proto `Ticket`). */
  block: Block
  /** The draw winner's identity id (`block.winnerIdentityId`). */
  winnerId: string
  /** `acceptBlockWinner(block, tickets, weights, challenge)` (4.3: `verifyDraw` + AD-12 signature). */
  accept: boolean
  /** The capped accepted ticket set (4.4), ordered with `weights`. */
  tickets: ProtoTicket[]
  /** The capped accepted weights (4.4), ordered with `tickets`. */
  weights: bigint[]
  /** The window's challenge `deriveWindowChallenge(block.parentHash, block.slot)`. */
  challenge: Uint8Array
}

/**
 * The domain-separation prefix of the multi-sim commitment
 * (`"SC-MULTISIM-COMMIT/1"` — a versioned domain tag, AD-12 style; distinct
 * from 3.7's `"SC-SIM-COMMIT/1"` and the tracer's `"SC-TRACER-COMMIT/1"`).
 */
const COMMIT_DOMAIN = new TextEncoder().encode('SC-MULTISIM-COMMIT/1')

/**
 * `FIXED_PARENT` — the 32 zero-byte parent for the PURE rate schedule
 * (`multiDrawSchedule`): with a fixed parent + the window index as the
 * slot, every challenge and commitment is a pinned sha256 of public data,
 * so the whole schedule is fully deterministic (AD-3) — mirroring 3.7's
 * `drawSchedule`.
 */
const FIXED_PARENT = new Uint8Array(32)

/**
 * One REAL signed proto `Ticket` for a simulated identity (D6, AD-3, AD-12):
 *
 *   - `identityId` = the identity's id (the keypair's hex public key);
 *   - `windowIndex` = the slot;
 *   - `challenge` = a copy of the (32-byte) window challenge (the proto
 *     field requires the ArrayBuffer-backed form);
 *   - `nonceCommitment` = `sha256("SC-MULTISIM-COMMIT/1" ‖ utf8(
 *     identityId) ‖ u64be(slot) ‖ u64be(ticketIndex) ‖ parentHash)` —
 *     32 bytes, a PINNED sha256 of public data (no RNG / wall clock),
 *     distinct per (identity, slot, parent) AND per `ticketIndex` (the
 *     0-based index of the ticket within that identity's submission for
 *     the window — so an identity CAN submit multiple DISTINCT tickets in
 *     a window, the R1 cap case, and they are byte-different);
 *   - `signature` = the 64-byte Ed25519 `signTicket(keypair,
 *     { windowIndex, challenge, nonceCommitment })` over the EXACT AD-12
 *     digest (4.2 — the digest is imported, never re-implemented).
 *
 * `keypair` is a CORE-INTERNAL sim value (AD-11): this function signs via
 * the identity module's OWN `signTicket` (the single `.secret` reader) and
 * never reads `.secret` itself.
 */
export function signedTicket(
  keypair: IdentityKeypair,
  slot: bigint,
  parentHash: Uint8Array,
  challenge: Uint8Array,
  ticketIndex = 0n,
): ProtoTicket {
  const idBytes = new TextEncoder().encode(keypair.identityId)
  const slotPart = new Uint8Array(8)
  new DataView(slotPart.buffer).setBigUint64(0, slot, false) // u64be, AD-12
  const idxPart = new Uint8Array(8)
  new DataView(idxPart.buffer).setBigUint64(0, ticketIndex, false) // u64be, AD-12
  // The pinned commitment (AD-3): domain ‖ identity ‖ u64be(slot) ‖
  // u64be(ticketIndex) ‖ parent.
  const digest = createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(idBytes)
    .update(slotPart)
    .update(idxPart)
    .update(parentHash)
    .digest()
  // Copy the digest into a fresh 32-byte buffer — the ArrayBuffer-backed
  // form `Ticket.nonceCommitment` requires (the `digest` is typed
  // `Uint8Array<ArrayBufferLike>` under TS 5.9's generic typed arrays).
  const nonceCommitment = new Uint8Array(32)
  nonceCommitment.set(digest)
  // Copy the (32-byte) challenge the same way.
  const challengeCopy = new Uint8Array(32)
  challengeCopy.set(challenge)
  // The AD-12 signature (4.2, IMPORTED — the digest is never re-
  // implemented): the identity's OWN key signs its ticket fields.
  const signature = new Uint8Array(
    signTicket(keypair, {
      windowIndex: slot,
      challenge: challengeCopy,
      nonceCommitment,
    }),
  )
  return {
    identityId: keypair.identityId,
    windowIndex: slot,
    challenge: challengeCopy,
    nonceCommitment,
    signature,
  }
}

/**
 * The window's accepted set (D4/D5): for each identity ELIGIBLE at `slot`
 * (4.6's `isEligibleAtWindow`), one `signedTicket` (4.2, ticket index 0) +
 * its uptime weight `computeUptimeWeight(validWindows, slot, lookbackL)`
 * (4.5) — in `identities` order (so `tickets[i]` / `weights[i]` /
 * `protoTickets[i]` align).
 *
 * A LAPSED identity (`slot > attestedUntilWindow`) is EXCLUDED from the
 * set (R4: it stops producing valid tickets — its tickets are not
 * accepted). `lookbackL` = the genesis `uptimeLookbackL` (D8).
 */
export function eligibleSignedSet(
  identities: ReadonlyArray<MultiSimIdentity>,
  slot: bigint,
  parentHash: Uint8Array,
  challenge: Uint8Array,
  lookbackL: bigint,
): WindowAcceptedSet {
  const tickets: DrawTicket[] = []
  const weights: bigint[] = []
  const protoTickets: ProtoTicket[] = []
  for (const id of identities) {
    // 4.6 — the re-attestation eligibility gate (chain-time, AD-3):
    // lapsed identities are excluded from the accepted set.
    if (!isEligibleAtWindow(id.attestedUntilWindow, slot)) continue
    const t = signedTicket(id.keypair, slot, parentHash, challenge, 0n)
    protoTickets.push(t)
    tickets.push({ identityId: t.identityId, nonceCommitment: t.nonceCommitment })
    // 4.5 — the uptime weight: the count of DISTINCT valid windows in the
    // `L` windows strictly before `slot` (ramp from zero, moving window).
    weights.push(computeUptimeWeight(id.validWindows, slot, lookbackL))
  }
  return { tickets, weights, protoTickets }
}

/**
 * Apply the acceptance cap (4.4, IMPORTED — never re-implemented) to a RAW
 * aligned set (allowing multiple tickets per identity) → the capped
 * (one-ticket-per-identity, keep-first) aligned set (R1: an identity's
 * extra tickets are dropped before the draw — its weight is counted ONCE).
 */
export function buildCappedSet(
  rawProtoTickets: ReadonlyArray<ProtoTicket>,
  rawWeights: ReadonlyArray<bigint>,
): CappedSet {
  return applyAcceptanceCap({ tickets: rawProtoTickets, weights: rawWeights })
}

/**
 * One window end-to-end on the memory transport (D1): derive the next
 * slot + parent from the STORE's head (R4, AD-3), derive the window's
 * challenge (AD-12), build the accepted set (`eligibleSignedSet` —
 * eligible identities, signed tickets, uptime weights), apply the
 * acceptance cap (4.4), run the ONE pinned draw (`drawWindow`, AD-7 —
 * imported, never re-implemented) to pick the winner, `mineBlock` (R3) for
 * that winner with the winner's SIGNED proto `Ticket` encoded as
 * `winnerTicket`, `applyBlock` (R5 — credit the reward, commit), then
 * `acceptBlockWinner` (4.3: `verifyDraw` + `verifyTicketSignature`).
 *
 * The reward display→base-unit conversion (`fromDisplay`, the AD-5 big.js
 * boundary via the ledger barrel) happens ONCE per window, OUTSIDE the
 * per-attempt mining loop. The store head is threaded forward by the
 * caller (`simulateMultiNetwork`) via the single-writer commit — the
 * memory transport.
 */
export async function simulateMultiWindow(params: {
  store: StorePort
  rewardDisplay: string
  maxSupplyDisplay: string
  identities: ReadonlyArray<MultiSimIdentity>
  lookbackL: bigint
}): Promise<MultiSimWindowResult> {
  const { store, rewardDisplay, maxSupplyDisplay, identities, lookbackL } = params

  // The AD-5 boundary conversion ONCE per window (outside the mining loop).
  const rewardBaseUnits = fromDisplay(rewardDisplay)

  // 1 — load or seed the balance state (absent snapshot → pre-funded mint,
  //    the closed-system treasury, mirroring 3.7's `simulateWindow`).
  const doc = await store.loadState()
  const balances: BalanceMap =
    doc === null
      ? new Map<string, bigint>([[MINT_ID, fromDisplay(maxSupplyDisplay)]])
      : fromJson(doc)

  // 2 — the next slot + parent, from the persisted head (R4, AD-3).
  const { slot, parentHash } = await nextSlotAndParent(store)

  // 3 — the window's challenge (AD-12): derived from the EXACT parentHash +
  //    slot the block will commit to. Copied into a fresh 32-byte buffer so
  //    the `Uint8Array<ArrayBuffer>` forms the proto `Ticket` requires hold.
  const derivedChallenge = deriveWindowChallenge(parentHash, slot)
  const challenge = new Uint8Array(32)
  challenge.set(derivedChallenge)

  // 4 — the window's accepted set: eligible identities, SIGNED tickets,
  //    uptime-derived weights (4.2 / 4.5 / 4.6 — all imported).
  const { tickets, weights, protoTickets } = eligibleSignedSet(
    identities,
    slot,
    parentHash,
    challenge,
    lookbackL,
  )

  // 5 — the acceptance cap (4.4, imported): collapse any per-identity
  //    duplicates to one (keep-first) BEFORE the draw (R1). For
  //    `eligibleSignedSet` (one ticket per identity) this is a no-op; the
  //    cap is where R1's multi-ticket case is collapsed.
  const capped = buildCappedSet(protoTickets, weights)

  // 6 — the ONE pinned draw (AD-7, imported — never re-implemented) picks
  //    the winner BEFORE any mining (hardware-independent by construction).
  const draw = drawWindow(capped.tickets, challenge, capped.weights)
  const winnerIdentityId = draw.winnerIdentityId
  const winnerProtoTicket = capped.tickets[draw.index]

  // 7 — mine one block for the ALREADY-SELECTED winner (R3 hot path), with
  //    the winner's SIGNED proto `Ticket` ENCODED (protons, AD-12 wire
  //    form) as `winnerTicket` (so the block carries a verifiable, signed
  //    ticket — 4.2/4.3).
  const block = mineBlock({
    slot,
    parentHash,
    winnerIdentityId,
    winnerTicket: Ticket.encode(winnerProtoTicket),
    txCount: 0n,
  })

  // 8 — apply: credit the reward `MINT_ID → winner`, commit, save (R5).
  await applyBlock({
    store,
    block,
    balances,
    rewardBaseUnits,
    mintId: MINT_ID,
  })

  // 9 — the 4.3 acceptance seam: the draw gate (`verifyDraw`) AND the
  //    AD-12 signature gate compose — the block is accepted only if the
  //    winner's OWN key signed its ticket (the residual replay is closed).
  const accept = acceptBlockWinner(block, capped.tickets, capped.weights, challenge)

  return {
    block,
    winnerId: winnerIdentityId,
    accept,
    tickets: capped.tickets,
    weights: capped.weights,
    challenge,
  }
}

/**
 * Run `windows` windows through the memory transport, threading the store
 * head forward (each `simulateMultiWindow` reads the next slot/parent from
 * the head committed by the previous — ONE chain, ONE accepted set per
 * window, D1).
 *
 * Returns each window's block + winner + the 4.3 acceptance result.
 */
export async function simulateMultiNetwork(params: {
  store: StorePort
  rewardDisplay: string
  maxSupplyDisplay: string
  identities: ReadonlyArray<MultiSimIdentity>
  lookbackL: bigint
  windows: number
}): Promise<Array<{ block: Block; winnerId: string; accept: boolean }>> {
  const { store, rewardDisplay, maxSupplyDisplay, identities, lookbackL, windows } = params
  const out: Array<{ block: Block; winnerId: string; accept: boolean }> = []
  for (let w = 0; w < windows; w++) {
    const r = await simulateMultiWindow({
      store,
      rewardDisplay,
      maxSupplyDisplay,
      identities,
      lookbackL,
    })
    out.push({ block: r.block, winnerId: r.winnerId, accept: r.accept })
  }
  return out
}

/**
 * The PURE rate schedule (NO mining / NO store) — the fast path the rate
 * rows consume (mirrors 3.7's `drawSchedule`): for window `w` ∈ [0,
 * `windows`), `challenge = deriveWindowChallenge(FIXED_PARENT, w)`,
 * `slot = w`, `eligibleSignedSet` → `buildCappedSet` (4.4) → `drawWindow`
 * (AD-7) → the winner id.
 *
 * Fully deterministic (AD-3, D7): `FIXED_PARENT` (32 zero bytes) + the
 * window index as the slot make every challenge, commitment, and
 * signature a pinned sha256 / Ed25519 of public data, so the schedule is
 * reproducible across runs/engines (the 3.3 `PROPORTIONAL_RATE` / 3.7
 * `SIM_RATE` precedent).
 */
export function multiDrawSchedule(
  identities: ReadonlyArray<MultiSimIdentity>,
  windows: number,
  lookbackL: bigint,
): Array<{ winnerId: string; slot: bigint }> {
  const out: Array<{ winnerId: string; slot: bigint }> = []
  for (let w = 0; w < windows; w++) {
    const slot = BigInt(w)
    const challenge = deriveWindowChallenge(FIXED_PARENT, slot)
    const { tickets, weights, protoTickets } = eligibleSignedSet(
      identities,
      slot,
      FIXED_PARENT,
      challenge,
      lookbackL,
    )
    // The acceptance cap (4.4) — a no-op for `eligibleSignedSet`'s
    // one-ticket-per-identity shape, applied for consistency with the
    // mined path (the draw always consumes a capped set).
    const capped = buildCappedSet(protoTickets, weights)
    const draw = drawWindow(capped.tickets, challenge, capped.weights)
    out.push({ winnerId: draw.winnerIdentityId, slot })
  }
  return out
}
