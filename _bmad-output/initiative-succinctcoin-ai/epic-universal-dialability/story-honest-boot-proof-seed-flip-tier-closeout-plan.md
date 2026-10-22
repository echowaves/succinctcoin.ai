---
title: 'Honest Boot Proof + seed flip + tier closeout'
type: 'feature'
ticket: '5'
created: '2026-10-22'
status: built
route: 'full'
route_source: 'auto'
baseline_revision: '9ea45dd6e284e8b438204dac5f580964b9dbcbda'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 11 (CAP-8) has shipped the laws, the adapter, and the seam, but no single test proves the promise end-to-end at BOOT level: a node with NO global IPv6 boots with default config, holds a relay circuit, gets its circuit address into its own signed announcement, is dialed through the hop by a v6-side peer, and exchanges real data over that relayed connection. The tier also closes with docs debt (deferred-work/spec still say v4-hop is parked).

**Approach:** One new headless memory-transport integration suite `packages/core/test/honest-boot-proof.test.ts` with two boot rows (v4-only host, dual-stack unchanged shape) using the established createCore real-ports fixture + relay-seeds dial idioms. Seed flip = DOCUMENTED SKIP (11.4 HITL not done): `DEFAULT_RELAY_SEEDS` stays pinned empty; epic Notes close with an explicit gap line. Closeout edits to deferred-work.md and the spec open question.

## Boundaries & Constraints

**Always:** memory transport, zero real sockets (AD-10); bounded polls only, no Math.random/Date.now in cadence (AD-3); root-barrel imports only; the held circuit string is derived from the REAL hold (`listenAddresses()`), the fixture only rewrites its `/memory` head to a TEST-NET `/ip4` head to model the host family; announce records asserted as EXACT ordered sets (a v6 leak must fail the row); `DEFAULT_RELAY_SEEDS` untouched and empty.

**Never:** no changes to `address-policy.ts`, `adapter.ts`, `net-config.ts`, or any shipped src; no new production seams for tests; no tcp sockets in CI; do not mark 11.4 built; never push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NO_V6 boot | createCore node, host modeled v4-only: provider offers direct `/ip4/203.0.113.x` (fails announce law) + real held circuit with TEST-NET-v4 head | Own signed announcement received by v6-side peer = EXACTLY `[circuit]`; direct v4 never in record; zero global-v6 anywhere (leak pin) | Any extra/direct/v6 address in the record fails the exact-set assert |
| Dial-through + data | v6-side peer dials `/p2p/<relay>/p2p-circuit/p2p/<self>` (transport form), then gossips a signed announcement | Mutual peers; hidden node RECEIVES it via `net.received`; hidden's next self-announcement envelope arrives back at the peer — bidirectional data over the relayed conn | Bounded poll (relay-seeds discipline: dialRaced + MAX_POLLS) |
| DUAL_STACK | same boot + provider additionally offers fake `/ip6/2001:db8:…` direct | Record = `[v6-direct, circuit]` order-preserved; direct dial works too — unchanged shape | Exact ordered-set assert |
| Seed flip | 11.4 provisioning undone | No code flip; skip-with-note in plan + epic Notes gap line | Documented, not silent |
| Live variant | `dial-manual.mjs relay-new-v4` trio (one machine) | Manual/live only — disclosed skip in file header + epic notes | n/a |

</frozen-after-approval>

## Code Map

