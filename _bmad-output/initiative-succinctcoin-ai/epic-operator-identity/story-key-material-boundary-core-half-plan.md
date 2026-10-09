---
ticket: "7"
title: "Key material boundary (keys never leave core in plaintext)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "25102e8efb0a840edf9de4448a30ff9464e11b70"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [E1]
context:
  - packages/core/src/events/types.ts
  - packages/core/src/identity/identity.ts
  - packages/core/src/identity/index.ts
  - packages/core/src/ports.ts
  - packages/core/src/index.ts
  - packages/core/test/identity-gate.test.ts
  - packages/core/test/identity-signature.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.7 Key material boundary (keys never leave core in plaintext)

## Story of truth

Guard **AD-11 in the core**: identity private keys **live in the core** and are
**never exposed through the core read API or event payloads in plaintext** — the
**core half** of the AD-11 boundary (the renderer / preload IPC half is **epic
6**, not this epic). The UI-facing surface receives **only identity ids, status,
and signed artifacts** — never the private key.

Concretely, the guard proves:
1. **The private key is absent from the read-API surface and the event
   payloads** — no read-API method return type and no event payload carries a
   key-material field (`secret` / `privateKey` / `key` / `keypair`).
2. **The surface exposes only identity ids / status / signed artifacts** —
   `ReadPeer` = peer ids, `ReadBlock` = status + winner id, the events = status
   (`slot`); the key set of every surface type is exactly that.
3. **The key material stays contained in the identity module** — the only module
   in `src/` that reads the keypair `secret` is `identity/identity.ts` (the
   AD-11 key-material owner); it cannot leak to the surface because no other
   module touches it.
4. **The guard is non-vacuous** — the keys DO live in core (present, usable for
   signing, a distinct field separate from the public `identityId` /
   `publicKey`); the boundary is "never in the **public surface**", not "never in
   core".

This is a **TEST-ONLY guard story** (the repo's established guard-test
convention — 2.5 `no-float-guard`, 4.1 `GATE_NO_BLOB_LEAK`, 3.9 e2e scans): one
new test file, **no source module added**. The "type-level boundary" is expressed
by **type-level assertions in the test** (a key-material field added to any
public-surface type would **fail compilation of the test**), plus runtime key-set
checks and a comment-stripped source scan. It does **NOT** change
`events/types.ts`, `identity/identity.ts`, `identity/index.ts`, `ports.ts`,
`protocol.proto`, any `src/consensus` module, the genesis seam, or
`config/genesis.json`.

## The epic requirement this delivers (E1 / AD-11)

