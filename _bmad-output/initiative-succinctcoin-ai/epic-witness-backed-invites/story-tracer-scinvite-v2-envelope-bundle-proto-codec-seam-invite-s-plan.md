---
title: 'Tracer: scinvite:v2 envelope — bundle proto, codec seam, invite surfaces speak v2'
type: 'feature'
ticket: '1'
created: '2026-11-04'
status: 'built'
baseline_revision: '4244432dbaf4045e43f8f2290a6694fc4104b908'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
followup_review_recommended: false  # pass 2 patched only medium+low
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `scinvite:v1` carries one signed address, so an invitation dies when the inviter sleeps. WB-1 (spec-scinvite-v2) opens the v2 wire format: one line carrying the v1 record verbatim plus witnessed backup candidates — v1 semantics untouched.

**Approach:** Proto adds `ReachabilityWitness` + `InviteBundle`; core gains an `scinvite:v2:` codec (`mintV2`/`parseV2`). `verifyInvite` dispatches by prefix so every consumer (boot rung 0, `applyInvite`, paste box) accepts v2 end to end; the stub accepts ONLY zero-candidate bundles — their primary passes v1's exact three gates. Mint keeps emitting v1 until 13.5; candidates reject with an honest reason until 13.3.

## Boundaries & Constraints

**Always:**
- v1 codec and `verifyInvite`'s v1 path byte-identical: existing fixtures/goldens untouched and green.
- New top-level proto messages only, additive field numbers (PeerAnnouncement max is 7 — do not touch it); PROTO_OK after regen = generated diff limited to the new messages.
- Digests must stay untouched: `canonicalBlockBytes` (pow.ts) enumerates only Block fields; `peerAnnouncementDigest` is hand-rolled — neither sees the new messages (verified in investigation; pin with a row).
- Length cap before decode: v2 text checked against `MAX_INVITE_TEXT_LEN` (4096 stays, per ticket unknown) BEFORE any base64 decode.
- v1's `parseInvite` keeps rejecting `scinvite:v2:` as `malformed-invite` (existing fixture discovery-invitation.test.ts:115 must stay green).
- AD-3 purity: verification context arrives only via `InviteContext`; no clocks, no ambient reads.

**Never:**
- No witness signature checking, expiry, k-of-n, or diversity logic (13.2/13.3).
- No change to `SelfInviteUpdated` minting (`encodeInvite` stays), relay policy, address book grades, or gossip fields.
- No new wire protocols, no digest/schema-version bumps, no renderer polling.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| v2 round-trip | `mintV2({primary, candidates: []})` → `parseV2`, incl. pasted whitespace / uppercase prefix | fields equal (bigint slots intact) | No error expected |
| Primary verbatim | zero-backup bundle vs `encodeInvite(sameRecord)` | primary re-encoded standalone equals v1 payload bytes | — |
| Zero-candidate redeem | valid v2 in invite.txt / paste | verifies via v1's three gates, invite-grade ingest, dials as v1 did | Gate failures pass through with verbatim v1 reasons |
| Candidate present | bundle with 1+ candidates | rejected `candidates-unverified`, never a dial target | Clean reason, no throw |
| v2 in v1 parser | `parseInvite('scinvite:v2:'+junk)` | `malformed-invite` — prefix reject, not corruption (existing :115 row) | — |
| Over-length | > 4096 chars | refused before decode (both codecs) | `malformed-invite` |

</intent-contract>

## Code Map

