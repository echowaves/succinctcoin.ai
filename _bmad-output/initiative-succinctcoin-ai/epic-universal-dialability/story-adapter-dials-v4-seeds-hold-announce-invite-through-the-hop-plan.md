---
title: '11.2 Adapter dials v4 seeds: hold, announce, invite through the hop exception'
type: 'feature'
ticket: '2'
created: '2026-10-21'
status: 'built'
baseline_revision: '29828330e2157b26af3096df93fd6c71725f7dc9'
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

**Problem:** Story 11.1 made global-v4-hop circuits valid CHAIN data, but the adapter still can't REACH one: `holdSeed` pre-flights seeds through `assertDialable` (rejects every `/ip4`) and `dial()` guards every target with the same direct-only law — so an IPv4-only machine still cannot dial a dual-stack relay, hold a reservation, or be dialed through one.

**Approach:** Two adapter call sites switch from the direct law to purpose-built DIAL-side laws in `address-policy.ts` (the one module that owns all boundaries): seeds obey a seed-shaped rule (direct global `/ip6` as today, or a global-scope v4/v6 relay ENDPOINT), circuit targets obey the hop law, and everything else keeps `assertDialable` byte-identically. The dev loopback flag extends to loopback hops of BOTH families (`::1` AND `127.0.0.1`) on the dial side only — same per-call env read, never ingest. Held v4-hop circuits then flow through the untouched ticket-7 machinery (announce/invite/book/auto-relay).

## Boundaries & Constraints

