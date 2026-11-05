/**
 * `core/discovery/invitation` — the invitation: a `PeerAnnouncement` (8.2)
 * plus PROOF OF LIVENESS, in one copy-paste-friendly string (ticket 9.2,
 * spec change-ipv6-invitation-join: joining this network is by invitation of
 * a trusted party; email/SMS/clipboard/QR all carry plain text, so the wire
 * form is ONE line of ASCII).
 *
 * THE FORMAT (pinned): `"scinvite:v1:"` + base64url (no padding) of the
 * canonical `PeerAnnouncement` proto bytes. The signature inside IS the
 * record's proof-of-identity — an invitation cannot be edited without
 * invalidating it, and cannot be minted without the identity's key. Parsing
 * is copy-paste tolerant: ALL whitespace is stripped first (mailers wrap
 * lines; messengers add spaces), the prefix match is case-insensitive.
 * QR is a rendering concern for the sender's app — no dependency ships here
 * (pinned decision 9.2: text-only, none in-tree).
 *
 * VERIFICATION IS THREE-GATED, and each gate has its own reason (an invite
 * that fails ANY gate never produces a dial target):
 *   1. parse      — prefix/base64/proto decode must succeed (`malformed-invite`);
 *   2. the 8.2 validator VERBATIM (`validatePeerAnnouncement`) — shape, chain
 *      scope, Ed25519 signature, slot freshness, and the 9.1 IPv6-only policy
 *      (an invite with no global-v6 address is not an invitation to anything
 *      — except the pinned dev-only loopback allowance, see below);
 *   3. TICKET LIVENESS — the identity must have had a valid mining ticket in
 *      a recent window (`no-recent-ticket`). This is what makes an old,
 *      faithfully-signed announcement useless to a squatter: re-announcing
 *      requires actually producing blocks on THIS chain right now. The
 *      getter is caller-supplied (AD-3 — no clocks, no store, no net here);
 *      the core boot wires it to applied-block winner tickets.
 *
 * Pure apart from one seam: no clock, no fs, no net (AD-3/AD-10); the single
 * ambient read is the dev-only `loopbackAnnounceAllowed()` env resolution for
 * the verification context — invite verify is a JOIN surface, never consensus.
 */
import {
  hopNetworkKey,
  isLoopbackIp6Multiaddr,
  isLoopbackV4Multiaddr,
  loopbackAnnounceAllowed,
} from '../net/address-policy.js'
import { validatePeerAnnouncement } from './announcements.js'
import type { AnnouncementRejectReason, SignedPeerAnnouncement } from './announcements.js'
import { verifyWitness } from './witness.js'

import { InviteBundle, PeerAnnouncement } from '../proto/index.js'
import type { InviteBundle as InviteBundleFields, succinctcoin } from '../proto/index.js'

/** Encode-side shape of the v2 envelope (all fields optional, plain bytes). */
type InviteBundleEncodeInput = succinctcoin.InviteBundleInput

/** The pinned textual prefix (versioned — a v2 format is a new prefix). */
export const INVITE_PREFIX = 'scinvite:v1:'

/**
 * The `scinvite:v2:` envelope prefix (spec-scinvite-v2 WB-1, ticket 13.1):
 * one line carrying the v1 record VERBATIM plus witnessed backup candidates.
 * A ZERO-candidate bundle is a v1 invite in a new wrapper — its primary runs
 * v1's exact three gates; a bundle WITH candidates runs those same gates for
 * the primary and then judges every candidate against the verification floor
 * (13.3): k witnesses from distinct signers, unexpired, spanning the /64
 * diversity law. Dispatch lives ONLY inside {@link verifyInvite};
 * `parseInvite` stays pure-v1 and keeps rejecting this prefix cleanly.
 */
export const INVITE_V2_PREFIX = 'scinvite:v2:'

/** Liveness lookback: how many slots back a winner ticket still counts. */
export const DEFAULT_TICKET_LOOKBACK_SLOTS = 32

