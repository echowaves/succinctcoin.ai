---
title: '11.1 Relay-hop address policy: one predicate, every boundary'
type: 'feature'
ticket: '1'
created: '2026-10-21'
status: done
baseline_revision: '3663d6742e0bf380ead22f4b79fbeba8796db6df'
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

**Problem:** The addressing law (spec constraint, amended 2026-10-21) still rejects `/ip4` everywhere — including as the HOP segment of a `/p2p-circuit` address — so an IPv4-only node can never hold or be dialed through a dual-stack relay. Today's single predicate `isGlobalIp6Multiaddr` accepts v6-hop circuits only because its all-`/ip6` rule happens to be stronger; there is no hop-scoped law.

**Approach:** Widen in ONE module (`address-policy.ts`): add a pure global-scope hop predicate (global `/ip4` OR global `/ip6`) and a circuit-shaped validator (head before the first `p2p-circuit` carries exactly one, global-scope IP component; tail carries no IP/zone components). Direct-address rules stay byte-identical. Switch the consensus-boundary consumers (announcement validator — which book ingest, invitation verify, boot files, candidates/apply-block/introductions all funnel through) to the combined predicate.

## Boundaries & Constraints

**Always:**
- `isGlobalIp6Multiaddr` and its existing accept/reject table unchanged; a v6-hop circuit that passes today still passes (multi-hop all-v6 stays accepted via the direct branch — no accept→reject flip anywhere).
- Hop-scope rejects: RFC1918, CGNAT 100.64.0.0/10, loopback 127.0.0.0/8, link-local 169.254.0.0/16, unspecified 0.0.0.0/8, multicast/reserved >= 224.0.0.0/4; v6 reuses existing global-unicast math; any `ip6zone` rejects.
- Consensus paths stay strict: direct `/ip4` still rejects in candidates/apply-block/introductions; loopback-context behavior unchanged (dev flag never reaches block data).
- Shipped-code lint (`/ip4\/\d`) must keep passing: NO `/ip4/<digit>` literal in any non-test source, comments included.
- Pure module: no env reads in the new predicates, no clock/net/fs; SC-NET-1 code and `relay` word stay in the assertDialable message (tests pin both).

**Never:**
- No adapter changes (holdSeed/dial guards are story 11.2), no net-config/seed changes (11.3), no block-rule/signature/slot-math/fork-choice edits, no new deps.
- Do not touch `isDialableMultiaddr`/`filterDialableAddresses` semantics or the memory transport's policy-free design.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| v4-hop circuit | `/ip4/203.0.113.9/tcp/4001/p2p/<R>/p2p-circuit/p2p/<P>` | hop+circuit+combined predicates true; strict validator ACCEPTS | — |
| direct v4 | `/ip4/203.0.113.9/tcp/4001` | all new predicates false (no circuit); validator rejects `unsupported-address` | SC-NET-1 at dial sites (unchanged) |
| non-global hop | hop in 10/8, 100.64/10, 127/8, 169.254/16, 0/8, >=224/4, or RFC4193 v6, or zone | hop+circuit false; validator rejects | — |
| IP in tail | `.../p2p-circuit/ip4/1.2.3.4/p2p/<P>` | circuit false (tail carries IP) | — |
| two IPs in head | `/ip4/a/ip4/b/.../p2p-circuit/...` | hop+circuit false | — |
| v6-hop circuit (regression) | `/ip6/2001:db8::1/tcp/4001/p2p/<R>/p2p-circuit/p2p/<P>` | still ACCEPTS at every boundary | — |
| hop network key | two v4-hop circuits in same /24 vs different /24 | `hopNetworkKey` groups per relay /24; book floor counts them like /64s | null → ungrouped (defensive, as today) |

</frozen-after-approval>

## Code Map