- `packages/core/proto/protocol.proto` — PeerAnnouncement :212 (fields 1–7); add `ReachabilityWitness {targetIdentityId=1, address=2, chainId=3, firstSeenSlot=4(int64), expirySlot=5(int64), signerIdentityId=6, signature=7}` and `InviteBundle {PeerAnnouncement primary=1; repeated InviteCandidate candidates=2; message InviteCandidate {address=1; repeated ReachabilityWitness witnesses=2}}` after PeerBookResponse (~:304 end).
- `packages/core/src/proto/protocol.ts` + barrel — generated, committed; regen via root build.
- `packages/core/src/discovery/invitation.ts` (193 ln) — reuse private `bytesToB64url`:75/`b64urlToBytes`:90, `MAX_INVITE_TEXT_LEN`:130; follow `parseInvite`:135 pattern (/\s/g strip, case-insensitive prefix); prefix dispatch inside `verifyInvite`:156; `InviteContext`:52–68 unchanged.
- `packages/core/src/discovery/index.ts` :101–107 — re-export block gains new symbols.
- `packages/core/src/discovery/boot-files.ts` — rung 0 `applyInvites`:309 + per-line cap :265: NO change needed (shared entry + cap).
- `packages/core/src/index.ts` — consumers unchanged (`applyInvite`:419, boot ladder); mint stays `encodeInvite`:354.
- `packages/app/src/renderer/ipv6-hint.ts` — `describeCircuitInvite`:77 hardcodes v1 prefix :79/:84; make bundle-aware (decode primary, same logic).
- `packages/app/src/renderer/App.tsx` — mirrored `InviteRejectReason` union :32–45 gains `'candidates-unverified'`; placeholder :269 mentions both versions.
- `packages/app/src/main/index.ts` :198 header comment + `run-node.ts` :331 help text — copy touch.
- Tests: `core/test/discovery-invitation.test.ts` (fixtures KEYPAIR/signedAt/ctxWith; CAPS row labels), `app/test/run-node.test.ts` (`bootRunner` ~:80–125, tmp dataDir — write invite.txt before boot), `app/test/ipv6-hint.test.ts` (:92–113 pattern).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/proto/protocol.proto` -- add the two messages; regen via root build; confirm generated diff is additive-only and digests untouched
- [x] `packages/core/src/discovery/invitation.ts` -- INVITE_V2_PREFIX, mintV2/parseV2 (cap-before-decode), verifyInvite prefix dispatch, stub accept-zero-candidates with `candidates-unverified`; export via discovery/index.ts. **mintV2 throws when the rendered text would exceed `MAX_INVITE_TEXT_LEN`** -- every minted invite must be redeemable by its own parser; N stays open (13.5 picks it under this invariant)
- [x] `core/test/discovery-invitation.test.ts` -- new CAPS rows for the I/O matrix incl. byte-identical primary pin and digest-untouched row (canonicalBlockBytes/peerAnnouncementDigest stable). OVER_LENGTH must pin the at-cap boundary with a REAL bundle: mint a zero-candidate invite just under 4096 -> parses ok; one char past cap -> `malformed-invite` (a junk-base64 string cannot distinguish cap from decode failure). Mint-side row: oversized input -> throw, no text emitted
- [x] `core/test/core-ladder.test.ts` -- paste-leg row: `applyInvite(mintV2 zero-candidate)` verifies + ingests invite-grade; candidate bundle refused `candidates-unverified`, nothing stored (panel leg of the AC pinned, mirroring the v1 rows)
- [x] `packages/app/src/renderer/ipv6-hint.ts` + `App.tsx` + copy touches -- bundle-aware circuit hint (**prefix match case-insensitive, matching the parser's documented tolerance**, pinned by an uppercase row), union mirror, placeholder/comment/help text
- [x] `app/test/run-node.test.ts` -- boot row: zero-backup v2 in invite.txt joins as v1 did (extract via mintV2); `app/test/ipv6-hint.test.ts` -- v2 circuit rows
- No stray probe/scratch files in the repo root; probes that establish behavior become test rows

**Acceptance Criteria:**
- Given a record, when mintV2-with-no-candidates then parseV2, then the decoded primary re-encoded standalone equals v1 payload bytes exactly.
- Given a zero-backup v2 line in invite.txt at boot, when the node starts, then it verifies and dials exactly as the v1 invite row does; given candidates, verification refuses with `candidates-unverified` and never yields a dial target.
- Given every pre-change test file untouched (except additive rows), when root + app suites run, then all pass headless; `parseInvite` still rejects the v2 prefix cleanly.

## Implementation Notes

- **Done 2026-11-04.** All tasks implemented; every gate green: root build+regen,
  `pnpm typecheck`, root vitest **572/70** (was 561/70 — +7 core rows), app tsc clean,
  app vitest **84/10** (was 80/10 — +4 rows). `git diff` on `packages/core/src/proto/`
  is additive-only (0 removed lines in both the .proto and the generated protocol.ts;
  barrel gained only the new messages).
- **Files touched:** `protocol.proto` (+`ReachabilityWitness`, +`InviteBundle` with
  nested `InviteCandidate`; PeerAnnouncement untouched) · generated `proto/protocol.ts`
  + hand-written `proto/index.ts` barrel (types + codec namespaces; protons emits the
  nested message as `InviteBundle.InviteCandidate`, re-exported flat as `InviteCandidate`)
  · `discovery/invitation.ts` (INVITE_V2_PREFIX, `InviteWitnessInput`/`InviteCandidateInput`/
  `MintV2Input`/`InviteBundleParse`, `mintV2`, `parseV2`, prefix dispatch in `verifyInvite`,
  shared gates-2+3 tail factored into `verifyRecord`, `'candidates-unverified'`) ·
  `discovery/index.ts` + `src/index.ts` re-exports (export-only; consumers untouched) ·
  `app/renderer/ipv6-hint.ts` (bundle-aware `describeCircuitInvite`: v2 = decode bundle,
  scan the PRIMARY only — a dependency-free field-1 tag+varint slice, no proto import) ·
  `App.tsx` (union mirror + placeholder shows both prefixes) · copy: `main/index.ts`
  invite.txt header, `run-node.ts` USAGE.
- **Decisions beyond the plan:**
  1. Candidate refusal runs BEFORE the primary's gates (pinned by a row): half a bundle
     is not an invitation, and the reason must not depend on data 13.3 will define.
  2. A decoded bundle WITHOUT a `primary` → `malformed-invite` (envelope junk). Probed
     protons behavior: unknown fields are SKIPPED (`0x18 0x01` decodes to an empty
     bundle) and an empty length-delimited submessage still PUSHES a candidate — so the
     no-primary fixture is `scinvite:v2:GAE`, pinned in tests.
  3. The existing :115 row (v2 prefix + v1 payload bytes ⇒ `malformed-invite`) stays
     green for a wire reason: `InviteBundle.decode` on v1 record bytes THROWS
     ("invalid wire type 4 at offset 103" — the identityId string re-parsed as
     submessage tags), so parseV2 itself returns malformed before any gate runs.
  4. `MAX_INVITE_TEXT_LEN` is now barrel-exported (cap behavior only pin-testable from
     the public surface); cap check precedes decode in BOTH v1 and v2 parsers, pinned
     by an OVER_LENGTH row incl. the at-cap boundary (`>`, not `>=`).
  5. Digest-untouched pinned with golden sha256 constants computed BEFORE the proto
     edit: `canonicalBlockBytes` (127-byte canonical form) and `peerAnnouncementDigest`.
  6. The v2 circuit hint deliberately does NOT scan candidate addresses — only the
     primary (what a join dials first); pinned by V2_DIRECT_SILENT with a circuit candidate.
- **Surprises:** protons' lenient unknown-field skip means proto-decode junk rejection
  is subtler than "garbage throws" — edge shapes were probed before pinning (see 2/3).
  Otherwise the plan's code map held exactly (boot rung 0 needed NO change: shared
  `verifyInvite` + per-line cap gave v2 for free; boot row asserts ladder report
  `invites {found:true, verified:1, rejected:1}` from a two-line invite.txt).
- **Done 2026-11-04 (re-derivation pass 2, from baseline 4244432).** All tasks
  implemented from scratch honoring every KEEP instruction; gates green: root
  build+regen (proto diff additive-only, 0 removed lines: +58 .proto / +729
  generated / +12 barrel), `pnpm typecheck` clean, root vitest **575/70** (was
  561/70 — +14 rows: 8 invitation, 1 core-ladder, 1 run-node, 4 ipv6-hint… the
  last two also run under the ROOT suite), app tsc clean, app vitest **85/10**
  (was 80/10). Files mirror pass 1's list; decisions kept: candidate refusal
  BEFORE primary gates (pinned with an expired-primary row), no-primary fixture
  `scinvite:v2:GAE` (re-probed: decodes to an empty bundle via unknown-field
  skip ⇒ malformed), cap-before-decode in both parsers, mintV2 throws RangeError
  past the cap (MINT_CAP row), digests pinned with pre-edit goldens (computed
  via a temp probe test BEFORE the proto edit; probe deleted):
  canonicalBlockBytes `aa398b…1548`, peerAnnouncementDigest `517e…9209`.
- **Beyond pass 1's notes:** (1) OVER_LENGTH at-cap pinned by MINTING to exactly
  4096 chars — base64url length is a function of raw bytes (n≡0 mod 3 hits every
  4k), so a loop over a padding multiaddr finds the exact-at-cap REAL bundle;
  at-cap parses, +1 char refuses `malformed-invite` before decode, v1 codec same
  cap. The at-cap text cannot also VERIFY (padding addr is off-policy) — parse-
  level boundary is what the row pins. (2) Runner boot row: invite fixture addrs
  must be VALID hex IPv6 (`2001:db8:v2:…` silently rejected BOTH lines —
  `v2` isn't hex); with valid addrs the default-mining runner boots
  {found:true, verified:1, rejected:1} (no STRICT race — ladder runs before the
  first block). (3) ipv6-hint v1 prefix match became case-insensitive too
  (consistent with its documented tolerance; no row pinned the old strictness).
  (4) mintV2 builds the proto INPUT shape (`succinctcoin.InviteBundleInput`),
  not the message type — the generated message demands `Uint8Array<ArrayBuffer>`
  bytes callers don't carry.
## Plan Change Log

### 2026-11-04 -- review pass 1 loopback (bad_plan)
Trigger: `mintV2` mints text its own parser rejects past 4096 (medium) -- the spec constraint "v2 raises [the cap] only by explicit decision, with bounded backups per bundle" (spec-scinvite-v2 Constraints) was captured decode-side only; no test could pin the at-cap boundary because the row used junk base64.
Amended: Tasks & Acceptance -- mintV2 throws when rendered text exceeds MAX_INVITE_TEXT_LEN (every minted invite redeemable by its own parser); OVER_LENGTH rewritten to pin the boundary with a real bundle; applyInvite v2 paste-leg row added to core-ladder.test.ts; hint prefix match case-insensitive + uppercase row; no stray probe files.
Known-bad avoided: an un-redeemable mint shipping once 13.5 assembles candidates; a cap test that passes for the wrong reason.
KEEP instructions (must survive re-derivation):
- Prefix dispatch ONLY inside `verifyInvite` (single entry); `parseInvite` stays pure-v1, rejecting the v2 prefix cleanly (fixture :115 untouched).
- Proto exactly as pass 1: `ReachabilityWitness` fields 1--7 incl. `signerIdentityId=6`; `InviteBundle{primary=1, candidates=2}` nested `InviteCandidate{address=1, witnesses=2}`; additive-only regen, PROTO_OK clean.
- v2 arm refuses candidate-bearing bundles WHOLESALE with `candidates-unverified` BEFORE the primary gates; zero-candidate primary runs the shared `verifyRecord` tail (v1's exact three gates).
- All pass-1 tests verbatim: PRIMARY_VERBATIM byte-identical pin, DIGESTS_UNTOUCHED, RUNNER_V2_INVITE_BOOTS ({found:true, verified:1, rejected:1}), v2 hint rows; thin-client rule in ipv6-hint.ts (no core import -- hand-rolled envelope slice stays).

## Review Triage Log

### 2026-11-04 -- Review pass 1 (quick lens)
- verdicts: 5 findings -- high 0, medium 3, low 2, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` mintV2 has no length cap -- can mint lines parseV2/boot-cap always reject (~200 chars per witness; probe: 3 candidates x 2 witnesses = 2448 chars) — real at L191 (no cap check); spec's "bounded backups per bundle" constraint uncaptured in plan; fix is new behavior (throw) -> plan amendment
  - `[medium]` `[bad_plan]` OVER_LENGTH at-cap assertion pins nothing -- 'A'-repeat is valid base64url, rejection comes from proto decode (field 0), so flipping `>` to `>=` keeps it passing — verified in test source; grouped with mintV2 row (same root cause: cap story incomplete mint->parse); amended
  - `[medium]` `[patch->amended]` applyInvite paste leg has no v2 row — core-ladder.test.ts untouched, zero v2 mentions (verified); AC says panel round-trips v2; folded into amendment so re-derivation pins it
  - `[low]` `[patch->amended]` ipv6-hint v2 branch hardcodes lowercase prefix while parser is case-insensitive — uppercase invite joins but silently loses the relay hint; newly written branch contradicting its own docstring; folded into amendment (one-line lower-case compare + row)
  - `[low]` `[patch]` tmp-probe.mjs review artifact left in repo root — self-labeled "delete after use"; deleted with the revert