- `packages/core/test/relay-seeds.test.ts` — REUSE idioms: `dialRaced`, `MAX_POLLS`/`SLEEP_MS`, `seedFor`/`identity`, SEED_HOLD hold-poll + peer-id-prefixed dial (L92–146). Transport-form vs announced-form distinction is pinned there.
- `packages/core/test/core-node-loop.test.ts` + `core-ladder.test.ts` — real-ports createCore fixture: mkdtemp `FileChainStore`, `deriveIdentityKeypair`, `ports.discovery = { announceAddresses, … }`, ladder fires in `start()`; discovery-port wiring shape also in `discovery-amnesiac-boot.test.ts` L160–175 (chainId + announceAddresses).
- `packages/core/src/consensus/node-loop.ts` L334–345 — own announcement = `filterAnnounceAddresses(opts.announceAddresses?.())`, published each mining window (`sendAnnouncement`).
- `packages/core/src/net/adapter.ts` — `listenAddresses()` = honest direct + `heldCircuits`; `received: ReadonlyMap<TopicClass, ReceivedEnvelope[]>` (L351) is the receive-observability seam; `relaySeeds`/`onRelaySeed` config.
- `packages/core/src/net/address-policy.ts` — announce law L678–686: record law OR pure `::1` under flag; `/memory` heads and direct `/ip4` NEVER pass; global-v4-hop circuits DO (11.1) — that is what makes the NO_V6 record non-empty.
- Heavy-row timeout convention: `{ timeout: 90_000 }` (block-propagation.test.ts).
- Closeout targets: `_bmad-output/initiative-succinctcoin-ai/deferred-work.md` (epic-10 RELAY TIER entry L129–151, parked item (a)); `spec-succinctcoin/spec-succinctcoin.md` Open Questions "Relay volunteers + seed supply" bullet; `epic-universal-dialability/epic-universal-dialability.md` Notes.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/test/honest-boot-proof.test.ts` — CREATE: header doc (matrix rows, live-variant skip disclosure); fixture helpers; HONEST_BOOT_NO_V6 + HONEST_BOOT_DUAL_STACK rows per I/O matrix; `{ timeout: 90_000 }`.
- [ ] `packages/core/test/honest-boot-proof.test.ts` — run isolated until green, then full root suite.
- [ ] `_bmad-output/initiative-succinctcoin-ai/deferred-work.md` — APPEND epic-11 SHIPPED entry (universal dialability: laws 11.1 / adapter 11.2 / seam+docs 11.3 / runbook 11.4-partial / proof 11.5; gap line for provisioning + seed flip); update parked item (a) with pointer instead of "zero default seeds forever" wording.
- [ ] `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md` — narrow the "Relay volunteers + seed supply" open question to: volunteer incentives + beyond-seed discovery; note seed FORMAT resolved (IP-form, `/dns` rejected) and one-relay call still pending user confirmation.
- [ ] `epic-universal-dialability.md` — Notes: explicit epic gap line (11.4 provisioning HITL-open; DEFAULT_RELAY_SEEDS pinned empty by design until then).
- [ ] README cross-ref check (manual): relay runbook link + `SUCCINCTCOIN_RELAY_SEEDS` mentions consistent with final docs.

**Acceptance Criteria:**
- Given a clean checkout, when the root vitest suite runs headless, then honest-boot-proof rows pass in BOTH variants and no existing row regresses.
- Given the shipped tree, then `DEFAULT_RELAY_SEEDS` is still `[]` (app net-config test pins unchanged) and no src/** file is modified by this story.
- Given a fresh IPv4-only-operator reader, then README → docs/relay-runbook.md → epic Notes tell one consistent story (IP-form seeds, v6-only dial-me, provisioning gap stated).

## Implementation Notes

- `packages/core/test/honest-boot-proof.test.ts` created (3 rows, all green; root suite 549/70 ✓, build+typecheck ✓). Fixture = createNodeLoop ×2 + relay adapter (memory), config-fixture announce seam exactly as the Design Notes sketch.
- DEVIATION from my own step-4 draft (sync round-trip): a chain-SYNC stream over the circuit dial is REFUSED by libp2p (`LimitedConnectionError` — reservations are LIMITED connections; discovered live via a scratch harness, since deleted). The row now proves the data round-trip at CHAIN level both directions (each node's signed announcement lands in the OTHER's mined blocks — strict-validated), which matches the frozen I/O matrix (it always said gossip envelopes) and is disclosed in the test header + step-(4) comment.
- Leak pins: hidden record asserted as EXACT ordered set ([circuit] / [v6,circuit]); `not.toContain('/ip6/')` on the v4 circuit; row 3 pins zero default seeds (flip = documented skip; gap line appended to epic Notes).
- Closeout edits landed: deferred-work.md (epic-11 SHIPPED entry + UPDATE pointer on parked item (a) + SUPERSEDED-IN-PART pointer on the 9.5 IPv4 decision), spec Open Questions narrowed (incentives + beyond-seed discovery; format resolved), epic Notes gap line. README verified consistent, unchanged.

## Plan Change Log

## Review Triage Log

Pass 1 (quick lens, post-implementation): verdict counts — high 0 / medium 1 / low 5 / false 0 / maybe-false 0 / rejected 2.

| # | Verdict | Route | Evidence |
|---|---------|-------|----------|
| F1 | medium | patch | DUAL_STACK row lacked the frozen matrix's "direct dial works too". Verified: no direct-face dial existed anywhere in the file. PATCHED: peer dials the hidden node's REAL direct memory face (bounded retry) before the hop dial; assert peers-contains. |
| F2 | low | patch | Frozen row names `net.received` as the receive seam; suite asserted only chain-level inclusion (stronger, but not the named seam). PATCHED: explicit `received.get('announcements')` payload-identity asserts on BOTH sides after the chain-level landing. |
| F3 | low | patch | Test header row-summary still said "sync round-trip" while the same header disclosed LimitedConnectionError. Verified at L22. PATCHED: header now reads "chain-level gossip both ways (via the adapter's `received` seam)". |
| F4 | low | patch | Plan Code Map pins `{ timeout: 90_000 }`; rows shipped 120_000. PATCHED to 90_000; suite re-run green (rows finish in seconds). |
| F5 | low | patch | Step-(1) comment claimed the ok event fired, but no `onRelaySeed` was wired. Verified: fixture had no callback. PATCHED: fixture captures `seedEvents`; row 1 asserts exactly one ok event for the seed (SEED_HOLD discipline). |
| F6 | low | patch | Header printed `SUCCINCTCOIN_ALLOW_LOOP‐BACK=1` with U+2010 (verified byte) — copy-paste would yield a wrong env var. PATCHED to ASCII, line rewrapped. |
| F7 | rejected | — | "Plan Verification section stale (2/2, 546+2)": the fix edits this build's plan → rejected by triage rule. Actuals recorded in Implementation Notes (3 rows; root 549/70). |
| F8 | low | patch | Epic Notes contradiction: pre-existing seed-format bullet said "11.5 flips DEFAULT_RELAY_SEEDS" vs the new gap line's documented skip. Verified both bullets. PATCHED: older bullet now reads "…once a relay is provisioned — until then the flip is a documented skip (see the epic gap line below)". |

Post-patch verification: honest-boot-proof 3/3 green, root suite 549/70 green, `corepack pnpm typecheck` clean; diff file rewritten from baseline 9ea45dd.

## Design Notes

The ticket's seam unknown (listener filtering vs config fixture) resolves to CONFIG FIXTURE: the `announceAddresses` provider is already the production announce source; the fixture wraps the REAL `listenAddresses()` and rewrites only the held circuit's `/memory/<relay>` head to `/ip4/203.0.113.9` (TEST-NET, RFC 5737 — never routable, lint-safe as a test literal? NO: discovery-lint bans `/ip4` literals in shipped SRC only; tests keep `/ip4` fixtures where bytes never pass the validator — wire-golden precedent). Filtering would hide leaks instead of failing on them; passthrough + exact-set assert fails if any global v6 ever appears in the fixture surface.

Sketch (NO_V6 provider):
```ts
const model = () => hiddenNet.listenAddresses().map((a) =>
  a === directMem ? `/ip4/203.0.113.7/tcp/4001/p2p/${self}`            // direct v4 → filtered out
                  : a.replace('/memory/hbp-relay', '/ip4/203.0.113.9/tcp/4001')) // circuit head
```

## Verification

**Commands:**
- `corepack pnpm exec vitest run packages/core/test/honest-boot-proof.test.ts` (root) -- expected: 2/2 green.
- `corepack pnpm build && corepack pnpm typecheck` -- expected: clean (no src change; guards only).
- `corepack pnpm exec vitest run --maxWorkers=2` (root) -- expected: all green (baseline 546+2 files).
- `grep -n "DEFAULT_RELAY_SEEDS: readonly string\[\] = \[\]" packages/app/src/main/net-config.ts` -- expected: still empty.

**Manual checks:**
- Read deferred-work/spec/epic diffs as a fresh reader: one consistent v4-only story, gap stated once.
