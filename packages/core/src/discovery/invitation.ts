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
 *      (an invite with no global-v6 address is not an invitation to anything);
 *   3. TICKET LIVENESS — the identity must have had a valid mining ticket in
 *      a recent window (`no-recent-ticket`). This is what makes an old,
 *      faithfully-signed announcement useless to a squatter: re-announcing
 *      requires actually producing blocks on THIS chain right now. The
 *      getter is caller-supplied (AD-3 — no clocks, no store, no net here);
 *      the core boot wires it to applied-block winner tickets.
 *
 * Pure module: no clock, no fs, no net (AD-3/AD-10).
 */
import { validatePeerAnnouncement } from './announcements.js'
import type { AnnouncementRejectReason, SignedPeerAnnouncement } from './announcements.js'

import { PeerAnnouncement } from '../proto/index.js'

/** The pinned textual prefix (versioned — a v2 format is a new prefix). */
export const INVITE_PREFIX = 'scinvite:v1:'

/** Liveness lookback: how many slots back a winner ticket still counts. */
export const DEFAULT_TICKET_LOOKBACK_SLOTS = 32

/** Invite-specific reject reasons (validator reasons pass through verbatim). */
export type InviteRejectReason = AnnouncementRejectReason | 'malformed-invite' | 'no-recent-ticket'

export type InviteValidation = { ok: true; record: SignedPeerAnnouncement } | { ok: false; reason: InviteRejectReason }

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
 * per-char base64 decode must never be handed megabytes (9.2 review). */
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

/**
 * The full join-time verification: parse → 8.2 validator (verbatim reasons)
 * → ticket liveness. On success the record is exactly what the address book
 * ingests invite-grade; on failure NOTHING is returned — an unverified invite
 * never produces a dial target (verify-before-connect, structural).
 */
export function verifyInvite(text: string, ctx: InviteContext): InviteValidation {
  const parsed = parseInvite(text)
  if (!parsed.ok) return parsed

  const validated = validatePeerAnnouncement(parsed.record, {
    currentSlot: ctx.currentSlot,
    expectedChainId: ctx.expectedChainId,
  })
  if (!validated.ok) return { ok: false, reason: validated.reason }
  const record = parsed.record as SignedPeerAnnouncement

  // Liveness LAST: it is the only gate with a caller dependency, and both
  // earlier gates are strictly cheaper. A squatter with an old faithfully-
  // signed announcement dies HERE (`no-recent-ticket`).
  const current = typeof ctx.currentSlot === 'bigint' ? ctx.currentSlot : BigInt(ctx.currentSlot)
  const lookback =
    typeof ctx.lookbackSlots === 'bigint'
      ? ctx.lookbackSlots
      : BigInt(ctx.lookbackSlots ?? DEFAULT_TICKET_LOOKBACK_SLOTS)
  const sinceWindow = current > lookback ? current - lookback : 0n
  if (!ctx.hadRecentTicket(record.identityId, sinceWindow)) return { ok: false, reason: 'no-recent-ticket' }

  return { ok: true, record }
}