/** Invite-specific reject reasons (validator reasons pass through verbatim).
 * Candidate-level verdicts are NOT rejects — they ride the ok arm as
 * {@link CandidateVerdict} entries (a skipped candidate never rejects the
 * bundle; 13.3). */
export type InviteRejectReason = AnnouncementRejectReason | 'malformed-invite' | 'no-recent-ticket'

/** How many DISTINCT signers must vouch for a backup candidate before it is
 * trusted (spec-scinvite-v2 WB-3 assumption: tunable, pinned at 2 — one
 * witness is an anecdote, two independent ones are corroboration). */
export const MIN_WITNESS_SIGNERS = 2

/** Why ONE candidate was skipped (pinned — consumers and metrics key on
 * these). Never a bundle-level reject: skipped candidates simply do not
 * become dial targets. */
export type CandidateRejectReason =
  | 'no-witnesses'
  | 'insufficient-signers'
  | 'address-unsupported'
  | 'address-not-diverse'

/** The per-candidate verdict of the verification floor (13.3), in BUNDLE
 * ORDER. `signers` counts distinct valid witness signers (0 when the
 * candidate carried none); `reason` is present exactly when not accepted. */
export interface CandidateVerdict {
  address: string
  accepted: boolean
  signers: number
  reason?: CandidateRejectReason
}

export type InviteValidation =
  | {
      ok: true
      record: SignedPeerAnnouncement
      /** Per-candidate verdicts — PRESENT only for a v2 bundle that carried
       * candidates (v1 and zero-candidate shapes stay byte-identical, so
       * existing consumer destructuring is safe). */
      candidates?: readonly CandidateVerdict[]
    }
  | { ok: false; reason: InviteRejectReason }

export interface InviteContext {
  /** Chain time the freshness + liveness window are judged at (AD-3). */
  currentSlot: number | bigint
  /** This network's genesis `chainId` — another chain's invite dies here. */
  expectedChainId: string
  /**
   * Liveness probe: did `identityId` hold a valid mining ticket in ANY window
   * at or after `currentSlot - lookbackSlots`? The core boot answers this from
   * APPLIED blocks (winner tickets) — gossiped tickets are un-anchored and
   * never liveness. Throwing getters propagate: a broken probe must not read
   * as "no tickets" and silently reject honest invites.
   */
  hadRecentTicket(identityId: string, sinceWindow: bigint): boolean
  /** Lookback window size (default {@link DEFAULT_TICKET_LOOKBACK_SLOTS}). */
  lookbackSlots?: number | bigint
  /**
   * Trust ceiling for candidate witnesses (13.3, pinned): `true` = this
   * chain has applied blocks, so a witness signer must themselves hold a
   * recent ticket (same window as the primary's liveness gate) for their
   * witness to COUNT toward k. Absent/false = the empty-chain soft side —
   * an undecidable-liveness world where signing is cheap, so signers are
   * not ticket-gated (their witnesses still pass chain/window/signature).
   */
  chainHasBlocks?: boolean
}

// ---------------------------------------------------------------------------
// base64url (no padding) — node-free, symmetric, strict
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function bytesToB64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const n = Math.min(3, bytes.length - i)
    out += B64URL[(chunk >>> 18) & 63]! + B64URL[(chunk >>> 12) & 63]!
    out += n >= 2 ? B64URL[(chunk >>> 6) & 63]! : ''
    out += n >= 3 ? B64URL[chunk & 63]! : ''
  }
  return out
}

/** Decode: canonical chars only, no padding; a partial tail group decodes to
 * its whole bytes (a mangled string yields DIFFERENT bytes — which then die
 * at proto decode or signature verification, never silently pass). */
