---
title: 'Verification floor: k-of-n distinct signers, slot expiry, /64 diversity, direct-first law'
type: 'feature'
ticket: '3'
created: '2026-11-04'
status: built
baseline_revision: '52b0b72061361a000c03d7b87e11c2d3d5a8226a'
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

**Problem:** WB-3 (spec-scinvite-v2, ticket 13.3, risk HIGH): 13.1's `verifyInvite` refuses every candidate-bearing bundle wholesale (`candidates-unverified`) because half-verified backups are an eclipse vector, not a feature. The floor that makes witnesses worth trusting must now exist: a backup candidate is trusted only with ≥ k=2 valid witnesses from DISTINCT signers, unexpired against `ctx.currentSlot`, spanning the /64 diversity floor — and law says the primary is always dialed before any candidate, none while it answers.

**Approach:** In `invitation.ts` replace the wholesale stub with `verifyInviteV2` logic behind the same dispatch: primary runs v1's gates VERBATIM (unchanged `verifyRecord` tail), then each candidate gets a verdict from a pure floor function that reuses 13.2's `verifyWitness` (chain/window/signature cost order) plus three pinned extras — witness must attest THIS peer at THIS address and not be self-attestation; candidate hop must be a global v6 whose `hopNetworkKey` group no earlier accepted candidate used (the existing 9.3 diversity instinct, tightened to one-per-group for bundles); signer ticket-liveness engages ONLY when `ctx.chainHasBlocks` is true (empty-chain trust ceiling). Consumers (`applyInvite` in core, `applyInvites` boot rung) gain the direct-first fallback: candidate addresses are dialed ONLY after every primary address failed, in bundle order.

## Boundaries & Constraints

