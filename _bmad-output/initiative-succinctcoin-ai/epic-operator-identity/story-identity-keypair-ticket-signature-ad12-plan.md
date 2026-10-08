---
ticket: "2"
title: "Identity keypair + ticket signature (AD-12)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "daacebddaa8f66c7d6d87cd5d9c801f522779a53"
review: quick
review_source: pinned
lenses_ran: ['quick']
review_loop_iteration: 0
covers: [E2]
context:
  - packages/core/src/identity/gate-verifier.ts
  - packages/core/src/identity/index.ts
  - packages/core/src/index.ts
  - packages/core/proto/protocol.proto
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/test/golden-vector.test.ts
  - packages/core/test/no-float-guard.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.2 Identity keypair + ticket signature (AD-12)

## Story of truth

Add the **identity keypair** (the AD-11 key material that lives in `core/identity`)
plus the **ticket signature** sign/verify over the EXACT AD-12 digest
`sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)`, and a
**pinned golden round-trip vector** — so that an unselected node that can read a
winner's PUBLIC ticket off the chain (its `identityId` + `nonceCommitment` +
`challenge` + `windowIndex` are all public) **cannot forge a valid signature**
(it does not hold the winner's private key). That closes the **epic-3 residual
replay** (3.4/3.7 note) that `verifyDraw`'s commitment-binding deliberately left
open pending a signature check.

This is a NEW-MODULE story (one new `src/identity/identity.ts` + additive barrel
re-exports + one new test file). It does NOT change the proto `Ticket` message
(the `signature` bytes field already exists — 4.1 confirmed it is not a blob),
`ports.ts`, or any existing consensus/ledger module. It is the signature seam
that **4.3** wires into block acceptance (additively — composing with `verifyDraw`),
and the key material that **4.7** guards behind the AD-11 core boundary.

## The epic requirement this delivers (E2, AD-11 / AD-12)

- **E2 (AD-12)** — the ticket carries an **identity-bound signature** over the
  exact canonical digest `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖
  nonceCommitment)` (big-endian fixed-width `windowIndex`, AD-12); one **golden
  round-trip vector** (fixed ticket → fixed signature) ships in the repo so the
  digest + signature can never drift; a tampered ticket (wrong
  `windowIndex`/`challenge`/`nonceCommitment`, or a reused public ticket with a
  forged/empty/foreign signature) **fails** verification.
- **AD-11** — identity **private keys live in the core**; the public surface is
  only `identityId` + the public key + signed artifacts (the renderer/IPC half is
  epic 6). The keypair's secret is a distinct field, never folded into
  `identityId`/`publicKey`.

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — Asymmetric scheme, Ed25519 via `node:crypto`.** The signature MUST be
  verifiable from **public data**: 4.3's acceptance path has only the winner's
  public ticket (`identityId` + fields) — never the private key. That rules out
  a symmetric/HMAC scheme (which would need a shared secret at verify time) and
  requires **sign-with-private / verify-with-public**. **Ed25519** is used
  because it is (a) native to `node:crypto` (the AD-6/AD-4 "node:crypto only, no
  new dependency" convention), (b) **deterministic** (RFC 8032: the nonce is
  derived from the key + message, NO RNG → offline + a reproducible golden
  vector + AD-3), and (c) the libp2p-ecosystem peer-id algorithm (consistent).
- **D2 — `identityId` = hex of the 32-byte Ed25519 public key.** This settles
  the ticket's "identityId derived from the public key vs a separate
  registration id" → **derived from the public key** (no separate id). An
  Ed25519 public key is exactly 32 bytes → 64 hex chars, matching the spine "IDs:
  32-byte hex" convention AND the 4.1 verifier's 64-hex `identityId` check.
  Verification **reconstructs the public key from `identityId` alone** (the
  SPKI DER = the 12-byte Ed25519 prefix ‖ the 32 raw bytes) — so a signature is
  verifiable from public data (AD-11: `identityId` + `publicKey` are public; the
  secret is separate).
- **D3 — Deterministic seed → keypair (the "deterministic test keypair").**
  `deriveIdentityKeypair(seed: Uint8Array)` requires `seed` to be exactly 32
  bytes (else `IdentityError` `SC-IDENTITY-2` — a programming error). It builds
  the PKCS#8 DER = the **16-byte Ed25519 prefix** ‖ `seed`, imports it via
  `crypto.createPrivateKey`, derives the public key via `crypto.createPublicKey`,
  and reads the raw 32-byte public key from the SPKI DER (`subarray(12)`).
  **No RNG** (AD-3/AD-10) — the same seed always yields the same keypair, so the
  golden vector + a future sim are reproducible. The returned `IdentityKeypair =
  { identityId, publicKey, secret }` (the `secret` is the PKCS#8 DER bytes — the
  private material AD-11 keeps separate).
- **D4 — The EXACT AD-12 digest.** Both `signTicket` and
  `verifyTicketSignature` compute the digest identically:
  `sha256(utf8(identityId) ‖ u64be(BigInt(windowIndex)) ‖ challenge ‖
  nonceCommitment)`. `identityId` is the **hex string as UTF-8** (consistent with
  4.1's blob + the proto `string identityId` field); `windowIndex` is **u64be**
  (big-endian fixed-width, AD-12 — a non-negative integer); `challenge` +
  `nonceCommitment` are their raw bytes (32 bytes each). `signTicket` =
  `crypto.sign(null, digest, privateKey)` → **64 bytes**; `verifyTicketSignature`
  = `crypto.verify(null, digest, publicKey, signature)` → **boolean**.
- **D5 — Reject = a normal `false`, never a throw (the `verifyDraw`
  convention).** `verifyTicketSignature` returns `false` for a malformed
  `identityId` (not 64 hex / not a valid Ed25519 public key), a truncated or
  garbage signature, and any signature that simply does not match — it wraps
  `node:crypto` in `try/catch → false`. It NEVER throws for a rejected ticket.
  The ONLY throw path is `deriveIdentityKeypair` on a bad seed length
  (`IdentityError` `SC-IDENTITY-2`, a programming error — like 4.1's issuer).
- **D6 — Module-local helpers; NO big.js; NO proto change.** The byte helpers
  (`u64be` / `bytesToBig` / `concat` / `sha256` / `bytesToHex` / `hexToBytes`) are
  local to `identity.ts` — the `pow.ts` / `draw.ts` / `gate-verifier.ts` pattern
  (the cross-module DRY extraction is deferred, per 3.8). `src/identity` still
  imports **no** `big.js` (AD-5 / the 2.5 no-float guard stays green). The proto
  `Ticket.signature` field already exists — 4.2 adds no field (AD-12).

## Frozen I/O matrix (each row a passing test)

The pinned AD-12 **golden vector** inputs (shared by the rows below):
`seed = 00 01 02 … 1f` (32 bytes, 0x00..0x1f); `windowIndex = 7`;
`challenge = 32 × 0x01`; `nonceCommitment = 32 × 0x02`. The resulting
`identityId` (64-hex) and the 64-byte signature are **computed by the
implementation and PINNED** in the test (the AD-12 golden vector).

| Row | Input | Expected |
|-----|-------|----------|
| SIG_KEYPAIR_DERIVE | `deriveIdentityKeypair(seed 00..1f)` twice; a second keypair from a different seed; a 31-byte and a 33-byte seed | deterministic: both calls → identical `identityId` + byte-identical `publicKey`; `identityId` is exactly 64 hex chars AND `identityId === hex(publicKey)`; a different seed → a different `identityId`; a 31- or 33-byte seed → **throws** `IdentityError` `SC-IDENTITY-2` |
| SIG_ROUNDTRIP_GOLDEN | the golden inputs (D-matrix above) | `signTicket(keypair, {windowIndex, challenge, nonceCommitment})` → the **pinned 64-byte signature** (byte-identical to the golden vector); `verifyTicketSignature(identityId, {…}, signature)` → **`true`** — the AD-12 golden round-trip |
| SIG_TAMPER_REJECT | the golden signature, but with (a) a different `windowIndex`, (b) a different `challenge`, (c) a different `nonceCommitment`, (d) a signature made by a DIFFERENT identity's key, (e) a truncated / one-byte-flipped signature | every tampered input → `verifyTicketSignature` **`false`** (the digest binds all four fields; a foreign key cannot sign for this identityId; a truncated/garbage signature is rejected) |
| SIG_REPLAY_REJECT | the winner's PUBLIC ticket (all four fields — `identityId` + `nonceCommitment` + `challenge` + `windowIndex` are public) presented WITHOUT the winner's private key: (a) an empty signature, (b) a signature produced by a DIFFERENT identity key over the same four fields, (c) the winner's GENUINE signature (sanity) | (a) `false`; (b) `false` — possession of the public ticket is NOT enough to forge a valid signature (the **epic-3 residual replay is closed**); (c) `true` (only the genuine private key verifies) |
| SIG_VERIFY_FROM_PUBLIC_DATA | (a) verify using ONLY the `identityId` string (no keypair object) for the genuine signature; (b) a malformed `identityId` (36 hex chars / non-hex / a valid-length but invalid Ed25519 key) | (a) `true` — the public key is reconstructed from `identityId` ALONE (no secret needed; this is what makes 4.3's acceptance path possible); (b) `false` (never a throw) — a reject is the normal `false`. `signTicket` is also deterministic: the same keypair + fields → byte-identical signature across two calls |

## Tasks

- [x] Add `src/identity/identity.ts` — `IdentityError` (`SC-IDENTITY-2`) +
  `deriveIdentityKeypair(seed: Uint8Array) → IdentityKeypair` (deterministic
  seed → Ed25519 keypair via `node:crypto`; `identityId` = hex of the 32-byte
  public key; `publicKey` = the 32 raw bytes; `secret` = the PKCS#8 DER; a bad
  seed length throws) + `signTicket(keypair, { windowIndex, challenge,
  nonceCommitment }) → Uint8Array` (a 64-byte Ed25519 signature over the exact
  AD-12 digest) + `verifyTicketSignature(identityId, { windowIndex, challenge,
  nonceCommitment }, signature) → boolean` (reconstructs the public key from
  `identityId`, recomputes the AD-12 digest, verifies; **reject = a normal
  `false`, never a throw**). Local byte helpers (the `pow.ts` / `draw.ts` /
  `gate-verifier.ts` pattern). Extend `src/identity/index.ts` (barrel) + additive
  re-exports in the root barrel `src/index.ts`. Do NOT change `ports.ts`,
  `protocol.proto`, or any existing module.
- [x] Add `test/identity-signature.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the AD-12 digest or the crypto):
  the 5 matrix rows (SIG_KEYPAIR_DERIVE / SIG_ROUNDTRIP_GOLDEN /
  SIG_TAMPER_REJECT / SIG_REPLAY_REJECT / SIG_VERIFY_FROM_PUBLIC_DATA), with the
  pinned AD-12 golden vector (fixed seed + fixed ticket → a pinned 64-byte
  signature).
- [x] Run the verification gate; confirm the golden vector + sign/verify are
  deterministic (run twice — the same signature bytes both times).

## Acceptance criteria

1. A deterministic identity keypair derivation (seed → `identityId` + public +
   secret); `identityId` is the hex of the 32-byte Ed25519 public key (64 hex
   chars, the spine convention).
2. `signTicket` / `verifyTicketSignature` round-trip over the EXACT AD-12 digest
   `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)`; a
   pinned golden vector (fixed ticket → fixed 64-byte signature) passes.
3. A tampered ticket (wrong `windowIndex` / `challenge` / `nonceCommitment`, a
   foreign-key signature, or a truncated/flipped signature) fails verification.
4. The epic-3 residual replay is closed: an unselected node holding only the
   winner's PUBLIC ticket cannot forge a valid signature (empty / foreign /
   fabricated signature → `false`; only the genuine private key verifies).
5. The signature is verifiable from PUBLIC data alone (the public key is
   reconstructed from `identityId`; no secret needed), and a reject is a normal
   `false` (never a throw).
6. `ports.ts` / `protocol.proto` / every existing module are UNCHANGED (4.2 adds
   one new `src/identity/identity.ts` + additive barrel re-exports + one test
   file); no `big.js` in `src/identity`; the golden vector is deterministic (two
   runs give identical bytes).

## Never

- NEVER change the proto `Ticket` message (the `signature` bytes field already
  exists — AD-12) or `ports.ts` — 4.2 adds a keypair + sign/verify, not a new
  field or seam.
- NEVER re-implement or reorder the AD-12 digest — it is exactly
  `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)`
  (big-endian fixed-width `windowIndex`).
- NEVER use a symmetric / HMAC / shared-secret scheme — the signature must verify
  from PUBLIC data (4.3's acceptance path has only the public ticket).
- NEVER introduce a new crypto dependency or an RNG — `node:crypto` Ed25519 only
  (deterministic, offline, AD-3 / AD-6).
- NEVER make `verifyTicketSignature` throw for a rejected ticket (reject = a
  normal `false`; only keypair-derivation errors throw).
- NEVER fold the private key into `identityId` or `publicKey` (AD-11: the secret
  is a separate field; only `identityId` + the public key are public).
- NEVER import `big.js` in `src/identity` (AD-5 / the 2.5 no-float guard).

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **168 prior + 5 new = 173 tests,
  23 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.2 adds no proto.
- Determinism: run `corepack pnpm test identity-signature` TWICE — both pass
  with the identical golden signature bytes (same seed + same ticket ⇒ same
  64-byte signature).
- Prior suites unchanged: the 168 pre-4.2 tests all still pass (the 5 new tests
  are additive; no existing test modified; the epic-3 verify-draw / sim / e2e
  empty-signature suites are untouched).
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]` — `src/identity/identity.ts` imports no `big.js`).

## Plan Change Log
_(none — built as planned; no post-build code changes.)_

## Review Triage Log
| Lens | Finding | Verdict | Action |
|------|---------|---------|--------|
| quick | (none) | — | The Quick lens returned **0 findings**: all 5 matrix rows covered by passing tests; all 6 acceptance criteria met; scrutiny points (a)–(j) all satisfied with evidence; the reviewer independently re-derived the pinned AD-12 golden vector (seed `00..1f` → `identityId 03a107…5531b8`, 64-byte signature `64660f3b…ae9905`) with `node:crypto` and it matched byte-for-byte, confirming the pin is genuine, not self-referential. Confirmed: the Ed25519 SPKI/PKCS#8 DER byte prefixes are correct; `signTicket`/`verifyTicketSignature` share ONE `ticketDigest` (the AD-12 digest cannot drift); verification reconstructs the public key from `identityId` alone (public data — makes 4.3's acceptance path possible); a reject is a normal `false` (the only throw path is `deriveIdentityKeypair` on a bad seed length); the scheme is genuinely asymmetric (the epic-3 residual replay is closed); no `big.js` in `src/identity/identity.ts` (no-float guard 6/6, specifier set still exactly `[ledger/display.ts, ledger/fee.ts]`); a non-integer/out-of-range `windowIndex` in `verifyTicketSignature` is caught → `false` (never a throw); TS 5.9 `Buffer`/`Uint8Array` bridging is correct. Orchestrator independently re-ran the full gate post-review: **173/173 (23 files), typecheck clean, build PROTO_OK, no-float 6/6, identity-signature 5/5 twice.** No code change. |

## Implementation Notes

**Built (baseline `daacebd` → 4.2).** Added `src/identity/identity.ts`
(`IdentityError` `SC-IDENTITY-2`, `deriveIdentityKeypair`, `signTicket`,
`verifyTicketSignature`, `IdentityKeypair`/`TicketFields` types, local byte
helpers) + additive re-exports in `src/identity/index.ts` and the root
`src/index.ts` + `test/identity-signature.test.ts` (5 matrix rows, imports
from the root barrel only). `ports.ts` / `protocol.proto` / every existing
module + test unchanged.

**Pinned AD-12 golden vector (computed by the implementation):**
seed `00..1f` → `identityId =
03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8`;
`windowIndex = 7`, `challenge = 32×0x01`, `nonceCommitment = 32×0x02` →
64-byte signature
`64660f3b591f68d6fd133ecea649e70295d53585a8d8d4e0ebe9931025ef408cde2f4484a61e95a52bfca2624b98df82c3e6d2c4ea5073ac44853d8921ae9905`
(digest `6486597edd39112b55aa483280c314e9e30e4a6adcb969909ef68705ec4a5a83`).

**Verification gate — all green:**
- `corepack pnpm test` → 23 files / 173 tests passed (168 prior + 5 new).
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean; `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK).
- Determinism: `corepack pnpm test identity-signature` run twice — both
  5/5 passed, identical pinned signature bytes.
- `corepack pnpm test no-float-guard` → 6/6 (the `big.js` import set over
  `src/` is still exactly `[ledger/display.ts, ledger/fee.ts]`).
- `identity-gate` source-scan guards (GATE_NO_BLOB_LEAK) stay green —
  `identity.ts` reads no `.blob`.

**Notes / observations (no action taken):**
- `node:crypto` `createPublicKey`/`verify` do NOT throw on a malformed
  Ed25519 public key or a truncated/empty signature on Node 24 (verified by
  probe: all-zero / all-0xff / RFC 8032 bad-sign-bit keys → `false`;
  63-byte / 0-byte signatures → `false`). The `try/catch → false` in
  `verifyTicketSignature` is therefore a defensive guard for the D5
  never-throw guarantee, not a load-bearing path.
- TS 5.9: `crypto.sign`/`verify`/`createPrivateKey`/`createPublicKey`
  bridged with `Buffer.from(...)`; `signTicket` returns `new
  Uint8Array(...)` so the generated proto's `Uint8Array<ArrayBuffer>`
  fields typecheck.
- `verifyTicketSignature` also returns `false` (never throws) if the
  caller passes a non-integer / out-of-u64-range `windowIndex` — a
  programming error on the caller's input, rejected per the D5 convention;
  `signTicket` on the same input throws `IdentityError` `SC-IDENTITY-2`
  (a sign is a minting act, like `issueGateCredential`).
- **Post-review (Quick lens, iteration 1)** — **0 findings**; the reviewer
  independently re-derived the pinned AD-12 golden vector with `node:crypto`
  (not from this implementation) and it matched byte-for-byte, confirming the
  pin is genuine. Orchestrator re-ran the full gate post-review: **173/173 (23
  files), typecheck clean, build PROTO_OK (empty proto diff), no-float 6/6,
  identity-signature 5/5 twice (deterministic).** No code change. See the
  `## Review Triage Log`.