- **Keys live in core** — the identity private key material (`secret`, the PKCS#8
  DER) is present in `core/identity` and usable for signing (AD-11: "identity
  private keys live in the core (Electron main process)").
- **Never in the read API / event payloads in plaintext** — no core read-API
  method or event payload exposes the private key; the surface is **only identity
  ids / status / signed artifacts** (AD-11: "the UI receives only peer IDs,
  status, and signed artifacts").
- **Core half, not the IPC half** — this story guards the **core's public
  surface** (the read-API + event types in `events/types.ts`); the renderer /
  preload IPC boundary that consumes that surface is **epic 6 (CAP-4)**.

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — TEST-ONLY guard, no source module (the repo guard-test convention).**
  The "type-level boundary" is realized as **type-level assertions inside the new
  test** (the 2.5 `no-float-guard` / 4.1 `GATE_NO_BLOB_LEAK` / 3.9 e2e-scan
  convention): a key-material field added to any public-surface type
  (`ReadPeer` / `ReadBlock` / a `CoreEvents[K]` payload) would **fail
  compilation of the test**, so the boundary is enforced at build time without
  changing `events/types.ts`. This keeps the story **strictly additive** (no
  source change; the proto is untouched).
- **D2 — The public surface is exactly the `events/types.ts` types (AD-1/AD-9:
  one owner).** The core's UI-facing surface is owned by `core/events/`
  (`CoreEvents`, `CoreReadApi`, `ReadPeer`, `ReadBlock`, `CoreInstance`). The
  guard inspects **exactly those types** (imported from the **root barrel**):
  the read-API return types (`ReadPeer[]`, `ReadBlock`) and every event payload
  (`CoreStarted` / `CoreStopped` = `{ slot }`). If the surface grows, the
  surface set is defined **from the types themselves** (via `keyof` over the
  event map), so the guard tracks it.
- **D3 — "Key material" = the private-key fields, by name.** The private key is
  `IdentityKeypair.secret` (the PKCS#8 DER, 4.2). The guard treats a **key
  material field** as any of the names `secret` / `privateKey` / `privateKeyHex`
  / `keypair` on a surface type / payload. The **public** fields —
  `identityId` (hex public key), `publicKey`, and signed artifacts (the ticket
  `signature`) — are **allowed** on the surface (AD-11 permits "peer IDs, status,
  and signed artifacts"); only the private-key material is banned.
- **D4 — Source scan: only the identity module reads the keypair `secret`.** A
  comment-stripped scan of every `.ts` under `src/` asserts the **only** module
  that reads the `secret` field (a `.secret` access) is `identity/identity.ts`
  (the AD-11 key-material owner — `keypair.secret` in `signTicket`). No other
  module reads the secret, so it **cannot** be projected into the surface
  (the same "single reader" invariant as 4.1's `GATE_NO_BLOB_LEAK` for `.blob`).
- **D5 — Non-vacuity: the keys ARE in core (present, usable, distinct).** The
  guard must not pass vacuously by there being no key at all. It asserts:
  `deriveIdentityKeypair` (core) returns a keypair whose `secret` is a
  **non-empty distinct field** (the private key is present in core); the public
  fields `identityId` = hex(`publicKey`) and `publicKey` do **not** contain /
  alias the `secret` (the public surface fields are genuinely public); and
  `signTicket` produces a verifiable signature from the keypair (the keys are
  **usable in core**). This is the AD-11 "keys live in core" half that makes the
  "never in the public surface" boundary meaningful.
- **D6 — Test-only, deterministic, root-barrel-only (AD-3).** The test imports
  **only** from the root barrel `../src/index.js` (+ `node:path` / `node:url` /
  `node:fs` for the source scan, as 4.1's `GATE_NO_BLOB_LEAK` does) — it never
  re-implements the keypair / signature. A fixed 32-byte seed (the 4.2 golden
  seed) makes the keypair deterministic (no RNG, AD-3). The source scan is over
  the committed `src/` tree (no I/O nondeterminism). No `big.js` (AD-5); no
  float.

## Frozen I/O matrix (each row a passing test)

Shared deterministic fixture (AD-3: no RNG): a fixed 32-byte seed (the 4.2
golden seed `00..1f` → `identityId` `03a107…5531b8`), a keypair from the
**IMPORTED** `deriveIdentityKeypair`, the public surface types (`ReadPeer`,
`ReadBlock`, `CoreEvents`) imported from the **ROOT barrel**. The surface
key-material-name set is `{ secret, privateKey, privateKeyHex, keypair }`.

| Row | Input | Expected |
|-----|-------|----------|
| KEY_SURF_NO_KEY_MATERIAL_TYPE | the public-surface types: `ReadPeer`, `ReadBlock`, and every `CoreEvents[K]` payload (over `K in keyof CoreEvents`); the key-material-name set `{secret, privateKey, privateKeyHex, keypair}` | **type-level**: for EVERY public-surface type `T` and EVERY key-material name `n`, `n extends keyof T` is `false` (asserted via `n extends keyof T ? never : true` — a key-material field added to any surface type **fails compilation of the test**); the surface carries **no** private-key material in plaintext (AD-11) |
| KEY_SURF_ONLY_IDS_STATUS_SIGNED | runtime: build a `ReadPeer`, a `ReadBlock`, and every `CoreEvents[K]` payload from their declared fields | each surface type's key set is **exactly** its declared ids/status/signed-artifact set — `ReadPeer` = `{ multiaddrs, peerId }`, `ReadBlock` = `{ hash, slot, ticketCount, txCount, winnerIdentityId }`, `CoreStarted`/`CoreStopped` = `{ slot }` — and **none** contains a key-material key (`secret` / `privateKey` / `privateKeyHex` / `keypair`); the surface exposes **only identity ids / status / signed artifacts** (AD-11) |
| KEY_SURF_PRIVATE_KEY_ABSENT | runtime: the private key `secret` (the keypair's PKCS#8 DER bytes) vs every surface payload + read-model | the private key is **absent**: for every surface payload / read-model, `'secret' in x === false` AND **no** field's value is the keypair's `secret` bytes (the secret is not **projected** into any read-API return or event payload); the private key never crosses the core public surface in plaintext (AD-11) |
| KEY_SURF_SECRET_LIVES_ONLY_IN_IDENTITY | a comment-stripped source scan of every `.ts` under `src/` for a `.secret` READ (dot + `secret`, no following word char, not a call) | the **only** module that reads the keypair `secret` is `identity/identity.ts` (the AD-11 key-material owner — `keypair.secret` in `signTicket`); **no** other module reads the secret, so it cannot leak to the surface (the "single reader" invariant, mirroring 4.1's `GATE_NO_BLOB_LEAK` for `.blob`); the scan self-test proves it matches `.secret` reads, not declarations / calls / longer ids / prose / comments |
| KEY_SURF_KEYS_PRESENT_IN_CORE | a keypair from the **IMPORTED** `deriveIdentityKeypair` (the 4.2 golden seed) + `signTicket` / `verifyTicketSignature` over a pinned `TicketFields` | the keys **live in core** (non-vacuity): `secret` is a **non-empty** distinct field (the private key is present in core — AD-11 "keys live in the core"); `identityId` === hex(`publicKey`) and `publicKey` **do not contain / alias** `secret` (the public fields are genuinely public, the secret is separate); and `signTicket` → a signature that `verifyTicketSignature` accepts (the keys are **usable in core**) — so the "never in the public surface" boundary is meaningful, not vacuous |

## Tasks

- [x] Add `test/identity-key-surface.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the keypair / signature;
  `node:path` / `node:url` / `node:fs` for the source scan, as 4.1's
  `GATE_NO_BLOB_LEAK` does): the 5 matrix rows (KEY_SURF_NO_KEY_MATERIAL_TYPE /
  KEY_SURF_ONLY_IDS_STATUS_SIGNED / KEY_SURF_PRIVATE_KEY_ABSENT /
  KEY_SURF_SECRET_LIVES_ONLY_IN_IDENTITY / KEY_SURF_KEYS_PRESENT_IN_CORE), with
  a deterministic fixture (the 4.2 golden 32-byte seed → the pinned
  `identityId`; the public surface types from the root barrel; the key-material
  name set `{ secret, privateKey, privateKeyHex, keypair }`). **TEST-ONLY — no
  source file under `src/` is touched.**
- [x] Run the verification gate; confirm the epic-3 `verify-draw` (12), `sim`
  (5), `e2e` (5) suites — and the 4.1 `identity-gate` (5), 4.2
  `identity-signature` (5), 4.3 `accept-winner` (5), 4.4 `acceptance-cap` (5),
  4.5 `uptime` (5), 4.6 `re-attestation` (5) suites — stay green (the ADDITIVE
  constraint) and the new suite is deterministic.

## Acceptance criteria

1. **No core read-API method or event payload exposes an identity private key in
   plaintext**: for every public-surface type (`ReadPeer`, `ReadBlock`, every
   `CoreEvents[K]` payload), **no** key-material field (`secret` / `privateKey` /
   `privateKeyHex` / `keypair`) is present — enforced **type-level** (a
   key-material field added to a surface type fails compilation of the test) and
   at **runtime** (`'secret' in x === false`, and no field value is the keypair's
   `secret` bytes).
2. **The surface exposes only identity ids / status / signed artifacts (AD-11)**:
   `ReadPeer` = peer ids, `ReadBlock` = status + winner id, the events = status
   (`slot`); each surface type's key set is exactly its declared ids/status/
   signed-artifact set.
3. **The key material stays contained in the identity module**: a
   comment-stripped source scan of `src/**/*.ts` shows the **only** module that
   reads the keypair `secret` is `identity/identity.ts` — it cannot leak to the
   surface.
4. **The guard is non-vacuous**: the keys **live in core** (present, usable,
   distinct) — `deriveIdentityKeypair` returns a keypair with a non-empty
   distinct `secret`, `identityId` = hex(`publicKey`) with `publicKey` not
   containing the `secret`, and `signTicket` → a verifiable signature.
5. **ADDITIVE / test-only**: no source file under `src/` is touched; the
   epic-3 `verify-draw` (12), `sim` (5), `e2e` (5) suites — and the 4.1
   `identity-gate` (5), 4.2 `identity-signature` (5), 4.3 `accept-winner` (5),
   4.4 `acceptance-cap` (5), 4.5 `uptime` (5), 4.6 `re-attestation` (5) suites —
   stay green; `events/types.ts` / `identity/identity.ts` / `ports.ts` /
   `protocol.proto` / the genesis seam / `config/genesis.json` are **UNCHANGED**;
   no `big.js` (AD-5).

## Never

- NEVER change a source file under `src/` — 4.7 is a **test-only guard** (the
  type-level boundary lives in the test's type-level assertions); the renderer /
  preload IPC half of AD-11 is **epic 6**, not this epic.
- NEVER let a key-material field (`secret` / `privateKey` / `privateKeyHex` /
  `keypair`) appear on any public-surface type (`ReadPeer` / `ReadBlock` / a
  `CoreEvents[K]` payload) — the surface is **only identity ids / status / signed
  artifacts** (AD-11).
- NEVER let the keypair `secret` be **projected** into a read-API return value or
  an event payload (by value, not just by name) — the private key never crosses
  the core public surface in plaintext.
- NEVER re-implement the keypair / signature in the test — the keypair is from
  the **IMPORTED** `deriveIdentityKeypair`, the signature from `signTicket` /
  `verifyTicketSignature` (the test only inspects the surface + scans `src/`).
- NEVER make the guard **vacuous** — assert the keys ARE present in core
  (non-empty distinct `secret`, usable via `signTicket`); the boundary is "never
  in the **public surface**", not "never in core".
- NEVER use `big.js` or a float (AD-5), or RNG / the wall clock (AD-3) — the
  fixture is a fixed seed; the source scan is over the committed `src/` tree.
- NEVER scan files outside `src/` (the guard is about the core's own source; the
  renderer is epic 6) and NEVER treat a `.secret` **declaration** (no leading
  dot), a call, a longer identifier, prose, or a comment as a `secret` read.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **193 prior + 5 new = 198 tests,
  28 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.7 is test-only (no proto).
- **ADDITIVE constraint (the HARD one):** `corepack pnpm test
  consensus-verify-draw` → **12 passed**; `corepack pnpm test simulation` →
  **5 passed**; `corepack pnpm test epic-end-to-end` → **5 passed**;
  `corepack pnpm test identity-gate` → **5 passed**; `corepack pnpm test
  identity-signature` → **5 passed**; `corepack pnpm test consensus-accept-winner`
  → **5 passed**; `corepack pnpm test consensus-acceptance-cap` → **5 passed**;
  `corepack pnpm test consensus-uptime` → **5 passed**; `corepack pnpm test
  identity-re-attestation` → **5 passed** — all UNCHANGED (the guard is a NEW
  test file; it changes no source).
- **TEST-ONLY check:** `git status --short` shows **only** the new test file
  untracked (no `src/` modification).
- Determinism: run `corepack pnpm test identity-key-surface` TWICE — both pass
  with the identical surface / scan outcomes.
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]`).

## Implementation Notes
- TEST-ONLY guard delivered exactly as planned: one new test file
  `packages/core/test/identity-key-surface.test.ts`, zero source changes
  (`git diff` over `packages/core/src/` is empty; `git status` shows only the
  new test file + this plan). All 5 frozen rows are passing tests:
  type-level per-name `SurfaceClean<T>` mapped types over `ReadPeer` /
  `ReadBlock` / every `CoreEvents[K]` payload (a single added key-material
  field fails compilation — empirically confirmed), runtime exact key-set
  checks (2/5/1 keys; none key-material), by-value secret absence
  (`'secret' in x === false` + `sameBytes` over every field, proven not
  always-false), the comment-stripped `.secret` READ scan over `src/**/*.ts`
  (exactly `['identity/identity.ts']` + 8-case self-test), and the
  non-vacuity row (non-empty distinct secret, `identityId === hex(publicKey)`,
  `signTicket` → `verifyTicketSignature` true, deterministic, `IdentityError`
  on a 31-byte seed). 198/198 tests (28 files); typecheck clean; build clean
  + PROTO_OK; the 4.1–4.6 + epic-3 suites (12/5/5/5/5/5/5/5/5) all unchanged;
  `no-float-guard` 6/6; determinism confirmed (ran twice).

## Plan Change Log
- 2026-10-08 (4.7 implementation) — no forced deviation from the frozen matrix / ACs. One
  clarification of mechanics, recorded for the next reviewer: the row
  KEY_SURF_NO_KEY_MATERIAL_TYPE's formula `n extends keyof T ? never : true` is applied
  **per name** via a mapped type `{ [N in KeyMaterialName]: N extends keyof T ? never :
  true }` over each surface type (plus a `keyof CoreEvents`-derived set over every event
  payload). A union-level `KeyMaterialName extends keyof T ? never : true` would resolve to
  `true` unless ALL FOUR names were present, so a single `secret` field added to
  `ReadPeer` would not fail compilation and AC #1's "a key-material field added to any
  surface type fails compilation of the test" would be vacuous. Per-name, the guard bites
  on the first added field. Verified empirically: temporarily adding `secret: Uint8Array`
  to `ReadPeer` in `events/types.ts` failed `pnpm typecheck` with
  `Type 'true' is not assignable to type 'never'` in the test (then reverted — `src/` is
  byte-identical to baseline; the mutation was a verification step only, not a source
  change).

## Review Triage Log
| Lens | Finding | Verdict | Action |
|------|---------|---------|--------|
| quick | (none) — reviewer empirically reproduced the compile-time guard (single added `secret` field fails tsc), re-ran the scan over all 31 `src/` files (only `identity/identity.ts` reads `.secret`), and confirmed the by-value check is not vacuous; two non-defect nuances noted (by-value row validates synthetic payloads — the real projection guarantee is the row-4 scan + the stubbed read-API; the exact-key-set pin is hardcoded for `ReadPeer`/`ReadBlock` while event payloads auto-track via `keyof`) | n/a | n/a — no patch needed |