### 2026-11-04 — Review pass 2 (quick lens, post-loopback)
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` re-derivation dropped the direct WB-1 pin — no test calls `parseInvite` with v2 text anymore (the :115 fixture reaches rejection via `verifyInvite` dispatch; verified by grep: only v1 texts hit parseInvite); a future parseInvite loosening would stay green — action: added direct assertion in V2_MALFORMED (`parseInvite(mintV2(...))` -> malformed-invite)
  - `[low]` `[patch]` stale v1-only prose on newly v2-capable surfaces — boot-files.ts readInviteFile + defaultInvitePath docs, discovery-ladder.ts inviteFilePath comment, App.tsx InvitePanel JOIN docstring all said "one scinvite:v1: line"; action: wording updated to `v1:`/`v2:` in all four

## Auto Run Result

**Implemented change:** WB-1 tracer — `scinvite:v2:` envelope opens the v2 wire format without touching v1 semantics: additive proto messages (`ReachabilityWitness`, `InviteBundle`), core codec seam (`mintV2` throwing past the 4096 cap / `parseV2` cap-before-decode), prefix dispatch inside `verifyInvite` only (zero-candidate bundles run v1's exact three gates; candidate-bearing bundles refuse wholesale `candidates-unverified` before the primary gates), and every invite surface (invite.txt boot rung, `applyInvite` paste leg, panel hint) round-trips v2 end to end.

**Files changed (17):**
- `packages/core/proto/protocol.proto` + generated `src/proto/*` — two additive messages (+58/+729/+12, zero removals)
- `packages/core/src/discovery/invitation.ts` — v2 codec + dispatch + shared `verifyRecord` tail; new reason `candidates-unverified`
- `packages/core/src/discovery/index.ts`, `src/index.ts` — export-only re-exports
- `packages/core/src/discovery/boot-files.ts` — doc wording (v1/v2)
- `packages/app/src/renderer/ipv6-hint.ts` — bundle-aware circuit hint, case-insensitive prefixes, thin-client byte-slice of the primary
- `packages/app/src/renderer/App.tsx`, `main/index.ts`, `main/run-node.ts`, `main/discovery-ladder.ts` — union mirror + copy/docs for both prefixes
- Tests (all additive): `discovery-invitation.test.ts` 8 rows incl. PRIMARY_VERBATIM byte pin, real-bundle OVER_LENGTH, MINT_CAP throw, DIGESTS_UNTOUCHED goldens, direct parseInvite-rejects-v2; `core-ladder.test.ts` paste-leg row; `run-node.test.ts` RUNNER_V2_INVITE_BOOTS ({found:true,verified:1,rejected:1}); `ipv6-hint.test.ts` 4 v2 rows

**Review findings breakdown:** pass 1 — 5 findings (2 medium bad_plan amended + reverted + re-derived, 1 medium + 1 low folded into amendment and delivered in re-derivation, 1 low artifact deleted). Pass 2 — 2 findings, both patched (direct parseInvite pin added; four stale comments updated). Nothing deferred; no rejects.

**Follow-up review recommendation:** false — pass 2 patched one medium + one low only; all KEEP constraints verified held.

**Verification performed:** root `corepack pnpm build` green with idempotent proto regen (additive diff); root `typecheck` clean; root vitest **575/575 (70 files)**; app `tsc --noEmit` clean; app vitest **85/85 (10 files)**. Matrix rows all covered by named green rows (V2_ROUND_TRIP, PRIMARY_VERBATIM, V2_REDEEM/RUNNER_V2_INVITE_BOOTS/paste-leg, CANDIDATES_UNVERIFIED, OVER_LENGTH+MINT_CAP, direct WB-1 pin).

**Residual risks:** at-cap OVER_LENGTH pins the parse boundary with a real minted bundle whose padded address is off-policy (cannot also verify — documented in-row); `mintV2` accepts candidate/witness shapes 13.2/13.3 will finalize (inputs carried, never checked — tracer by design).

## Design Notes

Prefix dispatch lives in `verifyInvite` (single entry point) so boot-files/applyInvite/paste gain v2 for free and no consumer learns two functions; `parseInvite` stays pure-v1 to keep the WB-1 rule "a v1 parser rejects v2 by prefix". Byte-identical pin: decode bundle → re-encode primary with `PeerAnnouncement.encode` → equals base64url payload of `encodeInvite(record)`.

## Verification

**Commands:**
- `corepack pnpm build 2>&1 | tail -1 && git diff --name-only -- packages/core/src/proto/` -- expected: regen succeeds; diff lists only proto/protocol.ts (+ barrel if changed)
- `corepack pnpm typecheck` -- expected: clean
- `corepack pnpm exec vitest run --maxWorkers=2` -- expected: all root suites green (was 561/70 baseline + new rows)
- `cd packages/app && corepack pnpm exec tsc --noEmit -p tsconfig.json && corepack pnpm exec vitest run --maxWorkers=2` -- expected: clean, app suites green
