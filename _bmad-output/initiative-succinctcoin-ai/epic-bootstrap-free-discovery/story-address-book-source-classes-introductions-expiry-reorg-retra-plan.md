---
title: 'Address book: source classes, introductions, expiry, reorg retraction'
type: 'feature'
ticket: '4'
created: '2026-10-18'
baseline_revision: fe1883d
status: 'built'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 8.3 makes presence verifiable (signed announcements anchored in blocks, gossiped with verify-before-relay), but nothing *stores* it or decides what is safe to dial. Without a book, every node re-discovers from zero and hints are indistinguishable from poison: R3 ("hints verify before connect") has no home, and hint-grade addresses have no path to eligibility (no Introduction producer exists).

**Approach:** One new pure core module — the address book — keyed by `identityId` (one identity, many addresses), every entry tagged `(source class block > log > dns > hint, first-seen slot)`, ingesting 8.3's emission as block-grade KEYED BY ORIGINATING BLOCK (reorg retraction removes exactly the records that came off a retracted block). All time is a parameter (current slot — AD-3). Plus the Introduction contract + producer: a second signed record ("saw identity X online at slot s") with its own AD-12 domain, gossiped on a new class topic with verify-before-relay exactly like announcements; ≥3 independent signed introductions promote a hint to dial-eligible.