- `packages/core/src/net/address-policy.ts` — ALL new math here. Reuse `ip6IsGlobalUnicast`, `expandHextets`; component codes 4/41/42 already defined; multiaddr v13 `getComponents()`. Add: private `ip4IsGlobalScope(text)`, exported `isGlobalHopMultiaddr`, `isRelayHopCircuitMultiaddr`, combined `isAddressableMultiaddr` (direct-OR-circuit), `hopNetworkKey` (first IP component → `"6:h0:h1:h2:h3"` via existing /64 math, or `"4:a.b.c.0"`; non-global → null). Update header rules comment + `assertDialable` message to name the hop rule.
- `packages/core/src/discovery/announcements.ts` — L337–345: strict branch `isGlobalIp6Multiaddr` → `isAddressableMultiaddr`; loopback branch ORs `isLoopbackIp6Multiaddr` as today. This ONE switch covers book ingest (address-book L441), invitation verify, boot files, node-loop gossip receive, candidates/apply-block/introductions (all call `validatePeerAnnouncement`).
- `packages/core/src/discovery/address-book.ts` — `slash64Of` (L385): body → `hopNetworkKey`; comment update. Floor logic untouched.
- `packages/core/src/net/index.ts`, `packages/core/src/index.ts:819ff` — export the four new symbols.
- `packages/core/test/net-address-policy.test.ts` — predicate tables (existing 9.1/9.5 rows unchanged).
- `packages/core/test/discovery-announcement.test.ts` — strict-ctx validator rows + encode→parse→verify round-trip over one direct-v6 and one v4-hop-circuit record; reuse its signing helpers/fixtures.
- `packages/core/test/net-address-policy-book.test.ts` (new, small) OR book rows in existing address-book test — block-grade ingest ACCEPTS v4-hop circuit; same-/24 floor binds like /64.
- Do NOT change: `adapter.ts`, `auto-relay.ts`, `crawler.ts` (consumes validator-approved book), `reachability.ts`, app package, `discovery-lint.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/net/address-policy.ts` — add hop/circuit/combined/hopNetworkKey predicates + docs; update SC-NET-1 message — single source of the widened law.
- [x] `packages/core/src/discovery/announcements.ts` + `address-book.ts` — switch boundary predicate and group key — every consensus boundary follows the one module.
- [x] barrels (`net/index.ts`, `src/index.ts`) — export new names.
- [x] tests: policy tables, validator rows (incl. strict-consensus rejections), round-trip, book /24 floor — pins per I/O matrix.

**Acceptance Criteria:**
- Given a record whose only multiaddr is a global-v4-hop circuit, when validated with STRICT ctx, then ok:true; given direct `/ip4`, CGNAT/RFC1918/loopback/link-local/multicast hops, or IP-in-tail, then `unsupported-address`.
- Given every existing 9.1/9.5/10.2 test row, when suites run, then unchanged verdicts (no edits to their expectations except the SC-NET-1 message pin if needed).
- Given build + typecheck + root/app vitest, when headless, then green; repo lint row finds nothing.

## Implementation Notes

**Built 2026-10-21 on baseline `3663d67`.** All four tasks landed exactly per the Code Map; no file outside the map changed.

