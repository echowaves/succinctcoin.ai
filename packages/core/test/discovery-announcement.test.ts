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
    multiaddrs: ['/ip4/192.168.1.10/tcp/4001', '/ip4/10.0.0.5/tcp/4001'],
    observedExternalAddr: '/ip4/203.0.113.7/tcp/4001',
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
    // [/ip4/192.168.1.10/tcp/4001, /ip4/10.0.0.5/tcp/4001], observed
    // /ip4/203.0.113.7/tcp/4001, slots 100..200, chain succinctcoin-v1.
    expect(KEYPAIR.identityId).toBe(
      '0b47823e71095dd59be78ac271c576ef389f87b64561ab07cf9a4ebcd02d2041',
    )
    const digest = peerAnnouncementDigest(fieldsAt())
    expect(Buffer.from(digest).toString('hex')).toBe(
      '5c7e132cd781de8ca4ee83781acf797234cc26c33b22aff476af588a01f56663',
    )
    const sig = signPeerAnnouncement(KEYPAIR, fieldsAt())
    expect(Buffer.from(sig).toString('hex')).toBe(
      '1638e77bf6418176b264548146547b0ced5b7e5f343bec9e2354ab4c6e49b3d1' +
        '5fc3a225b2872910de11bdedccc8be610d53fbdeb6112d6b3fd3793946e31a01',
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
    // Exactly 160 chars passes the shape bound.
    expect(
      validatePeerAnnouncement(
        signedAt({ multiaddrs: [`/ip4/1.2.3.4/tcp/${'9'.repeat(143)}`] }), // 17 + 143 = 160
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
      multiaddrs: ['/ip4/10.0.0.5/tcp/4001', '/ip4/192.168.1.10/tcp/4001'],
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
          multiaddrs: Array.from({ length: 9 }, (_, i) => `/ip4/10.0.0.${i}/tcp/1`),
        }),
        'too-many-multiaddrs',
      ],
      [
        'duplicate multiaddrs',
        signedAt({ multiaddrs: ['/ip4/1.2.3.4/tcp/1', '/ip4/1.2.3.4/tcp/1'] }),
        'malformed-multiaddr',
      ],
      ['no-slash entry', signedAt({ multiaddrs: ['example.com:4001'] }), 'malformed-multiaddr'],
      ['whitespace entry', signedAt({ multiaddrs: ['/ip4/1.2.3.4 /tcp/1'] }), 'malformed-multiaddr'],
      [
        'observed addr malformed',
        signedAt({ observedExternalAddr: 'nope' }),
        'malformed-observed-addr',
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
        signedAt({ multiaddrs: [`/ip4/1.2.3.4/tcp/${'9'.repeat(144)}`] }), // 17 + 144 = 161
        'malformed-multiaddr',
      ],
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
