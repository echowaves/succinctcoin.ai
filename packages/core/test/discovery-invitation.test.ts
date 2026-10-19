/**
 * discovery-invitation.test.ts — ticket 9.2 matrix. The invitation is an
 * 8.2 announcement in a copy-paste string PLUS ticket liveness; this suite
 * pins the format, the three verification gates with their DISTINCT reasons
 * (parse → validator verbatim → liveness), and the never-throws contract.
 *
 *   ROUND_TRIP        encode → parse → verify keeps every field; the verified
 *                     record IS what the book ingests.
 *   TOLERANCE         whitespace/newline stripping, case-insensitive prefix.
 *   MALFORMED         missing prefix / junk base64 / undecodable bytes /
 *                     truncation — all one reason, never a throw.
 *   VALIDATOR_PASS    expired / wrong chain / off-policy addr / forged sig
 *                     reject with the 8.2 reasons VERBATIM (the invite layer
 *     THROUGH       adds nothing to the validator's taxonomy).
 *   SQUATTER          zero recent tickets → 'no-recent-ticket' — and the
 *                     window math (sinceWindow) is pinned, custom lookback too.
 *   MODULE_PURE       no Date / setTimeout / performance / net imports.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  INVITE_PREFIX,
  deriveIdentityKeypair,
  encodeInvite,
  parseInvite,
  signPeerAnnouncement,
  validatePeerAnnouncement,
  verifyInvite,
} from '../src/index.js'
import type { InviteContext, PeerAnnouncementFields, SignedPeerAnnouncement } from '../src/index.js'

// ---------------------------------------------------------------------------
// fixtures — deterministic keypairs (no RNG anywhere, AD-3)
// ---------------------------------------------------------------------------

const KEYPAIR = deriveIdentityKeypair(
  Uint8Array.from({ length: 32 }, (_, i) => (0xc7 + i) % 256),
)
const OTHER = deriveIdentityKeypair(new Uint8Array(32).fill(0x5e))

function fieldsAt(over: Partial<PeerAnnouncementFields> = {}): PeerAnnouncementFields {
  return {
    identityId: KEYPAIR.identityId,
    multiaddrs: ['/ip6/2001:db8:c0a8:10a::/tcp/4001'],
    observedExternalAddr: undefined,
    slotStart: 100,
    slotEnd: 200,
    chainId: 'succinctcoin-v1',
    ...over,
  }
}

function signedAt(over: Partial<PeerAnnouncementFields> = {}): SignedPeerAnnouncement {
  const fields = fieldsAt(over)
  return { ...fields, signature: signPeerAnnouncement(KEYPAIR, fields) }
}

const LIVE: Pick<InviteContext, 'currentSlot' | 'expectedChainId'> = {
  currentSlot: 150,
  expectedChainId: 'succinctcoin-v1',
}

function ctxWith(ticket: boolean | ((id: string, since: bigint) => boolean), over: Partial<InviteContext> = {}): InviteContext {
  return {
    ...LIVE,
    hadRecentTicket: typeof ticket === 'function' ? ticket : () => ticket,
    ...over,
  }
}

// ---------------------------------------------------------------------------

describe('9.2 — invitation format + three-gated verification', () => {
  it('ROUND_TRIP: encode → parse → verify keeps every field; verified record validates', () => {
    const record = signedAt()
    const text = encodeInvite(record)
    expect(text.startsWith(INVITE_PREFIX)).toBe(true)
    expect(/[\s]/.test(text)).toBe(false) // single line, clipboard-safe

    const parsed = parseInvite(text)
    expect(parsed.ok).toBe(true)

    const verified = verifyInvite(text, ctxWith(true))
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    // Field-for-field (proto int64 arrives as bigint — the wire convention).
    expect(verified.record.identityId).toBe(record.identityId)
    expect(verified.record.multiaddrs).toEqual(record.multiaddrs)
    expect(Number(verified.record.slotStart)).toBe(100)
    expect(Number(verified.record.slotEnd)).toBe(200)
    expect(verified.record.chainId).toBe('succinctcoin-v1')
    // The verified record IS book/validator-ready unchanged.
    expect(validatePeerAnnouncement(verified.record, LIVE)).toEqual({ ok: true })
  })

  it('TOLERANCE: wrapped lines / stray spaces / uppercase prefix all parse', () => {
    const text = encodeInvite(signedAt())
    const wrapped = text
      .slice(0, 40)
      .concat('\n  ', text.slice(40, 80), ' \t', text.slice(80))
    expect(verifyInvite(wrapped, ctxWith(true)).ok).toBe(true)
    const upper = (INVITE_PREFIX.toUpperCase() + text.slice(INVITE_PREFIX.length)).replace(/\s/g, '')
    expect(verifyInvite(upper, ctxWith(true)).ok).toBe(true)
  })

  it('MALFORMED: every text-stage failure is malformed-invite and never throws', () => {
    const good = encodeInvite(signedAt())
    for (const junk of [
      '',
      '   ',
      'just some text',
      'scinvite:v2:' + good.slice(INVITE_PREFIX.length), // unknown version prefix
      'SCINVITE:V1:!!!not base64!!!',
      INVITE_PREFIX + 'AAAA-BB!C',
      good.slice(0, good.length - 8), // truncated payload (decode junk)
      INVITE_PREFIX, // empty payload
      INVITE_PREFIX + 'A', // impossible b64 length
      good + '###trailing junk after padding bits',
    ]) {
      const r = verifyInvite(junk, ctxWith(true))
      expect(r.ok ? 'ok' : r.reason, JSON.stringify(junk.slice(0, 24))).toBe('malformed-invite')
    }
  })

  it('VALIDATOR_PASS: the 8.2 reasons surface VERBATIM through the invite layer', () => {
    const rows: Array<[string, SignedPeerAnnouncement, string]> = [
      ['expired', signedAt({ slotEnd: 120 }), 'expired'], // currentSlot 150 > 120
      ['not yet valid', signedAt({ slotStart: 400, slotEnd: 500 }), 'not-yet-valid'],
      ['wrong chain', signedAt({ chainId: 'succinctcoin-mainnet-1' }), 'chain-mismatch'],
      ['ipv4 address', signedAt({ multiaddrs: ['/ip4/10.0.0.1/tcp/1'] }), 'unsupported-address'],
    ]
    for (const [label, record, reason] of rows) {
      const r = verifyInvite(encodeInvite(record), ctxWith(true))
      expect(r.ok ? 'ok' : r.reason, label).toBe(reason)
    }
    // Forged signature: honest fields, signed by another key → bad-signature.
    const forged = { ...fieldsAt(), signature: signPeerAnnouncement(OTHER, fieldsAt()) }
    const r = verifyInvite(encodeInvite(forged as SignedPeerAnnouncement), ctxWith(true))
    expect(r.ok ? 'ok' : r.reason).toBe('bad-signature')
  })

  it('SQUATTER: zero recent tickets rejects with no-recent-ticket and yields nothing', () => {
    const text = encodeInvite(signedAt())
    const r = verifyInvite(text, ctxWith(false))
    expect(r).toEqual({ ok: false, reason: 'no-recent-ticket' })
  })

  it('LIVENESS_WINDOW: sinceWindow = currentSlot - lookback (floor 0); custom lookback honored', () => {
    const text = encodeInvite(signedAt())
    const seen: Array<[string, bigint]> = []
    const probe = (id: string, since: bigint): boolean => {
      seen.push([id, since])
      return true
    }
    expect(verifyInvite(text, ctxWith(probe)).ok).toBe(true)
    expect(seen).toEqual([[KEYPAIR.identityId, 150n - 32n]]) // default lookback 32

    seen.length = 0
    verifyInvite(text, ctxWith(probe, { lookbackSlots: 10 }))
    expect(seen[0]?.[1]).toBe(140n)

    seen.length = 0
    // Window floor at 0 needs a record that is FRESH at slot 5 — otherwise
    // the validator gate rejects before liveness ever runs.
    const early = encodeInvite(signedAt({ slotStart: 1, slotEnd: 10 }))
    expect(verifyInvite(early, ctxWith(probe, { currentSlot: 5 })).ok).toBe(true)
    expect(seen[0]?.[1]).toBe(0n)
  })

  it('MODULE_PURE: the invitation source touches no clock, fs, or net', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/discovery/invitation.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bDate\b|\bsetTimeout\b|\bperformance\b|node:net|node:http|node:fs/)
  })
})
