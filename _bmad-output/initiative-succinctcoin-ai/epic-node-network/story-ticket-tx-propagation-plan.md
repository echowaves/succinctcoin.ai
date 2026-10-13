---
ticket: "6"
epic: epic-node-network
status: "built"
review: quick
review_source: pinned
covers: ["R1", "R3"]
baseline_revision: "498847596e407b71aeb431eb90150093fa0df93e"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/topics.ts
  - packages/core/src/consensus/multi-sim.ts
  - packages/core/src/consensus/acceptance-cap.ts
  - packages/core/src/consensus/uptime.ts
  - packages/core/src/identity/identity.ts
  - packages/core/proto/protocol.proto
  - packages/core/src/index.ts
  - packages/core/test/block-propagation.test.ts
  - packages/core/test/net-adapter.test.ts
  - config/genesis.json
---

# Story 5.6 — Ticket + tx propagation on their own topics

## Story of Truth

This story proves, over a **live multi-node memory-transport mesh**, that tickets and
transactions each travel on **their own gossipsub topic** (spine AD-8: one stable topic
per class) and arrive at peers as **well-formed, usable** payloads:

- **A ticket** published on the `tickets` topic by one node is **received** by peers and
  **accepted into the peer's per-window accepted set** — it becomes **eligible for the
  draw on the receiving node**, and the **4.4 acceptance cap applies to gossiped tickets
  exactly as to local ones** (origin-agnostic). The peer builds its accepted set purely
  from `(identityId, nonceCommitment, signature)` + the identity's validWindows; a
  `Ticket` carries **no origin field**, so a gossiped ticket and a local ticket are
  literally indistinguishable data, and `applyAcceptanceCap` de-dups by `identityId`
  regardless of where the ticket came from.
- **A tx** published on the `tx` topic is **received with its decimal-string amount
  intact** (spine AD-5 / R3): the `amount` and `fee` fields are EXACT decimal strings
  (byte-for-byte, `typeof === 'string'`), never a float, across the wire.
- **Topic isolation**: each class travels on its own topic — a block published on the
  `blocks` topic never appears on the `tickets`/`tx` topics, and vice versa. This is the
  live-mesh version of 5.2's self-publish `TOPIC_ISOLATION` (real gossiped bytes, not a
  single-node self-echo).

This is the **second half of the Done-when clause (2)**: "A block authored by one node
propagates via gossipsub to k peers (5.5, blocks topic); **a ticket and a tx propagate
on their own topics**." 5.5 proved the block half; 5.6 proves the ticket + tx half.

**Scope (DECIDED — TEST-ONLY):** one new, self-contained test file
`packages/core/test/ticket-tx-propagation.test.ts` with its own focused driver. The
driver is **not** refactored out of `block-propagation.test.ts` (5.5) — a shared-driver
extraction is 5.9's (the sweep) domain if wanted. **No src/proto/dep changes** — see the
decode-containment disposition in Design Notes.

## Acceptance Criteria

- **AC-1 (ticket into the accepted set, origin-agnostic).** A ticket published on the
  `tickets` topic by one node is received by a peer over the live mesh and appears in
  the peer's capped accepted set for that window, with weight
  `computeUptimeWeight(identity.validWindows, slot, L)` — the **same weight** the
  identity would get from a locally-mined ticket, and **eligible for the draw**
  (`drawWindow` over the capped set returns one of the participants). A direct
  `applyAcceptanceCap` on a raw set holding a "local" and a "gossiped" ticket for the
  same identity collapses to one (keep-first), proving the 4.4 cap is origin-agnostic.
- **AC-2 (tx decimal-string intact).** A `proto Tx` published on the `tx` topic is
  received by a peer with `amount` and `fee` as the **exact** decimal strings published
  (`typeof === 'string'`, byte-for-byte), `sender`/`recipient` byte-identical, and
  `slot` preserved. No float ever touches the amount (AD-5 / R3).
- **AC-3 (topic isolation over the live mesh).** A block on `blocks`, a ticket on
  `tickets`, and a tx on `tx` are each received **only** on their own topic; the
  `blocks` topic never receives a ticket or tx envelope, and the `tickets`/`tx` topics
  never receive a block envelope.