Pinned build decisions (the ticket + spec defer these):
- **Reorg strategy = key-by-block + explicit retraction** (NOT replay-from-head): every block-grade entry stores `blockRef {blockHashHex, slot}` from 8.3's emission ctx; `retractBlock(blockHashHex)` removes exactly the entries whose CURRENT provenance is that block. No older-record history is kept (a record superseded by a fresher one simply has different provenance and survives — "removes B-sourced records and only those").
- **Introduction = signed by the SIGNER ONLY; the digest binds signer AND subject** ("signer + subject signed" read as: the signature covers both identity fields). A third party can vouch unilaterally — the three-introductions rule needs introducers, not co-signers. Fields: `signerIdentityId`, `subjectIdentityId`, `slotObserved` (int64), `reachability` (string `'direct' | 'via-relay' | 'lan'` per discovery-design; carried, unused by any eligibility rule in MVP), `chainId`, `signature`.
- **Domain separation** (the ticket unknown): distinct tag `succinctcoin/Introduction/v1\0` AND a distinct field layout — neither signature can verify as the other (pinned both directions).
- **Validator order mirrors 8.2:** shape (incl. no self-vouch: `signerIdentityId === subjectIdentityId` rejects as `self-introduction` — a vouch by the subject carries zero independence) → chain → signature → time; time rule: `slotObserved > currentSlot` REJECTS (`future-observation` — you cannot claim to have seen the future). Intros carry no slot range and do not expire in MVP (promotion additionally counts only intros with `slotObserved <= currentSlot`, so eligibility is monotone in slots; rotation/privacy stays a spec open question).
- **log/DNS classes are enum-only stubs** (the ticket unknown: yes): the class union + eligibility table ship, NO producers this epic. Table: block → eligible if fresh; log → ≥1 distinct-signer intro ("corroborate, then dial"); dns/hint → ≥3 distinct-signer intros.
- **Verify-before-connect is structural:** the book's ONLY ingest paths run 8.2/8.4 validators internally — an unsigned/forged/expired record cannot enter, so `dialEligible(slot)` never contains one. Callers pass raw decoded wire data; the book never trusts it.
- **Replace policy:** per identityId, newest-wins on `slotEnd` (the freshest expiry; tie → higher class) so eligibility never regresses on same-class replacement (a cross-class demotion — block replaced by a longer-lived hint — is ACCEPTED: fresh addresses must not inherit the older record's trust provenance); replacement PRESERVES collected introductions + `firstSeenSlot` (identities persist across address rotation — spec "one identity, many addresses").
- **Quarantine:** 3 recorded dial failures → entry ineligible until `currentSlot + QUARANTINE_SLOTS` (default 32); a dial success or quarantine expiry resets the counter. Takes current slot as parameter.
- **Book size cap = 64 entries; eviction order** (the ticket unknown): prune expired first, then evict the WORST by `(class rank, slotEnd)` ascending, tie → oldest `firstSeenSlot`, then identityId hex (deterministic, "prefer freshest/highest-class").
- **Producer rule (loop):** when `introduce: true` (+ chainId), each window sign + gossip an Introduction for every identity in the loop's verified announcement set (own excluded), `slotObserved = currentSlot`, at most `MAX_INTRODUCED_PER_WINDOW = 4` in subject-id order, once per subject per loop lifetime. Gossiped intros: verify-before-relay, relay exactly once per `(signer, subject)` keyed set with newest-`slotObserved` replace-as-dedup (the 8.3 announcement pattern verbatim).
- **Hint-ingest seam for 8.5:** optional loop callbacks `onGossipedAnnouncement(record, slot)` / `onGossipedIntroduction(intro, slot)` fire when a gossiped record verified AND was accepted (replace happened) — the boot ladder wires them into a book; hint-grade records thus reach the book with zero new plumbing in 8.5.
- **ALL new loop params optional** — pre-8.4 loops (and every existing test) behave byte-identically; `introduce` defaults off.

## Boundaries & Constraints

**Always:** announcements/introductions validated ONLY through the pinned validators; book is pure (no clock, no net, no fs — current slot always a parameter); signing via 8.2/8.4 sign seams (identity.ts stays the single key reader, AD-11); new topic `/succinctcoin/introductions/1` follows AD-8 (one class per topic) with `IntroductionEnvelope {introduction=1, sourcePeerId=2}`; proto change PURELY ADDITIVE (PROTO_OK: regen idempotent, existing golden hexes untouched, no protocolVersion bump — nothing consensus-visible changes block bytes); every new option optional.

**Never:** no wall clocks (AD-3); no dialing logic in the book (it exposes eligibility, the dialer dials — 8.5); no LAN-book-file / ladder wiring (8.5's boot sequence); no app changes; no reorg DETECTION machinery (retraction API + simulated-reorg proof only — nothing today forks a book); no real producers for log/dns classes; no NetPort interface change (adapter-extension method like `sendAnnouncement`); existing field numbers frozen.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ingest block-grade (8.3 emission) | validated record + `{blockHashHex, slot}` | entry `(block, firstSeenSlot, blockRef)`; dialEligible while fresh | invalid record → not stored (validator reason returned) |
| Forged / expired / unsigned record | hostile wire data | NEVER in the book, NEVER in `dialEligible` at any slot | `{ok:false}` from ingest |
| Hint with 0/1/2 intros | hint-grade entry + <3 distinct signers | not dial-eligible | — |
| Hint with exactly 3 intros | 3 DISTINCT signer identities, slotObserved ≤ slot | promoted → dial-eligible | — |
| Same signer ×3 | one signer, 3 intros | NOT promoted (independence) | — |
| Self-vouch | `signerIdentityId == subjectIdentityId` | rejected `self-introduction` (shape stage) | `{ok:false}` |
| Expiry demotes | entry `slotEnd < currentSlot` | gone from eligible; monotone: once ineligible at s, ineligible for all s′ > s until re-ingested | — |
| Reorg retract B | entries sourced from blocks A,B,C | `retractBlock(B)` removes exactly B-sourced entries; A/C + hint entries untouched | unknown blockHash → no-op |
| Retract then re-ingest | B's records re-appear in canonical block B′ | fresh ingest under B′ works normally | — |
| Dial failures | 3 failures at slot s | ineligible until `currentSlot > s + QUARANTINE_SLOTS`; success resets | — |
| Book pressure | 65th distinct identity | worst `(class,slotEnd)` evicted (freshest/highest-class kept) | deterministic order |
| Introduction future-dated | `slotObserved > currentSlot` | rejected `future-observation` | `{ok:false}` |
| Cross-domain signature | announcement sig presented as intro (and vice versa) | verification FALSE both directions | — |
| Relay: forged gossiped intro | loop receives bad-sig envelope | never republished | — |
| Relay: valid gossiped intro | received over several windows | republished EXACTLY once per (signer,subject) | — |
| Loop `introduce` absent | today's loops | byte-identical behavior, zero introduction traffic | — |

</frozen-after-approval>

## Code Map

- `packages/core/proto/protocol.proto` — after `PeerAnnouncement`: `Introduction` (6 fields above) + `IntroductionEnvelope {Introduction introduction = 1; string sourcePeerId = 2}`. Purely additive; regen via root build (PROTO_OK).
- `packages/core/src/proto/index.ts` — hand-maintained re-export layer += `Introduction` / `IntroductionEnvelope` (type + const), mirroring the AnnouncementEnvelope entry.
- `packages/core/src/net/topics.ts` — sixth TOPICS entry `introductions: '/succinctcoin/introductions/1'`; TopicClass → six; header comment updated.
- `packages/core/src/net/adapter.ts` — decode case for `TOPICS.introductions`; subscribe list += 1; `sendIntroduction(intro)` adapter-extension method (the `sendAnnouncement` pattern, NOT on NetPort); envelope-count comments 5→6.
- `packages/core/src/discovery/introductions.ts` — NEW: domain tag, digest, `signIntroduction` / `verifyIntroductionSignature`, `validateIntroduction(record, {currentSlot, expectedChainId})` + reason union. Mirrors `announcements.ts` structure (local byte helpers, coerceSlot, SPKI reconstruct from identityId).
- `packages/core/src/discovery/address-book.ts` — NEW: `AddressSourceClass`, `createAddressBook(opts?)` → `{ ingestAnnouncement(record, ctx & {sourceClass, blockRef?}), ingestIntroduction(record, ctx), recordDialFailure(id, slot), recordDialSuccess(id), retractBlock(blockHashHex), dialEligible(slot), entries(), pruneExpired(slot) }` (`entries()` is the raw full view — slot-filtered reads go through `dialEligible`; review finding 7). Pure; validators are the only admission gate. NO member named `blob`/`secret` (AD-4/AD-11 scans).
- `packages/core/src/discovery/index.ts` — barrel += introductions + address-book exports.
- `packages/core/src/index.ts` — root barrel: new discovery exports + `Introduction`/`IntroductionEnvelope` proto re-exports.
- `packages/core/src/consensus/node-loop.ts` — net type += optional `sendIntroduction?`; opts += `introduce?: boolean`, `onGossipedAnnouncement?`, `onGossipedIntroduction?`; loop state: `knownIntros` Map (keyed `signer|subject`) + `introduced` set; `processIntroductions(slot)` after `processAnnouncements(slot)` in Window(); hint/intro callbacks at the accept points.
- Tests: NEW `discovery-introduction.test.ts` (contract), `discovery-address-book.test.ts` (book + fast-check property rows), `discovery-introduction-loop.test.ts` (loop producer/relay + adapter round-trip + book-fed E2E row); pin updates where the topic/envelope set is enumerated (`net-adapter.test.ts` received-map literal; any "five classes" comments).
- `README.md` — test count line.

## Design Notes

- **Why key-by-block over replay:** replay needs a block→emission re-read path (store scan + re-apply) that doesn't exist and would duplicate sync machinery for a rare event; the emission ctx already carries `{blockHashHex, slot}` verbatim from 8.3 — keying is one Map-of-Sets and O(1) retraction. Cost: no older-record fallback on retract (documented; MVP hint records usually corroborate anyway).
- **Why intros don't expire:** the frozen rows need promotion monotone in slots + expiry DEMOTION of records, not of vouches; vouch decay rides quarantine (bad addresses stop dialing) — expiring vouches would silently de-promote healthy peers under churn. Recorded as a deliberate MVP limit for epic 9 review.
- **Producer corroboration semantics:** "saw X online at slot s" = this node verified X's announcement (8.2 signature ⇒ presence proof) at slot s. Gossiped-and-verified announcements are exactly that observation, so the producer introduces from the loop's `known` set — plurality across nodes gives the 3-signer threshold meaning (one node cannot mint its own three vouches).
- **No protocolVersion bump:** blocks unchanged on the wire; a new gossip topic + additive messages cannot fork anyone. The 8.3 bump precedent applied because DIGEST bytes changed.
- **fast-check placement:** poison-never-enters (both ingests, any sequence) and replace-monotonicity-of-slotEnd get property rows; retract-only-B, exactly-3-promotes, and expiry demotion stay example-based pins (crisper failure messages) — they are enumerated scenarios, not invariants over random sequences.

## Tasks & Verification

- [x] 1. Proto: `Introduction` + `IntroductionEnvelope`; root build → PROTO_OK regen idempotent; proto barrel + root barrel re-exports; existing golden tests still green unchanged.
- [x] 2. `introductions.ts`: digest/sign/verify/validator + golden vector (pinned bytes, like 8.2); `discovery-introduction.test.ts` green (~10 rows incl. cross-domain both directions).
- [x] 3. `address-book.ts` + barrel; `discovery-address-book.test.ts` green — every frozen matrix row covered; fast-check rows included.
- [x] 4. Net: topics/adapter/barrel for the introductions class; update enumerated pins.
- [x] 5. Loop: producer + relay-once + callbacks (all optional); `discovery-introduction-loop.test.ts` green (forged never relayed; exact-once relay pinned as set equality; E2E hint+3-vouches → real book dialEligible).
- [x] 6. Gates: root suite, typecheck, build PROTO_OK, app package untouched-but-green (`cd packages/app && corepack pnpm test`); README count; AD scans green (no `.blob`/`.secret`, big.js set unchanged, no Date.now/Math.random in src).

**Verify (frozen):** property rows (fast-check): forged/expired/hint-without-3 NEVER in dial-eligible; exactly-3 promotes, 2 does not, expiry demotes; simulated reorg retracting B removes B-sourced records and only those; expiry monotone in slots; introduction signatures verify with domain separation from announcements; module pure / memory-transport-only (AD-10).

## Implementation Notes

- Golden vector (pinned in `discovery-introduction.test.ts`): signer seed bytes 0x00..0x1f (`03a107bf…5531b8`), subject seed fill(0x42) (`2152f8d1…81db12`), slotObserved 7, 'direct', chain `succinctcoin-test` → digest `58a442a3…9d9138`, signature `b02fcc5b…d40f0b`. Re-verified against the shipped build before pinning.
- Frozen matrix: all rows pinned across the three new files (31 tests at first green; 345/49 root total after review patches). Loop rows reuse the 8.3 mesh harness generalized to arbitrary topologies (`peersList`), incl. the five-node star proving hint+3-vouches → dialEligible through ONLY the callbacks + a real `createAddressBook()` — the exact 8.5 seam.
- **Test-harness trap (re-learned):** the loop's store fake MUST serve `getBlock(head)` — `nextSlotAndParent` throws without the parent block, and `runWindow` swallows window errors by design, so a stub returning `null` silently pins every loop to ONE window. The 8.3 tracer fake already served blocks; copy it verbatim.
- Loop relay dedup gained a cheap pre-verify gate (key + slotObserved compare before Ed25519) and `knownIntros` is capped (`MAX_KNOWN_INTROS = 256`, oldest-observed evicted, deterministic tie-break) — the DoS/memory floor from review findings 3/4. Skipping a held-at-least-as-fresh pair never relays, so verify-before-relay survives: only verified records were ever stored.
- Self-vouches (`signer == subject`) reject at the validator's shape stage (`self-introduction`) — without it a subject could mint one of its own three required vouches (review finding 5). Loop E2E confirms B's book holds EXACTLY {C,D,E} for A: B's own vouch returns from leaves as stale copies and dies at the dedup gate, never reaching the callback.
- Quarantine expiry now resets `failedDials` lazily (`expireQuarantine` in `recordDialFailure` + `dialEligible`) — the frozen rule the first cut missed (review finding 1).
- Vouch maps are bounded: `MAX_VOUCHES_PER_SUBJECT = 16` per live entry AND per parked subject (freshest kept, deterministic eviction); parked-SUBJECT overflow now evicts by oldest-newest-vouch, not insertion order (findings 4/9).
- `createNodeLoop` stays OFF the root barrel (core-surface pin); loop tests deep-import the consensus sub-barrel. No existing test enumerated the TOPICS key set, so the sixth topic needed no pin changes beyond comments; `net-adapter.test.ts` needed none.
- Suite: 345 tests / 49 files root, app 27/6 green; typecheck green; build PROTO_OK (protocol.ts +398/−0 additive).

## Plan Change Log

- Replace policy frozen line said newest-wins on `slotStart`; implementation uses **`slotEnd`** (freshest expiry — replacing on slotStart lets a longer-lived older record block a fresher one and lets eligibility regress at the old expiry). Same tie rule. Callbacks renamed plural→singular (`onGossipedAnnouncement(record, slot)` / `onGossipedIntroduction(intro, slot)`) to match per-record firing.
- "Eligibility never regresses on replacement" narrowed to same-class replacements (finding 2): cross-class demotion is the ACCEPTED behavior — addresses from a hint-grade record must not inherit block-grade provenance. Mechanism (newest-slotEnd-wins, tie→class) unchanged.
- `entries(slot)` in the Code Map implemented as `entries()` (raw view; slot-scoped reads are `dialEligible`) — finding 7, docstring aligned.
- Validator order line + matrix amended with the `self-introduction` shape rule (finding 5) — added during the review loop, not a post-hoc drift.
- Batch-edit hazard hit again: a `multi_replace` batch with an invented sentinel oldString FUZZY-matched and destroyed the adapter's announcements decode case; restored same session from context, whole adapter diff re-verified additive. Rule reaffirmed: no sentinel oldStrings ever; `git diff` after every batch.

## Review Triage Log

| # | Finding (quick lens) | Verdict | Route | Action |
|---|----------------------|---------|-------|--------|
| 1 | Quarantine expiry never resets `failedDials` — one stale failure re-mints a full window; contradicts frozen rule | medium, real (intent_gap) | patch | `expireQuarantine` in `recordDialFailure` + `dialEligible`; QUARANTINE row extended to pin post-expiry single failure stays eligible |
| 2 | Newest-slotEnd replace can DEMOTE class (block→hint) and drop eligibility — contradicts the rationale clause | medium, mechanism frozen / rationale overclaimed | bad_plan → patch plan | Rationale narrowed to same-class; cross-class demotion documented as accepted (fresh addresses must not inherit old provenance). No code change |
| 3 | Every received intro re-pays Ed25519 in EVERY window forever (append-only inbox, no expiry horizon) | medium, real | patch + defer | Pre-verify dedup gate shipped (kills the valid-flood replay case); full inbox cursor/prune is the SAME cross-cutting design deferred at 8.3 triage #3 — epic-9 hardening |
| 4 | `knownIntros` + per-subject vouch maps unbounded (one key flooding subjects grows them forever) | medium, real | patch | `MAX_KNOWN_INTROS = 256` (loop), `MAX_VOUCHES_PER_SUBJECT = 16` (book: live, parked, merged); deterministic oldest-first eviction; VOUCH_CAP row pinned |
| 5 | Self-vouches accepted and counted toward the three-introductions threshold | medium, real | patch | `self-introduction` reject at shape stage; matrix + validator order amended; test row added |
| 6 | Malformed bytes on the new topic throw inside the adapter's gossip listener (decode un-caught) | medium, pre-existing class across all six topics | defer | One try/catch sweep over ALL topic decode cases belongs in a hardening ticket — fixing only the sixth case leaves five broken siblings; recorded for epic 9 |
| 7 | `entries()` drops the plan-pinned slot param while its docstring claims it | low, real | patch | Docstring + Code Map aligned to `entries()` (raw view) |
| 8 | Producer marks subject introduced even when send fails (vouch lost for loop lifetime); own node's book never sees its own vouches | low, follows frozen rows | rejected → note | Accepted cost of once-per-subject; 8.5 can self-feed producer vouches into the local book — noted in Implementation Notes |
| 9 | Parked-vouch eviction was insertion-order (arrival-order divergence between nodes) | low, real | patch | Evict by oldest NEWEST-vouch (tie: greatest hex subject) — deterministic like the pinned pressure policy |
