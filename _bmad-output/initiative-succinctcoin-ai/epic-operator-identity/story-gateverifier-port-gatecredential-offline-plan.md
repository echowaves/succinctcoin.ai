---
ticket: "1"
title: "GateVerifier port + GateCredential (offline)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "554502e24c2c02cc71ae1b609f0bfe820c87e0ae"
review: quick
review_source: pinned
lenses_ran: ['quick']
review_loop_iteration: 1
covers: [R3]
context:
  - packages/core/src/ports.ts
  - packages/core/src/config/genesis.ts
  - config/genesis.json
  - packages/core/src/index.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/proto/protocol.proto
  - packages/core/test/no-float-guard.test.ts
  - packages/core/test/golden-vector.test.ts
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.1 GateVerifier port + GateCredential (offline)

## Story of truth

Stand up `core/identity` (CAP-2) with the offline `GateVerifier` seam made concrete:
the port shape is ALREADY declared in `src/ports.ts` (epic 1 — `GateCredential
{ gateId, blob }`, `GateVerification { valid, identityId, attestedUntilWindow }`,
`GateVerifier.verify(cred, windowIndex): Promise<GateVerification>`), so 4.1 does
NOT change the port. It adds the `core/identity` module that owns a
**deterministic offline verifier** implementing that exact port (the
"deterministic offline test verifier" the entry names) plus a deterministic
**credential issuer** (the offline gate-standin the harness/sim uses to mint
valid credentials), and enforces the **accepted-gate registry** (must-hold (c):
gates enter only by protocol upgrade, never auto-valid). A credential from an
accepted `gateId` verifies offline; one from a non-accepted `gateId` is rejected.
The `blob` is opaque — only the verifier interprets it; no other module reads it
(AD-4), and a `Ticket` carries at most a credential hash, never the blob.

This is a NEW-MODULE story: one new `src/identity/` module + one new test file.
It does NOT change the port (`ports.ts`), the proto (`protocol.proto`), or any
existing consensus/ledger module. It is the first slice of epic 4 and the seam
4.2 (ticket signature) / 4.3 (conformance + signature wiring) / 4.6
(re-attestation) / 4.8 (multi-identity sim) build on.

## The epic requirement this delivers (R3, AD-4)

- **R3 (AD-4)** — the gate is verified **offline**: the verifier port is exactly
  `GateVerifier.verify(cred, window) → { valid, identityId, attestedUntilWindow }`;
  `GateCredential = { gateId: string, blob: Uint8Array }` is the only representable
  credential shape; **no module parses credential fields outside the verifier**; a
  `Ticket` carries at most the credential **hash**, never the blob.
- **Must-hold (c) (registration-design)** — gates are **addable only by protocol
  upgrade, never auto-valid**: a credential whose `gateId` is not in genesis's
  accepted-gate registry is rejected (the "cheap weak third gate = sybil faucet"
  defense).

## Design Notes (decisions)

- **D1 — The port already exists; 4.1 adds the implementation, not the seam.**
  `src/ports.ts` already declares `GateCredential` / `GateVerification` /
  `GateVerifier` (exact AD-4 shape). 4.1 does NOT touch `ports.ts`. It adds
  `src/identity/gate-verifier.ts` (the deterministic offline verifier + issuer) +
  `src/identity/index.ts` (barrel) + additive root-barrel re-exports in
  `src/index.ts`. The port shape stays byte-identical (AD-4).
- **D2 — Registry enforcement (must-hold (c)).** The verifier is constructed with
  the accepted-gate registry (a factory `createOfflineGateVerifier({ acceptedGates })`
  — the caller passes `genesis.gates`). The verifier reads ONLY `cred.gateId` to
  check `gateId ∈ acceptedGates`; a credential from a non-accepted `gateId` →
  `valid: false`. This is AD-4-permitted: "no module parses credential fields
  beyond `gateId`" — `gateId` is the one field the core may read; the `blob` stays
  opaque. The registry comes from the validated `GenesisConfig.gates` (epic 1),
  not a hard-coded list.
