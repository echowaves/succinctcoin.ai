---
title: 'Witness issuance + local witness store'
type: 'feature'
ticket: '2'
created: '2026-11-04'
status: done
baseline_revision: '2eff8cdd3e749da94af604df3fd4bb127859d354'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** WB-2 (spec-scinvite-v2): a witness-backed invite is only as strong as the attestations inside it — any node must be able to sign "address Y of peer X was reachable for me" with its identity key, bounded so the node is never an unbounded signing oracle, and keep fresh witnesses locally for later minting/gossip (13.4/13.5).

**Approach:** New pure module `packages/core/src/discovery/witness.ts`: pinned digest + `issueWitness` signer using the core-held `IdentityKeypair`; pure `verifyWitnessSignature` + full `verifyWitness(witness, ctx)` (shape → chain → half-open slot window → signature); a factory `createWitnessIssuer` enforcing kill-switch/empty-evidence/cap declines; a factory `createWitnessStore` keeping fresh witnesses with slot-parameterized eviction. No wiring yet — 13.4 stores received witnesses, 13.5 mints from the store.

## Boundaries & Constraints

**Always:**
- Mirror `introductions.ts` structure exactly (fields → digest → sign → verify → reason union → ctx → validator; local copies of sha256/concat/u64be/u32be/hexToBytes — self-contained-module pattern).
- Domain constant `REACHABILITY_WITNESS_DOMAIN = 'succinctcoin/ReachabilityWitness/v1\0'`; digest covers EXACTLY the five ticket-pinned fields (targetIdentityId, address, chainId, firstSeenSlot, expirySlot) — signer identity is bound by the pubkey, NOT in the bytes.
- Signing only via `signDigest(keypair, digest)` from `../identity/identity.js` (AD-11 — it stays unexported from `src/index.ts`); verify rebuilds SPKI pubkey from hex id like `verifyPeerAnnouncementSignature` (never throws).
- Slot bounds HALF-OPEN `[firstSeenSlot, expirySlot)` on caller-supplied `currentSlot` (AD-3 — no clocks anywhere; note: announcements use closed intervals, witnesses deliberately half-open per ticket).
- Cost order in `verifyWitness`: shape → chain-mismatch → slot window → Ed25519 last (pinned row, mirroring SIG_BEFORE_EXPIRY).
- Pinned constants: `DEFAULT_WITNESS_EXPIRY_SLOTS = 96` (3× the 32-slot liveness lookback — resolves the ticket unknown), `WITNESS_ISSUANCE_WINDOW_SLOTS = 32n`, `MAX_ISSUANCES_PER_TARGET_WINDOW = 8` (matches MAX_MULTIADDRS), `MAX_WITNESSES_PER_TARGET = 16` (mirrors MAX_VOUCHES_PER_SUBJECT).
- Declines are `{ ok: false, reason }` unions with pinned literals — issuance: `'issuance-disabled' | 'no-evidence' | 'issuance-cap-reached'`; verify: `'malformed-witness' | 'chain-mismatch' | 'not-yet-valid' | 'expired' | 'bad-signature'`.
- Store = interface + factory closure over Maps (NO classes in discovery); copy-on-read snapshots; `pruneExpired(currentSlot): number`; window counter bucketed `currentSlot / WITNESS_ISSUANCE_WINDOW_SLOTS` (round-counted discipline, no clocks).

