---
ticket: "8"
epic: epic-node-network
status: "built"
review: quick
review_source: pinned
covers: ["E2"]
baseline_revision: "f8a445c1044fa4c8db18a8986a7640ac5241d063"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/src/net/adapter.ts
  - packages/core/test/circuit-relay-v2.test.ts
  - packages/core/test/block-propagation.test.ts
  - packages/core/test/net-adapter.test.ts
  - packages/core/package.json
  - config/genesis.json
---

# Story 5.8 — DHT threshold spike: bootstrap + mDNS vs Kad-DHT (E2)

## Story of Truth

A SPIKE (test-only) that settles the DHT-threshold open question (E2) with a
MEASURED answer, recorded as a dated `Decision:` line in the epic Notes — and
wires NOTHING. The spike builds an N-node network over the `@libp2p/memory`
transport (N swept over 10 / 50 / 200 / 1000), measures — with an event-bounded
budget (AD-3, never a wall clock) — how many peers a fresh node reaches by
connecting to a KNOWN address list (the bootstrap-list model that bootstrap +
mDNS reduce to over memory) and how many connect operations that costs, and
reasons about whether that known-list model (and its relay / mDNS companions)
suffices in our launch range or whether Kad-DHT (discovery of UNKNOWN peers)
becomes warranted.

The deliverable is a DECISION with measured numbers, not a capability: the epic
Notes gain ONE dated `Decision:` line (the measured peers-reached +
connect-operation numbers per N + the recommendation). NO production code is
added, NO DHT is wired, and `@libp2p/kad-dht` is NOT added as a dependency — if
the spike recommends a DHT, that is a follow-up epic, not this one (the no-DHT
non-goal holds by default).

## Acceptance Criteria

- **AC-1 — The N-sweep measures peers-reached + bounded time per N.** A
  test-only harness builds an N-node memory-transport network for each
  N ∈ {10, 50, 200, 1000}; a fresh node connects to the KNOWN address list of
  the other N−1 nodes and the row asserts it reaches all N−1 peers using a
  bounded, event-counted connect budget (dial operations), never a wall-clock
  bound (AD-3).
- **AC-2 — The epic Notes carry a dated Decision line.** The spike records ONE
  dated `Decision:` line in `epic-node-network/epic-node-network.md` with the
  measured numbers (peers reached + connect-operation count, per N) and the
  recommendation (the node count at which bootstrap+mDNS stop sufficing and
  Kad-DHT becomes warranted — or "adopt DHT day-one" or "never in our range").
- **AC-3 — No production code.** The src diff is EMPTY
  (`git diff --name-only -- packages/core/src` → nothing) AND the proto diff is
  EMPTY (`git diff --name-only -- packages/core/src/proto/` → nothing) — the
  spike is test-only (the 3.9/4.10/5.5/5.6 precedent).
- **AC-4 — `@libp2p/kad-dht` is NOT added.** The deps diff is EMPTY
  (`git diff --stat -- packages/core/package.json pnpm-lock.yaml` → nothing); a
  guard row proves the dependency is absent from `package.json` and that the
  test imports no `@libp2p/` / `@multiformats/` package (root-barrel-only).

## Design Decisions

- **D1 — Test-only harness, one new file, root-barrel-only.**
  `test/dht-threshold-spike.test.ts` (the ONLY code change besides the plan +
  the epic-Notes Decision line). It reuses the 5.5/5.6/5.7 driver shape
  (`createNetAdapter` over the memory transport, `dialWithRetry` bounded
  retry, bounded `sleep` yields — no wall-clock read, no RNG) and imports ONLY
  from the root barrel `../src/index.js` (+ vitest + node builtins: `node:fs` /
  `node:path` to read `package.json` for AC-4). No `@libp2p/` or
  `@multiformats/` import (AD-10 + the transitive-only `@libp2p/peer-id` rule).