- **D3 — Offline blob check (deterministic, no network, no RNG).** The `blob` is a
  deterministic canonical encoding of the gate's offline credential:
  `utf8(gateId) ‖ utf8(identityId) ‖ u64be(attestedUntilWindow) ‖
  sha256("SC-GATE-CRED/1" ‖ utf8(gateId) ‖ utf8(identityId) ‖ u64be(attestedUntilWindow))`
  (the trailing digest is the offline MAC — the "signature/credential check only,
  no network call" AD-4 requires). The verifier recomputes the MAC and accepts
  only a well-formed blob where: `identityId` is 64 hex chars (32-byte hex, the
  spine id convention), `attestedUntilWindow` fits u64be, the MAC matches, and
  `gateId` is accepted. Any failure → `valid: false` (a normal `false`, NOT an
  error — the same "reject = normal false, not error" convention as `verifyDraw`).
- **D4 — The issuer (offline gate-standin).** `issueGateCredential({ gateId,
  identityId, attestedUntilWindow }) → GateCredential` deterministically builds a
  blob with the correct MAC. It is the harness/sim's stand-in for the external gate
  provider (AD-4: the real gate is external; the core owns the offline verifier +
  the credential SHAPE, and this issuer is how tests/sim mint valid credentials).
  It is a pure function (no RNG, no clock) — the same input always yields the same
  `GateCredential`.
- **D5 — Chain-time window check (AD-3).** `verify(cred, windowIndex)` checks
  `windowIndex <= attestedUntilWindow`: a credential is valid only at or before its
  `attestedUntilWindow`. `windowIndex > attestedUntilWindow` (lapsed) → `valid:
  false`. This makes the port's `windowIndex` input meaningful and is chain-time
  (never the wall clock). **4.6 builds on this**: it owns the re-attestation
  CADENCE (K) — re-issuing a credential with a later `attestedUntilWindow` every K
  windows — and the "lapse → lose eligibility" lifecycle + sim. 4.1 proves the
  verifier's offline window check; 4.6 proves the re-attestation lifecycle.
- **D6 — The Ticket carries no blob; NO proto change.** The current proto `Ticket`
  message is `{ identityId, windowIndex, challenge, nonceCommitment, signature }` —
  it has NO credential field, so it trivially satisfies "a Ticket carries at most
  the credential **hash**, never the blob." 4.1 does NOT add a proto field (that
  would be an AD-12 protocol change). A test asserts (a) the `Ticket` message has
  no credential-blob field (schema) and (b) no `src/` module outside the verifier
  reads `cred.blob` / `.blob` (a source scan, like the standing import-scan guards).
  A future networking epic (5) MAY add a credential-hash field if credentials are
  gossiped — deferred, not 4.1.

## Frozen I/O matrix (each row a passing test)

| Row | Input | Expected |
|-----|-------|----------|
| GATE_OFFLINE_VERIFY | `issueGateCredential({ gateId: "biometric" (accepted), identityId: <64 hex>, attestedUntilWindow: 100 })` + `verify(cred, 50)` | `{ valid: true, identityId: <the 64-hex>, attestedUntilWindow: 100 }` — deterministic (same input ⇒ same output, verified across two runs) and offline (a pure function of its inputs; no network, no RNG, no wall clock) |
| GATE_REGISTRY_REJECT | (a) a credential from an ACCEPTED `gateId` ("biometric") → `verify`; (b) a credential from a NON-accepted `gateId` ("rogue-gate") → `verify` | (a) `valid: true`; (b) `valid: false` — must-hold (c): gates enter only by the accepted registry (genesis `gates`), never auto-valid |
| GATE_BLOB_TAMPER | a credential whose `blob` is tampered (one byte flipped / truncated / a wrong trailing MAC) and a malformed blob (bad `identityId` length, non-canonical) | every tampered/malformed blob → `valid: false` (the offline MAC + shape checks catch forgery); a well-formed credential from the issuer → `valid: true` |
| GATE_WINDOW_CHAIN_TIME | a credential with `attestedUntilWindow = 100`: `verify(cred, 50)` and `verify(cred, 101)` | `windowIndex = 50` (≤ 100) → `valid: true`; `windowIndex = 101` (> 100, lapsed) → `valid: false` — AD-3 chain-time (no wall clock) |
| GATE_NO_BLOB_LEAK | (a) the generated `Ticket` proto message's fields; (b) a comment-stripped source scan of `src/**/*.ts` for `cred.blob` / `.blob` reads | (a) the `Ticket` message has NO credential-blob field (it carries at most a credential hash, never the blob — AD-4); (b) the ONLY `src/` module that reads `cred.blob` is the verifier (`src/identity/gate-verifier.ts`); `ports.ts` declares the field type but no other module reads it |

## Tasks

