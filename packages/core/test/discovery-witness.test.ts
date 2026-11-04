/**
 * discovery-witness.test.ts — ticket 13.2 matrix (spec-scinvite-v2 WB-2).
 * The witness is "address Y of peer X was reachable for me", signed by the
 * witnessing identity; this suite pins the digest + domain separation, the
 * HALF-OPEN slot window with the chain → window → signature cost order, the
 * issuer's kill-switch / evidence / per-target-cap policy (a decline carries
 * NO witness bytes), and the store's verify-before-store freshness, eviction
 * and freshest-wins rules.
 *
 *   ISSUE_VERIFY_ROUNDTRIP  issue → verifyWitness ok; bigint slots intact;
 *                           signer = issuer identity; default expiry +96;
 *                           the record IS InviteWitnessInput-shaped.
 *   SIG_TAMPER              each of the five signed fields changed alone ⇒
 *                           bad-signature (the chainId row judges under a
 *                           ctx that MATCHES the forged chain — the gate
 *                           passes and the SIGNATURE is what rejects).
 *   WRONG_SIGNER            valid signature + swapped signerIdentityId ⇒
 *                           bad-signature (the pubkey IS the binding).
 *   CHAIN_MISMATCH_BEFORE_SIG  garbage sig + wrong chain ⇒ chain-mismatch.
 *   SLOT_WINDOW_BEFORE_SIG  expired witness + garbage sig ⇒ expired.
 *   EXPIRY_BOUNDARY         firstSeen−1 / firstSeen / expiry−1 / expiry ⇒
 *                           not-yet-valid / ok / ok / expired (half-open).
 *   ISSUANCE_DISABLED       enabled:false ⇒ issuance-disabled, signs nothing.
 *   NO_EVIDENCE             blank address / non-hex target ⇒ no-evidence.
 *   CAP_ROW                 8 ok then issuance-cap-reached; next window ok.
 *   DECLINE_YIELDS_NO_SIGNATURE  every decline is exactly {ok:false, reason}.
 *   STORE_ADD_GET_FRESH     verified witnesses enter; get filters by slot,
 *                           sorts, and copies signature bytes (copy-on-read).
 *   STORE_REJECTS_EXPIRED_ON_ADD  expired ⇒ refused `expired`; wrong-chain
 *                           refused `chain-mismatch`; nothing entered.
 *   STORE_EVICT             reads filter [expiry <= current]; pruneExpired
 *                           removes exactly those and returns the count.
 *   STORE_FRESHEST_KEPT     same (target, address, signer) — later expiry
 *                           replaces, earlier is a no-op; distinct signers
 *                           are DISTINCT rows.
 *   STORE_PER_TARGET_CAP    > MAX_WITNESSES_PER_TARGET for one target ⇒
 *                           oldest expiry evicted; the cap is per target.
 *   DIGEST_DOMAIN_PIN       domain constant pinned; witness digest ≠ the
 *                           announcement/introduction digests; signer NOT
 *                           in the bytes (signer-only difference ⇒ equal).
 *   MODULE_PURE             no Date / setTimeout / performance / net imports.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createWitnessIssuer,
  createWitnessStore,
  DEFAULT_WITNESS_EXPIRY_SLOTS,
  deriveIdentityKeypair,
  introductionDigest,
  issueWitness,
  MAX_ISSUANCES_PER_TARGET_WINDOW,
  MAX_WITNESSES_PER_TARGET,
  peerAnnouncementDigest,
  REACHABILITY_WITNESS_DOMAIN,
  verifyWitness,
  witnessDigest,
} from '../src/index.js'
import type {
  InviteWitnessInput,
  SignedWitness,
  WitnessFields,
  WitnessIssuer,
  WitnessIssuerOptions,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// fixtures — deterministic keypairs (no RNG anywhere, AD-3)
// ---------------------------------------------------------------------------

const KEYPAIR = deriveIdentityKeypair(
  Uint8Array.from({ length: 32 }, (_, i) => (0xc7 + i) % 256),
)
const OTHER = deriveIdentityKeypair(new Uint8Array(32).fill(0x5e))
const NOTARY = deriveIdentityKeypair(new Uint8Array(32).fill(0x2b))

const CHAIN = 'succinctcoin-v1'
const LIVE = { currentSlot: 150, expectedChainId: CHAIN } as const

const addr = (n: number): string => `/ip6/2001:db8:w${n}::/tcp/4001`
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

function mkIssuer(over: Partial<WitnessIssuerOptions> = {}): WitnessIssuer {
  return createWitnessIssuer({ keypair: KEYPAIR, expectedChainId: CHAIN, ...over })
}

/** Issue or fail — the happy path only; decline rows call `.issue` direct. */
function issueOk(issuer: WitnessIssuer, target: string, address: string, slot: number | bigint): SignedWitness {
  const r = issuer.issue({ targetIdentityId: target, address }, slot)
  if (!r.ok) throw new Error(`expected issuance, got ${r.reason}`)
  return r.witness
}

