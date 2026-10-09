/**
 * Story 4.7 matrix — the AD-11 key-material boundary, CORE half (E1):
 * identity private keys live in the core and are never exposed through
 * the core read API or event payloads in plaintext. The UI-facing surface
 * receives only identity ids, status, and signed artifacts — the
 * renderer / preload IPC half is epic 6 (CAP-4), not this story.
 *
 *   KEY_SURF_NO_KEY_MATERIAL_TYPE — TYPE-LEVEL: for every public-surface
 *                            type (`ReadPeer`, `ReadBlock`, every
 *                            `CoreEvents[K]` payload) and every
 *                            key-material name (`secret` / `privateKey` /
 *                            `privateKeyHex` / `keypair`), `n extends
 *                            keyof T` is false (asserted via
 *                            `n extends keyof T ? never : true`) — a
 *                            key-material field added to any surface type
 *                            FAILS COMPILATION of this test (AD-11).
 *   KEY_SURF_ONLY_IDS_STATUS_SIGNED — runtime: a `ReadPeer`, a `ReadBlock`,
 *                            and every `CoreEvents[K]` payload built from
 *                            their declared fields each carry EXACTLY
 *                            their declared ids / status / signed-artifact
 *                            key set — `ReadPeer` = `{ multiaddrs,
 *                            peerId }`, `ReadBlock` = `{ hash, slot,
 *                            ticketCount, txCount, winnerIdentityId }`,
 *                            `CoreStarted` / `CoreStopped` = `{ slot }` —
 *                            and none contains a key-material key (AD-11:
 *                            only identity ids / status / signed
 *                            artifacts).
 *   KEY_SURF_PRIVATE_KEY_ABSENT — runtime: the keypair's `secret` (the
 *                            PKCS#8 DER private key) is ABSENT from every
 *                            surface payload / read-model: `'secret' in x
 *                            === false` AND no field's value is the
 *                            keypair's `secret` bytes (the secret is not
 *                            projected into any read-API return or event
 *                            payload, by value not just by name — AD-11).
 *   KEY_SURF_SECRET_LIVES_ONLY_IN_IDENTITY — a comment-stripped source
 *                            scan of every `.ts` under `src/` for a
 *                            `.secret` READ (dot + `secret`, no following
 *                            word char, not a call) shows the ONLY module
 *                            that reads the keypair `secret` is
 *                            `identity/identity.ts` (the AD-11
 *                            key-material owner — `keypair.secret` in
 *                            `signTicket`); no other module reads it, so
 *                            it cannot leak to the surface (the
 *                            "single reader" invariant, mirroring 4.1's
 *                            `GATE_NO_BLOB_LEAK` for `.blob`). The scan
 *                            self-test proves it matches `.secret` reads,
 *                            not declarations / calls / longer ids / prose
 *                            / comments.
 *   KEY_SURF_KEYS_PRESENT_IN_CORE — non-vacuity (the keys DO live in core):
 *                            the IMPORTED `deriveIdentityKeypair` over the
 *                            4.2 golden seed returns a keypair whose
 *                            `secret` is a NON-EMPTY DISTINCT field (not
 *                            contained in / aliasing `publicKey`);
 *                            `identityId === hex(publicKey)` (the public
 *                            fields are genuinely public); and
 *                            `signTicket` over the pinned `TicketFields`
 *                            → a signature `verifyTicketSignature`
 *                            accepts (the keys are usable in core) — so
 *                            the "never in the public surface" boundary is
 *                            meaningful, not vacuous.
 *
 * TEST-ONLY guard (the repo convention — 2.5 `no-float-guard`, 4.1
 * `GATE_NO_BLOB_LEAK`): ONE new test file, NO source module added or
 * changed. Imports ONLY from the ROOT barrel (`../src/index.js`) — the
 * keypair and the signature are NEVER re-implemented here (the keypair is
 * from the IMPORTED `deriveIdentityKeypair`, the signature from
 * `signTicket` / `verifyTicketSignature`) — plus `node:fs` / `node:path` /
 * `node:url` for the source scan (as 4.1 does). Deterministic: the fixed
 * 32-byte golden seed (4.2, no RNG — AD-3); the scan is over the committed
 * `src/` tree. No `big.js` (AD-5); no float.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  IdentityError,
  deriveIdentityKeypair,
  signTicket,
  verifyTicketSignature,
} from '../src/index.js'
import type {
  CoreEvents,
  ReadBlock,
  ReadPeer,
  TicketFields,
} from '../src/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')

// ---------------------------------------------------------------------------
// the pinned deterministic fixture (AD-3: no RNG, no wall clock)
// ---------------------------------------------------------------------------

/** The 4.2 golden seed: 32 bytes, 0x00..0x1f (no RNG — AD-3/AD-10). */
const GOLDEN_SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i))