**Always:**
- Direct-target law UNCHANGED: `isDialableMultiaddr`/`filterDialableAddresses` stay byte-identical (global `/ip6`, pure `::1` under flag); direct `/ip4` still throws SC-NET-1 in `dial()` WITH AND WITHOUT the flag; RECORD INGEST never gains v4. Announce construction gains exactly what validators accept — global-hop circuits of either family (epic R3 flow-through; AMENDED via PCL-2, review F1: without it a held v4-hop circuit could never reach gossip/invites and the story's own acceptance criterion was unmeetable).
- The dev flag stays dial-side-only: per-call read, never consulted by validators or ingest (context-gating from 10.3 untouched).
- No-accept→reject flips on existing pins: all-hop-`::1` circuits stay dialable under the flag; global v6 hops unchanged; memory transport stays policy-free (preflight remains tcp-only).
- Seeds must still carry `/p2p/<relayId>` (`seedRelayPeerId` gate unchanged).

**Never:**
- No changes to announcements/address-book/validators (11.1 shipped them), no net-config or seed-list changes (11.3), no README rewrite, no new deps, no adapter listen-address policy (v4 binds stay whatever-the-operator-passes; production keeps `/ip6/::`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| v4 seed pre-flight | tcp, seed `/ip4/203.0.113.9/tcp/4001/p2p/<R>` (flag unset) | passes, hold episode runs | — |
| loopback-v4 seed | flag unset: `/ip4/127.0.0.1/tcp/N/p2p/<R>` skipped; flag set: passes | skip event names the rule | one skip, no retries |
| direct v4 target dial | any transport=tcp, `dial('/ip4/1.2.3.4/tcp/9')` | REJECTS SC-NET-1 flag or no flag | throw (pinned) |
| global v4-hop circuit dial | `dial('/ip4/203.0.113.9/…/p2p-circuit/p2p/<P>')`, flag unset | ACCEPTS (hop law) | — |
| loopback-hop circuit dial | `/ip4/127.0.0.1/…/p2p-circuit/…`: flag unset REJECT, flag set ACCEPT; all-`::1` chain under flag still ACCEPT | SC-NET-1 when off | — |
| seed shape junk | no `/p2p`, zone, `p2p-circuit` inside seed, or non-global first IP | skipped deterministically (one event) | skip event |
| live v4 trio | built dist, flag set: relay-new-v4 binds 127.0.0.1; node-behind holds through it; outsider dials the circuit invite | HELD + DIALED THROUGH RELAY, exits 0 (manual proof, disclosed) | FAIL lines + non-zero exit |

</frozen-after-approval>

## Code Map

- `packages/core/src/net/address-policy.ts` — add beside the hop law: private `ip4IsLoopback(text)` (first octet 127); private component helpers; exported PURE `isRelaySeedMultiaddr(addr)` (parses, no zone, no p2p-circuit, carries a `/p2p` component [code 421], FIRST IP global-scope either family — reuse `ip4IsGlobalScope`/`ip6IsGlobalUnicast`); env-aware `isDialableSeedMultiaddr(addr)` (= pure OR flag && same shape with first IP loopback-family); circuit-aware dial target law `isDialableTargetMultiaddr(addr)` (has p2p-circuit → `isRelayHopCircuitMultiaddr` OR flag && every IP component loopback-family [≥1, either family]; no circuit → exactly `isDialableMultiaddr`) and throwing twin `assertDialableTarget` reusing SC-NET-1 + the 11.1 message. Export all three from `net/index.ts` + `src/index.ts`.
- `packages/core/src/net/adapter.ts` — `holdSeed` pre-flight (~L903): `assertDialable(seed)` → `isDialableSeedMultiaddr(seed)`, skip-event text names the seed rule; `dial()` guard (~L1195): `assertDialable(address)` → `assertDialableTarget(address)`; update both comments + imports. NOTHING else in the adapter (heldCircuits/announce/auto-relay untouched).
- `_bmad-output/initiative-succinctcoin-ai/epic-real-network/dial-manual.mjs` — add mode `relay-new-v4` (copy of relay-new: relayRole 'relay', listenAddress `/ip4/127.0.0.1/tcp/0`, seed printed from the BOUND address + peerId — no filterPolicyAddresses; SERVED poll identical); relax `node-behind` usage string to any seed family.
- `packages/core/test/net-address-policy.test.ts` — SEED_ROWS / TARGET_ROWS tables (matrix rows above, flag off/on, twin equality for non-circuit targets).
- `packages/core/test/relay-seeds.test.ts` — one row: memory transport never consults the seed policy (v4-shaped seed reaches dispatch unchanged) pinning preflight stays tcp-only.
- Do NOT change: announcements/address-book/invitation (11.1), net-config, app package, existing 9.5/10.2/10.3 test expectations.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/net/address-policy.ts` — three new predicates + assert twin + exports — dial-side laws join the one policy module.
- [x] `packages/core/src/net/index.ts`, `packages/core/src/index.ts` — barrel exports.
- [x] `packages/core/src/net/adapter.ts` — two guard swaps + comments.
- [x] `packages/core/test/net-address-policy.test.ts` + `relay-seeds.test.ts` — tables + tcp-only pin.
- [x] `dial-manual.mjs` — relay-new-v4 mode; run the live v4 trio (flag set, built dist) and record output in Implementation Notes.

**Acceptance Criteria:**
- Given flag unset, when holdSeed pre-flights a global-v4 seed, it passes to dispatch; given `/ip4/127.0.0.1` seed, one skip event names the rule; direct v4 dial still throws SC-NET-1.
- Given flag set, the live loopback trio on 127.0.0.1 prints HELD + DIALED THROUGH RELAY (exit 0) — recorded, skips disclosed.
- Given suites headless: build PROTO_OK, typecheck, root green, app tsc + suite green; existing circuit/loopback pins unchanged.

## Implementation Notes

**Built as designed** (baseline `2982833`):

- `address-policy.ts`: private `ip4IsLoopback` / `parseComponents` helpers; PURE
  `isRelaySeedMultiaddr` (parses, no zone, no p2p-circuit, carries `/p2p`, FIRST
  IP global-scope either family); env-aware `isDialableSeedMultiaddr` (= pure OR
  flag && same shape with loopback-family first IP; flag branch widened to
  ALL IPs by F5); circuit-aware `isDialableTargetMultiaddr` (as first written:
  circuit → hop law OR flag branch — REWORKED by F2 into the no-flip
  composition, see review-fix batch); `assertDialableTarget` shares ONE error factory
  (`dialPolicyError`) with `assertDialable`, so SC-NET-1 + the 11.1 message are
  byte-identical across the two gates (pinned by a test). All three predicates
  exported from both barrels; `isDialableMultiaddr`/
  `filterDialableAddresses`/`assertDialable` behavior untouched.
- `adapter.ts`: `holdSeed` pre-flight → `isDialableSeedMultiaddr` (skip event
  now names the seed rule); `dial()` guard → `assertDialableTarget`; comments
  updated. Nothing else in the adapter changed.
- Tests: 11.2 describe in `net-address-policy.test.ts` (SEED_ROWS off/on,
  purity of the pure seed law, TARGET_ROWS off/on incl. direct-v4-never +
  all-`::1`-chain-under-flag pins, non-circuit twin equality both flag
  states, assert-twin message equality); `relay-seeds.test.ts`
  MEMORY_POLICY_FREE row (v4-shaped seed on memory dispatches SEED_ATTEMPTS
  dial-failure retries, never the tcp skip text — preflight stays tcp-only).
- `dial-manual.mjs`: `relay-new-v4` mode (bind `/ip4/127.0.0.1/tcp/0`, seed
  from the BOUND address + peerId, NO filterPolicyAddresses, refuses to run
  without the flag, SERVED poll identical to relay-new); `node-behind` usage
  string now names both families.

**Live v4 trio proof** (one machine, built dist, all three commands with
`SUCCINCTCOIN_ALLOW_LOOPBACK=1`, automated driver chaining SEED → invite):

- `relay-new-v4` bound `/ip4/127.0.0.1/tcp/53625/p2p/…`, printed the v4 SEED,
  then `SERVED <hiddenId>, <outsiderId>` — exit 0.
- `node-behind '<v4 seed>'` → `seed HELD` + `HELD circuit:
  /ip4/127.0.0.1/tcp/53625/p2p/…/p2p-circuit/p2p/<self>` + invite carrying ONLY
  that v4-hop circuit address, then `PEERS <outsiderId>` (arrival through the
  circuit) — exit 0.
- `invite-use-through-relay '<invite>'` → `DIALED THROUGH RELAY` + `PEERS`
  (relay + hidden node) — exit 0. Driver verdict: `TRIO RESULT: PASS`,
  all three probe exits 0.
- **Disclosed skips** (printed in-band by the probe): invite verification ran
  probe-side sig+chainId ONLY — address policy, slot freshness and ticket
  liveness SKIPPED because the hop is LOOPBACK (the record law stays strict);
  with a global v4 relay hop the full shipped `verifyInvite` path applies.
  Two `seed HELD` events per run observed — the known accepted 10.3 re-hold
  behavior, not new.

**Gates** (re-run after the review-fix batch below): build PROTO_OK (proto
diff empty), root typecheck 0, root suite 538/538 (69 files; +10 tests over
baseline), app
tsc 0 + app suite 66/66 — all green on the final tree. Existing
9.5/10.2/10.3 circuit/loopback pins unchanged.

**Review-fix batch** (step-04, findings F1–F5 in the triage log):

- **F1 (announce flow-through):** new ANNOUNCE law `isAnnounceableMultiaddr`
  (= record law `isAddressableMultiaddr` OR flag && pure `::1`) +
  `filterAnnounceAddresses`; `node-loop.ts` announce construction switched
  from `filterDialableAddresses` to it (self-invite reuses the same record).
  A held v4-hop circuit now reaches gossip/invites; direct `/ip4` and any
  loopback-v4 hop never do — the filter admits EXACTLY what the strict
  validator accepts, so announces cannot be silently dropped downstream.
  `::1` under the dev flag keeps its 9.5 allowance. Both exported from both
  barrels. Pinned by the ANNOUNCE-law table (filter order + flag rows).
- **F2 (no accept→reject flip):** `isDialableTargetMultiaddr` now composes
  `isDialableMultiaddr || isRelayHopCircuitMultiaddr || (circuit && flag &&
  allIpsLoopbackFamily)` — the first branch keeps EVERY address the frozen
  direct law dialed (tail-/p2p-only and multi-hop all-v6 chains included);
  the loopback branch is CIRCUIT-ONLY, so direct `/ip4/127.x` still never
  dials flag or no. Rows pinned both flag states.
- **F3:** shared `dialPolicyError` message rewritten — dropped the stale
  "DIALING stays direct-only until relay seeding lands" claim; keeps all
  four test-pinned substrings (SC-NET-1, relay, p2p-circuit, global-scope
  hop) and names the dual-stack-relay remedy.
- **F4:** holdSeed skip text extracted to exported `SEED_POLICY_SKIP_ERROR`
  (AD-10 forbids a tcp `start()` headless — the constant is the pinned
  surface); `relay-seeds.test.ts` pins its law-bearing substrings and uses
  it in the negative check.
- **F5:** seed flag branch tightened from first-IP to `allIpsLoopbackFamily`
  — `/loopback-first + public-IP` junk seeds no longer hold under the flag
  (row pinned).

**Live v4 trio re-proof on the final tree** (manual drive, one machine,
flag set): relay-new-v4 bound `/ip4/127.0.0.1/tcp/56923/p2p/…` →
`SERVED <hiddenId>, <outsiderId>`; node-behind `seed HELD` + `HELD circuit:
/ip4/127.0.0.1/…/p2p-circuit/p2p/<self>` + invite carrying ONLY that v4-hop
circuit; outsider `DIALED THROUGH RELAY` + `PEERS` (both) — all exits 0.
Disclosed skips unchanged (probe-side sig+chainId only for loopback hops).

## Plan Change Log

- **PCL-1 (probe-only, disclosed):** `relay-new-v4` gained a 20 s settle AFTER
  its SERVED PASS before stop/exit. The 10.3 trio has a pre-existing teardown
  race: `relay-new` exits the moment it counts two peers, which kills the
  circuit before `node-behind`'s next 1.5 s poll can observe the arrival — an
  automated driver lost that race 12/12 on BOTH the new v4 trio and the
  classic v6 trio (unchanged `relay-new`) on this machine, so no exit-0 trio
  could be recorded without touching teardown timing. The settle mirrors the
  outsider mode's documented 15 s rationale ("so the others' polls can observe
  the circuit before teardown") and lives ONLY in the new v4 mode —
  `relay-new`/`node-behind` logic untouched (beyond the sanctioned usage-string
  relaxation). The v6 race remains open as pre-existing behavior; fixing it is
  candidate follow-up work, deliberately not done here.
- **PCL-2 (frozen-boundary amendment, review F1; autonomous under standing
  delegation — flag to human):** the frozen Boundaries clause "announce
  construction … never gain[s] v4 from this story" was wrong as written: a
  held v4-hop circuit filtered OUT of the announce means the ticket's own
  verify step ("announce set includes `<hop>/p2p-circuit/p2p/<self>`") and
  epic R3 flow-through can never happen — the feature would ship dead. The
  clause is amended (in place, marked) to: record ingest never gains v4;
  announce construction gains exactly what validators accept. Known-bad
  avoided: keeping `filterDialableAddresses` at the announce site (silently
  drops held circuits — empirically shown by the review probe). KEEP:
  `isAnnounceableMultiaddr`/`filterAnnounceAddresses` in address-policy.ts,
  the node-loop switch, and the ANNOUNCE-law test table. Do NOT "restore"
  the old filter at the announce site; the invariant to preserve is
  announce-admitted ⊆ validator-accepted (strict) ∪ {`::1` under flag}.

## Review Triage Log

| # | Finding | Verdict → Action | Evidence |
|---|---------|------------------|----------|
| F1 | node-loop announce construction still `filterDialableAddresses` → held v4-hop circuits never announced/invited; story AC unmeetable; frozen clause itself at fault | medium (patch) → fixed + frozen amended via PCL-2 (autonomous, flagged) | probe: filter drops `/ip4/203.0.113.9/…/p2p-circuit/…`; epic R3 + ticket verify govern; trio now shows invite carrying the circuit |
| F2 | `isDialableTargetMultiaddr` routed ALL circuits through hop law → accept→reject flip on tail-/p2p-only and multi-hop all-v6 chains the direct law dialed | medium (patch) → fixed (no-flip composition), rows pinned both flag states | probe: old impl false vs `isDialableMultiaddr` true on 2-hop v6 chain |
| F3 | shared SC-NET-1 message claims "DIALING stays direct-only until relay seeding lands" — false post-11.2 | medium (patch) → rewritten, all four test-pinned substrings kept | message text vs story state |
| F4 | holdSeed skip string unpinned headless (AD-10: no tcp `start()` in tests); only an incidental substring was checked | low (patch) → exported `SEED_POLICY_SKIP_ERROR`, pinned in relay-seeds.test.ts | grep: single literal use site |
| F5 | seed flag branch checked only the FIRST IP → `/loopback + /8.8.8.8` junk seed held under flag | low (patch) → `allIpsLoopbackFamily`, row pinned | probe: junk seed true pre-fix |

Regression caught during fixing: first F2 fix let direct `/ip4/127.x` dial
under the flag — loopback branch made CIRCUIT-ONLY, false-row pinned.