- [x] Add `src/identity/gate-verifier.ts` — the deterministic offline
  `GateVerifier` implementation: `createOfflineGateVerifier({ acceptedGates }) →
  GateVerifier` (reads only `cred.gateId` for the registry; recomputes the offline
  MAC; checks `identityId` 64-hex + `windowIndex <= attestedUntilWindow`; reject =
  normal `{ valid: false, identityId: "", attestedUntilWindow: 0 }`, not an error)
  + `issueGateCredential({ gateId, identityId, attestedUntilWindow }) → GateCredential`
  (pure, no RNG/clock). Add `src/identity/index.ts` (barrel) + additive re-exports in
  the root barrel `src/index.ts`. Do NOT change `ports.ts`, `protocol.proto`, or any
  existing consensus/ledger module.
- [x] Add `test/identity-gate.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the verifier): the 5 matrix rows
  (GATE_OFFLINE_VERIFY / GATE_REGISTRY_REJECT / GATE_BLOB_TAMPER /
  GATE_WINDOW_CHAIN_TIME / GATE_NO_BLOB_LEAK). `GATE_NO_BLOB_LEAK` uses a
  comment-stripped source scan of `src/` (the `no-float-guard.test.ts` pattern) for
  `.blob` reads + a `Ticket` proto schema assertion (no credential-blob field).
- [x] Run the verification gate; confirm the verifier is deterministic (run it
  twice — same input ⇒ same `{ valid, identityId, attestedUntilWindow }`).

## Acceptance criteria

1. A deterministic offline `GateVerifier` implementation in `core/identity`
   implements the EXACT port shape (`verify(cred, windowIndex) → { valid,
   identityId, attestedUntilWindow }`); it makes no network call, uses no RNG and
   no wall clock (AD-4 offline, AD-3 chain-time).
2. Registry (must-hold (c)): a credential from an accepted `gateId` (from genesis
   `gates`) verifies; one from a non-accepted `gateId` is rejected.
3. Offline blob check: a well-formed credential (issuer-produced) verifies; a
   tampered or malformed blob (wrong MAC, bad `identityId`, truncated) is rejected.
4. Chain-time window: `windowIndex <= attestedUntilWindow` → valid; a lapsed
   credential (`windowIndex > attestedUntilWindow`) is rejected (AD-3, no wall clock).
5. AD-4 blob boundary: no `src/` module outside the verifier reads `cred.blob`
   (source scan); the `Ticket` proto carries no credential blob (schema) — a
   `Ticket` carries at most a credential hash, never the blob.
6. The port (`ports.ts`) and the proto are UNCHANGED; the verifier is deterministic
   (two runs give the identical result for the same input).

## Never

- NEVER change the `GateVerifier` / `GateCredential` / `GateVerification` port
  shape in `src/ports.ts` (AD-4) or the proto `Ticket` message (AD-12) — 4.1 adds
  the implementation + a new test, not a new seam or a protocol field.
- NEVER parse credential fields (the `blob`) outside the verifier (AD-4) — the core
  reads only `cred.gateId` (the registry key); the `blob` is interpreted only by
  the verifier.
- NEVER introduce a network call, `Math.random`, or wall-clock time into the
  verifier (AD-4 offline, AD-3 chain-time) — the MAC is a deterministic `sha256`
  over public data.
- NEVER put the credential `blob` into a `Ticket` (AD-4: at most the credential
  hash, never the blob).
- NEVER import `big.js` in `src/identity` (AD-5 / the 2.5 no-float guard) — the
  verifier uses only `node:crypto` `sha256` + integers.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **163 prior + 5 new = 168 tests,
  22 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.1 adds no proto.
- Determinism: run `corepack pnpm test identity-gate` TWICE — both pass with the
  identical verifier results (same input ⇒ same `{ valid, identityId,
  attestedUntilWindow }`).
- Prior suites unchanged: the 163 pre-4.1 tests all still pass (the 5 new tests are
  additive; no existing test modified).
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]` — `src/identity` imports no `big.js`).