function b64urlToBytes(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null // impossible encoding length
  const values: number[] = []
  for (const c of s) {
    const v = B64URL.indexOf(c)
    if (v === -1) return null
    values.push(v)
  }
  const out = new Uint8Array(Math.floor((values.length * 3) / 4))
  let o = 0
  for (let i = 0; i < values.length; i += 4) {
    const a = values[i]!
    const b = values[i + 1] ?? 0 // partial tail group (length % 4 !== 0)
    out[o++] = (a << 2) | (b >> 4)
    if (i + 2 < values.length) {
      const c = values[i + 2]!
      out[o++] = ((b & 15) << 4) | (c >> 2)
      if (i + 3 < values.length) out[o++] = ((c & 3) << 6) | values[i + 3]!
    }
  }
  return out.subarray(0, o)
}

// ---------------------------------------------------------------------------
// render / parse / verify
// ---------------------------------------------------------------------------

/** Render a signed announcement as the one-line invitation string. */
export function encodeInvite(record: SignedPeerAnnouncement): string {
  const bytes = PeerAnnouncement.encode({
    ...record,
    slotStart: BigInt(record.slotStart),
    slotEnd: BigInt(record.slotEnd),
  })
  return INVITE_PREFIX + bytesToB64url(bytes)
}

/** Hard ceiling on invite text (whitespace-stripped). A valid encoded
 * record is ~2 KB; anything past this is an attack or corruption, and the
 * per-char base64 decode must never be handed megabytes (9.2 review).
 * Checked BEFORE any base64/proto decode in both parsers; v2 keeps the same
 * cap (WB-1: raising it is an explicit future decision with bounded
 * backups), and {@link mintV2} refuses to MINT text this parser would
 * reject — every minted invite is redeemable by its own parser. */
export const MAX_INVITE_TEXT_LEN = 4096

/** Parse-only: the three text-stage failures (prefix, base64, proto decode)
 * collapse into `malformed-invite`. NO validation happens here — a parse is
 * not trust. Whitespace anywhere is stripped; prefix is case-insensitive. */
export function parseInvite(text: string): { ok: true; record: unknown } | { ok: false; reason: 'malformed-invite' } {
  const compact = text.replace(/\s/g, '')
  if (compact.length <= INVITE_PREFIX.length || compact.length > MAX_INVITE_TEXT_LEN)
    return { ok: false, reason: 'malformed-invite' }
  if (compact.slice(0, INVITE_PREFIX.length).toLowerCase() !== INVITE_PREFIX)
    return { ok: false, reason: 'malformed-invite' }
  const bytes = b64urlToBytes(compact.slice(INVITE_PREFIX.length))
  if (bytes === null) return { ok: false, reason: 'malformed-invite' }
  try {
    return { ok: true, record: PeerAnnouncement.decode(bytes) }
  } catch {
    return { ok: false, reason: 'malformed-invite' }
  }
}

// ---------------------------------------------------------------------------
// scinvite:v2 — the witness-backed envelope (WB-1 seam, ticket 13.1)
// ---------------------------------------------------------------------------

/** One witness as minted by 13.2 (the 13.1 codec seam carries it but never
 * checks it — no signature verification, expiry, or k-of-n before then). */
export interface InviteWitnessInput {
  targetIdentityId: string
  address: string
  chainId: string
  firstSeenSlot: number | bigint
  expirySlot: number | bigint
  signerIdentityId: string
  signature: Uint8Array
}

/** One witnessed backup address inside a v2 bundle. */
export interface InviteCandidateInput {
  address: string
  witnesses?: InviteWitnessInput[]
}

/** What {@link mintV2} renders: the v1 record plus zero or more candidates. */
export interface MintV2Input {
  primary: SignedPeerAnnouncement
  candidates?: InviteCandidateInput[]
}

/** Result of {@link parseV2}: the decoded envelope (primary present) or the
 * single text/decode-stage reason `malformed-invite`. No validation here. */
export type InviteBundleParse =
  | { ok: true; bundle: InviteBundleFields }
  | { ok: false; reason: 'malformed-invite' }

/** Render the v2 envelope. The primary encodes EXACTLY like `encodeInvite`
 * (WB-1: the v1 record verbatim inside the wrapper). Throws when the
 * rendered text would exceed {@link MAX_INVITE_TEXT_LEN} — an invite nobody
 * can redeem is not an invite (the candidate budget N is 13.5's decision,
 * made under this invariant). */