**Never:**
- No k-of-n, distinct-signer, diversity or direct-first logic (13.3); do NOT touch `invitation.ts`'s `candidates-unverified` stub or any v1/v2 codec path.
- No gossip/proto changes (`ReachabilityWitness` exists since 13.1 — PROTO untouched), no adapter/node-loop wiring, no `process.env` reads (the loopback seam is the only sanctioned one).
- No export of `signDigest`; do not reuse "witnesses" naming from peerbook Introduction vouches — different concept.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Issue → verify round-trip | issuer.issue({target, addr}, slot) → verifyWitness(w, ctx) | ok:true; slots bigint intact; signer = issuer identity | — |
| Tamper any of 5 fields | re-encoded witness with one field changed | signature check fails (`bad-signature`) | never throws |
| Wrong chain | witness.chainId ≠ ctx.expectedChainId | `chain-mismatch` BEFORE signature cost (garbage sig still says chain-mismatch) | — |
| Expiry boundaries | currentSlot = firstSeen−1 / firstSeen / expiry−1 / expiry | not-yet-valid / ok / ok / expired (half-open) | — |
| Cap filled | cap+1 issues for one target in one window | first 8 ok, rest `issuance-cap-reached`; next window issues again | decline returns NO witness |
| Kill switch / empty evidence | enabled:false; or blank address / non-hex target | `issuance-disabled` / `no-evidence`, no signature produced | — |
| Store freshness | add expired witness; pruneExpired(current) | add refused `expired`; prune removes `[expiry <= current]`, returns count | — |

</intent-contract>

## Code Map