## Plan Change Log
- **Post-build review patch (Quick lens, iteration 1)** — three code
  corrections to `src/identity/gate-verifier.ts` + three added assertions
  in `test/identity-gate.test.ts`, all backward-compatible (genesis
  gateIds are ASCII; existing window inputs are non-negative integers):
  (1) `parseBlob` now slices the gateId prefix by its UTF-8 **byte**
  length (`gateIdBytes.length`) instead of the UTF-16 code-unit length
  (`gateId.length`) — `buildBlob` emits `utf8(gateId)`, so a non-ASCII
  gateId previously desynced the field offsets and a well-formed
  credential was wrongly rejected (AC-3 violation); now round-trips for
  any `gateId: string`. (2) `coerceWindow` now **throws** `GateError`
  `SC-IDENTITY-1` for a non-finite / fractional `attestedUntilWindow`
  instead of silently `Math.trunc`-ing it — matching the documented
  `@throws` "non-integer" contract (a window is a chain-time integer,
  AD-3). (3) `verify` now rejects a non-finite / fractional / negative
  `windowIndex` with the normal `REJECT` value instead of letting
  `BigInt(windowIndex)` throw — honoring the "reject = normal false, not
  error" convention for type-legal `number` inputs.

## Review Triage Log
| Lens | Finding | Verdict | Action |
|------|---------|---------|--------|
| quick | `parseBlob`/`buildBlob` disagree on gateId prefix length for non-ASCII gateId (UTF-16 `gateId.length` vs UTF-8 bytes) → a well-formed issuer credential for a non-ASCII accepted gateId is rejected (AC-3 violation; suite green only because genesis gateIds are ASCII) | **high — real bug** | FIXED: `idStart = gateIdBytes.length` (UTF-8 byte length); added a `gâté` round-trip assertion to GATE_REGISTRY_REJECT (c) |
| quick | `coerceWindow` uses `Math.trunc` → a fractional `attestedUntilWindow` (e.g. `100.9`) is silently truncated and accepted, contradicting the documented `@throws` "non-integer" | **medium — real (honest contract + correctness)** | FIXED: `coerceWindow` throws `GateError` on a non-finite/fractional window; added a `toThrow(GateError)` assertion for `100.9` to GATE_OFFLINE_VERIFY |
| quick | `issueGateCredential` `@throws` list incomplete for out-of-range `bigint` | **low — decline** | Moot after finding-2 fix: `coerceWindow` becomes the single throw site for all non-bigint/out-of-range paths and its message names `attestedUntilWindow`; the doc is now accurate |
| quick | `verify` does `BigInt(windowIndex)` unguarded → `NaN`/`5.5`/`-1` (all type-legal `number`s) throw `RangeError` instead of returning the normal `REJECT` | **medium — real (contract violation)** | FIXED: `verify` rejects a non-finite/fractional/negative `windowIndex` with `REJECT`; added a loop of invalid-window assertions to GATE_WINDOW_CHAIN_TIME |
| quick | The "offline MAC" is unkeyed (plain `sha256` over public data) — anyone can mint a MAC-valid credential for an accepted gateId; the registry is the only real gate | **decline — by design** | AD-4 mandates a *deterministic OFFLINE* verifier with no network; the real attestation is the EXTERNAL gate. The offline verifier is a deterministic test/sim stand-in, not the authenticity boundary. The registry (must-hold (c)) + the external gate are the auth boundary. No code change. |
| quick | `GATE_NO_BLOB_LEAK` (b) scan weaker than its self-test (no `import`-alias / dynamic `cred['blob']` detection; relies on `stripComments`' "no comment marker in a string" assumption) | **low — decline** | Mirrors the standing `no-float-guard.test.ts` `stripComments` + walker pattern verbatim (repo convention, established + passing). A future reader would still need to defeat the self-test. No code change. |

## Implementation Notes

- **Files added** (4.1's full change surface): `src/identity/gate-verifier.ts`
  (verifier factory + issuer + `GateError` `SC-IDENTITY-1`), `src/identity/index.ts`
  (barrel), `test/identity-gate.test.ts` (the 5 frozen rows, root-barrel imports
  only). `src/index.ts` gained ONE additive export block
  (`GateError` / `createOfflineGateVerifier` / `issueGateCredential` + the
  `IssueGateCredentialParams` type) — no existing export touched. `ports.ts`,
  `protocol.proto`, and every existing consensus/ledger/test file are
  byte-identical (build's protons regen + `git status` confirm an empty proto
  diff).
- **D3 blob format as built** — `blob = utf8(gateId) ‖ utf8(identityId) ‖
  u64be(attestedUntilWindow) ‖ sha256("SC-GATE-CRED/1" ‖ utf8(gateId) ‖
  utf8(identityId) ‖ u64be(attestedUntilWindow))` (32-byte offline MAC
  trailing). The verifier's `parseBlob` re-derives the MAC over the blob's
  OWN window bytes (so the check is self-consistent) and requires the blob's
  leading `gateId` bytes to equal `cred.gateId`. Minimum well-formed blob is
  40 bytes (empty id + 8 + 32); identity is then shape-checked to exactly
  64 lowercase hex chars. Non-UTF-8 id regions are rejected via a
  `TextDecoder` with `fatal: true`. All byte helpers (`u64be` /
  `bytesToBig` / `concat` / `sha256` / constant-time-ish `bytesEqual`) are
  local to the module — the `pow.ts` / `draw.ts` pattern, no imports from
  consensus.
- **Reject convention** — `verify` returns the shared
  `{ valid: false, identityId: "", attestedUntilWindow: 0 }` value for
  EVERY reject (registry miss, malformed blob, MAC mismatch, bad id shape,
  blob/`gateId` mismatch, lapsed window) and never throws for a rejected
  credential (the `verifyDraw` convention). The ONLY throw paths are
  programming errors in `issueGateCredential` / the u64be range (an empty
  `gateId`, a non-hex-64 id, an out-of-range window) — the issuer mints
  only well-formed credentials, so the reject path is exercised solely by
  tampering, as the matrix intends.
- **GATE_NO_BLOB_LEAK (b) scan design** — pattern
  `/\.blob(?![\w(])/` over comment-stripped `src/**/*.ts` (the
  `no-float-guard.test.ts` `stripComments` + recursive walker, verbatim).
  It matches reads (`cred.blob`, `c?.blob`) but NOT the `ports.ts` type
  declaration (`blob: Uint8Array` — no dot), method calls (`.blob()`),
  longer identifiers (`.blobx`), or prose. Result: exactly
  `identity/gate-verifier.ts`. The self-test of the pattern lives INSIDE
  the GATE_NO_BLOB_LEAK `it` (the plan pins 5 tests / 168 total, so no
  separate self-test `it`).
- **GATE_NO_BLOB_LEAK (a) Ticket schema check** — type-level
  (`'credentialBlob' extends keyof Ticket ? never : true` — a new proto
  blob field breaks compilation) + runtime (the decoded object's key set is
  exactly the five declared fields; `'blob' in t` is false). No proto
  change, per D6 / AD-12.
- **Registry provenance (the entry's `unknown`)** — resolved as D2 says:
  the factory takes `acceptedGates` from the caller; the test feeds it
  `loadGenesis(config/genesis.json).gates` (the real single source —
  `["biometric", "social-graph"]`), never a hard-coded list.
- **Determinism** — `corepack pnpm test identity-gate` run TWICE: both
  `5 passed (5)`; the GATE_OFFLINE_VERIFY row also asserts within-run
  identity of the verify result AND of the issuer's bytes for identical
  inputs.
- **Verification gate output (all green)** — `corepack pnpm test`: 168
  tests / 22 files passed (163 prior + 5 new); `corepack pnpm typecheck`:
  clean; `corepack pnpm build` + `git diff --name-only --
  packages/core/src/proto/`: empty diff (PROTO_OK); `corepack pnpm test
  no-float-guard`: 6 passed (big.js specifier set still exactly
  `[ledger/display.ts, ledger/fee.ts]`); `git status --short`: ONLY
  `packages/core/src/index.ts` (M) + the new `src/identity/` dir +
  `test/identity-gate.test.ts` (+ this untracked plan file).
- **Post-review (Quick lens, 6 findings → 3 fixed / 3 declined, see
  Review Triage Log)** — `parseBlob` now slices the gateId prefix by UTF-8
  byte length (non-ASCII gateIds round-trip); `coerceWindow` throws
  `GateError` on a non-finite/fractional `attestedUntilWindow`; `verify`
  rejects a non-finite/fractional/negative `windowIndex` with the normal
  `REJECT` (never a throw). Three assertions added (a `gâté` round-trip, a
  `100.9` `toThrow(GateError)`, an invalid-window loop). All patches are
  backward-compatible — the 5 frozen rows still pass unchanged.
- **Final gate (post-review, re-run by the orchestrator, all green)** —
  `corepack pnpm test`: **168 tests / 22 files**; `corepack pnpm
  typecheck`: clean; `corepack pnpm build` + `git diff --name-only --
  packages/core/src/proto/`: empty (PROTO_OK); `corepack pnpm test
  no-float-guard`: 6 passed; `corepack pnpm test identity-gate` run
  TWICE: both `5 passed (5)` (deterministic). Change surface unchanged:
  `src/index.ts` (M) + new `src/identity/` + `test/identity-gate.test.ts`
  (+ this plan file).
