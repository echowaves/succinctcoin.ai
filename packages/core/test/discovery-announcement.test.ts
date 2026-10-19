/**
 * discovery-announcement.test.ts — ticket 8.2 matrix (CAP-7 contract slice).
 * The signed PeerAnnouncement: wire round-trip, the PINNED AD-12 digest
 * (golden vector), sign/verify per the identity.ts conventions, and the PURE
 * validator's pinned reject reasons. Freshness uses ONLY the caller-supplied
 * slot; verification reconstructs keys from public data (D2).
 *
 *   WIRE_ROUND_TRIP        encode → decode keeps every field (protons codec,
 *                          incl. the optional observedExternalAddr).
 *   GOLDEN_DIGEST_SIG      digest + signature pinned byte-exact for a fixed
 *                          seed keypair (deterministic per RFC 8032).
 *   VALID_OK               valid record, covering slot, matching chain → {ok:true}.
 *   BAD_SIGNATURE          flipped sig bit / wrong-key sig → 'bad-signature'.
 *   EXPIRED / NOT_YET_VALID / CHAIN_MISMATCH  each pinned reason.
 *   SIG_BEFORE_EXPIRY      expired AND forged → 'bad-signature' (pinned cost order).
 *   ORDER_CANONICAL        wire-list reorder verifies (digest sorts addrs).
 *   SHAPE_ROWS             empty/>8/dup/no-slash/whitespace multiaddrs, bad
 *                          observed addr, slotEnd<start / non-integer slots,
 *                          long chainId, short sig, bad identity → pinned reasons.
 *   JUNK_NEVER_THROWS      hostile values (null, arrays, nested junk) all
 *                          return {ok:false} — never a throw.
 *   MODULE_PURE            comment-stripped source: no Date / setTimeout /
 *                          performance / net imports (AD-3/AD-10 purity).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PeerAnnouncement,
  deriveIdentityKeypair,
  peerAnnouncementDigest,
  signPeerAnnouncement,
  validatePeerAnnouncement,
} from '../src/index.js'
import type { AnnouncementContext, PeerAnnouncementFields } from '../src/index.js'

// ---------------------------------------------------------------------------
// fixtures — deterministic keypairs (no RNG anywhere, AD-3)
// ---------------------------------------------------------------------------

const KEYPAIR = deriveIdentityKeypair(
  Uint8Array.from({ length: 32 }, (_, i) => (0xa1 + i) % 256),
)
const OTHER = deriveIdentityKeypair(new Uint8Array(32).fill(0xbb))

const CTX: AnnouncementContext = { currentSlot: 150, expectedChainId: 'succinctcoin-v1' }

function fieldsAt(over: Partial<PeerAnnouncementFields> = {}): PeerAnnouncementFields {
  return {
    identityId: KEYPAIR.identityId,
    multiaddrs: ['/ip6/2001:db8:c0a8:10a::/tcp/4001', '/ip6/2001:db8:a00:5::/tcp/4001'],
    observedExternalAddr: '/ip6/2001:db8:cb00:7107::/tcp/4001',
    slotStart: 100,
    slotEnd: 200,
    chainId: 'succinctcoin-v1',
    ...over,
  }
}

function signedAt(over: Partial<PeerAnnouncementFields> = {}) {
  const fields = fieldsAt(over)
  return { ...fields, signature: signPeerAnnouncement(KEYPAIR, fields) }
}

// ---------------------------------------------------------------------------

describe('8.2 — PeerAnnouncement wire + digest contract', () => {
  it('WIRE_ROUND_TRIP: encode → decode preserves every field incl. the optional addr', () => {
    const record = signedAt()
    // The generated codec takes the proto Input shape (int64 = bigint —
    // the repo-wide convention, cf. `Block.slot: bigint`).
    const bytes = PeerAnnouncement.encode({
      ...record,
      slotStart: BigInt(record.slotStart),
      slotEnd: BigInt(record.slotEnd),
    })
    const back = PeerAnnouncement.decode(bytes)

    expect(back.identityId).toBe(record.identityId)
    expect(back.multiaddrs).toEqual(record.multiaddrs)
    expect(back.observedExternalAddr).toBe(record.observedExternalAddr)
    // protons decodes proto int64 as bigint — the contract accepts it.
    expect(back.slotStart).toBe(BigInt(record.slotStart))
    expect(back.slotEnd).toBe(BigInt(record.slotEnd))
    expect(back.chainId).toBe(record.chainId)
    expect(Buffer.from(back.signature).equals(Buffer.from(record.signature))).toBe(true)

    // The optional field is really optional on the wire.
    const lanOnly = signedAt({ observedExternalAddr: undefined })
    const backLan = PeerAnnouncement.decode(
      PeerAnnouncement.encode({
        ...lanOnly,
        slotStart: BigInt(lanOnly.slotStart),
        slotEnd: BigInt(lanOnly.slotEnd),
      }),
    )
    expect(backLan.observedExternalAddr).toBeUndefined()

    // THE 8.3 PATH: a wire-decoded record (bigint slots, Buffer signature)
    // validates end-to-end with no adapter layer.
    expect(validatePeerAnnouncement(back, CTX)).toEqual({ ok: true })
  })

  it('GOLDEN_DIGEST_SIG: digest + signature are byte-pinned (domain-separated AD-12 layout)', () => {
    // Pinned at build (2026-10-18) from seed (0xa1+i)%256, addrs
    // [/ip6/2001:db8:c0a8:10a::/tcp/4001, /ip6/2001:db8:a00:5::/tcp/4001], observed
    // /ip6/2001:db8:cb00:7107::/tcp/4001, slots 100..200, chain succinctcoin-v1.
    expect(KEYPAIR.identityId).toBe(
      '0b47823e71095dd59be78ac271c576ef389f87b64561ab07cf9a4ebcd02d2041',
    )
    const digest = peerAnnouncementDigest(fieldsAt())
    expect(Buffer.from(digest).toString('hex')).toBe(
      'c0bc953e9aa6b00f07760ad1c606e2e8dda88329388d95ba3eb8ded0734e93f0',
    )
    const sig = signPeerAnnouncement(KEYPAIR, fieldsAt())
    expect(Buffer.from(sig).toString('hex')).toBe(
      '9018a638235f5b7a78ba7befec26c6c1b91503adffe239f4e815a60028a510a8' +
        '687ae3a833f72fa1d3b3dec94bdcb1a70119193d91594b0a4f7316ff3c3a3503',
    )
  })

  it('VALID_OK: covering slot + matching chain + honest signature validates', () => {
    expect(validatePeerAnnouncement(signedAt(), CTX)).toEqual({ ok: true })
    // Boundary slots are inclusive.
    expect(validatePeerAnnouncement(signedAt(), { ...CTX, currentSlot: 100 })).toEqual({ ok: true })
    expect(validatePeerAnnouncement(signedAt(), { ...CTX, currentSlot: 200 })).toEqual({ ok: true })
    // A LAN-only record (no observed addr) is valid too.
    expect(
      validatePeerAnnouncement(signedAt({ observedExternalAddr: undefined }), CTX),
    ).toEqual({ ok: true })
    // A full-form textual address validates (under the 160-char shape bound,
    // parses, and passes the IPv6-only policy).
    expect(
      validatePeerAnnouncement(
        signedAt({ multiaddrs: ['/ip6/2001:0db8:85a3:0000:0000:8a2e:0370:7334/tcp/65535'] }),
        CTX,
      ),
    ).toEqual({ ok: true })
  })

  it('BAD_SIGNATURE: a flipped bit or another key signing the fields both reject', () => {
    const record = signedAt()
    const flipped = new Uint8Array(record.signature)
    flipped[0] = flipped[0] ^ 0x01
    expect(validatePeerAnnouncement({ ...record, signature: flipped }, CTX)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })

    const forgedFields = fieldsAt({ slotEnd: 999_999 })
    const wrongKeySig = signPeerAnnouncement(OTHER, {
      ...forgedFields,
      identityId: OTHER.identityId,
    })
    expect(
      validatePeerAnnouncement({ ...forgedFields, signature: wrongKeySig }, CTX),
    ).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('EXPIRED / NOT_YET_VALID: freshness judged ONLY against the supplied slot', () => {
    const record = signedAt()
    expect(validatePeerAnnouncement(record, { ...CTX, currentSlot: 201 })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(validatePeerAnnouncement(record, { ...CTX, currentSlot: 99 })).toEqual({
      ok: false,
      reason: 'not-yet-valid',
    })
  })

  it('CHAIN_MISMATCH: another network\'s honestly-signed record never enters the book', () => {
    const foreign = { ...signedAt(), chainId: 'succinctcoin-mainnet-1' }
    // Re-sign honestly under the foreign chain id — still rejected by scope.
    const reSigned = {
      ...foreign,
      signature: signPeerAnnouncement(KEYPAIR, fieldsAt({ chainId: 'succinctcoin-mainnet-1' })),
    }
    expect(validatePeerAnnouncement(reSigned, CTX)).toEqual({
      ok: false,
      reason: 'chain-mismatch',
    })
  })

  it('SIG_BEFORE_EXPIRY: expired AND forged reports bad-signature (pinned cost order)', () => {
    const record = signedAt()
    expect(
      validatePeerAnnouncement({ ...record, signature: new Uint8Array(64) }, {
        ...CTX,
        currentSlot: 500,
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('ORDER_CANONICAL: reordering the wire multiaddrs still verifies (sorted digest)', () => {
    const fields = fieldsAt({
      multiaddrs: ['/ip6/2001:db8:a00:5::/tcp/4001', '/ip6/2001:db8:c0a8:10a::/tcp/4001'],
    })
    const sig = signPeerAnnouncement(KEYPAIR, fieldsAt()) // signed over the OTHER order
    expect(validatePeerAnnouncement({ ...fields, signature: sig }, CTX)).toEqual({ ok: true })
  })

  it('SHAPE_ROWS: every malformed shape returns its pinned reason', () => {
    const rows: Array<[string, unknown, string]> = [
      ['empty multiaddrs', signedAt({ multiaddrs: [] }), 'malformed-multiaddr'],
      [
        'too many multiaddrs',
        signedAt({
          multiaddrs: Array.from({ length: 9 }, (_, i) => `/ip6/2001:db8:${i.toString(16)}::/tcp/1`),
        }),
        'too-many-multiaddrs',
      ],
      [
        'duplicate multiaddrs',
        signedAt({ multiaddrs: ['/ip6/2001:db8:102:304::/tcp/1', '/ip6/2001:db8:102:304::/tcp/1'] }),
        'malformed-multiaddr',
      ],
      ['no-slash entry', signedAt({ multiaddrs: ['example.com:4001'] }), 'malformed-multiaddr'],
      ['whitespace entry', signedAt({ multiaddrs: ['/ip6/2001:db8:102:304:: /tcp/1'] }), 'malformed-multiaddr'],
      [
        'observed addr malformed',
        signedAt({ observedExternalAddr: 'nope' }),
        'malformed-observed-addr',
      ],
      [
        'observed addr unparseable (shape passes, parse does not)',
        signedAt({ observedExternalAddr: '/no-such-proto/xyz' }),
        'malformed-observed-addr',
      ],
      // 9.1 IPv6-only policy: an OFF-HAND-CLEAN but off-policy address (honest
      // signature included) rejects with the new pinned reason.
      ['ipv4 address', signedAt({ multiaddrs: ['/ip4/10.0.0.1/tcp/1'] }), 'unsupported-address'],
      ['link-local v6', signedAt({ multiaddrs: ['/ip6/fe80::1/tcp/1'] }), 'unsupported-address'],
      [
        'observed addr ipv4',
        signedAt({ observedExternalAddr: '/ip4/1.2.3.4/tcp/9' }),
        'unsupported-address',
      ],
      // Slots are digest-bound, so malformed ones must be forged POST-signature
      // (that is exactly the untrusted-record case the validator owns).
      ['slotEnd < start', { ...signedAt(), slotStart: 200, slotEnd: 100 }, 'malformed-slot'],
      ['fractional slot', { ...signedAt(), slotStart: 1.5 }, 'malformed-slot'],
      [
        'unsafe slot',
        { ...signedAt(), slotEnd: Number.MAX_SAFE_INTEGER + 10 },
        'malformed-slot',
      ],
      ['long chainId', signedAt({ chainId: 'x'.repeat(65) }), 'malformed-chain-id'],
      ['short signature', { ...signedAt(), signature: new Uint8Array(63) }, 'malformed-signature'],
      [
        'memory signature',
        { ...signedAt(), signature: new ArrayBuffer(64) },
        'malformed-signature',
      ],
      // identityId is bound by the signer, so a bad one must be forged POST-signature.
      ['bad identityId', { ...signedAt(), identityId: 'g'.repeat(64) }, 'malformed-identity'],
      // The pinned 160-char boundary (matrix row): 161 chars rejected…
      [
        '161-char multiaddr',
        signedAt({ multiaddrs: [`/ip6/2001:db8::/tcp/${'9'.repeat(141)}`] }), // 20 + 141 = 161
        'malformed-multiaddr',
      ],
      [
        // Shape bound passes EXACTLY at 160; parseability is checked next and
        // this one does not parse (port overflow) — malformed, NOT off-policy.
        '160-char but unparseable (shape passes, parse does not)',
        signedAt({ multiaddrs: [`/ip6/2001:db8::/tcp/${'9'.repeat(140)}`] }), // 20 + 140 = 160
        'malformed-multiaddr',
      ],
      ['unparseable address', signedAt({ multiaddrs: ['/no-such-proto/xyz'] }), 'malformed-multiaddr'],
      // …and an honestly-signed empty observed addr is STILL a shape error —
      // "" is never a second spelling of "absent" (the digest binds it as present).
      ['empty observed addr', signedAt({ observedExternalAddr: '' }), 'malformed-observed-addr'],
    ]
    for (const [name, record, reason] of rows) {
      expect(validatePeerAnnouncement(record, CTX), name).toEqual({ ok: false, reason })
    }
  })

  it('JUNK_NEVER_THROWS: hostile decoded values reject with a reason, never a throw', () => {
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'announcement',
      [],
      {},
      { identityId: KEYPAIR.identityId },
      { identityId: 1, multiaddrs: {}, slotStart: 'x', signature: 'y' },
    ]
    for (const value of junk) {
      const result = validatePeerAnnouncement(value, CTX)
      expect(result.ok, JSON.stringify(value)).toBe(false)
    }
  })

  it('MODULE_PURE: no clock / timer / net surface in the validator module (AD-3/AD-10)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'discovery', 'announcements.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(src).not.toMatch(/\bDate\b/)
    expect(src).not.toMatch(/setTimeout|setInterval|performance\.now/)
    expect(src).not.toMatch(/node:(net|http|https|dgram|fs)|libp2p|createSocket/)
  })
})