- **AC-4 (additive / test-only).** `src`, `proto`, and deps are byte-untouched
  (`git diff --name-only -- packages/core/src`, `-- packages/core/proto`, and the
  `package.json`/`pnpm-lock.yaml` diff are all EMPTY); the driver imports **only**
  root-barrel seams + `vitest` + node builtins; the memory transport is used (zero real
  sockets, AD-10); every wait is a **bounded poll** (no `Date.now`/`Math.random` in the
  cadence); no new dependencies; the prior 234 tests still pass (new suite ≈ 238).

## Design Decisions

- **D1 — TEST-ONLY, one new file.** `test/ticket-tx-propagation.test.ts` is the only new
  artifact. It carries its own focused driver (3 in-process nodes, each with its own
  `FileChainStore` + net adapter + identity keypair, composing **root-barrel seams only** —
  the same AD-1 pattern as 5.5, not wired into `createCore`). `src`/`proto`/deps are
  untouched. Rationale: 5.6's verify is a propagation proof; it exercises the existing
  adapter `sendTicket`/`sendTx` + `received` seams and the pure 4.4/4.5 draw seams — no
  new capability code is required.
- **D2 — the ticket-into-set path is origin-agnostic by construction.** A `proto Ticket`
  has no origin field. The peer's accepted set is built from
  `(identityId, nonceCommitment, signature)` + the identity's `validWindows` (the
  participant roster the driver supplies). `applyAcceptanceCap` (4.4) de-dups by
  `identityId` (keep-first) and `computeUptimeWeight` (4.5) keys on `validWindows` —
  neither looks at where the ticket came from. **Proven** by AC-1: the gossiped ticket
  is in the peer's capped set with its correct weight and is a valid draw participant; a
  synthetic `{localA, gossipedA, B}` set collapses to two under the cap.
- **D3 — txs are HELD, not re-gossiped / not applied** (the 5.6 ticket's stated build
  decision for the "unknown"). A node publishes a `proto Tx` to the `tx` topic; peers
  **receive and hold** it for the ledger path (it lands in the adapter's `received` map
  under the `tx` class). 5.6 proves the tx **propagates** (decimal-string amount intact)
  and is **holdable**. Actually *applying* a tx (the verified-Tx ledger path) is a
  deferred follow-up, **not** 5.6.
- **D4 — topic isolation is asserted over the live mesh.** Unlike 5.2's self-publish
  isolation (one node, self-echo), 5.6 publishes a block + ticket + tx across the mesh
  and asserts each class's `received` list on each topic holds only its own class — the
  live-mesh version of the AD-8 invariant.
- **D5 — no new dependencies** (5.1–5.5 precedent). The memory transport + existing
  seams are sufficient.

## Design Notes — disposition of the 5.5 forward notes

- **Note 1 (send retry / `allowPublishToZeroTopicPeers`): DEFERRED to 5.7.** The 5.5
  driver forms the mesh *before* publishing (bounded dial retry + `settleMesh`), so the
  send path is not load-bearing here. 5.6 does not change that — publishing happens only
  after the mesh has settled. The decision belongs with the NAT/relay story (5.7), where
  the send path genuinely depends on peers not yet being in the mesh.
- **Note 2 (decode containment): DECIDED — deferred as a post-epic-5 net-robustness
  follow-up, NOT implemented here.** Rationale: (a) 5.6's verify is exclusively about
  **well-formed** propagation — it does not test corrupt-envelope handling; (b) the
  containment (a corrupt envelope on a known topic → a normal drop, never a throw, by
  catching the protons `XEnvelope.decode` `RangeError` inside the adapter's
  `decodeReceived`/message handler) is **untestable with the adapter's current public
  API** — `sendBlock`/`sendTicket`/`sendTx` always emit well-formed envelopes on the
  correct topic, and there is no raw/malformed-message publish path to exercise it.
  Adding an **untestable** code path (or a test-only raw-publish hook to the adapter,
  which is a `src` change + a new test-only API surface) is out of 5.6's scope and would
  violate the "verify empirically / no dead code" discipline. Per the 5.4 F2
  clarification, the spine's "reject = a normal `false`/REJECT, never a throw" rule
  governs the **acceptance decision**, not a protocol fault — a corrupt envelope throwing
  is a separate robustness concern, not an acceptance-rule violation. The containment is
  **named** (not dropped): it should land with a **test-only malformed-message publish
  hook** so it is verifiable, as a post-epic-5 net-robustness follow-up.
- **Note 3 (5.4-F1 framing unit test via exported framing helpers): DEFERRED to 5.7**
  (real/relayed transport, where framing matters).