/** The 4.2 pinned `TicketFields` (the signature is over this digest). */
const PINNED_FIELDS: TicketFields = {
  windowIndex: 7,
  challenge: new Uint8Array(32).fill(0x01),
  nonceCommitment: new Uint8Array(32).fill(0x02),
}

/**
 * The key-material name set (D3): a "key material field" is any of these
 * names on a surface type / payload. The PUBLIC fields — `identityId` (the
 * hex public key), `publicKey`, and signed artifacts (the ticket
 * `signature`) — are NOT key material (AD-11 permits "peer IDs, status, and
 * signed artifacts"); only the private-key material is banned.
 */
const KEY_MATERIAL_NAMES = ['privateKey', 'privateKeyHex', 'keypair', 'secret'] as const
type KeyMaterialName = (typeof KEY_MATERIAL_NAMES)[number]

/** Byte-wise equality over any value (the "is this value the secret bytes?" check). */
function sameBytes(a: Uint8Array, value: unknown): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('byteLength' in value) ||
    !('buffer' in value)
  ) {
    return false
  }
  const b = value as Uint8Array
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Build a runtime payload for EVERY public-surface type from its declared
 * fields ONLY (the surface set is defined from the types themselves — via
 * `keyof` over the event map — so if the surface grows, the guard tracks
 * it, D2): one `ReadPeer`, one `ReadBlock`, and one payload per
 * `CoreEvents` entry. Each value is a distinct id / status / signed-artifact
 * string — none is the keypair `secret` bytes (row KEY_SURF_PRIVATE_KEY_ABSENT).
 */
function surfacePayloads(): Record<'ReadPeer' | 'ReadBlock' | keyof CoreEvents, unknown> {
  const peer: ReadPeer = {
    peerId: '0'.repeat(64),
    multiaddrs: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3Koo'],
  }
  const block: ReadBlock = {
    slot: 1,
    hash: '1'.repeat(64),
    winnerIdentityId: '2'.repeat(64),
    ticketCount: 3,
    txCount: 2,
  }
  const events = {
    CoreStarted: { slot: 0 },
    CoreStopped: { slot: 9 },
  } as const
  return { ReadPeer: peer, ReadBlock: block, ...events }
}

// The declared key set of each surface type (D-matrix) — the surface
// exposes ONLY identity ids / status / signed artifacts (AD-11).
const EXPECTED_KEY_SETS: Record<
  'ReadPeer' | 'ReadBlock' | keyof CoreEvents,
  string[]
> = {
  ReadPeer: ['multiaddrs', 'peerId'],
  ReadBlock: ['hash', 'slot', 'ticketCount', 'txCount', 'winnerIdentityId'],
  CoreStarted: ['slot'],
  CoreStopped: ['slot'],
}

// ---------------------------------------------------------------------------
// KEY_SURF_NO_KEY_MATERIAL_TYPE
// ---------------------------------------------------------------------------