**Always:**
- Primary path stays byte-identical: v1 text and zero-candidate bundles run exactly today's `verifyRecord`; a primary that fails ANY gate kills the whole bundle — candidates NEVER rescue the primary's gates (verify-before-connect is structural).
- k = 2 as exported constant `MIN_WITNESS_SIGNERS` in `invitation.ts` (spec assumption: tunable).
- A witness COUNTS toward k only if ALL hold: `verifyWitness(w, {currentSlot, expectedChainId})` ok (13.2 validator — shape → chain-mismatch → half-open window → Ed25519); `w.targetIdentityId === primary.identityId`; `w.address === candidate.address`; `w.signerIdentityId !== primary.identityId` (self-attestation is worthless); and when `ctx.chainHasBlocks === true`, `ctx.hadRecentTicket(w.signerIdentityId, sinceWindow)` holds (same window as the primary's gate). Bad witnesses simply do not count — a candidate carrying 3 witnesses where 1 is forged still passes on 2 good ones.
- Candidate address law (resolves ticket unknowns, pinned here): group = `hopNetworkKey(address)` from `../net/address-policy.js`. Group `"4:…"` → skip `address-unsupported` (v4 diversity metric undecided — draft resolution in the ticket). Group null → `address-unsupported`, EXCEPT under `loopbackAnnounceAllowed()` where loopback-family hops are accepted and EXEMPTED from diversity (mirrors the primary gate's dev-only allowance; 13.8's loopback proof depends on this). Group `"6:…"` already used by an EARLIER ACCEPTED candidate in bundle order → `address-not-diverse`; else accept and mark the group used (at most one accepted candidate per /64 — the 9.3 floor instinct from `address-book.ts` MAX_ENTRIES_PER_64, tightened for tiny bundles; "entries span distinct /64 prefixes" per change-ledger-dials §R2).
- Verdict order = bundle order; verdicts are `{ address, accepted, signers, reason? }` with pinned reasons `'no-witnesses' | 'insufficient-signers' | 'address-unsupported' | 'address-not-diverse'`. A skipped candidate NEVER rejects the bundle — the invite verifies with fewer/no candidates.
- `'candidates-unverified'` is DELETED from `InviteRejectReason` (union in invitation.ts + mirror in App.tsx) — nothing emits it anymore.
- `InviteValidation` ok-arm gains OPTIONAL `candidates?: readonly CandidateVerdict[]` (present only for v2 bundles that carried candidates; v1/zero-candidate shapes unchanged so existing consumer destructuring is safe).
- `InviteContext` gains optional `chainHasBlocks?: boolean` (absent/false = empty-chain soft side — the pinned trust ceiling). Consumers wire it honestly: core `applyInvite` passes `head >= 0`; core boot passes `bootSlot >= 0` through `BootLadderOptions.chainHasBlocks` → `ApplyInvitesOptions`.
- Direct-first law in BOTH consumers: dial primary addresses first (existing loops unchanged); only after ALL fail and only if a dialer exists, try each ACCEPTED candidate address once in bundle order. No candidate dial ever precedes the first primary attempt; none happens when any primary dial succeeded. Candidate dials are NOT book ingests — witness-grade ingest is 13.5.
- Purity unchanged: no clocks/net/fs beyond the sanctioned `loopbackAnnounceAllowed()` seam; AD-11 untouched (no signing here).

**Never:**
- No proto changes (bundle/witness messages shipped in 13.1); no gossip fields (13.4); no address-book grade changes or ingest of candidates (13.5); no renderer copy beyond removing the dead union member; no witness-store reads inside verify (verification is pure over bundle + ctx).
- Do NOT touch `mintV2`/`parseV2`/`parseInvite`, MAX_INVITE_TEXT_LEN, digest paths, or any v1 constant.
- Do not dial candidates from `verifyInvite` — it returns verdicts; only the two consumers act.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Zero-candidate bundle | v2, no candidates | ok:true exactly as 13.1 (no verdicts key) | unchanged |
| Minimal valid bundle | 1 candidate, 2 distinct signers, global v6 | accepted, signers:2; invite ok | — |
| Two-/64 bundle | 2 candidates each k=2, distinct groups | both accepted (spec's minimal-valid row) | — |
| Same-/64 cluster | 2 candidates same /64, both k=2 | first accepted; second `address-not-diverse` | bundle still ok |
| Single witness / none | 1 witness ⇒ `insufficient-signers`; 0 ⇒ `no-witnesses` | candidate skipped | — |
| Duplicate signer | 2 witnesses same signer | `insufficient-signers` (distinct count 1) | — |
| Self-attestation | sole extra signer = primary identity | does not count → `insufficient-signers` | — |
| Expired witness | expiry == currentSlot (half-open) | expired, doesn't count; boundary firstSeen/expiry−1 count | via 13.2 validator |
| Wrong target / wrong address / forged sig / other chain | one such witness among 2 good | bad one skipped, candidate still accepted on 2 good | never throws |
| Empty-chain vs blocks | signers hold no tickets; `chainHasBlocks` absent → accepted; true → `insufficient-signers`; true + signer ticket → accepted | pinned strictness rows | — |
| v4 hop / junk hop | `/ip4/…` or local candidate | `address-unsupported` | dev flag: loopback hop accepted, diversity-exempt |
| Dead primary | primary fails liveness, witnesses perfect | whole bundle `no-recent-ticket`; zero verdicts acted on | candidates never gate-rescue |
| Dial order (boot rung) | spy dialer; primary answers | dialed list = primary addrs only; ZERO candidate dials | — |
| Dial fallback (boot rung) | spy: all primary addrs fail | after last primary failure, first ACCEPTED candidate dialed once; rejected candidates never | report counts unchanged |
| Runtime applyInvite | net.dial spy fails all primary addrs | accepted candidate dialed after; success ⇒ ok:true | fire-and-forget as today |

</intent-contract>

## Code Map

- `packages/core/src/discovery/invitation.ts` — THE edit site. Dispatch stub to replace: `verifyInvite` v2 arm :293–305 (`candidates.length > 0 → candidates-unverified`); union member to DELETE :68–77; `InviteContext` :79–100 (add `chainHasBlocks?`); shared tail `verifyRecord` :308+ (DO NOT change); sinceWindow computation inside it (:335–338) is the window signers get under strictness.
- `packages/core/src/discovery/witness.ts` — `verifyWitness(w, ctx)` :316 (the ONLY witness checker to call; accepts unknown, never throws); `SignedWitness`/`WitnessFields` types; half-open `[first, expiry)` is its own judgment — do not re-check windows here.
- `packages/core/src/net/address-policy.ts` — `hopNetworkKey(addr)` :496 (`"6:h0:h1:h2:h3"` / `"4:a.b.c.0"` / null), `ip6Slash64` :458, `loopbackAnnounceAllowed()` (already imported by invitation.ts), `isDialableSeedMultiaddr` :~500+ for the dev-flag loopback-family test under the flag.
- `packages/core/src/index.ts` — `applyInvite` :419–467: verify ctx at :434 (add `chainHasBlocks: head >= 0`), fire-and-forget dial loop :449–459 (append candidate fallback after the primary for-loop); boot wiring `runBootLadder({...})` :228–246 (add `chainHasBlocks: bootSlot >= 0`).
- `packages/core/src/discovery/boot-files.ts` — `ApplyInvitesOptions` :275–291 (add `chainHasBlocks?`), `applyInvites` :309+ two-pass loop (pass 1 stores verdicts alongside records; pass 2 candidate fallback after the primary addr loop, inside `opts.dial !== undefined`), `BootLadderOptions` + rung-0 call site :410–450 (thread the flag).
- `packages/app/src/renderer/App.tsx` — reason mirror :32–47: delete `'candidates-unverified'` line only.
- Barrels: `discovery/index.ts`, `src/index.ts` invite export block — add `MIN_WITNESS_SIGNERS`, `CandidateVerdict`, `CandidateRejectReason`; nothing else.
- Tests: `packages/core/test/discovery-invitation.test.ts` — fixtures KEYPAIR (primary)/OTHER via deriveIdentityKeypair seeds, LIVE ctx; REPLACE the 13.1 CANDIDATES_UNVERIFIED row and the candidate half of V2_MALFORMED's sibling assertions; add `describe('13.3 — verification floor')` rows per matrix. `packages/core/test/core-ladder.test.ts` — update the 13.1 paste-leg row (candidate bundle now ok with verdicts) and add two dial-order spy rows. `packages/app/test/run-node.test.ts` — RUNNER_V2_INVITE_BOOTS: second line becomes a VALID witnessed bundle → expect `{found:true, verified:2, rejected:0}`; keep a reject count by appending a garbage v2 line (`verified` counts, AD-9).
- `packages/core/test/discovery-lint.test.ts` — unchanged (no new forbidden symbols; invitation.ts stays UI-clean).

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/discovery/invitation.ts` -- delete `'candidates-unverified'`; add `MIN_WITNESS_SIGNERS = 2`, `CandidateRejectReason`, `CandidateVerdict`, optional `InviteContext.chainHasBlocks`, optional `candidates?` on the ok arm; implement the per-candidate floor (witness counting via `verifyWitness` + target/address/self checks + strict-signer rule; address law via `hopNetworkKey` with dev-loopback exemption; one-accepted-per-group diversity) and wire it into the v2 dispatch AFTER `verifyRecord` succeeds
- [ ] `packages/core/src/index.ts` -- `chainHasBlocks: head >= 0` in applyInvite ctx; candidate fallback in the fire-and-forget dial loop (accepted verdicts, bundle order, only after all primary addrs failed); `chainHasBlocks: bootSlot >= 0` into runBootLadder opts
- [ ] `packages/core/src/discovery/boot-files.ts` -- `chainHasBlocks?` on ApplyInvitesOptions + BootLadderOptions (threaded at rung 0); pass 1 keeps verdicts with records; pass 2 candidate fallback dial after primary exhaustion, accepted-only, bundle order, each once
- [ ] Barrels (`discovery/index.ts`, `src/index.ts`) -- export `MIN_WITNESS_SIGNERS` + the two new types; App.tsx mirror: drop `'candidates-unverified'`
- [ ] `packages/core/test/discovery-invitation.test.ts` -- replace 13.1 stub rows; add FLOOR_* matrix rows (minimal, two-/64, cluster, single/none, dup signer, self-witness, expiry boundary, mixed-good-bundle, strictness trio, v4/junk, dead-primary)
- [ ] `packages/core/test/core-ladder.test.ts` -- update paste row; add DIAL_ORDER_PRIMARY_ANSWERS + DIAL_ORDER_FALLBACK spy rows (boot applyInvites)
- [ ] `packages/app/test/run-node.test.ts` -- RUNNER_V2_INVITE_BOOTS to `{found:true, verified:2, rejected:0}` with one valid witnessed bundle + one garbage v2 line (+1 reject ⇒ keep rejected:1 if a third junk line is used — choose and pin)
- [ ] Gates: root `corepack pnpm build` → `typecheck` → `vitest run --maxWorkers=2`; app `tsc --noEmit -p tsconfig.json` + `vitest run --maxWorkers=2`

**Acceptance Criteria:**
- Given a bundle whose candidate carries 2 valid witnesses from distinct signers across two /64s, when verified against LIVE ctx, then ok:true with both candidates accepted and no reason anywhere.
- Given the same bundle with one signer's ticket missing under `chainHasBlocks: true`, then that witness does not count and the candidate is skipped `insufficient-signers`; with `chainHasBlocks` absent the bundle verifies (empty-chain ceiling).
- Given a spy dialer where the primary answers, then zero candidate addresses appear in the dial log (both consumers); given all primary dials fail, exactly one candidate dial occurs, after all primary attempts.
- `'candidates-unverified'` exists nowhere in packages/ (src or tests) after the change; suites green headless.

## Implementation Notes

(appended during implementation — append-only)

## Implementation Notes — pass 1 (subagent)

Implemented 2026-11-04 on baseline `52b0b72` (uncommitted, per instruction). All four gates green; `'candidates-unverified'` appears in NO file under `packages/*/src` or `packages/*/test` (grep-exit=1).

### Per-file changes

- `packages/core/src/discovery/invitation.ts` — deleted `'candidates-unverified'` from `InviteRejectReason`; added exported `MIN_WITNESS_SIGNERS = 2`, `CandidateRejectReason`, `CandidateVerdict`, optional `InviteContext.chainHasBlocks`, optional `candidates?: readonly CandidateVerdict[]` on the ok arm (ABSENT for v1/zero-candidate — shape pinned by a new V2_REDEEM assertion). Replaced the wholesale-stub v2 dispatch arm: primary runs `verifyRecord` VERBATIM first (failure returns byte-identical), then non-zero candidates go through the new pure `judgeCandidates` — witness counting (cheap target/address/self checks BEFORE `verifyWitness`; signer DISTINCT via Set; strict-signer rule only when `ctx.chainHasBlocks === true`, same `sinceWindow` math as the primary gate), then the address law (`hopNetworkKey`: `"4:…"`→unsupported, null→unsupported except loopback-family under `loopbackAnnounceAllowed()` which is accepted + diversity-EXEMPT, `"6:…"` reused by an earlier ACCEPTED candidate→not-diverse, else accept+mark). Docblocks updated (v2 prefix, verifyInvite); imports extended (`hopNetworkKey`, `isLoopbackIp6Multiaddr`, `isLoopbackV4Multiaddr`, `verifyWitness`).
- `packages/core/src/index.ts` — `applyInvite` ctx gains `chainHasBlocks: head >= 0`; fire-and-forget dial loop keeps the primary for-loop and appends an accepted-candidate fallback (bundle order, each once, break on success) that only runs after ALL primary addrs failed; `runBootLadder({...})` gains `chainHasBlocks: bootSlot >= 0`. Barrels extended (see below).
- `packages/core/src/discovery/boot-files.ts` — `ApplyInvitesOptions.chainHasBlocks?` + `BootLadderOptions.chainHasBlocks?` (threaded at rung 0 → `applyInvites` → verify ctx); pass 1 stores `{record, candidates}`; pass 2 primary loop sets `connected`, candidate fallback runs only when `!connected`, accepted-only, bundle order, break on first success. Report counts unchanged.
- `packages/core/src/discovery/index.ts` + `packages/core/src/index.ts` (barrels) — added `MIN_WITNESS_SIGNERS` (values) and `CandidateRejectReason`, `CandidateVerdict` (types). Nothing else.
- `packages/app/src/renderer/App.tsx` — deleted the `'candidates-unverified'` mirror line ONLY.
- Tests as detailed below; `mintV2`/`parseV2`/`parseInvite`/`verifyRecord`/MAX_INVITE_TEXT_LEN/digests untouched; no proto changes (build regen diff EMPTY).

### Deviations from the plan

1. **Loopback-family test**: used `isLoopbackIp6Multiaddr(addr) || isLoopbackV4Multiaddr(addr)` instead of the Code Map's suggested `isDialableSeedMultiaddr` — that predicate REQUIRES a `/p2p/<id>` component (seed law), which candidate addresses (`/ip6/::1/tcp/1`) never carry, so it could never accept one. The chosen pair is the exact loopback-family law of address-policy.ts and matches the user-pinned example.
2. **Candidate check order** pinned as witness-counts-first (`no-witnesses` → `insufficient-signers`), then address law (`address-unsupported` → `address-not-diverse`) — the union declaration order in the plan; a v4/junk candidate with k valid witnesses therefore reports `address-unsupported`, not a witness reason.
3. **Candidate fallback breaks on first success** (mirrors the primary "first success wins" rule in both consumers); the matrix only pinned "first ACCEPTED candidate dialed once", this makes the remainder un-dialed — pinned by DIAL_ORDER_FALLBACK.
4. `protocol.proto:349` comment still mentions the old reason — NOT touched (Never §"no proto changes" is binding; the grep gate is scoped to src/test).
5. Witness counting runs cheap field checks BEFORE `verifyWitness` (cheaper than a wasted Ed25519 for witnesses aimed at other peers/addresses); semantics identical, cost order of the validator itself unchanged.

### Test rows added/updated

- `packages/core/test/discovery-invitation.test.ts`: removed 13.1 `CANDIDATES_UNVERIFIED` row; V2_REDEEM gained the no-`candidates`-key pin; new `describe('13.3 — verification floor')` with REAL `issueWitness` fixtures (SIGNER_A/B/C derived keypairs): **FLOOR_MINIMAL, FLOOR_TWO_SIXTYFOURS, FLOOR_SAME_64_CLUSTER** (incl. order-flip + rejected-candidate-marks-no-group pins), **FLOOR_NO_WITNESSES / FLOOR_SINGLE_WITNESS** (one row), **FLOOR_DUP_SIGNER, FLOOR_SELF_WITNESS, FLOOR_EXPIRY_BOUNDARY** (firstSeen==current & expiry−1 count; expiry==current dead), **FLOOR_MIXED_GOOD** (forged/wrong-target/wrong-address/other-chain skipped, 2 good carry it), **FLOOR_STRICT_SIGNERS** (soft/strict/ticketed trio + sinceWindow=118n pin), **FLOOR_UNSUPPORTED_ADDR** (v4 + ULA), **FLOOR_DEV_LOOPBACK** (flag on: accepted + diversity-exempt both families; flag off: unsupported; still k-gated), **FLOOR_SKIPPED_NOT_FATAL**, **FLOOR_DEAD_PRIMARY** (expired/no-recent-ticket/bad-signature — candidates never gate-rescue).
- `packages/core/test/core-ladder.test.ts`: paste-leg row reworked (candidate-less-witness bundle now ok:true, invite-grade ingest, primary dialed, rejected candidate never); new `describe('13.3 — direct-first dial law (boot applyInvites)')`: **DIAL_ORDER_PRIMARY_ANSWERS** (zero candidate dials), **DIAL_ORDER_FALLBACK** (`[P1,P2,cGood1]` order, rejected/never-reached excluded, book holds primary addrs only).
- `packages/app/test/run-node.test.ts`: **RUNNER_V2_INVITE_BOOTS** reworked to three lines (plain v2 + VALID witnessed bundle via `issueWitness` × 2 distinct signers + `INVITE_V2_PREFIX+'GAE'` junk) ⇒ pinned `{found:true, verified:2, rejected:1}`.

### Gate results (exact tails)

1. `corepack pnpm build` — exit 0; proto regeneration produced an EMPTY diff (`git status --porcelain packages/core/src/proto` empty).
2. `corepack pnpm typecheck` — exit 0 (`tsc -p packages/core/tsconfig.json` clean).
3. `corepack pnpm exec vitest run --maxWorkers=2` — **Test Files 71 passed (71) / Tests 606 passed (606)** (baseline 592 + 14 net: +13 floor rows, +2 dial-order, −1 removed stub row).
4. app: `tsc --noEmit -p tsconfig.json` exit 0; `vitest run --maxWorkers=2` — **Test Files 10 passed (10) / Tests 85 passed (85)**.


## Implementation Notes — matrix audit + patch (orchestrator, pass 1)

Diff judged line-by-line against the contract: floor ordering (cheap checks →
`verifyWitness` → strict-signer), `usedGroups` marked ONLY on acceptance,
dev-loopback exemption mirrors `allowLoopbackAddresses`, both consumers hold the
direct-first law exactly (candidate loop unreachable until every primary address
failed; accepted-only; break on first success). All four pass-1 deviations
ACCEPTED (deviation 1 verified myself: `isDialableSeedMultiaddr` demands a `/p2p`
component candidates never carry).

**Gap found and patched by me:** the matrix row "runtime applyInvite | net.dial
spy fails all primary addrs | accepted candidate dialed later" had NO test —
core/index.ts's fallback loop was unexercised (the paste-leg row only proved the
primary-answers case). Added `runtime applyInvite FALLBACK` to
core-ladder.test.ts (dial spy throws except C_GOOD; bundle = [no-witnesses
C_BAD, accepted C_GOOD]; pins `dialed == [P1, C_GOOD]` — after primary failure,
accepted-only, rejected never). File re-run green (14/14). Full root suite ran
by me BEFORE this patch: 606/71 + build/typecheck clean + proto regen EMPTY;
expected total now 607.

## Review Triage Log


### 2026-11-04 — Review pass 1 (quick lens, pinned)
- verdicts: 2 findings — high 0, medium 0, low 2, false 0
- findings:
  - `[low]` `[patch]` `protocol.proto:349` — stale wire-contract comment still said candidate lists are "refused `candidates-unverified`" (behavior deleted this ticket); AC-4's grep was scoped src/test so it survived — verified true by grep (single hit; generated protocol.ts carries no comments, regen-safe). Action: comment rewritten to the 13.3 floor semantics; build re-run, regen EMPTY.
  - `[low]` `[patch]` `invitation.ts` `verifyRecord` docblock said "shared by the v1 path and the zero-candidate v2 primary" — every v2 primary now runs it (candidates never gate-rescue). Verified true. Action: wording fixed.

## Auto Run Result

**Implemented change:** WB-3 verification floor — `verifyInvite`'s v2 arm replaced the wholesale `candidates-unverified` stub with per-candidate verdicts: witnesses count toward k=2 only when valid (13.2 validator), aimed at THIS peer/address, non-self, and (strictly, only under `ctx.chainHasBlocks`) signer-ticketed; candidate hops obey the pinned address law (global v6, one accepted per /64 group, dev-loopback exempt under the flag); `'candidates-unverified'` deleted from the union + renderer mirror. Both consumers enforce the direct-first law: accepted candidates join the dial loop only after every primary address failed, bundle order, first success wins.

**Files changed (9):** plan .md; `invitation.ts` (floor, verdict types, ctx.chainHasBlocks, MIN_WITNESS_SIGNERS); `core/src/index.ts` (honest chainHasBlocks wiring ×2 + runtime fallback dial); `boot-files.ts` (flag threaded, pass-2 candidate fallback, report shape unchanged); barrels + App.tsx mirror; tests: 13 FLOOR rows (replacing the 13.1 stub row), DIAL_ORDER_PRIMARY_ANSWERS/FALLBACK + runtime FALLBACK spy rows, RUNNER_V2_INVITE_BOOTS rework ({found:true, verified:2, rejected:1}).

**Review findings breakdown:** pass 1 — 2 low, both patched (stale proto comment; stale verifyRecord docblock). One verification gap found and fixed BEFORE review by the matrix audit (runtime applyInvite fallback was untested → new FALLBACK row). No deferrals, no rejects, no loopback.

**Follow-up review recommendation:** false — only comment-level findings after the matrix-audit patch; all contract rows covered by named green tests.

**Verification performed:** root build green with EMPTY proto regen (twice, incl. after the .proto comment edit); typecheck clean; root vitest **607/607 (71 files)**; floor+ladder files green standalone (order-independent); app tsc clean; app vitest **85/85 (10 files)**. `candidates-unverified` grep-clean across packages src/test/proto.

**Residual risks:** strict-signer rule trusts consumer-wired `chainHasBlocks` (both core wirings pinned honest: head/bootSlot ≥ 0); witness-grade book ingest of accepted candidates is deliberately NOT this ticket (13.5) — today's candidate dials are transient; v4 candidate law stays undecided-by-rejection until the spec question resolves.