- **Note 4 (5.4-F2 catch the seam `DrawError` on a malformed sync block = normal stop):
  DEFERRED** (untrusted-peer threat model; not exercised by 5.6, which uses well-formed
  tickets only).
- **Note 5 (5.4-F3 client-side contiguity): already LANDED in 5.5 via D6** (pinned by
  `TRACER_CONTIGUOUS`). Nothing to do in 5.6.

## Matrix Test Plan — `test/ticket-tx-propagation.test.ts` (4 rows)

- **TICKET_INTO_ACCEPTED_SET** — 3 nodes (A, B, C) over the memory mesh. Each node
  publishes its own window-S ticket to the `tickets` topic; node B collects
  own + gossiped (the 5.5 F1-safe collect-all loop: bounded, until every participant's
  ticket is present), identity-sorts, applies `computeUptimeWeight` + `applyAcceptanceCap`
  → **B's capped set holds exactly {A, B, C}**, the gossiped A ticket present with weight
  `computeUptimeWeight(A.validWindows, S, L)` (origin-agnostic) and **eligible for the
  draw** (`drawWindow` over the capped set ∈ {A, B, C}). Sub-assertion: a direct
  `applyAcceptanceCap` on a synthetic raw set `{localA, gossipedA, B}` (same identityId
  A, different commitments) collapses to 2 (keep-first = localA) — the cap is
  origin-agnostic.
- **TX_DECIMAL_STRING** — node A builds a `proto Tx` with `sender`/`recipient` as 32-byte
  arrays, `amount` = a large decimal **string** (e.g. `'123456789012345678901234567890'`),
  `fee` = `'1234567'`, `slot` = S, `signature` = 64 bytes; publishes via `sendTx`. Node B
  receives it on the `tx` topic and asserts `amount`/`fee` are the **exact** published
  strings (`typeof === 'string'`, byte-for-byte), `sender`/`recipient` byte-identical,
  `slot === S` (AD-5 / R3).
- **TOPIC_ISOLATION** — over the live mesh: a block published on `blocks`, a ticket on
  `tickets`, a tx on `tx`. Each peer's `received.get('blocks')` holds **only** the block
  (no ticket/tx), `received.get('tickets')` **only** the ticket, `received.get('tx')`
  **only** the tx. A block never lands on the tickets/tx topics (AD-8).
- **ADDITIVE** — `src`/`proto`/deps diffs EMPTY; the driver imports **only** root-barrel
  seams (+ vitest + node builtins); the memory transport is used; every wait is a bounded
  poll (self-source asserts no `Date.now(` / `Math.random(` in the cadence); no new
  deps; the four class topics are pinned; the prior suite stays green.

## Code Map

- **NEW:** `packages/core/test/ticket-tx-propagation.test.ts` — the 4 rows above + its
  focused driver (pinned constants, `seedFor(i)`, `deriveIdentityKeypair`,
  `MultiSimIdentity`, `makeNode`, `dialWithRetry`, `settleMesh`, a collect-all
  `collectGossipedTickets(node, participants, slot)` helper, `publishUntilAccepted`,
  `pollReceived` (single-target, per-topic cursor), `close`).
- **Do NOT touch:** `src/**` (incl. `src/net/adapter.ts` — the decode containment is
  deferred, see Note 2), `proto/**`, `package.json`, `pnpm-lock.yaml`,
  `config/genesis.json`, and every existing test file (incl.
  `test/block-propagation.test.ts`).

## Tasks