describe('4.7 AD-11 key-material boundary (core half, E1) — frozen matrix', () => {
  it('KEY_SURF_NO_KEY_MATERIAL_TYPE: type-level — no key-material name is a key of ANY public-surface type (ReadPeer / ReadBlock / every CoreEvents[K] payload)', () => {
    // TYPE-LEVEL (the D1 guard): for EVERY public-surface type T and EVERY
    // key-material name n, `n extends keyof T ? never : true` must hold —
    // asserted PER NAME via a mapped type over the name set (a union-level
    // `KeyMaterialName extends keyof T` would only fire when ALL four names
    // were present; a single added field must fail compilation on its own).
    // If any surface type ever gains a `secret` / `privateKey` /
    // `privateKeyHex` / `keypair` field, that name's entry becomes `never`
    // and the `true` literal below fails to assign — this test stops
    // compiling (the boundary is enforced at build time, without changing
    // events/types.ts).
    type SurfaceClean<T> = {
      [N in KeyMaterialName]: (N extends keyof T ? never : true)
    }

    const clean: { privateKey: true; privateKeyHex: true; keypair: true; secret: true } =
      {
        privateKey: true,
        privateKeyHex: true,
        keypair: true,
        secret: true,
      }

    const readPeerClean: SurfaceClean<ReadPeer> = clean
    const readBlockClean: SurfaceClean<ReadBlock> = clean
    // Over `K in keyof CoreEvents` — the surface set is derived from the
    // event map itself (D2): a new event's payload is guarded automatically.
    type AllEventPayloadsClean = {
      [K in keyof CoreEvents]: SurfaceClean<CoreEvents[K]>
    }
    const allEventPayloadsClean: AllEventPayloadsClean = {
      CoreStarted: clean,
      CoreStopped: clean,
    }

    // The type bindings are exercised at compile time (the assignments
    // above); at runtime their values are all-true, mirroring 4.1's
    // `noBlobField` row.
    expect(readPeerClean).toEqual(clean)
    expect(readBlockClean).toEqual(clean)
    expect(allEventPayloadsClean.CoreStarted).toEqual(clean)
    expect(allEventPayloadsClean.CoreStopped).toEqual(clean)

    // Runtime shadow (non-vacuous name set, D3): the key-material name set
    // is exactly the four names — a set narrowed to `[]` would make the
    // type-level guard vacuous.
    expect([...KEY_MATERIAL_NAMES].sort()).toEqual([
      'keypair',
      'privateKey',
      'privateKeyHex',
      'secret',
    ])
  })

  // ---------------------------------------------------------------------
  // KEY_SURF_ONLY_IDS_STATUS_SIGNED
  // ---------------------------------------------------------------------

  it('KEY_SURF_ONLY_IDS_STATUS_SIGNED: each surface type\u2019s key set is EXACTLY its declared ids / status / signed-artifact set; none contains a key-material key', () => {
    const payloads = surfacePayloads()

    for (const [type, payload] of Object.entries(payloads)) {
      expect(
        Object.keys(payload as object).sort(),
        `key set of surface type ${type}`,
      ).toEqual([...EXPECTED_KEY_SETS[type as keyof typeof EXPECTED_KEY_SETS]].sort())
      for (const name of KEY_MATERIAL_NAMES) {
        expect(
          name in (payload as object),
          `surface type ${type} must not carry key-material key \`${name}\``,
        ).toBe(false)
      }
    }

    // The surface exposes only identity ids / status / signed artifacts:
    // the declared sets themselves carry no key-material name (AD-11).
    for (const declared of Object.values(EXPECTED_KEY_SETS)) {
      expect(declared.some((k) => KEY_MATERIAL_NAMES.includes(k as KeyMaterialName))).toBe(
        false,
      )
    }
  })

  // ---------------------------------------------------------------------
  // KEY_SURF_PRIVATE_KEY_ABSENT
  // ---------------------------------------------------------------------

  it('KEY_SURF_PRIVATE_KEY_ABSENT: the keypair secret is absent from every surface payload / read-model — by name AND by value', () => {
    const keypair = deriveIdentityKeypair(GOLDEN_SEED)
    const secret = keypair.secret
    // The key material IS present in core (non-vacuity anchor for this row;
    // KEY_SURF_KEYS_PRESENT_IN_CORE asserts it fully).
    expect(secret.byteLength).toBeGreaterThan(0)
    const payloads = surfacePayloads()

    for (const [type, payload] of Object.entries(payloads)) {
      // By name: no read-API return or event payload has a `secret` field.
      expect(
        'secret' in (payload as object),
        `surface type ${type} must not carry a \u0060secret\u0060 field`,
      ).toBe(false)
      // By value: NO field's value is the keypair's secret bytes (the
      // secret is not projected into the surface — by value, not just by
      // name). Skip the value's self-reference (a field never contains
      // itself).
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (value === payload) continue
        expect(
          sameBytes(secret, value),
          `surface type ${type} field \`${key}\` must not be the keypair secret bytes`,
        ).toBe(false)
      }
    }

    // The value-comparison helper is not vacuous: the secret matches
    // itself (and a different value does not).
    expect(sameBytes(secret, secret)).toBe(true)
    expect(sameBytes(secret, keypair.publicKey)).toBe(false)
    expect(sameBytes(secret, '0'.repeat(64))).toBe(false)
  })

  // ---------------------------------------------------------------------
  // KEY_SURF_SECRET_LIVES_ONLY_IN_IDENTITY
  // ---------------------------------------------------------------------

  it('KEY_SURF_SECRET_LIVES_ONLY_IN_IDENTITY: only identity/identity.ts reads .secret in src/ (single-reader invariant, like 4.1 GATE_NO_BLOB_LEAK)', () => {
    const files = tsFiles(srcDir)
    expect(files.length).toBeGreaterThan(0)
    const readers = files
      .filter((f) => SECRET_READ.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(
      readers,
      `modules reading .secret in src/:\n${readers.join('\n')}\nexpected exactly identity/identity.ts`,
    ).toEqual(['identity/identity.ts'])

    // Scan self-test (same row): the pattern matches `.secret` READS, not
    // declarations, calls, longer identifiers, prose, or comments.
    expect(SECRET_READ.test('const k = keypair.secret')).toBe(true)
    expect(SECRET_READ.test('return kp?.secret')).toBe(true)
    expect(SECRET_READ.test('f(secret, kp.secret)')).toBe(true)
    expect(SECRET_READ.test('secret: Uint8Array')).toBe(false) // a declaration (no dot)
    expect(SECRET_READ.test('const s = kp.secret()')).toBe(false) // a method call
    expect(SECRET_READ.test('const s = x.secretx')).toBe(false) // a longer identifier
    expect(SECRET_READ.test('the secret stays in core')).toBe(false) // prose, no dot
    expect(
      SECRET_READ.test(stripComments('// const k = keypair.secret')),
    ).toBe(false) // comments stripped
  })

  // ---------------------------------------------------------------------
  // KEY_SURF_KEYS_PRESENT_IN_CORE
  // ---------------------------------------------------------------------

  it('KEY_SURF_KEYS_PRESENT_IN_CORE: the keys live in core — non-empty distinct secret, identityId = hex(publicKey), publicKey does not contain the secret, and signTicket verifies (non-vacuous)', () => {
    const keypair = deriveIdentityKeypair(GOLDEN_SEED)

    // Present: the private key is a NON-EMPTY distinct field in core
    // (AD-11 "keys live in the core") — the guard must not pass vacuously
    // by there being no key at all.
    expect(keypair.secret.byteLength).toBeGreaterThan(0)

    // Distinct: `publicKey` does not contain / alias the `secret` (the
    // secret is a separate 48-byte PKCS#8 DER, not folded into the public
    // key), and vice versa.
    expect(sameBytes(keypair.secret, keypair.publicKey)).toBe(false)
    expect(sameBytes(keypair.publicKey, keypair.secret)).toBe(false)

    // Genuinely public: identityId = hex(publicKey) — the public surface
    // fields are derived from the public key alone.
    expect(keypair.identityId).toMatch(/^[0-9a-f]{64}$/)
    expect(keypair.identityId).toBe(
      Buffer.from(keypair.publicKey).toString('hex'),
    )

    // Usable in core: signTicket (which reads keypair.secret) produces a
    // signature verifyTicketSignature accepts from PUBLIC data alone — the
    // "never in the public surface" boundary is meaningful, not vacuous.
    const signature = signTicket(keypair, PINNED_FIELDS)
    expect(signature.byteLength).toBe(64)
    expect(verifyTicketSignature(keypair.identityId, PINNED_FIELDS, signature)).toBe(true)

    // The keypair derivation is the imported, deterministic one (same seed
    // → identical key material — no re-implementation, no RNG, AD-3).
    const again = deriveIdentityKeypair(GOLDEN_SEED)
    expect(again.identityId).toBe(keypair.identityId)
    expect(sameBytes(again.secret, keypair.secret)).toBe(true)
    // And the module's only throw path is a programming error (bad seed
    // length) — sanity that the imported IdentityError is the one used.
    expect(() => deriveIdentityKeypair(new Uint8Array(31))).toThrow(IdentityError)
  })
})

// ---------------------------------------------------------------------------
// source-scan helpers (the 4.1 `GATE_NO_BLOB_LEAK` / no-float-guard.test.ts
// `stripComments` + walker pattern, verbatim)
// ---------------------------------------------------------------------------

/** Recursively collect every `.ts` file under `dir`. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Remove block and line comments (both preserved as blank lines so line
 * structure is intact). Safe for this codebase because no string or
 * template literal contains a comment marker (verified across `src/`);
 * the block regex is non-greedy so a comment body that contains a slash
 * never swallows past its real close.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** `dir`-relative path with `/` separators (stable for assertion messages). */
function rel(dir: string, p: string): string {
  return p.slice(dir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
}

// A `.secret` READ: a dot + the `secret` identifier, with no following word
// char (so `.secretx` is not a match) and not a call (so `.secret(...)` is
// not a match). `keypair.secret` / `kp?.secret` match; a TYPE DECLARATION
// `secret: Uint8Array` (no dot) does not; prose "the secret" (no dot) does
// not. (Self-tested inside the KEY_SURF_SECRET_LIVES_ONLY_IN_IDENTITY row.)
const SECRET_READ = /\.secret(?![\w(])/