// ---------------------------------------------------------------------------

describe('13.2 — witness issuance + local witness store', () => {
  it('ISSUE_VERIFY_ROUNDTRIP: issue → verifyWitness; bigint slots, signer pinned, default expiry', () => {
    const issued = mkIssuer().issue({ targetIdentityId: OTHER.identityId, address: addr(1) }, 150)
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    const w = issued.witness
    expect(w.signerIdentityId).toBe(KEYPAIR.identityId) // signer := issuer identity
    expect(typeof w.firstSeenSlot).toBe('bigint')
    expect(typeof w.expirySlot).toBe('bigint')
    expect(w.firstSeenSlot).toBe(150n)
    expect(w.expirySlot).toBe(150n + BigInt(DEFAULT_WITNESS_EXPIRY_SLOTS))
    expect(w.chainId).toBe(CHAIN)
    expect(w.signature).toHaveLength(64)
    expect(verifyWitness(w, LIVE)).toEqual({ ok: true })
    // The 13.5 mint seam: the record structurally satisfies the v2 wire input.
    const asInput: InviteWitnessInput = w
    expect(asInput.targetIdentityId).toBe(OTHER.identityId)
  })

  it('SIG_TAMPER: changing ANY of the five signed fields alone ⇒ bad-signature', () => {
    const w = issueOk(mkIssuer(), OTHER.identityId, addr(1), 100) // [100, 196)
    const rows: Array<[string, WitnessFields]> = [
      ['targetIdentityId', { ...w, targetIdentityId: KEYPAIR.identityId }],
      ['address', { ...w, address: addr(42) }],
      // The chain row must reach the SIGNATURE, so judge it under a ctx that
      // MATCHES the forged chain — the gate passes, Ed25519 rejects.
      ['chainId', { ...w, chainId: 'succinctcoin-v2' }],
      ['firstSeenSlot', { ...w, firstSeenSlot: 101n }], // still <= current
      ['expirySlot', { ...w, expirySlot: 300n }], // still > current
    ]
    for (const [field, forged] of rows) {
      const ctx = field === 'chainId' ? { ...LIVE, expectedChainId: 'succinctcoin-v2' } : LIVE
      expect(verifyWitness(forged, ctx), field).toEqual({ ok: false, reason: 'bad-signature' })
    }
  })

  it('WRONG_SIGNER: the pubkey is the binding — a swapped signer id fails Ed25519', () => {
    const w = issueOk(mkIssuer(), OTHER.identityId, addr(1), 100)
    expect(verifyWitness({ ...w, signerIdentityId: NOTARY.identityId }, LIVE)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('CHAIN_MISMATCH_BEFORE_SIG: a garbage signature + wrong chain ⇒ chain-mismatch', () => {
    const w = issueOk(mkIssuer(), OTHER.identityId, addr(1), 100)
    const garbage = new Uint8Array(64).fill(0xab)
    expect(verifyWitness({ ...w, chainId: 'other-chain', signature: garbage }, LIVE)).toEqual({
      ok: false,
      reason: 'chain-mismatch',
    })
    // Control: the same garbage sig under the RIGHT chain reaches the sig.
    expect(verifyWitness({ ...w, signature: garbage }, LIVE)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('SLOT_WINDOW_BEFORE_SIG: an expired witness with a garbage sig ⇒ expired', () => {
    const w = issueOk(mkIssuer(), OTHER.identityId, addr(1), 100) // [100, 196)
    const garbage = new Uint8Array(64).fill(0xab)
    expect(verifyWitness({ ...w, expirySlot: 120n, signature: garbage }, LIVE)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('EXPIRY_BOUNDARY: half-open [firstSeen, expiry) on all four boundary slots', () => {
    const w = issueOk(mkIssuer(), OTHER.identityId, addr(1), 100) // [100, 196)
    expect(w.firstSeenSlot).toBe(100n)
    expect(w.expirySlot).toBe(196n)
    const at = (slot: number): string => {
      const r = verifyWitness(w, { ...LIVE, currentSlot: slot })
      return r.ok ? 'ok' : r.reason
    }
    expect(at(99)).toBe('not-yet-valid')
    expect(at(100)).toBe('ok')
    expect(at(195)).toBe('ok')
    expect(at(196)).toBe('expired') // half-open: expiry itself is already expired
  })

  it('ISSUANCE_DISABLED: the kill switch declines before any evidence or signature', () => {
    const r = mkIssuer({ enabled: false }).issue({ targetIdentityId: OTHER.identityId, address: addr(1) }, 150)
    expect(r).toEqual({ ok: false, reason: 'issuance-disabled' })
  })

  it('NO_EVIDENCE: blank address or non-hex target — evidence signs nothing', () => {
    const issuer = mkIssuer()
    const rows: Array<[string, string]> = [
      [OTHER.identityId, ''],
      [OTHER.identityId, '   '],
      ['nope', addr(1)],
      [KEYPAIR.identityId.toUpperCase(), addr(1)], // uppercase hex is not the id form
    ]
    for (const [targetIdentityId, address] of rows) {
      expect(issuer.issue({ targetIdentityId, address }, 150)).toEqual({
        ok: false,
        reason: 'no-evidence',
      })
    }
  })

  it('CAP_ROW: 8 per target per window, then decline; the next window issues again', () => {
    const issuer = mkIssuer()
    for (let i = 0; i < MAX_ISSUANCES_PER_TARGET_WINDOW; i += 1) {
      expect(issuer.issue({ targetIdentityId: OTHER.identityId, address: addr(i) }, 150).ok).toBe(true)
    }
    const capped = issuer.issue({ targetIdentityId: OTHER.identityId, address: addr(99) }, 150)
    expect(capped.ok ? 'ok' : capped.reason).toBe('issuance-cap-reached')

    // The counter is PER TARGET — another target in the same window issues.
    expect(issuer.issue({ targetIdentityId: NOTARY.identityId, address: addr(0) }, 150).ok).toBe(true)

    // Bucket = currentSlot / WITNESS_ISSUANCE_WINDOW_SLOTS (integer): slot
    // 150 lives in bucket 4 (128..159), so 160 is the next window — and it
    // issues again.
    expect(150n / 32n).toBe(4n)
    expect(issuer.issue({ targetIdentityId: OTHER.identityId, address: addr(99) }, 160).ok).toBe(true)
  })

  it('DECLINE_YIELDS_NO_SIGNATURE: every decline is exactly {ok:false, reason}', () => {
    const cappedIssuer = mkIssuer({ capPerWindow: 1 })
    cappedIssuer.issue({ targetIdentityId: OTHER.identityId, address: addr(0) }, 150)
    const declines = [
      mkIssuer({ enabled: false }).issue({ targetIdentityId: OTHER.identityId, address: addr(0) }, 150),
      mkIssuer().issue({ targetIdentityId: 'nope', address: addr(0) }, 150),
      cappedIssuer.issue({ targetIdentityId: OTHER.identityId, address: addr(1) }, 150),
    ]
    for (const d of declines) {
      expect(d.ok).toBe(false)
      expect(Object.keys(d).sort()).toEqual(['ok', 'reason']) // no witness anywhere
      expect('witness' in d).toBe(false)
    }
  })

  it('STORE_ADD_GET_FRESH: verified witnesses enter; get filters, sorts, copies on read', () => {
    const store = createWitnessStore({ expectedChainId: CHAIN })
    const issuer = mkIssuer()
    const wB = issueOk(issuer, OTHER.identityId, addr(2), 120) // [120, 216)
    const wA = issueOk(issuer, OTHER.identityId, addr(1), 100) // [100, 196)
    expect(store.add(wA, 150)).toEqual({ ok: true })
    expect(store.add(wB, 150)).toEqual({ ok: true })
    expect(store.size()).toBe(2)

    const got = store.get(OTHER.identityId, 150)
    expect(got.map((w) => w.address)).toEqual([addr(1), addr(2)]) // deterministic order
    for (const w of got) expect(verifyWitness(w, LIVE)).toEqual({ ok: true })

    // Copy-on-read: mutating a returned signature cannot touch the store.
    const first = got[0]!
    first.signature[0] = (first.signature[0]! + 1) % 256
    expect(store.get(OTHER.identityId, 150)[0]!.signature).toEqual(wA.signature)
    // Copy-on-WRITE too: mutating the caller's own added bytes afterwards
    // cannot retroactively corrupt what is stored (the address-book mirror).
    wB.signature[63] = (wB.signature[63] + 1) % 256
    const stillGood = store.get(OTHER.identityId, 150).find((w) => w.address === addr(2))!
    expect(stillGood.signature).not.toEqual(wB.signature)
    expect(verifyWitness(stillGood, LIVE)).toEqual({ ok: true })
    // Unknown targets read empty; a slot outside the window reads empty too.
    expect(store.get(NOTARY.identityId, 150)).toEqual([])
    expect(store.get(OTHER.identityId, 300)).toEqual([])
  })

  it('STORE_REJECTS_EXPIRED_ON_ADD: expired and wrong-chain witnesses never enter', () => {
    const store = createWitnessStore({ expectedChainId: CHAIN })
    const issuer = mkIssuer()
    const stale = issueOk(issuer, OTHER.identityId, addr(1), 10) // [10, 106)
    expect(store.add(stale, 200)).toEqual({ ok: false, reason: 'expired' })

    const foreign = mkIssuer({ expectedChainId: 'other-chain' }).issue(
      { targetIdentityId: OTHER.identityId, address: addr(2) },
      150,
    )
    if (!foreign.ok) throw new Error('foreign issuance should succeed')
    expect(store.add(foreign.witness, 150)).toEqual({ ok: false, reason: 'chain-mismatch' })

    expect(store.size()).toBe(0)
    expect(store.get(OTHER.identityId, 150)).toEqual([])
  })

  it('STORE_EVICT: reads filter [expiry <= current]; pruneExpired removes exactly those', () => {
    const store = createWitnessStore({ expectedChainId: CHAIN })
    const issuer = mkIssuer()
    const oldW = issueOk(issuer, OTHER.identityId, addr(1), 0) // [0, 96)
    const newW = issueOk(issuer, OTHER.identityId, addr(2), 100) // [100, 196)
    expect(store.add(oldW, 50)).toEqual({ ok: true })
    expect(store.add(newW, 150)).toEqual({ ok: true })
    expect(store.size()).toBe(2)

    // Reads filter before any prune: only newW is live at 150.
    expect(store.get(OTHER.identityId, 150).map((w) => w.address)).toEqual([addr(2)])

    expect(store.pruneExpired(150)).toBe(1) // expiry 96 <= 150
    expect(store.size()).toBe(1)
    expect(store.get(OTHER.identityId, 150).map((w) => w.address)).toEqual([addr(2)])

    // Half-open prune rule: expiry == current prunes too.
    expect(store.pruneExpired(196)).toBe(1)
    expect(store.size()).toBe(0)
    expect(store.pruneExpired(196)).toBe(0) // idempotent
  })

  it('STORE_FRESHEST_KEPT: same (target, address, signer) keeps the freshest expiry', () => {
    const store = createWitnessStore({ expectedChainId: CHAIN })
    const mk = (signer: typeof KEYPAIR, expiry: bigint): SignedWitness =>
      issueWitness(signer, {
        targetIdentityId: OTHER.identityId,
        address: addr(7),
        chainId: CHAIN,
        firstSeenSlot: 100n,
        expirySlot: expiry,
        signerIdentityId: 'overridden by issueWitness', // the pin replaces it
      })
    expect(store.add(mk(KEYPAIR, 300n), 150)).toEqual({ ok: true })
    expect(store.get(OTHER.identityId, 150).map((w) => w.expirySlot)).toEqual([300n])

    expect(store.add(mk(KEYPAIR, 200n), 150)).toEqual({ ok: true }) // older — no-op
    expect(store.get(OTHER.identityId, 150).map((w) => w.expirySlot)).toEqual([300n])

    expect(store.add(mk(KEYPAIR, 400n), 150)).toEqual({ ok: true }) // fresher — replaces
    expect(store.size()).toBe(1)
    expect(store.get(OTHER.identityId, 150).map((w) => w.expirySlot)).toEqual([400n])

    // A DISTINCT SIGNER on the same address is a distinct row (the dedupe key).
    expect(store.add(mk(NOTARY, 250n), 150)).toEqual({ ok: true })
    expect(store.size()).toBe(2)
  })

  it('STORE_PER_TARGET_CAP: oldest expiry evicted at MAX_WITNESSES_PER_TARGET; cap is per target', () => {
    const store = createWitnessStore({ expectedChainId: CHAIN })
    // Cap lifted on the ISSUER — this row tests the STORE's per-target cap;
    // issuance-policy rows pin their own cap elsewhere.
    const issuer = mkIssuer({ capPerWindow: MAX_WITNESSES_PER_TARGET + 8 })
    // w_i lives [i, i+96) — all live at slot 20; w_0 has the oldest expiry.
    for (let i = 0; i <= MAX_WITNESSES_PER_TARGET; i += 1) {
      const w = issueOk(issuer, OTHER.identityId, addr(i), i)
      expect(store.add(w, 20)).toEqual({ ok: true })
    }
    expect(store.size()).toBe(MAX_WITNESSES_PER_TARGET)
    const held = store.get(OTHER.identityId, 20)
    expect(held).toHaveLength(MAX_WITNESSES_PER_TARGET)
    expect(held.some((w) => w.expirySlot === 96n)).toBe(false) // the oldest went

    // The cap is PER TARGET — another target gets its own budget.
    const other = issueOk(issuer, NOTARY.identityId, addr(0), 20)
    expect(store.add(other, 20)).toEqual({ ok: true })
    expect(store.size()).toBe(MAX_WITNESSES_PER_TARGET + 1)
  })

  it('DIGEST_DOMAIN_PIN: domain pinned; ≠ announcement/introduction digests; signer not in bytes', () => {
    expect(REACHABILITY_WITNESS_DOMAIN).toBe('succinctcoin/ReachabilityWitness/v1\0')
    const f: WitnessFields = {
      targetIdentityId: OTHER.identityId,
      address: addr(1),
      chainId: CHAIN,
      firstSeenSlot: 100n,
      expirySlot: 196n,
      signerIdentityId: KEYPAIR.identityId,
    }
    const d = witnessDigest(f)
    expect(d).toHaveLength(32)

    // Same field VALUES under the other two discovery signatures ⇒ different
    // digests (domain separation both ways; the peers pin their own tags).
    const intro = introductionDigest({
      signerIdentityId: f.signerIdentityId,
      subjectIdentityId: f.targetIdentityId,
      slotObserved: f.firstSeenSlot,
      reachability: 'direct',
      chainId: f.chainId,
    })
    const ann = peerAnnouncementDigest({
      identityId: f.targetIdentityId,
      multiaddrs: [f.address],
      observedExternalAddr: undefined,
      slotStart: f.firstSeenSlot,
      slotEnd: f.expirySlot,
      chainId: f.chainId,
    })
    expect(hex(d)).not.toBe(hex(intro))
    expect(hex(d)).not.toBe(hex(ann))

    // The signer is NOT in the bytes: only-signer differences digest EQUAL.
    expect(hex(witnessDigest({ ...f, signerIdentityId: OTHER.identityId }))).toBe(hex(d))
  })

  it('MODULE_PURE: the witness source touches no clock, fs, or net', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/discovery/witness.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/\bDate\b|\bsetTimeout\b|\bperformance\b|node:net|node:http|node:fs/)
  })
})