- [x] **T1 — Author the driver + pinned constants.** Seed/identity/`MultiSimIdentity`
  fixtures (identical shape to 5.5), `makeNode`, `dialWithRetry` + `settleMesh`
  (mesh-first), `publishUntilAccepted`, `pollReceived`, and the F1-safe
  `collectGossipedTickets` (bounded collect-all over the accumulated `tickets` list until
  every participant's ticket is present). Root-barrel imports only.
- [x] **T2 — TICKET_INTO_ACCEPTED_SET.** Publish each node's window-S ticket; node B collects
  + builds the capped set; assert {A, B, C} present, gossiped A with its correct weight
  and draw-eligible; the origin-agnostic cap sub-assertion.
- [x] **T3 — TX_DECIMAL_STRING.** Publish a `proto Tx` with a large decimal-string amount;
  assert the receiver's copy is byte-exact (strings, sender/recipient, slot).
- [x] **T4 — TOPIC_ISOLATION + ADDITIVE.** Publish block+ticket+tx across the mesh; assert
  per-class topic isolation; assert the additive gates (EMPTY diffs, root-barrel-only
  imports, memory transport, bounded polls, no new deps, topics pinned).
- [x] **T5 — Run the full gate (7 commands below) and record results in Implementation
  Notes.**

## Verification (run from `packages/core`)

1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` — expect all prior + new
   green (≈ 238, 34 files).
2. `corepack pnpm typecheck 2>&1 | tail -1` — clean.
3. `corepack pnpm build 2>&1 | tail -1` — clean (protons regen byte-identical; proto
   untouched).
4. `git diff --name-only -- packages/core/src` — **EMPTY** (src untouched).
5. `git diff --name-only -- packages/core/proto` — **EMPTY** (proto untouched).
6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml` — **EMPTY** (deps
   untouched).
7. Guards (no-float guard, identity-key surface guard) still pass — covered by the suite.

## Never (this story)

- No real sockets — memory transport only (AD-10).
- No wall-clock / RNG in the cadence — every wait is a **bounded poll** (5.5's
  `MAX_POLLS`/`DIAL_POLLS`/`MESH_SETTLE_POLLS` pattern).
- No re-implementation of a seam — use root-barrel exports only.
- **No decode-containment code** (deferred per Note 2 — do NOT add an untestable
  try/catch to `src/net/adapter.ts` in this story).
- `reject`/drop = a normal outcome, never a throw.
- Do NOT touch `proto`, `package.json`, `pnpm-lock.yaml`, `config/genesis.json`, or any
  existing test file.
- Do NOT `git commit` or `git push` — the orchestrator commits.

## Implementation Notes

T1–T4 built; T5 gate recorded (2026-10-12, baseline `4988475` = 5.5).

- **T1 — driver + pinned constants.** `test/ticket-tx-propagation.test.ts`
  (844 lines) reuses 5.5's proven driver shape: `seedFor(i)` (32 ×
  `0x40+i`) → `deriveIdentityKeypair` → `MultiSimIdentity`
  (`attestedUntilWindow: 100000n`, `validWindows` = 8 windows from
  `validWindowStart`), `makeNode` (mkdtemp `FileChainStore` + memory
  adapter + per-topic cursors; balance seeding kept for 5.5 shape parity),
  `dialWithRetry` (≤40), `settleMesh` (≤120 yields), `publishUntilAccepted`
  (≤400), `pollReceived` (per-topic cursor, single-target-safe), and the
  F1-safe `collectGossipedTickets(node, participants, slot)` — publish own
  `signedTicket`, then ONE bounded collect-all loop over the accumulated
  `tickets` list (dedupe by identityId, keep-first). New bounded liveness
  gate `waitAllClasses` for the isolation row. Pinned window: `SLOT = 3n`
  + `GENESIS_PARENT` (32 zeros) — 5.6 does not run the slot loop (no
  mining/applying), so the window is a fixed chain-time point; a non-zero
  slot gives every identity a non-trivial 4.5 weight (3n — valid over
  windows [0,1,2] of the L=50 lookback) so the weight assertions are not
  the ramp-from-zero degenerate case. The challenge is derived locally by
  every node via the imported `deriveWindowChallenge` (5.5 D3 — never
  wire-trusted).
- **T2 — TICKET_INTO_ACCEPTED_SET.** 3 nodes publish their window-3
  tickets in parallel; B collects (F1-safe), identity-sorts, 4.5 weights,
  4.4 cap → exactly {A,B,C}; gossiped A ticket byte-identical to the
  recomputed pinned commitment, wire-stamped `sourcePeerId === A`, weight
  `computeUptimeWeight(A.validWindows, SLOT, L)` = B's local weight
  (origin-agnostic); `drawWindow` over the capped set ∈ {A,B,C}. Synthetic
  `{localA, gossipedA, B}` (same identityId, different commitments)
  collapses to 2, keep-first = localA (same reference).
- **T3 — TX_DECIMAL_STRING.** `proto Tx` with the 30-digit decimal-string
  amount `'123456789012345678901234567890'` (beyond float64 precision) +
  fee `'1234567'` + 32-byte sender/recipient + 64-byte signature
  publishes on the `tx` topic; B's copy: `typeof amount/fee === 'string'`
  byte-for-byte, sender/recipient byte-identical, `slot === SLOT`,
  signature byte-identical, envelope stamped with A's protocol id.