export function mintV2(input: MintV2Input): string {
  // Built as the proto INPUT shape (encode's parameter) — the full message
  // type would demand `Uint8Array<ArrayBuffer>` bytes we do not carry.
  const bundle: InviteBundleEncodeInput = {
    primary: {
      ...input.primary,
      slotStart: BigInt(input.primary.slotStart),
      slotEnd: BigInt(input.primary.slotEnd),
    },
    candidates: (input.candidates ?? []).map((candidate) => ({
      address: candidate.address,
      witnesses: (candidate.witnesses ?? []).map((witness) => ({
        ...witness,
        firstSeenSlot: BigInt(witness.firstSeenSlot),
        expirySlot: BigInt(witness.expirySlot),
      })),
    })),
  }
  const text = INVITE_V2_PREFIX + bytesToB64url(InviteBundle.encode(bundle))
  if (text.length > MAX_INVITE_TEXT_LEN) {
    throw new RangeError(
      `scinvite:v2 renders to ${text.length} chars, over MAX_INVITE_TEXT_LEN=${MAX_INVITE_TEXT_LEN}: ` +
        'reduce the candidate/witness budget (an un-redeemable invite must never be minted)',
    )
  }
  return text
}

/** Parse-only v2 reader (mirror of {@link parseInvite}): whitespace-stripped,
 * case-insensitive prefix, length cap BEFORE any decode, proto decode in a
 * try. A bundle WITHOUT a primary is envelope junk ⇒ `malformed-invite`.
 * NO validation happens here — a parse is not trust. */
export function parseV2(text: string): InviteBundleParse {
  return parseV2Compact(text.replace(/\s/g, ''))
}

function parseV2Compact(compact: string): InviteBundleParse {
  if (compact.length <= INVITE_V2_PREFIX.length || compact.length > MAX_INVITE_TEXT_LEN)
    return { ok: false, reason: 'malformed-invite' }
  if (compact.slice(0, INVITE_V2_PREFIX.length).toLowerCase() !== INVITE_V2_PREFIX)
    return { ok: false, reason: 'malformed-invite' }
  const bytes = b64urlToBytes(compact.slice(INVITE_V2_PREFIX.length))
  if (bytes === null) return { ok: false, reason: 'malformed-invite' }
  try {
    const bundle = InviteBundle.decode(bytes)
    // An envelope without its record is not an invitation — junk, not a
    // gate failure (protons SKIPS unknown fields, so field-junk can decode
    // to an empty bundle; pin the shape here, before any gate).
    if (bundle.primary === undefined) return { ok: false, reason: 'malformed-invite' }
    return { ok: true, bundle }
  } catch {
    return { ok: false, reason: 'malformed-invite' }
  }
}

// ---------------------------------------------------------------------------
// verify — the single dispatching entry point
// ---------------------------------------------------------------------------

/**
 * The full join-time verification. PREFIX DISPATCH lives ONLY here (single
 * entry point — boot rung 0, `applyInvite`, and the paste box gain v2 for
 * free and no consumer learns two functions):
 *
 *   v1 — parse → 8.2 validator (verbatim reasons) → ticket liveness.
 *   v2 — envelope parse; the primary runs the VERY SAME validator + liveness
 *        tail as v1 (a primary failing ANY gate kills the whole bundle —
 *        candidates never gate-rescue, verify-before-connect is structural);
 *        then each candidate carries a per-candidate verdict from the 13.3
 *        verification floor ({@link judgeCandidates}). The invite verifies
 *        with fewer or no candidates — a skipped candidate NEVER rejects
 *        the bundle.
 *
 * On success the record is exactly what the address book ingests invite-
 * grade; on failure NOTHING is returned — an unverified invite never
 * produces a dial target (verify-before-connect, structural). Candidate
 * verdicts are DATA: this function never dials, consumers act on them.
 */
