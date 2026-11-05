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
 *
 * Ticket 13.1 (spec-scinvite-v2 WB-1) ADDS the scinvite:v2 envelope rows:
 *
 *   V2_ROUND_TRIP     mintV2 → parseV2 keeps every field (bigint slots
 *                     intact); paste whitespace / uppercase prefix tolerated.
 *   PRIMARY_VERBATIM  the decoded primary re-encoded standalone EQUALS the
 *                     v1 payload bytes (WB-1: the record rides verbatim).
 *   V2_REDEEM         a zero-candidate bundle verifies through v1's exact
 *                     three gates — failures pass through VERBATIM, and the
 *                     ok arm carries NO candidates key (v1 shape).
 *   OVER_LENGTH       cap pinned at the at-cap boundary with REAL bundles,
 *                     both codecs (mint-side: an over-cap mint THROWS, every
 *                     minted invite redeemable by its own parser).
 *
 * Ticket 13.3 (WB-3) REPLACED the WB-1 wholesale refusal with the
 * verification floor — see `describe('13.3 — verification floor')` below.
 *   DIGESTS_UNTOUCHED golden sha256 of canonicalBlockBytes /
 *                     peerAnnouncementDigest — computed BEFORE the proto
 *                     edit; the new messages must not reach either digest.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  INVITE_PREFIX,
  INVITE_V2_PREFIX,
  MAX_INVITE_TEXT_LEN,
  PeerAnnouncement,
  canonicalBlockBytes,
  deriveIdentityKeypair,
  encodeInvite,
  issueWitness,
  mintV2,
  parseInvite,
  parseV2,
  peerAnnouncementDigest,
  signPeerAnnouncement,
  validatePeerAnnouncement,
  verifyInvite,
} from '../src/index.js'
import type {
  Block,
  IdentityKeypair,
  InviteContext,
  InviteWitnessInput,
  PeerAnnouncementFields,
  SignedPeerAnnouncement,
} from '../src/index.js'

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

// ---------------------------------------------------------------------------
// ticket 13.1 — the scinvite:v2 envelope (WB-1 seam)
// ---------------------------------------------------------------------------

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(hex, 'hex'))
const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/** A shape-only witness (13.1 never checks signatures — the seam carries it). */
function dummyWitness(i: number): InviteWitnessInput {
  return {
    targetIdentityId: KEYPAIR.identityId,
    address: `/ip6/2001:db8:w${i}::/tcp/4001`,
    chainId: 'succinctcoin-v1',
    firstSeenSlot: 100,
    expirySlot: 5000,
    signerIdentityId: OTHER.identityId,
    signature: new Uint8Array(64).fill(i),
  }
}