- `packages/core/src/discovery/introductions.ts` — THE structural template: fields :114, digest :139, sign :160, verifySignature :171 (SPKI rebuild from hex id, try/catch→false), reason union :202, ctx :217, validator :236, private `fail()` :291. Copy its header-docblock style.
- `packages/core/src/identity/identity.ts` — `IdentityKeypair` :64 (hex id, PKCS#8 secret), `deriveIdentityKeypair` :212, `signDigest` :304 (the ONLY signing seam; not re-exported from src/index.ts). SPKI_PREFIX pattern: announcements.ts verify.
- `packages/core/src/discovery/announcements.ts` — digest layout convention (domain ‖ fields, u32be length prefixes), chain-check-before-sig cost order :392–397, `coerceSlot` RangeError-on-junk discipline, MAX_* const naming.
- `packages/core/src/discovery/address-book.ts` — store shape: interface :165 + `createAddressBook` closure :340, options-with-defaults, `pruneExpired(currentSlot): number` :205, copy-on-read `snapshot()` :396, per-subject cap MAX_VOUCHES_PER_SUBJECT :87.
- `packages/core/src/proto/index.ts` — `ReachabilityWitness` type+codec already exported (:58/:89); slots bigint on decode; encode takes INPUT shape (all optional) — build Input, BigInt-normalize slots first (mintV2 pattern in invitation.ts :214).
- `packages/core/src/discovery/invitation.ts` — DO NOT CHANGE. `InviteWitnessInput` :97 mirrors the wire shape 13.2's witnesses must satisfy; `DEFAULT_TICKET_LOOKBACK_SLOTS = 32` :60 is the constant the expiry default references.
- Barrels: `discovery/index.ts` (value+type export pair per module), `src/index.ts` invite block :968–987 (add witness exports beside it).
- `packages/core/test/discovery-lint.test.ts` — FORBIDDEN_UI_SYMBOLS :249 (contains signPeerAnnouncement/signIntroduction): add `'issueWitness'`.
- Tests: `packages/core/test/discovery-invitation.test.ts` fixtures to mirror — KEYPAIR/OTHER via `deriveIdentityKeypair` deterministic seeds :72–76, frozen LIVE ctx :~100, CAPS-row header table + `describe('13.2 — …')` naming, MODULE_PURE source-scan row.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/discovery/witness.ts` (NEW) -- constants, `WitnessFields`/`WitnessContext`/`WitnessValidation`/`WitnessRejectReason`/`WitnessIssuance`, `witnessDigest`, `issueWitness(keypair, fields)` (pure signer; pins signerIdentityId = keypair identity), `verifyWitnessSignature(fields, signature): boolean`, `verifyWitness(witness, ctx)` (cost order), `createWitnessIssuer({keypair, expectedChainId, expirySlots?, windowSlots?, capPerWindow?, enabled?})` with `.issue({targetIdentityId, address}, currentSlot)`, `createWitnessStore({expectedChainId})` with `add/get/pruneExpired/size` -- all pinned constants named and exported
- [ ] `packages/core/src/discovery/index.ts` + `src/index.ts` -- export pair for witness values/types -- public surface only; `signDigest` stays internal
- [ ] `packages/core/test/discovery-witness.test.ts` (NEW) -- header CAPS table; rows: ISSUE_VERIFY_ROUNDTRIP, SIG_TAMPER (each of the 5 fields separately), WRONG_SIGNER (forged signerIdentityId under a valid sig), CHAIN_MISMATCH_BEFORE_SIG (garbage sig + wrong chain ⇒ chain-mismatch), EXPIRY_BOUNDARY (all four boundary slots), ISSUANCE_DISABLED, NO_EVIDENCE (blank addr; non-hex target), CAP_ROW (8 ok then decline; next window ok again), DECLINE_YIELDS_NO_SIGNATURE, STORE_ADD_GET_FRESH, STORE_REJECTS_EXPIRED_ON_ADD, STORE_EVICT (prune count + get-filter), STORE_FRESHEST_KEPT (same signer+address, later expiry wins), STORE_PER_TARGET_CAP, DIGEST_DOMAIN_PIN (digest ≠ peerAnnouncementDigest/introduction digests — domain separation), MODULE_PURE
- [ ] `packages/core/test/discovery-lint.test.ts` -- add `'issueWitness'` to FORBIDDEN_UI_SYMBOLS -- AD-11: signing never reaches preload/renderer

**Acceptance Criteria:**
- Given a keypair and evidence, when the issuer signs a witness, then an independent `verifyWitness` with matching ctx accepts, and tampering any single signed field makes it fail with `bad-signature`.
- Given issuance policy, when the per-target window cap is hit or the kill switch is off or evidence is empty, then the decline carries its pinned reason and NO signature bytes exist anywhere in the result.
- Given the store, when witnesses expire against a caller-supplied currentSlot, then reads filter them and `pruneExpired` removes exactly those (returned count), across both issued and add()-ed witnesses.
- Given every pre-change test file untouched (except the lint list line), when root suites run headless, then all pass; app is unchanged.

## Implementation Notes

- **Done 2026-11-04.** Full route, implementing subagent; parent re-read the whole
  diff and re-ran every gate personally: root build green (proto regen diff EMPTY),
  `pnpm typecheck` clean, root vitest **592/71** (baseline 575/70 + 17 witness rows —
  file proven registered via standalone run), app tsc clean, app vitest **85/10**
  unchanged. Files: `witness.ts` (NEW 566 ln), `discovery-witness.test.ts` (NEW 386 ln),
  export pairs in `discovery/index.ts` + `src/index.ts`, `issueWitness` added to
  FORBIDDEN_UI_SYMBOLS (lint :253).
- **Deviation accepted (digest layout):** the Code Map mentioned announcements'
  u32be length prefixes; the shipped digest is bare utf8 concatenation of the five
  fields — which matches the CLOSEST template `introductions.ts` `introductionDigest`
  (:141, also bare utf8 parts), and the module header pins the exact layout. Field-
  boundary ambiguity is unreachable in practice: targetIdentityId is fixed-width hex
  and chainId only ever equals ctx.expectedChainId at verify (chain gate before sig).
- **Decisions:** issuer keeps ONE live rate bucket (rolled bucket cleared, never
  consulted); store dedupe key `address\0signer` per target; add() normalizes slots
  to bigint (wire form) but stores the signature by reference — reads snapshot
  (`.slice()`), matching address-book's copy-on-read pattern. Declines return exactly
  `{ok:false, reason}` (pinned by key-set assertion).
- **Not done here (by plan):** no wiring — kill-switch env seam at the adapter is a
  later ticket; self-witness (signer == target) is NOT rejected here (distinct-signer
  law is 13.3's); expiry > firstSeen is not enforced beyond shape.
- **Pass 2 (review patch):** store `add()` now slices the signature on write too
  (double-defense mirror); STORE_ADD_GET_FRESH grew a copy-on-write assertion.
  Gates re-run green after the patch.

## Plan Change Log

## Review Triage Log

### 2026-11-04 — Review pass 1 (quick lens)
- verdicts: 3 findings — high 0, medium 0, low 1, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` store `add()` kept the caller's signature BY REFERENCE while the cited template (address-book.ts:574) slices on WRITE as well as read — verified true at witness.ts:491; action: `signature: w.signature.slice()` + copy-on-write pin appended to STORE_ADD_GET_FRESH (mutate caller bytes post-add, store still verifies)
  - `[false]` `[reject]` `issue()` can throw RangeError when `currentSlot + expirySlots` overflows u64 — verified at witness.ts:417, but the bad outcome needs currentSlot ≥ 2⁶⁴−96: unrepresentable chain-time under any slot cadence; a loud documented-precondition throw on absurd caller input is correct behavior per repo discipline, not a decline-worthy hostile case
  - `[false]` `[reject]` exported `verifyWitnessSignature` alone tolerates address‖chainId field rebinding (bare-utf8 digest) — true as arithmetic but no caller gets a gate-free verify: the module header sends receivers to `verifyWitness` (chain gate before sig forces A′=A), and the named template `verifyIntroductionSignature` (:171) has the identical primitive-shape; hardening it is a pre-existing-pattern change, not this diff's defect

## Design Notes

Two-tier API on purpose: `issueWitness` is the pure primitive (13.4's receiver-side and tests call verify without policy), while `createWitnessIssuer` owns stateful policy (kill switch, per-(target, window) counter) — the adapter seam later constructs one issuer from node options. Window buckets are `currentSlot / 32n` integer division: deterministic, clock-free, and a burst cannot spill into the next bucket. Store dedupe key is (target, address, signer): one live witness per signer per address, freshest expiry kept — mirrors how vouches are bounded per subject.

## Verification

**Commands:**
- `corepack pnpm build` -- expected: green (no proto regen changes; generated diff empty)
- `corepack pnpm typecheck` -- expected: clean
- `corepack pnpm exec vitest run --maxWorkers=2` -- expected: all root suites green (baseline 575/70 + witness rows)
- `cd packages/app && corepack pnpm exec vitest run --maxWorkers=2` -- expected: 85/10 unchanged (app untouched — guard against accidental import creep)

## Auto Run Result

**Implemented change:** WB-2 witness issuance — new pure module `discovery/witness.ts`: pinned domain-separated digest over the five ticket fields (signer bound by pubkey, not bytes), pure `issueWitness` signer through the single AD-11 seam, full `verifyWitness` validator with the chain → half-open-slot-window → Ed25519 cost order, a policy-gated `createWitnessIssuer` (kill switch / empty-evidence / per-target-per-window cap — declines carry no signature bytes), and a freshness-keeping `createWitnessStore` (verify-before-store, freshest-wins dedupe, per-target cap, slot-parameterized eviction). No wiring: 13.4 fills it from gossip, 13.5 mints from it.

**Files changed (5):**
- `packages/core/src/discovery/witness.ts` (NEW) — the whole WB-2 surface + pinned constants (expiry 96 = 3× liveness lookback resolves the ticket unknown)
- `packages/core/test/discovery-witness.test.ts` (NEW) — 17 rows covering every matrix cell incl. cost-order pins and MODULE_PURE
- `discovery/index.ts`, `src/index.ts` — export pairs only (`signDigest` stays internal)
- `discovery-lint.test.ts` — `issueWitness` joins FORBIDDEN_UI_SYMBOLS (AD-11)

**Review findings breakdown:** 3 findings — 1 low patched (copy-on-write signature, mirroring the template's double defense; pin added), 2 rejected false (u64-overflow throw unreachable by cadence; primitive-shape rebinding has no gate-free caller and matches the introductions template). Nothing deferred.

**Follow-up review recommendation:** false — one low patched, no high/medium.

**Verification performed:** root build green with EMPTY proto regen diff; typecheck clean; root vitest **592/592 (71 files)** — new file proven registered via standalone run; app tsc clean + vitest **85/85 (10 files)** unchanged. All re-run green after the patch.

**Residual risks:** store keeps only ONE live issuer rate-bucket and assumes monotonic caller slots (rewinding clears counts — acceptable pre-wiring, adapter supplies chain time); witness `address` is shape-checked only — policy filtering belongs to 13.3's floor.