- **T4 — TOPIC_ISOLATION + ADDITIVE.** A publishes a pinned fixture
  `Block` (no mining — the row is about topics, 5.2 FIX_BLOCK precedent) +
  the 4.2-signed ticket + the AD-5 tx; B and C each receive EXACTLY
  1/1/1 per topic with payload-identity + sourcePeerId checks (any
  cross-class leak would bump a count). ADDITIVE row asserts: the 14
  imported seams, `TRANSPORT === 'memory'`, self-source scan
  (`../src/` imports = root barrel only; no `Date.now(` / `Math.random(`),
  the four topic pins.
- **T5 — gate results (2026-10-12, exact output):**
  1. `corepack pnpm test 2>&1 | grep -E "Test Files|Tests "` →
     `Test Files  34 passed (34)` / `Tests  238 passed (238)` (234 prior +
     4 new — the plan's ≈238/34-files prediction, exact).
  2. `corepack pnpm typecheck 2>&1 | tail -1` → clean (tsc no output).
  3. `corepack pnpm build 2>&1 | tail -1` → clean (protons regen
     byte-identical; tsc no output).
  4. `git diff --name-only -- packages/core/src` → EMPTY.
  5. `git diff --name-only -- packages/core/proto` → EMPTY.
  6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml` → EMPTY.
  7. `git status --porcelain` → `?? packages/core/test/ticket-tx-
     propagation.test.ts` (the only new file) + this plan file + the
     pre-existing `M story-block-propagation-plan.md` (5.5's uncommitted
     implementation notes — present at baseline, untouched here).
- **Observations (no action):** (a) the frontmatter `context:` lists
  `packages/core/src/proto/protocol.proto`; the actual proto lives at
  `packages/core/proto/protocol.proto` (pre-existing context-path drift,
  same class as the 3.3 note — the file was loaded from its real path).
  (b) This plan file is UNTRACKED at baseline (orchestrator-created, not
  yet committed), so its modification surfaces as `??` rather than `M` in
  gate 7 — the `M` the task brief expected would require the file to be
  tracked first.

## Plan Change Log

- **2026-10-12 (step-04, quick-lens):** corrected the frontmatter `context:` entry
  `packages/core/src/proto/protocol.proto` → `packages/core/proto/protocol.proto`
  (the SOURCE proto; `src/proto/` is the protons **output** dir — the listed path did
  not exist). Docs-only; no code impact; no re-gate required.

## Review Triage Log

**Quick lens (2026-10-12) — iteration 1: NO defects.** The reviewer verified every
acceptance criterion and spine rule against source and found no unmet ACs, no rule
violations, and no bugs:
- **AC-1 (origin-agnostic cap) proven, not just asserted:** the gossiped A ticket is the
  wire-decoded object, byte-identical to a local recompute, weight `3n` (non-trivial —
  valid over windows [0,1,2] of L=50), equal to B's local weight, and draw-eligible; the
  synthetic `{localA, gossipedA, B}`→2 sub-assertion is non-vacuous (the 5th
  `signedTicket` arg `ticketIndex` is folded into the commitment sha256, so 0n vs 1n
  differ; keep-first pinned by reference).
- **AC-2 (tx decimal-string):** the 30-digit amount exceeds float64's ~15.95-digit
  mantissa, so the byte-for-byte string equality is a real no-float proof; sender/
  recipient/slot/signature intact.
- **AC-3 (topic isolation):** verified on PEERS (b, c — the publisher's self-echo
  excluded) with EXACT 1/1/1 per-topic counts + per-payload identity + sourcePeerId.
- **AC-4 (additive / TEST-ONLY):** 7 import statements, all `../src/index.js` (+ vitest +
  node builtins); zero src/proto/deps changes; NO decode-containment try/catch added to
  `src/net/adapter.ts` (Design Note 2 deferral honored).
- **Decode-containment deferral (Note 2) confirmed SOUND:** the adapter's public API has
  no raw/malformed-message publish path, so the containment is untestable without a
  test-only hook (a src change, out of scope); well-formed propagation is 5.6's verify.
- **Determinism (AD-3/AD-10):** pinned seeds/challenge/fixture; memory transport only.
- **Gate correctness:** TEST-ONLY gates (src/proto/deps EMPTY, suite green) conform.
- **Observation (fixed):** the frontmatter `context:` listed the non-existent
  `packages/core/src/proto/protocol.proto`; corrected to the real source
  `packages/core/proto/protocol.proto` (see Plan Change Log). Docs-only.