- **D2 — The measured model is the KNOWN-ADDRESS bootstrap connect (the honest,
  CI-runnable reading of "bootstrap + mDNS reach").** A fresh node joins an
  N-node network by dialing the KNOWN address list of the other N−1 nodes
  (each a real started `createNetAdapter` node listening on a distinct
  `/memory/dht-<N>/peer-<i>` address; the joiner on `/memory/dht-<N>/joiner`).
  This is exactly what a genesis bootstrap list (5.3) provides — a set of
  KNOWN addresses to dial. Over the memory transport, mDNS (5.3) is a faithful
  double that ANNOUNCES known multiaddrs, so it too reduces to a KNOWN/announced
  address set — the known-list dial model subsumes it. The row asserts
  `peersReached === N−1` (all of them) AND `dialOps === N−1` (one successful
  dial per peer — no redundant / retry dials over memory), both event-counted
  (AD-3). It is DISCOVERY-ONLY (no gossip is published, no mesh is settled) —
  the metric is connect cost, not gossip reach (gossip reach is 5.5/5.6's
  territory).
- **D3 — The recommendation reasoning (the spike's answer, fed by the numbers).**
  Kad-DHT exists to DISCOVER peers whose addresses you do not already know. Our
  launch discovery is all KNOWN/ANNOUNCED addresses: the genesis bootstrap list
  (5.3, a fixed known set) + mDNS (5.3, LAN broadcast of known multiaddrs) +
  the circuit relay (5.7, an operator-configured `relayAddress`). None of these
  needs a DHT. The sweep's measurement confirms the known-list connect is
  LINEAR and bounded across the whole sweep (N ≤ 1000 over the CI model), so the
  known-list model is viable in our range. The DHT question (a large, DYNAMIC
  peer set whose addresses are not knowable in advance) is a DIFFERENT model we
  do not have at launch. → **Recommendation: do NOT wire Kad-DHT at launch**
  (the no-DHT non-goal holds); the recommendation + the measured numbers are the
  dated Decision in the Notes. (The exact threshold / day-one / never-in-range
  wording is fixed by the measured numbers at build time — D3 records the
  reasoning those numbers feed, not a pre-committed figure.)
- **D4 — Event-bounded, no wall-clock (AD-3).** The asserted "time" metric is
  the CONNECT-OPERATION count (dial ops), not a duration. The test never reads
  a wall clock and never uses `Math.random`. A wall-clock duration may be noted
  in the Decision as INFORMATIONAL context (not asserted), but the reproducible,
  asserted number is the event count.
- **D5 — Memory-transport honesty (scope the Decision).** The memory transport
  models the CONNECT + GOSSIP path in-process; it does NOT model a real
  network's discovery (no real broadcast, no real NAT, no real link cost). The
  sweep is therefore a CI-MODEL measurement of the known-list connect cost, not
  a real-network guarantee. The Decision is scoped to our launch model
  (small-to-medium, known-list) + the no-DHT non-goal; it does not claim the
  known-list model scales to arbitrary real-world N.

## Design Notes — measurement + decision rationale

- The N-sweep is the measurement; D3 is the reasoning it feeds. The test PINS
  the numbers it measures (peers-reached + dial-ops per N) so the Decision line
  cites reproducible figures, not a hand-wave.
- The N sweep is {10, 50, 200, 1000} (the ticket's suggested range). If the
  N=1000 case proves infeasible in the CI model (times out / OOMs), that is
  itself a recorded data point (the CI model's cost of simulating large-N
  connect grows) and the Decision notes the effective measurable range — it is
  NOT silently skipped.
- Each N case creates + stops its own nodes (only one case's nodes are alive at
  a time, bounding peak memory to the largest N).
- The joiner is the ONLY node that dials; the N−1 "existing" nodes just listen.
  This is the "a fresh node joins via a known list" scenario (the realistic
  bootstrap model) and keeps the connect cost O(N), not O(N²).

## Matrix Test Plan — `test/dht-threshold-spike.test.ts`

- **DHT_SWEEP** (`it.each` over N = 10, 50, 200, 1000): build N−1 started
  memory nodes + 1 joiner; the joiner dials the N−1 KNOWN addresses (bounded
  retry); assert `peersReached === N−1` AND `dialOps === N−1` (all peers
  reached, one successful dial each — linear, event-bounded). Bounded connect
  budget (dial retries) — no wall-clock bound.
- **NO_DHT_WIRED**: assert `@libp2p/kad-dht` is ABSENT from `package.json`
  (deps + devDeps); a self-source scan of the test file → root-barrel-only
  `../src/` import (no `@libp2p/` / `@multiformats/`), no `Date.now(` /
  `Math.random(`; `TRANSPORT === 'memory'`. (The AC-4 guard.)

## Code Map

- `packages/core/test/dht-threshold-spike.test.ts` (NEW) — the N-sweep harness
  + the NO_DHT_WIRED guard row.
- `_bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md`
  (EDIT, Notes section) — the dated `Decision:` line (measured numbers +
  recommendation), inserted after the "Open question (spike here)" line it
  answers.
- `packages/core/src/**` — UNCHANGED (AC-3).
- `packages/core/proto/protocol.proto` — UNCHANGED (AC-3).
- `packages/core/package.json` + `pnpm-lock.yaml` — UNCHANGED (AC-4).

## Tasks

- [x] **T1 — The N-sweep harness.** `test/dht-threshold-spike.test.ts`: the N
  sweep constant, `seedFor(i)`, `makeNode` (a started `createNetAdapter` over
  memory), `dialWithRetry` (bounded), the `runSweepCase(N)` helper (build N−1 +
  1, the joiner dials the N−1 KNOWN addresses, measure `peersReached` +
  `dialOps`, stop all). Root-barrel-only imports; AD-3 (bounded, no
  wall-clock/RNG).
- [x] **T2 — The DHT_SWEEP rows.** `it.each` over {10,50,200,1000}: assert
  `peersReached === N−1` AND `dialOps === N−1` (event-bounded, linear).
- [x] **T3 — The NO_DHT_WIRED guard row.** `@libp2p/kad-dht` absent from
  `package.json`; self-source scan (root-barrel-only, no `@libp2p/` /
  `@multiformats/`, no `Date.now` / `Math.random`); `TRANSPORT === 'memory'`.
- [x] **T4 — Run the full gate + record the Decision.** Run the 7-command gate
  (below); record the measured numbers in the plan's Implementation Notes;
  write the dated `Decision:` line in the epic Notes.

## Verification (run from `packages/core`)

1. `corepack pnpm test` — full suite green (243 prior + the new rows).
2. `corepack pnpm typecheck` — clean.
3. `corepack pnpm build` — clean (protons regen byte-identical — proto untouched).
4. `git diff --name-only -- packages/core/src` — EMPTY (test-only).
5. `git diff --name-only -- packages/core/src/proto/` — EMPTY (PROTO_OK).
6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml` — EMPTY (no DHT dep).
7. `git status --short` — only the new test file + the plan + the epic-doc Notes line.

## Never (this story)

- Do NOT add ANY production code (the src diff must stay EMPTY).
- Do NOT add `@libp2p/kad-dht` or any DHT dependency (the deps diff must stay EMPTY).
- Do NOT wire a DHT service into the adapter (the no-DHT non-goal holds).
- Do NOT assert on wall-clock time or use `Date.now` / `Math.random` (AD-3).
- Do NOT import any `@libp2p/` or `@multiformats/` package in the test
  (root-barrel-only; `@libp2p/peer-id` is transitive-only).
- Do NOT silently skip an infeasible N case — record it as a measured data
  point in the Decision.

## Implementation Notes

- **Measured numbers (DHT_SWEEP rows — memory transport, AD-3 event-bounded;
  wall-clock from the runner's report, informational only — never asserted):**
  - N=10: peersReached = 9 (= N−1), dialOps = 9 (= N−1) — 105 ms.
  - N=50: peersReached = 49 (= N−1), dialOps = 49 (= N−1) — 328 ms.
  - N=200: peersReached = 199 (= N−1), dialOps = 199 (= N−1) — 1153 ms.
  - **N=1000 — INFEASIBLE for the full-reach pin (recorded data point, NOT
    silently skipped):** dialOps = 999 (= N−1 — the full known list IS dialed,
    linear cost, zero retries) but peersReached settles at ~652 (< N−1):
    libp2p 3.3.11's `ConnectionPruner` (default `maxConnections = 300`) fires
    on every `connection:open` and closes excess connections via
    `safelyCloseConnectionIfUnused` (only connections whose streams are all
    speculative identify/autonat — not yet gossipsub-established — are
    closable), trimming the sustained live set. The settled count is
    scheduling-dependent (observed 652 in two independent runs; peak 654).
    The pin holds exactly while N−1 ≤ 300 — verified at N=300 (299/299
    reached, 299 dial-ops — ad-hoc only, NOT a committed row). **SWEEP is
    therefore the committed, below-threshold, reproducible set {10, 50, 200}
    of the ticket's range {10, 50, 200, 1000}. (The N=301 / N=1000 figures
    are a DISCOVERY-ONLY HARNESS ARTIFACT — in this no-gossip test every
    joiner connection carries only the speculative identify/autonat streams,
    so the pruner trims them; in production the same connections carry live
    gossipsub streams, which `safelyCloseConnectionIfUnused` refuses to close
    — NOT a production peer-set bound. See the PCL review entry.)**
- **Address-shape fix (plan discrepancy, reported — no behavior change):** the
  plan's `/memory/dht-<N>/peer-<i>` shape is INVALID over `@libp2p/memory` —
  the `memory` multiaddr protocol is SINGLE-SEGMENT; a nested path throws
  `UnknownProtocolError` at `createNetAdapter().start()`. Flattened to
  `/memory/dht-<N>-peer-<i>` / `/memory/dht-<N>-joiner` (same per-N namespace +
  per-node distinctness).
- **Seed-shape note (4.8 convention, extended for the sweep range):**
  `seedFor(i)` writes i little-endian into the first 8 bytes (the rest 0x40)
  instead of the 4.8 one-byte fill `0x40 + i`, which wraps mod 256 (a full
  256-value permutation for i ∈ 0..255 — the first repeat is at i = 256) —
  the sweep needs distinct seeds up to i = 999. Still a pure, deterministic
  function of i (AD-3).
- **Gate results (7-command gate):**
  1. `corepack pnpm test` (packages/core): 36 files / 247 tests passed (243
     prior + 4 new rows).
  2. `corepack pnpm typecheck` (packages/core): clean.
  3. `corepack pnpm build` (packages/core): clean (protons regen — proto
     untouched).
  4. `git diff --name-only -- packages/core/src`: EMPTY.
  5. `git diff --name-only -- packages/core/src/proto/`: EMPTY.
  6. `git diff --stat -- packages/core/package.json pnpm-lock.yaml`: EMPTY.
  7. `git status --short`: only the new test file + this plan + the one-line
     epic-Notes Decision.
- **Exact Decision line written into the epic Notes:**
  > - Decision: 2026-10-13 (5.8 spike) — **DHT threshold: do NOT wire Kad-DHT at launch — the known-list model (bootstrap + mDNS + the 5.7 relay) suffices in our range** ("never in our range" — revisit only if launch scale expects a large DYNAMIC peer set whose addresses are not knowable in advance: that is a follow-up epic, not launch scope). Measured over the memory-transport CI model (event-bounded, AD-3; test/dht-threshold-spike.test.ts): a fresh node dialing the KNOWN address list reaches ALL N−1 peers at LINEAR dial cost — N=10: 9 peers / 9 dial-ops; N=50: 49 / 49; N=200: 199 / 199 (wall-clock ~0.1/~0.3/~1.2 s, informational) — the committed sweep is the below-threshold set {10, 50, 200} (each reproducible in test/dht-threshold-spike.test.ts). At N=1000 the full known list is STILL dialed (999 dial-ops, zero retries — linear) but the sustained live set settles well below N−1 (~652 in two runs, scheduling-dependent): a DISCOVERY-ONLY HARNESS ARTIFACT — in this no-gossip test every joiner connection carries only the speculative identify/autonat streams, so libp2p 3.3.11's ConnectionPruner (MAX_CONNECTIONS=300; it trims only a connection whose streams are all in that speculative set) treats them as idle and closes them; in production the same bootstrap connections carry live gossipsub streams, which the pruner refuses to close, so this is NOT a production peer-set bound. A Kad-DHT discovers peers whose addresses are unknown — it does not bound the peer set — and the launch model never needs it (all discovery is known/announced). Scope: CI model — the memory transport does not model real-network discovery (plan D5).

## Plan Change Log

- (created) — plan authored at `status: planned`; baseline `f8a445c` (5.7 built).
- 2026-10-13 (5.8 build) — two recorded deviations, both reported (no
  behavior change beyond the test file itself): (1) SWEEP reduced
  {10, 50, 200, 1000} → {10, 50, 200} — the LARGEST FEASIBLE set for the
  `peersReached === N−1` pin: at N=1000 libp2p 3.3.11's ConnectionPruner
  (default maxConnections=300) trims the sustained live set to ~652 while
  dialOps stays 999 (the full known list is still dialed, linearly); the pin
  was verified to hold up to N=301 (N=300: 299/299). (2) the address shape
  was flattened `/memory/dht-<N>/peer-<i>` → `/memory/dht-<N>-peer-<i>` — the
  `memory` multiaddr protocol is single-segment (a nested path throws
  `UnknownProtocolError`). Both are recorded in the Implementation Notes +
  the epic's dated Decision line. `status:` untouched.
- 2026-10-13 (5.8 review, quick lens) — three findings, all wording/doc-only
  (no behavior change; full gate re-green after fixes): (1) the epic Decision
  line's N=1000 rationale was INACCURATE — the ~652 settle is a DISCOVERY-ONLY
  HARNESS ARTIFACT (`safelyCloseConnectionIfUnused` trims only a connection
  whose streams are all the speculative identify/autonat set, so in this
  no-gossip test it trims the joiner's bootstrap connections; in production
  they carry live gossipsub streams and are never pruned), and a Kad-DHT does
  NOT "bound the peer set" (it discovers UNKNOWN peers); reworded to frame
  {10,50,200} as the committed reproducible sweep and the N=1000 note as a
  harness artifact. (2) the "holds exactly up to N=301" claim rested on a
  non-reproducible ad-hoc N=300 run — reworded so the committed pins are
  {10,50,200} and N=300 is contextualized as ad-hoc. (3) the seed rationale
  said the 4.8 fill "collides past i = 191" — corrected to "wraps mod 256
  (a full 256-value permutation for i ∈ 0..255; first repeat at i = 256)".
  Fixed in the epic Decision line + the test header + these notes. Verified
  against libp2p 3.3.11 source (`safelyCloseConnectionIfUnused`,
  `MAX_CONNECTIONS=300`, `numConnections <= maxConnections`). `status:`
  untouched (in-review).
- 2026-10-13 (5.8 review, quick lens) — three findings, all wording/doc-only
  (no behavior change; full gate re-green after fixes): (1) the epic Decision
  line's N=1000 rationale was INACCURATE — the ~652 settle is a DISCOVERY-ONLY
  HARNESS ARTIFACT (`safelyCloseConnectionIfUnused` trims only a connection
  whose streams are all the speculative identify/autonat set, so in this
  no-gossip test it trims the joiner's bootstrap connections; in production
  they carry live gossipsub streams and are never pruned), and a Kad-DHT does
  NOT "bound the peer set" (it discovers UNKNOWN peers); reworded to frame
  {10,50,200} as the committed reproducible sweep and the N=1000 note as a
  harness artifact. (2) the "holds exactly up to N=301" claim rested on a
  non-reproducible ad-hoc N=300 run — reworded so the committed pins are
  {10,50,200} and N=300 is contextualized as ad-hoc. (3) the seed rationale
  said the 4.8 fill "collides past i = 191" — corrected to "wraps mod 256
  (a full 256-value permutation for i ∈ 0..255; first repeat at i = 256)".
  Fixed in the epic Decision line + the test header + these notes. Verified
  against libp2p 3.3.11 source (`safelyCloseConnectionIfUnused`,
  `MAX_CONNECTIONS=300`, `numConnections <= maxConnections`). `status:`
  untouched (in-review).

## Review Triage Log

- **F1 — the epic Decision line's N=1000 rationale mischaracterized the
  ConnectionPruner + Kad-DHT** (epic-node-network.md, the Decision line) —
  **FIXED (verified against libp2p 3.3.11 source).** `connection-manager/utils.ts`
  `safelyCloseConnectionIfUnused` refuses to close any connection whose streams
  are outside `DEFAULT_CLOSABLE_PROTOCOLS` (identify / identify-push / autonat /
  dcutr), and `constants.ts` sets `MAX_CONNECTIONS = 300`; `connection-pruner.ts`
  fires on `connection:open` and only prunes excess via that helper. So a
  connection carrying a live gossipsub stream is NEVER pruned. In this
  DISCOVERY-ONLY (no-gossip) test every joiner connection carries only the
  speculative identify/autonat streams → all closable → the pruner trims them →
  the ~652 settle is a HARNESS ARTIFACT, not a production peer-set bound (in
  production the same bootstrap connections carry live gossipsub streams and are
  never pruned). And a Kad-DHT discovers peers whose ADDRESSES are unknown — it
  does not "bound the peer set". Reworded the Decision line (drop the "stack
  ALREADY bounds the peer set (the property a DHT would add)" claim; frame the
  ~652 as a discovery-only-harness artifact; the recommendation stands on the
  known-list argument) + the plan's N=1000 note + Decision quote.
- **F2 — AC-1 weakened by deviation 1: the N=1000 / N=300 figures are
  narrative-only, not reproducible** (test/dht-threshold-spike.test.ts —
  `SWEEP = [10, 50, 200]`) — **ACCEPTED deviation + FIXED wording.** The
  {10,50,200,1000}→{10,50,200} reduction is JUSTIFIED (the `peersReached === N−1`
  pin is unachievable past the ConnectionPruner cap — verified in source; the
  adapter exposes no `connectionManager` config, and fixing it would require a
  production-code surface that AC-3 forbids) + HONESTLY RECORDED (PCL + Notes +
  Decision + test header; the N=1000 case is recorded, not silently skipped, per
  the plan's contingency). The Decision line + Notes now present {10,50,200} as
  the committed, below-threshold, reproducible sweep and contextualize the N=300
  "299/299" as an ad-hoc verification, not a committed pin. No N=300 row added —
  pinning the boundary would pin a discovery-only-harness artifact (see F1), not
  a production property; the recommendation stands on the reproducible {10,50,200}
  linear-reach evidence + the known-list argument.
- **F3 — the recorded seed-shape rationale is off** (test header + plan seed
  note: "collides past i = 191") — **FIXED (wording).** The 4.8 fill `0x40 + i`
  wraps mod 256 — a complete 256-value permutation for i ∈ 0..255 (the byte value
  wraps at i = 192, but the first REPEAT is at i = 256, colliding with i = 0),
  not "collides past i = 191". The new `seedFor` (index little-endian in the
  first 8 bytes) was already correct + distinct for all i ≤ 999 (no behavior
  change); corrected the stated reason in the test header + the plan's seed note.
- **Post-fix gate (full re-run, all green):** test 36 files / 247 tests passed;
  typecheck clean; build clean; `git diff --name-only -- packages/core/src`
  EMPTY; `git diff --name-only -- packages/core/src/proto/` EMPTY; `git diff
  --stat -- packages/core/package.json pnpm-lock.yaml` EMPTY; `git status
  --short` = the 3 expected files. All three fixes are wording/doc-only (the
  test's executable assertions + SWEEP set are unchanged).