export function verifyInvite(text: string, ctx: InviteContext): InviteValidation {
  const compact = text.replace(/\s/g, '')
  if (compact.slice(0, INVITE_V2_PREFIX.length).toLowerCase() === INVITE_V2_PREFIX) {
    const parsed = parseV2Compact(compact)
    if (!parsed.ok) return parsed
    const verified = verifyRecord(parsed.bundle.primary, ctx)
    if (!verified.ok) return verified
    if (parsed.bundle.candidates.length === 0) return verified // v1 shape, no verdicts key
    return {
      ...verified,
      candidates: judgeCandidates(parsed.bundle.candidates, verified.record, ctx),
    }
  }

  const parsed = parseInvite(text)
  if (!parsed.ok) return parsed
  return verifyRecord(parsed.record, ctx)
}

/** Gates 2 + 3 VERBATIM (the v1 path AND every v2 primary, candidate-bearing
 * or not — candidates never gate-rescue): the 8.2 validator then ticket
 * liveness. */
function verifyRecord(record: unknown, ctx: InviteContext): InviteValidation {
  const validated = validatePeerAnnouncement(record, {
    currentSlot: ctx.currentSlot,
    expectedChainId: ctx.expectedChainId,
    // Invite verification is a JOIN surface, not consensus (10.3 closeout):
    // under the dev flag a `::1` invite verifies so local meshes work — and
    // such a record still fails STRICT block validation everywhere, so it
    // can never enter anyone's chain.
    allowLoopbackAddresses: loopbackAnnounceAllowed(),
  })
  if (!validated.ok) return { ok: false, reason: validated.reason }
  const signed = record as SignedPeerAnnouncement

  // Liveness LAST: it is the only gate with a caller dependency, and both
  // earlier gates are strictly cheaper. A squatter with an old faithfully-
  // signed announcement dies HERE (`no-recent-ticket`).
  const current = typeof ctx.currentSlot === 'bigint' ? ctx.currentSlot : BigInt(ctx.currentSlot)
  const lookback =
    typeof ctx.lookbackSlots === 'bigint'
      ? ctx.lookbackSlots
      : BigInt(ctx.lookbackSlots ?? DEFAULT_TICKET_LOOKBACK_SLOTS)
  const sinceWindow = current > lookback ? current - lookback : 0n
  if (!ctx.hadRecentTicket(signed.identityId, sinceWindow)) return { ok: false, reason: 'no-recent-ticket' }

  return { ok: true, record: signed }
}

// ---------------------------------------------------------------------------
// the verification floor (13.3) — per-candidate verdicts over a verified
// primary (spec-scinvite-v2 WB-3: k-of-n distinct signers, slot expiry,
// /64 diversity)
// ---------------------------------------------------------------------------

/** One wire candidate as DECODED from the bundle (hostile data — every field
 * is re-checked by the floor, never trusted from the codec). */
type WireCandidate = InviteBundleFields['candidates'][number]

/**
 * Judge every candidate of a VERIFIED-primary bundle, in bundle order
 * (pure — no dials, no store reads beyond ctx). A candidate COUNTS one
 * witness toward k only when ALL hold:
 *
 *   1. the witness attests THIS peer at THIS address (a witness for another
 *      target or another address is worthless here), and is NOT the
 *      primary's self-attestation (the primary vouching for itself proves
 *      nothing);
 *   2. `verifyWitness` accepts it (13.2: shape → chain-mismatch → half-open
 *      window → Ed25519 — never throws, so bad witnesses simply do not
 *      count; 3 witnesses with 1 forged still pass on the 2 good ones);
 *   3. under `ctx.chainHasBlocks === true` ONLY: the signer holds a recent
 *      ticket in the SAME window the primary's liveness gate uses (the
 *      strict side of the pinned trust ceiling; an empty chain cannot
 *      demand it and stays soft).
 *
 * Distinct signers ≥ {@link MIN_WITNESS_SIGNERS} first, then the address
 * law: `hopNetworkKey` group `"6:…"` must not have been used by an EARLIER
 * ACCEPTED candidate (at most one accepted candidate per /64 — the 9.3
 * diversity instinct, tightened for tiny bundles); a `"4:…"` group or null
 * is `address-unsupported`, EXCEPT loopback-family hops under the pinned
 * dev flag, which are accepted and EXEMPT from diversity (mirrors the
 * primary gate's `allowLoopbackAddresses: loopbackAnnounceAllowed()`).
 */