**Predicate shapes as built (pinned by `net-address-policy.test.ts` tables):**
- `ip4IsGlobalScope(text)` (private): strict dotted-quad; rejects `0/8`, `127/8`, `>=224/4`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16`, CGNAT `100.64/10`. Boundary rows pin `100.63.255.9`/`100.128.0.9`/`172.15`/`172.32` as global.
- `hopNetworkKey(addr)`: FIRST IP component → `"6:h0:h1:h2:h3"` (exact `ip6Slash64` math, family-tagged — v6 keys can never collide with v4 keys) or `"4:a.b.c.0"`. Null on: no IP, any `ip6zone`, first IP non-global, junk. The book treats null as ungrouped (defensive, as today).
- `isGlobalHopMultiaddr(addr)`: the HOP judged ALONE — parses, contains `p2p-circuit`, FIRST IP global scope. Deliberately coarse; it never decides acceptance alone.
- `isRelayHopCircuitMultiaddr(addr)`: the strict circuit SHAPE validator — head before the FIRST `p2p-circuit` carries EXACTLY ONE IP and it is global; tail after the separator carries no `/ip4`/`/ip6`/`ip6zone`. Direct addresses are false by shape.
- `isAddressableMultiaddr(addr)` = `isGlobalIp6Multiaddr || isRelayHopCircuitMultiaddr` — the combined law, env-free, consumed by the validator switch.

**Matrix reading recorded (frozen-row semantics):** "two IPs in head ⇒ hop+circuit false" is satisfied at every BOUNDARY via the combined predicate; taken literally against the coarse hop predicate, a two-IP head has a global FIRST IP so `isGlobalHopMultiaddr` is true there (the hop predicate judges the hop alone — documented in its JSDoc and pinned in HOP_ROWS/CIRCUIT_ROWS). Same for IP-in-tail (hop true by design — it IS a circuit with a global hop; only the circuit validator and the combined law reject it). No boundary decision differs from the matrix.

**One switch, every boundary:** `announcements.ts` strict branch is now `isAddressableMultiaddr`; the loopback ctx ORs `isLoopbackIp6Multiaddr` on top (a v4-hop circuit therefore verifies in dev contexts too — global scope either way; a private/CGNAT hop never does, flagged or not). Book ingest, invitation verify, boot files, node-loop gossip receive, candidates/apply-block/introductions all funnel through `validatePeerAnnouncement`, so they all follow with zero further edits (invitation.ts confirmed to call it verbatim).

**Book grouping:** `slash64Of` → `networkGroupOf` via `hopNetworkKey`; floor logic byte-identical; `MAX_ENTRIES_PER_64` name/value unchanged (doc updated: per-family group = v6 /64 or v4 /24). Side effect accepted: under the dev loopback flag, pure-`::1` book entries now group null (ungrouped) instead of sharing a `::/0`-ish key — dev-flag surface only, no floor pressure there. *Review correction:* that "side effect" never happened — the OLD `ip6Slash64` also returned null for `::1` (it skips non-global `/ip6` and finds none), so loopback grouping is unchanged old-vs-new; no behavioral delta existed to accept.

**Deliberately NOT changed:** `isDialableMultiaddr`/`filterDialableAddresses` (dial side flips to the hop law in 11.2); adapter `holdSeed` still rejects a v4 seed via `assertDialable` (11.2's switch — the SC-NET-1 message now names the hop rule so the operator error reads correctly meanwhile); app-side listen-address filters (`main/index.ts`, `run-node.ts`) stay strict `isGlobalIp6Multiaddr` — a node never ANNOUNCES a v4-hop circuit as its own listener until 11.2's held-circuit machinery produces them; memory transport policy-free design untouched.

**Verification (headless):** targeted trio 69/69; `corepack pnpm build` PROTO_OK (`src/proto` diff empty); root typecheck clean; root suite **528/528 (69 files)** — every pre-existing 9.1/9.5/10.2 row unchanged (only additions to the test files); app tsc clean, app suite 66/66 (10 files); shipped-code lint: `grep -rn '/ip4/[0-9]' packages/core/src packages/app/src` → zero hits; `discovery-lint.test.ts` green inside the root run. SC-NET-1 pins (`/SC-NET-1/`, `/relay/`) hold with the new message; new rows additionally pin `/p2p-circuit/` + `/global-scope hop/`.

**Post-review fix (matrix audit):** the frozen row "two IPs in head ⇒ hop+circuit false" was satisfied at every BOUNDARY but NOT literally by the coarse `isGlobalHopMultiaddr` (a two-IP head has a global FIRST IP, so it returned true). Per step-03 (never edit a test to match code; fix code), `isGlobalHopMultiaddr` now shares the strict head rule with the circuit validator via a new private `hopHeadIsSingleGlobalIp(components)` helper — exactly one global-scope IP before the first `p2p-circuit`, so a two-IP head is false. The hop predicate still does NOT judge the tail (multi-hop all-v6 and IP-in-tail stay true there, pinned), preserving its distinct coarse role; no boundary verdict changes because acceptance already ran through `isAddressableMultiaddr`. Added HOP_ROWS literal pin for the two-IP case.

## Review Triage Log

| # | Finding (quick lens) | Verdict | Evidence & route |
|---|----------------------|---------|------------------|
| 1 | `address-policy.ts` missing trailing newline at EOF | low — patch | `od -c` confirmed file ended `}\n}` … no final `\n`; appended. |
| 2 | Module header preamble still asserted the pre-amendment law ("ONLY shape … ingests", "first hop is a global /ip6") contradicting the hop law in the same comment | medium — patch | Real contradiction inside the single-source-of-law module; preamble rewritten to direct-only + amendment pointer. |
| 3 | `assertDialable` message implied v4-hop circuits are dialable while `isDialableMultiaddr` still rejects them | medium — patch | Runtime probe: valid v4-hop circuit threw SC-NET-1 with a message describing its shape as required; message reworded to state the hop rule as ANNOUNCE/INGEST-valid and DIALING as direct-only until seeding (all test pins kept). |
| 4 | Frozen zone row literal unmet: `isGlobalHopMultiaddr` true for an `ip6zone` in the circuit TAIL | medium — patch | Probe confirmed hop=true, combined=false; frozen Always says "any ip6zone rejects". Predicate now rejects ANY zone component; HOP_ROWS pin added (tail zone → false). Boundary was already safe via combined law. |
| 5 | Implementation Notes recorded a book-grouping side effect that never existed (`ip6Slash64` also returned null for `::1`) | low — rejected as finding (fix edits this build's plan) per Classify rule; note corrected append-only anyway | Verified both old and new key functions return null for `::1`. |
| 6 | Eviction-rules comment in `address-book.ts` still explained the floor as v6-/64-only after grouping widened to /24 | low — patch | Comment governs the switched code and under-described when the floor binds (pinned by SLASH24_FLOOR); reworded to per-family GROUP FLOOR. |

## Plan Change Log

- 2026-10-21 (build): no deviations. Code Map executed as written (`net-address-policy-book.test.ts` not created — the book rows landed in the existing `discovery-address-book.test.ts`, the plan's sanctioned alternative). Coarse-hop-predicate literal-reading nuance documented in Implementation Notes (frozen matrix text untouched).
- 2026-10-21 (matrix audit): tightened `isGlobalHopMultiaddr` to reject a two-IP head via shared `hopHeadIsSingleGlobalIp` helper so the frozen "two IPs in head ⇒ hop false" row holds literally; added its HOP_ROWS pin. No boundary verdict changed (acceptance path unchanged). Root 528/528, app 66/66 re-verified green.