describe('13.1 — scinvite:v2 envelope (WB-1: v1 record verbatim + candidates)', () => {
  it('V2_ROUND_TRIP: mintV2 → parseV2 keeps every field; paste tolerance holds', () => {
    const record = signedAt()
    const text = mintV2({ primary: record })
    expect(text.startsWith(INVITE_V2_PREFIX)).toBe(true)
    expect(/\s/.test(text)).toBe(false)

    const parsed = parseV2(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.candidates).toEqual([])
    const primary = parsed.bundle.primary!
    expect(primary.identityId).toBe(record.identityId)
    expect(primary.multiaddrs).toEqual(record.multiaddrs)
    expect(primary.slotStart).toBe(100n) // bigint slots intact (wire convention)
    expect(primary.slotEnd).toBe(200n)
    expect(primary.chainId).toBe('succinctcoin-v1')

    // Copy-paste tolerance mirrors v1: whitespace stripped, prefix case-free.
    const wrapped = text.slice(0, 40) + '\n  ' + text.slice(40, 80) + ' \t' + text.slice(80)
    expect(parseV2(wrapped).ok).toBe(true)
    const upper = INVITE_V2_PREFIX.toUpperCase() + text.slice(INVITE_V2_PREFIX.length)
    expect(verifyInvite(upper, ctxWith(true)).ok).toBe(true)
  })

  it('PRIMARY_VERBATIM: the decoded primary re-encoded standalone equals the v1 payload bytes', () => {
    const record = signedAt()
    const parsed = parseV2(mintV2({ primary: record }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const standalone = Buffer.from(PeerAnnouncement.encode(parsed.bundle.primary!)).toString(
      'base64url',
    )
    expect(standalone).toBe(encodeInvite(record).slice(INVITE_PREFIX.length))
  })

  it('V2_REDEEM: a zero-candidate bundle runs v1 exact three gates, reasons verbatim', () => {
    const text = mintV2({ primary: signedAt() })
    const ok = verifyInvite(text, ctxWith(true))
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.record.identityId).toBe(KEYPAIR.identityId)
    // 13.3 shape pin: the candidates key is ABSENT for zero-candidate
    // bundles — v1/zero-candidate consumers destructure unchanged.
    expect(ok.candidates).toBeUndefined()

    // Gate failures pass through with v1's exact reasons (nothing added).
    expect(verifyInvite(mintV2({ primary: signedAt({ slotEnd: 120 }) }), ctxWith(true))).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(verifyInvite(text, ctxWith(false))).toEqual({ ok: false, reason: 'no-recent-ticket' })
  })

  it('V2_MALFORMED: junk / no-primary envelope / v1 bytes under v2 — malformed-invite, never a throw', () => {
    const v1Payload = encodeInvite(signedAt()).slice(INVITE_PREFIX.length)
    for (const junk of [
      '', // prefix only
      '!!!not base64!!!',
      'GAE', // decodes WITHOUT a primary (unknown-field skip) — envelope junk
      v1Payload, // a v1 record under the v2 prefix (proto decode dies)
    ]) {
      const text = INVITE_V2_PREFIX + junk
      expect(parseV2(text), junk.slice(0, 12)).toEqual({ ok: false, reason: 'malformed-invite' })
      expect(verifyInvite(text, ctxWith(true))).toEqual({ ok: false, reason: 'malformed-invite' })
    }
    // The WB-1 rule DIRECTLY (not via the verifyInvite dispatch): parseInvite
    // stays pure-v1 — a VALID v2 bundle is rejected by prefix as
    // `malformed-invite`, never parsed, never corruption.
    expect(parseInvite(mintV2({ primary: signedAt() }))).toEqual({
      ok: false,
      reason: 'malformed-invite',
    })
  })

  it('OVER_LENGTH: cap pinned at the at-cap boundary with REAL bundles, both codecs', () => {
    // Mint a zero-candidate invite whose rendered text is EXACTLY at the cap
    // (a junk-base64 string cannot distinguish cap from decode failure).
    let atCap = ''
    for (let n = 1; n <= 3500; n++) {
      try {
        const padded = mintV2({
          primary: signedAt({ multiaddrs: ['/ip6/2001:db8:c0a8:10a::/tcp/4001', 'x'.repeat(n)] }),
        })
        if (padded.length === MAX_INVITE_TEXT_LEN) {
          atCap = padded
          break
        }
      } catch {
        break // over the cap — lengths only grow with n
      }
    }
    expect(atCap.length, 'a real bundle mints to exactly MAX_INVITE_TEXT_LEN').toBe(
      MAX_INVITE_TEXT_LEN,
    )
    // At-cap ACCEPTS and the REAL bundle decodes (the check is `>`, not `>=`).
    expect(parseV2(atCap).ok).toBe(true)
    // One char past: refused BEFORE any decode.
    const over = atCap + 'A'
    expect(parseV2(over)).toEqual({ ok: false, reason: 'malformed-invite' })
    expect(verifyInvite(over, ctxWith(true))).toEqual({ ok: false, reason: 'malformed-invite' })
    // The v1 codec applies the same cap before decode.
    const v1Over = encodeInvite(signedAt()) + 'A'.repeat(MAX_INVITE_TEXT_LEN)
    expect(parseInvite(v1Over)).toEqual({ ok: false, reason: 'malformed-invite' })
  })

  it('MINT_CAP: mintV2 throws instead of minting text its own parser would reject', () => {
    const flooded = Array.from({ length: 30 }, (_, i) => ({
      address: `/ip6/2001:db8:b${i}::/tcp/4001/p2p/12D3KooRelay/p2p-circuit`,
      witnesses: [dummyWitness(i), dummyWitness(i + 100)],
    }))
    expect(() => mintV2({ primary: signedAt(), candidates: flooded })).toThrow(RangeError)
    // (No text is emitted on the throwing path — an un-redeemable invite can
    // never ship once 13.5 assembles candidates under this invariant.)
  })

  it('DIGESTS_UNTOUCHED: goldens pinned BEFORE the proto edit stay byte-stable', () => {
    const block: Block = {
      slot: 42n,
      parentHash: hexBytes('ab'.repeat(32)),
      winnerIdentityId: 'cd'.repeat(32),
      winnerTicket: hexBytes('ef'.repeat(24)),
      nonce: hexBytes('0102030405060708'),
      hash: new Uint8Array(32),
      txCount: 3n,
      announcements: [hexBytes('0a0b')],
    }
    // canonicalBlockBytes enumerates ONLY Block fields — the new messages are
    // unreachable from it (AD-6); golden sha256 computed pre-edit.
    expect(sha256Hex(canonicalBlockBytes(block))).toBe(
      'aa398b3b69e80981b4eef65dd1ccb11cb3dafe3c90fed8a91fc138b94a991548',
    )
    // peerAnnouncementDigest is hand-rolled (pinned 8.2 layout) — same story.
    const paFields: PeerAnnouncementFields = {
      identityId: 'ab'.repeat(32),
      multiaddrs: ['/ip6/2001:db8:c0a8:10a::/tcp/4001'],
      observedExternalAddr: '/ip6/2001:db8::1/tcp/4001',
      slotStart: 100,
      slotEnd: 200,
      chainId: 'succinctcoin-v1',
    }
    expect(sha256Hex(peerAnnouncementDigest(paFields))).toBe(
      '517e466e3d73a8c92b38b0b61339a5be6c7164fbe652888eb0f7669003409209',
    )
  })
})

// ---------------------------------------------------------------------------
// ticket 13.3 — the verification floor (WB-3): k-of-n distinct signers,
// slot expiry, /64 diversity. Witness fixtures are REAL: minted with
// issueWitness by additional derived keypairs (the floor verifies signatures).
// ---------------------------------------------------------------------------

const SIGNER_A = deriveIdentityKeypair(new Uint8Array(32).fill(0x71))
const SIGNER_B = deriveIdentityKeypair(new Uint8Array(32).fill(0x72))
const SIGNER_C = deriveIdentityKeypair(new Uint8Array(32).fill(0x73))

/** Candidate addresses: CAND_A and CAND_A2 share the /64 group (they differ
 * only after the fourth hextet); CAND_B brings its own group. */
const CAND_A = '/ip6/2001:db8:cafe:1::5/tcp/4001'
const CAND_A2 = '/ip6/2001:db8:cafe:1::9/tcp/4002'
const CAND_B = '/ip6/2001:db8:beef:9::7/tcp/4002'

/** A REAL signed witness (chainId pinned to the LIVE ctx; slots bigint). */
function witnessFor(
  signer: IdentityKeypair,
  over: Partial<{
    target: string
    address: string
    chainId: string
    firstSeenSlot: bigint
    expirySlot: bigint
  }> = {},
): InviteWitnessInput {
  return issueWitness(signer, {
    targetIdentityId: over.target ?? KEYPAIR.identityId,
    address: over.address ?? CAND_A,
    chainId: over.chainId ?? 'succinctcoin-v1',
    firstSeenSlot: over.firstSeenSlot ?? 0n,
    expirySlot: over.expirySlot ?? 5000n,
    signerIdentityId: signer.identityId,
  })
}

/** Flip one signature byte (a forgery that keeps length and shape). */
function forge(w: InviteWitnessInput): InviteWitnessInput {
  const signature = Uint8Array.from(w.signature)
  signature[0] = (signature[0] ?? 0) ^ 0xff
  return { ...w, signature }
}

/** Verify a minted bundle, unwrapping the ok arm (floor rows live there). */
function floorVerdicts(text: string, ctx?: InviteContext) {
  const result = verifyInvite(text, ctx ?? ctxWith(true))
  expect(result.ok).toBe(true)
  if (!result.ok) return undefined
  return result.candidates
}

describe('13.3 — verification floor', () => {
  it('FLOOR_MINIMAL: one candidate, two distinct signers, global v6 ⇒ accepted; zero-candidate keeps the v1 shape', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [{ address: CAND_A, witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_B)] }],
    })
    expect(floorVerdicts(text)).toEqual([{ address: CAND_A, accepted: true, signers: 2 }])
  })

  it('FLOOR_TWO_SIXTYFOURS: two k-valid candidates in distinct /64 groups ⇒ both accepted (spec minimal-valid)', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        { address: CAND_A, witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_B)] },
        {
          address: CAND_B,
          witnesses: [
            witnessFor(SIGNER_A, { address: CAND_B }),
            witnessFor(SIGNER_C, { address: CAND_B }),
          ],
        },
      ],
    })
    const verdicts = floorVerdicts(text)
    expect(verdicts).toEqual([
      { address: CAND_A, accepted: true, signers: 2 },
      { address: CAND_B, accepted: true, signers: 2 },
    ])
    expect(verdicts?.every((v) => v.reason === undefined)).toBe(true)
  })

  it('FLOOR_SAME_64_CLUSTER: second k-valid candidate in an ACCEPTED group is address-not-diverse; bundle stays ok', () => {
    const cluster = mintV2({
      primary: signedAt(),
      candidates: [
        { address: CAND_A, witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_B)] },
        {
          address: CAND_A2,
          witnesses: [
            witnessFor(SIGNER_A, { address: CAND_A2 }),
            witnessFor(SIGNER_C, { address: CAND_A2 }),
          ],
        },
      ],
    })
    expect(floorVerdicts(cluster)).toEqual([
      { address: CAND_A, accepted: true, signers: 2 },
      { address: CAND_A2, accepted: false, signers: 2, reason: 'address-not-diverse' },
    ])
    // Bundle ORDER decides who keeps the group — flipping the order flips the
    // verdicts (the floor marks groups only on ACCEPTED candidates).
    const flipped = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: CAND_A2,
          witnesses: [
            witnessFor(SIGNER_A, { address: CAND_A2 }),
            witnessFor(SIGNER_C, { address: CAND_A2 }),
          ],
        },
        { address: CAND_A, witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_B)] },
      ],
    })
    expect(floorVerdicts(flipped)).toEqual([
      { address: CAND_A2, accepted: true, signers: 2 },
      { address: CAND_A, accepted: false, signers: 2, reason: 'address-not-diverse' },
    ])
    // A REJECTED candidate never marks its group (a later one may still land).
    const sharesAfterReject = mintV2({
      primary: signedAt(),
      candidates: [
        { address: CAND_A, witnesses: [witnessFor(SIGNER_A)] }, // insufficient ⇒ no mark
        {
          address: CAND_A2,
          witnesses: [
            witnessFor(SIGNER_B, { address: CAND_A2 }),
            witnessFor(SIGNER_C, { address: CAND_A2 }),
          ],
        },
      ],
    })
    expect(floorVerdicts(sharesAfterReject)).toEqual([
      { address: CAND_A, accepted: false, signers: 1, reason: 'insufficient-signers' },
      { address: CAND_A2, accepted: true, signers: 2 },
    ])
  })

  it('FLOOR_NO_WITNESSES / FLOOR_SINGLE_WITNESS: zero witnesses skip no-witnesses, one skips insufficient-signers', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        { address: CAND_A, witnesses: [] },
        { address: CAND_B }, // witnesses field omitted — same verdict
        { address: '/ip6/2001:db8:c0dd:a::/tcp/4001', witnesses: [witnessFor(SIGNER_A, { address: '/ip6/2001:db8:c0dd:a::/tcp/4001' })] },
      ],
    })
    expect(floorVerdicts(text)).toEqual([
      { address: CAND_A, accepted: false, signers: 0, reason: 'no-witnesses' },
      { address: CAND_B, accepted: false, signers: 0, reason: 'no-witnesses' },
      {
        address: '/ip6/2001:db8:c0dd:a::/tcp/4001',
        accepted: false,
        signers: 1,
        reason: 'insufficient-signers',
      },
    ])
  })

  it('FLOOR_DUP_SIGNER: two valid witnesses from ONE signer count once ⇒ insufficient-signers', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: CAND_A,
          witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_A, { expirySlot: 4000n })],
        },
      ],
    })
    expect(floorVerdicts(text)).toEqual([
      { address: CAND_A, accepted: false, signers: 1, reason: 'insufficient-signers' },
    ])
  })

  it('FLOOR_SELF_WITNESS: the primary attesting itself never counts toward k', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: CAND_A,
          witnesses: [witnessFor(SIGNER_A), witnessFor(KEYPAIR /* self-attestation */)],
        },
      ],
    })
    expect(floorVerdicts(text)).toEqual([
      { address: CAND_A, accepted: false, signers: 1, reason: 'insufficient-signers' },
    ])
  })

  it('FLOOR_EXPIRY_BOUNDARY: half-open [firstSeen, expiry) — firstSeen==current and expiry−1 count; expiry==current does not', () => {
    // currentSlot = 150 in the LIVE ctx.
    const counts = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: CAND_A,
          witnesses: [
            witnessFor(SIGNER_A, { firstSeenSlot: 150n }), // inclusive start counts
            witnessFor(SIGNER_B, { expirySlot: 151n }), // expiry−1 = 150 still live
          ],
        },
      ],
    })
    expect(floorVerdicts(counts)).toEqual([{ address: CAND_A, accepted: true, signers: 2 }])

    const expired = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: CAND_A,
          witnesses: [
            witnessFor(SIGNER_A, { expirySlot: 150n }), // current >= expiry ⇒ dead
            witnessFor(SIGNER_B),
          ],
        },
      ],
    })
    expect(floorVerdicts(expired)).toEqual([
      { address: CAND_A, accepted: false, signers: 1, reason: 'insufficient-signers' },
    ])
  })

  it('FLOOR_MIXED_GOOD: forged / wrong-target / wrong-address / other-chain witnesses are skipped, never fatal — 2 good carry the candidate', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: CAND_A,
          witnesses: [
            witnessFor(SIGNER_A),
            witnessFor(SIGNER_B),
            forge(witnessFor(SIGNER_C)), // bad-signature
            witnessFor(SIGNER_C, { target: OTHER.identityId }), // attests another peer
            witnessFor(SIGNER_C, { address: CAND_B }), // attests another address
            witnessFor(SIGNER_C, { chainId: 'succinctcoin-mainnet-1' }), // chain-mismatch
          ],
        },
      ],
    })
    expect(floorVerdicts(text)).toEqual([{ address: CAND_A, accepted: true, signers: 2 }])
  })

  it('FLOOR_STRICT_SIGNERS: signer tickets engage ONLY under chainHasBlocks — soft accepts, strict skips, ticketed accepts', () => {
    const asked: Array<[string, bigint]> = []
    const winners = new Set<string>()
    const probe = (id: string, since: bigint): boolean => {
      asked.push([id, since])
      return id === KEYPAIR.identityId || winners.has(id) // primary always live
    }
    const bundle = mintV2({
      primary: signedAt(),
      candidates: [{ address: CAND_A, witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_B)] }],
    })

    // Soft side (flag absent): signers are never ticket-gated.
    asked.length = 0
    expect(floorVerdicts(bundle, ctxWith(probe))).toEqual([
      { address: CAND_A, accepted: true, signers: 2 },
    ])
    expect(asked).toEqual([[KEYPAIR.identityId, 118n]]) // primary gate only

    // Strict side: ticket-less signers do not count — and they are asked with
    // the SAME window as the primary's gate (currentSlot − lookback = 118).
    asked.length = 0
    expect(floorVerdicts(bundle, ctxWith(probe, { chainHasBlocks: true }))).toEqual([
      { address: CAND_A, accepted: false, signers: 0, reason: 'insufficient-signers' },
    ])
    expect(asked).toEqual([
      [KEYPAIR.identityId, 118n],
      [SIGNER_A.identityId, 118n],
      [SIGNER_B.identityId, 118n],
    ])

    // Strict + ticketed signers: accepted.
    winners.add(SIGNER_A.identityId)
    winners.add(SIGNER_B.identityId)
    expect(floorVerdicts(bundle, ctxWith(probe, { chainHasBlocks: true }))).toEqual([
      { address: CAND_A, accepted: true, signers: 2 },
    ])
  })

  it('FLOOR_UNSUPPORTED_ADDR: v4 hops and non-global (junk/ULA) candidate hops are address-unsupported even with k witnesses', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: '/ip4/203.0.113.7/tcp/4001',
          witnesses: [
            witnessFor(SIGNER_A, { address: '/ip4/203.0.113.7/tcp/4001' }),
            witnessFor(SIGNER_B, { address: '/ip4/203.0.113.7/tcp/4001' }),
          ],
        },
        {
          address: '/ip6/fd00::1/tcp/4001', // ULA — hopNetworkKey null
          witnesses: [
            witnessFor(SIGNER_A, { address: '/ip6/fd00::1/tcp/4001' }),
            witnessFor(SIGNER_B, { address: '/ip6/fd00::1/tcp/4001' }),
          ],
        },
      ],
    })
    expect(floorVerdicts(text)).toEqual([
      { address: '/ip4/203.0.113.7/tcp/4001', accepted: false, signers: 2, reason: 'address-unsupported' },
      { address: '/ip6/fd00::1/tcp/4001', accepted: false, signers: 2, reason: 'address-unsupported' },
    ])
  })

  it('FLOOR_DEV_LOOPBACK: under the pinned dev flag loopback-family candidates are accepted (still k-gated) and diversity-exempt; without it unsupported', () => {
    const had = process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
    const bundle = mintV2({
      primary: signedAt(),
      candidates: [
        {
          address: '/ip6/::1/tcp/4001',
          witnesses: [
            witnessFor(SIGNER_A, { address: '/ip6/::1/tcp/4001' }),
            witnessFor(SIGNER_B, { address: '/ip6/::1/tcp/4001' }),
          ],
        },
        {
          address: '/ip4/127.0.0.1/tcp/4002', // second loopback — exempt ⇒ accepted too
          witnesses: [
            witnessFor(SIGNER_A, { address: '/ip4/127.0.0.1/tcp/4002' }),
            witnessFor(SIGNER_B, { address: '/ip4/127.0.0.1/tcp/4002' }),
          ],
        },
        { address: '/ip6/::1/tcp/4003', witnesses: [witnessFor(SIGNER_A, { address: '/ip6/::1/tcp/4003' })] }, // still k-gated
      ],
    })
    try {
      process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = '1'
      expect(floorVerdicts(bundle)).toEqual([
        { address: '/ip6/::1/tcp/4001', accepted: true, signers: 2 },
        { address: '/ip4/127.0.0.1/tcp/4002', accepted: true, signers: 2 },
        { address: '/ip6/::1/tcp/4003', accepted: false, signers: 1, reason: 'insufficient-signers' },
      ])
    } finally {
      if (had === undefined) delete process.env.SUCCINCTCOIN_ALLOW_LOOPBACK
      else process.env.SUCCINCTCOIN_ALLOW_LOOPBACK = had
    }
    // Without the flag the same bundle rejects both loopbacks as unsupported.
    expect(floorVerdicts(bundle)).toEqual([
      { address: '/ip6/::1/tcp/4001', accepted: false, signers: 2, reason: 'address-unsupported' },
      { address: '/ip4/127.0.0.1/tcp/4002', accepted: false, signers: 2, reason: 'address-unsupported' },
      { address: '/ip6/::1/tcp/4003', accepted: false, signers: 1, reason: 'insufficient-signers' },
    ])
  })

  it('FLOOR_SKIPPED_NOT_FATAL: a bundle whose EVERY candidate is skipped still verifies — verdicts ride the ok arm, no reject', () => {
    const text = mintV2({
      primary: signedAt(),
      candidates: [
        { address: CAND_A, witnesses: [dummyWitness(1)] }, // shape-only witness ⇒ bad signature
        { address: CAND_B },
      ],
    })
    const result = verifyInvite(text, ctxWith(true))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.identityId).toBe(KEYPAIR.identityId) // primary ingests as always
    expect(result.candidates).toEqual([
      { address: CAND_A, accepted: false, signers: 0, reason: 'insufficient-signers' },
      { address: CAND_B, accepted: false, signers: 0, reason: 'no-witnesses' },
    ])
  })

  it('FLOOR_DEAD_PRIMARY: a failing primary kills the WHOLE bundle despite perfect witnesses — candidates never gate-rescue', () => {
    const perfect = [
      { address: CAND_A, witnesses: [witnessFor(SIGNER_A), witnessFor(SIGNER_B)] },
    ]
    // Gate 2 (freshness): expired primary dies with the VERBATIM validator reason.
    expect(
      verifyInvite(mintV2({ primary: signedAt({ slotEnd: 120 }), candidates: perfect }), ctxWith(true)),
    ).toEqual({ ok: false, reason: 'expired' })
    // Gate 3 (liveness): ticket-less primary dies no-recent-ticket.
    expect(verifyInvite(mintV2({ primary: signedAt(), candidates: perfect }), ctxWith(false))).toEqual(
      { ok: false, reason: 'no-recent-ticket' },
    )
    // Gate 1 (signature): a forged primary dies bad-signature — witnesses are
    // never even looked at.
    const forged = { ...fieldsAt(), signature: signPeerAnnouncement(OTHER, fieldsAt()) }
    expect(
      verifyInvite(
        mintV2({ primary: forged as SignedPeerAnnouncement, candidates: perfect }),
        ctxWith(true),
      ),
    ).toEqual({ ok: false, reason: 'bad-signature' })
  })
})