function judgeCandidates(
  candidates: readonly WireCandidate[],
  primary: SignedPeerAnnouncement,
  ctx: InviteContext,
): CandidateVerdict[] {
  const current = typeof ctx.currentSlot === 'bigint' ? ctx.currentSlot : BigInt(ctx.currentSlot)
  const lookback =
    typeof ctx.lookbackSlots === 'bigint'
      ? ctx.lookbackSlots
      : BigInt(ctx.lookbackSlots ?? DEFAULT_TICKET_LOOKBACK_SLOTS)
  const sinceWindow = current > lookback ? current - lookback : 0n
  const allowLoopback = loopbackAnnounceAllowed()
  const usedGroups = new Set<string>()
  const verdicts: CandidateVerdict[] = []

  for (const candidate of candidates) {
    const address = typeof candidate.address === 'string' ? candidate.address : ''
    const witnesses = Array.isArray(candidate.witnesses) ? candidate.witnesses : []
    if (witnesses.length === 0) {
      verdicts.push({ address, accepted: false, signers: 0, reason: 'no-witnesses' })
      continue
    }
    // Count DISTINCT signers whose witness is valid for THIS candidate.
    const signers = new Set<string>()
    for (const witness of witnesses) {
      // Cheap identity checks BEFORE the validator (signature cost is the
      // expensive step — a witness aimed at another peer/address never pays
      // it). Shape junk simply matches nothing and is skipped.
      const w = witness as Partial<{
        targetIdentityId: string
        address: string
        signerIdentityId: string
      }>
      if (w.targetIdentityId !== primary.identityId) continue // attests another peer
      if (w.address !== address) continue // attests another address
      if (typeof w.signerIdentityId !== 'string') continue
      if (w.signerIdentityId === primary.identityId) continue // self-attestation: worthless
      const validation = verifyWitness(witness, {
        currentSlot: ctx.currentSlot,
        expectedChainId: ctx.expectedChainId,
      })
      if (!validation.ok) continue
      // Strict signer rule — ONLY when the chain has blocks (pinned ceiling).
      if (ctx.chainHasBlocks === true && !ctx.hadRecentTicket(w.signerIdentityId, sinceWindow))
        continue
      signers.add(w.signerIdentityId)
    }
    if (signers.size < MIN_WITNESS_SIGNERS) {
      verdicts.push({
        address,
        accepted: false,
        signers: signers.size,
        reason: 'insufficient-signers',
      })
      continue
    }
    // Address law (pinned resolution of the ticket unknowns).
    const group = hopNetworkKey(address)
    if (group === null) {
      if (allowLoopback && (isLoopbackIp6Multiaddr(address) || isLoopbackV4Multiaddr(address))) {
        verdicts.push({ address, accepted: true, signers: signers.size }) // dev-only; diversity-EXEMPT
        continue
      }
      verdicts.push({
        address,
        accepted: false,
        signers: signers.size,
        reason: 'address-unsupported',
      })
      continue
    }
    if (group.startsWith('4:')) {
      // v4 diversity metric undecided (ticket draft resolution) — a v4 hop
      // is not a dialable candidate under the WB floor.
      verdicts.push({
        address,
        accepted: false,
        signers: signers.size,
        reason: 'address-unsupported',
      })
      continue
    }
    if (usedGroups.has(group)) {
      verdicts.push({
        address,
        accepted: false,
        signers: signers.size,
        reason: 'address-not-diverse',
      })
      continue
    }
    usedGroups.add(group)
    verdicts.push({ address, accepted: true, signers: signers.size })
  }
  return verdicts
}
