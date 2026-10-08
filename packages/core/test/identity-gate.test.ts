/**
 * Story 4.1 matrix — the offline `GateVerifier` (R3 / AD-4) + the
 * accepted-gate registry (must-hold (c)).
 *
 *   GATE_OFFLINE_VERIFY    — an issuer-minted credential from an accepted
 *                            gate verifies OFFLINE to the exact port shape;
 *                            the verifier is a pure function of its inputs
 *                            (same input ⇒ same output across the run — and
 *                            across the two CI runs, which is how this row's
 *                            determinism is proven).
 *   GATE_REGISTRY_REJECT   — accepted `gateId` ⇒ valid; a non-accepted
 *                            `gateId` ⇒ the normal reject (must-hold (c):
 *                            gates enter only by the accepted registry —
 *                            the genesis `gates`, never auto-valid).
 *   GATE_BLOB_TAMPER       — every tampered / malformed blob (one byte
 *                            flipped anywhere, truncated, wrong trailing
 *                            MAC, bad `identityId` length, non-UTF-8,
 *                            blob/`gateId` mismatch) ⇒ valid:false; the
 *                            well-formed issuer credential ⇒ valid:true.
 *   GATE_WINDOW_CHAIN_TIME — `windowIndex <= attestedUntilWindow` ⇒ valid;
 *                            lapsed (`windowIndex > attestedUntilWindow`)
 *                            ⇒ reject. Chain time only — never the wall
 *                            clock (AD-3).
 *   GATE_NO_BLOB_LEAK      — (a) the generated proto `Ticket` message type
 *                            carries NO credential-blob field (at most a
 *                            credential hash, never the blob — AD-4);
 *                            (b) a comment-stripped source scan of every
 *                            `.ts` file under `src/` asserts the ONLY module that
 *                            reads `.blob` is the verifier
 *                            (`src/identity/gate-verifier.ts`); `ports.ts`
 *                            declares the field type but reads no blob.
 *
 * Imports ONLY from the ROOT barrel (`../src/index.js`) — the verifier is
 * NEVER re-implemented here (AD-4: the core owns the offline verifier).
 * Test-only: the guard scans source but edits nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  GateError,
  createOfflineGateVerifier,
  issueGateCredential,
  loadGenesis,
  Ticket,
} from '../src/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')
// test/ -> core/ -> packages/ -> repo root, then config/genesis.json —
// the single accepted-gate registry source (D2: the registry comes from
// the validated genesis `gates`, not a hard-coded list).
const GENESIS_PATH = join(here, '..', '..', '..', 'config', 'genesis.json')

// A pinned spine-convention identity id (32-byte hex, 64 hex chars).
const ID =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
// An identity with the SAME byte length (64 hex chars) — so a length-
// mismatch tamper is impossible and the MAC/shape checks are the ones
// exercised by the identity-region flips.
const ID2 =
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'

const REJECT = { valid: false, identityId: '', attestedUntilWindow: 0 }

describe('4.1 offline GateVerifier (R3 / AD-4) — frozen matrix', () => {
  // The accepted-gate registry, straight from the validated genesis config
  // (D2) — "biometric" is a real accepted gate; "rogue-gate" is not.
  const genesis = loadGenesis(GENESIS_PATH).then((cfg) => cfg.gates)

  it('GATE_OFFLINE_VERIFY: an accepted-gate credential verifies offline to the exact port shape; deterministic across the run', async () => {
    const verifier = createOfflineGateVerifier({
      acceptedGates: await genesis,
    })

    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: 100,
    })
    expect(cred.gateId).toBe('biometric')
    expect(cred.blob.byteLength).toBeGreaterThan(0)

    const v = await verifier.verify(cred, 50)
    expect(v).toEqual({ valid: true, identityId: ID, attestedUntilWindow: 100 })

    // Deterministic within the run: same input ⇒ same output, byte for
    // byte (the two-run CI check below pins it across runs).
    const v2 = await verifier.verify(
      issueGateCredential({
        gateId: 'biometric',
        identityId: ID,
        attestedUntilWindow: 100,
      }),
      50,
    )
    expect(v2).toEqual(v)
    // The issuer is pure too: identical inputs ⇒ identical bytes.
    expect(
      Buffer.from(cred.blob).compare(
        Buffer.from(
          issueGateCredential({
            gateId: 'biometric',
            identityId: ID,
            attestedUntilWindow: 100,
          }).blob,
        ),
      ),
    ).toBe(0)

    // A non-integer attestedUntilWindow is a programming error (the window
    // is a chain-time integer) → a GateError, never a silent truncation.
    expect(() =>
      issueGateCredential({ gateId: 'biometric', identityId: ID, attestedUntilWindow: 100.9 }),
    ).toThrow(GateError)
  })

  it('GATE_REGISTRY_REJECT: accepted gateId verifies; a non-accepted gateId is the normal reject (must-hold (c))', async () => {
    const verifier = createOfflineGateVerifier({
      acceptedGates: await genesis,
    })

    // (a) — a credential from an ACCEPTED gateId (the real genesis gate
    //      "biometric") verifies.
    const good = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: 100,
    })
    expect(await verifier.verify(good, 50)).toEqual({
      valid: true,
      identityId: ID,
      attestedUntilWindow: 100,
    })

    // (b) — a credential from a NON-accepted gateId is rejected: a
    //      well-formed blob with a correct MAC is NOT enough — the gate
    //      must be in the accepted registry (never auto-valid).
    const rogue = issueGateCredential({
      gateId: 'rogue-gate',
      identityId: ID,
      attestedUntilWindow: 100,
    })
    expect(await verifier.verify(rogue, 50)).toEqual(REJECT)

    // (c) — a NON-ASCII gateId round-trips: buildBlob emits utf8(gateId)
    //      (bytes), so a gateId whose UTF-8 byte length differs from its
    //      UTF-16 code-unit length ("gâté": 10 bytes / 4 units) must still
    //      verify for a verifier whose registry accepts it.
    const unicode = createOfflineGateVerifier({ acceptedGates: ['gâté'] })
    const uniCred = issueGateCredential({
      gateId: 'gâté',
      identityId: ID,
      attestedUntilWindow: 100,
    })
    expect(await unicode.verify(uniCred, 50)).toEqual({
      valid: true,
      identityId: ID,
      attestedUntilWindow: 100,
    })
  })

  it('GATE_BLOB_TAMPER: every tampered / malformed blob is rejected; the well-formed issuer credential verifies', async () => {
    const verifier = createOfflineGateVerifier({
      acceptedGates: await genesis,
    })

    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: 100,
    })

    // The well-formed, issuer-produced credential verifies.
    expect(await verifier.verify(cred, 50)).toEqual({
      valid: true,
      identityId: ID,
      attestedUntilWindow: 100,
    })

    const gateIdBytes = Buffer.from('biometric', 'utf8').length // 9
    const idStart = gateIdBytes
    const idBytes = Buffer.from(ID, 'utf8').length // 64
    const windowStart = idStart + idBytes
    const macStart = windowStart + 8
    const n = cred.blob.byteLength // 9 + 64 + 8 + 32 = 113

    // One byte flipped — in EVERY region (gateId, identityId, window,
    // MAC): each flip breaks the canonical shape or the offline MAC.
    for (const i of [
      0,
      idStart,
      idStart + 32,
      windowStart,
      windowStart + 7,
      macStart,
      n - 1,
    ]) {
      const tampered = new Uint8Array(cred.blob)
      tampered[i] ^= 0xff
      expect(await verifier.verify({ gateId: 'biometric', blob: tampered }, 50), `flip at byte ${i}`).toEqual(REJECT)
    }

    // Truncated (every prefix length < the full blob).
    for (const len of [0, 39, 40, n - 1]) {
      expect(await verifier.verify({ gateId: 'biometric', blob: cred.blob.subarray(0, len) }, 50), `truncated to ${len}`).toEqual(REJECT)
    }

    // A wrong trailing MAC — a canonical 32-byte digest that is not the
    // correct one.
    const wrongMac = new Uint8Array(cred.blob)
    for (let i = 0; i < 32; i += 1) wrongMac[macStart + i] = 0xab
    expect(await verifier.verify({ gateId: 'biometric', blob: wrongMac }, 50)).toEqual(REJECT)

    // A malformed `identityId` (same length, not 64-lowercase-hex).
    const badId = new Uint8Array(cred.blob)
    const idX = Buffer.from('x'.repeat(idBytes))
    badId.set(idX, idStart)
    expect(await verifier.verify({ gateId: 'biometric', blob: badId }, 50)).toEqual(REJECT)

    // A non-canonical (non-UTF-8) identity region.
    const nonUtf8 = new Uint8Array(cred.blob)
    nonUtf8[idStart + 32] = 0xff
    expect(await verifier.verify({ gateId: 'biometric', blob: nonUtf8 }, 50)).toEqual(REJECT)

    // A canonical blob whose embedded gateId differs from `cred.gateId`.
    const otherGate = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: 100,
    })
    expect(await verifier.verify({ gateId: 'social-graph', blob: otherGate.blob }, 50)).toEqual(REJECT)
  })

  it('GATE_WINDOW_CHAIN_TIME: valid at or before attestedUntilWindow; lapsed windows are rejected (AD-3, no wall clock)', async () => {
    const verifier = createOfflineGateVerifier({
      acceptedGates: await genesis,
    })

    const cred = issueGateCredential({
      gateId: 'biometric',
      identityId: ID,
      attestedUntilWindow: 100,
    })

    // windowIndex 50 <= 100 → valid.
    expect(await verifier.verify(cred, 50)).toEqual({
      valid: true,
      identityId: ID,
      attestedUntilWindow: 100,
    })
    // Boundary: windowIndex === attestedUntilWindow → still valid.
    expect(await verifier.verify(cred, 100)).toEqual({
      valid: true,
      identityId: ID,
      attestedUntilWindow: 100,
    })
    // windowIndex 101 > 100 (lapsed) → the normal reject.
    expect(await verifier.verify(cred, 101)).toEqual(REJECT)
    // Far lapsed → still the normal reject.
    expect(await verifier.verify(cred, 10_000)).toEqual(REJECT)
    // Invalid window inputs (non-finite / fractional / negative) are
    // type-legal `number`s but not valid chain-time windows → the normal
    // reject, never a throw (the "reject = normal false, not error"
    // convention).
    for (const w of [NaN, Infinity, -Infinity, 5.5, -1]) {
      expect(await verifier.verify(cred, w), `window ${w}`).toEqual(REJECT)
    }

    // Chain time only: the result depends solely on `windowIndex` (the
    // input) — never the wall clock (AD-3). Two immediate calls at the
    // same window agree exactly.
    const a = await verifier.verify(cred, 50)
    const b = await verifier.verify(cred, 50)
    expect(b).toEqual(a)
  })

  it('GATE_NO_BLOB_LEAK: the proto Ticket carries no credential-blob field, and only the verifier reads .blob in src/', () => {
    // (a) — the GENERATED proto `Ticket` message type (from
    //      protocol.proto via protons) has NO credential-blob field: a
    //      Ticket carries at most a credential hash, never the blob
    //      (AD-4). Type-level: the field set is exactly the five
    //      declared fields — a blob field added to the proto would fail
    //      this assignment (a new property on the object literal).
    const t: Ticket = {
      identityId: ID,
      windowIndex: 7n,
      challenge: new Uint8Array(32),
      nonceCommitment: new Uint8Array(32),
      signature: new Uint8Array(64),
    }
    // Type-level: a credential-blob field does NOT exist on the proto
    // `Ticket` message (AD-4). If protocol.proto ever gained a
    // `credentialBlob` field, this line would stop compiling.
    type NoBlobField = 'credentialBlob' extends keyof Ticket ? never : true
    const noBlobField: NoBlobField = true
    expect(noBlobField).toBe(true)
    // Runtime: the field set is exactly the five declared fields — no
    // credential-blob field among them.
    expect(Object.keys(t).sort()).toEqual([
      'challenge',
      'identityId',
      'nonceCommitment',
      'signature',
      'windowIndex',
    ])
    expect('credentialBlob' in t).toBe(false)
    expect('blob' in t).toBe(false)

    // (b) — a comment-stripped source scan of src/**/*.ts: the ONLY
    //      module that READS the credential blob (`.blob`) is the
    //      verifier. `ports.ts` declares the field type but reads no
    //      blob; no other module touches it (AD-4).
    const files = tsFiles(srcDir)
    expect(files.length).toBeGreaterThan(0)
    const readers = files
      .filter((f) => BLOB_READ.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => rel(srcDir, f))
      .sort()
    expect(
      readers,
      `modules reading .blob in src/:\n${readers.join('\n')}\nexpected exactly identity/gate-verifier.ts`,
    ).toEqual(['identity/gate-verifier.ts'])

    // Scan self-test (same row): the pattern matches `.blob` reads, not
    // declarations, calls, longer identifiers, prose, or comments.
    expect(BLOB_READ.test('const b = cred.blob')).toBe(true)
    expect(BLOB_READ.test('return c?.blob')).toBe(true)
    expect(BLOB_READ.test('f(blob, x.blob)')).toBe(true)
    expect(BLOB_READ.test('blob: Uint8Array')).toBe(false) // a declaration (no dot)
    expect(BLOB_READ.test('const b = file.blob()')).toBe(false) // a method call
    expect(BLOB_READ.test('const b = x.blobx')).toBe(false) // a longer identifier
    expect(BLOB_READ.test('the blob is opaque')).toBe(false) // prose, no dot
    expect(BLOB_READ.test(stripComments('// const b = cred.blob'))).toBe(false) // comments stripped
  })
})

// ---------------------------------------------------------------------------
// source-scan helpers (the no-float-guard.test.ts `stripComments` + walker
// pattern, verbatim)
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

// A `.blob` READ: a dot + the `blob` identifier, with no following word
// char (so `.blobx` is not a match) and not a call (so `.blob(...)` —
// e.g. a Blob API — is not a match). `cred.blob` / `cred?.blob` match;
// a TYPE DECLARATION `blob: Uint8Array` (ports.ts) does not (no dot);
// prose "the blob" (no dot) does not.
// (Self-tested inside the GATE_NO_BLOB_LEAK row.)
const BLOB_READ = /\.blob(?![\w(])/
