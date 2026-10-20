---
id: dev-only-announce-allowance-loopback-dev-mesh
status: built
epic: epic-ipv6-invite-network (follow-on to the 9.5 loopback dial flag)
title: Dev-only ANNOUNCE allowance — symmetric SUCCINCTCOIN_ALLOW_LOOPBACK
---

# Dev-only announce allowance — plan

## The problem (deferred-work OPEN, user-reported twice)

The operator's dev machine has NO global IPv6 (`ifconfig` → `::1` only, no
v6 default route; verified 2026-10-20). The invite panel honestly says so —
but the machine therefore cannot produce an invite or two-node-test the join
flow AT ALL. Epic 10 does not help: holding a relay seed is DIALING one, and
dialing needs outbound global v6. 9.5's `SUCCINCTCOIN_ALLOW_LOOPBACK=1`
relaxed ONLY dialing (`assertDialable`); announce stayed strict
(`filterPolicyAddresses` in node-loop), so the loopback the flag makes
dialable is never announced.

Verified fact that shapes the design: a tcp adapter on this machine already
LISTENS reachable-on-loopback and `listenAddresses()` yields exactly
`/ip6/::1/tcp/<port>/p2p/<self>` — the strict filter is the only thing
dropping it. No address synthesis needed.

## Design (the OPEN entry's bar, met)

1. **One new primitive** (`address-policy.ts`): `isDialableMultiaddr(addr)`
   = the boolean twin of `assertDialable` — policy-global, OR pure-loopback
   under the flag (per-call env read, default off). Plus
   `filterDialableAddresses(addrs)`. `assertDialable` refactored onto the
   primitive — behavior byte-identical.
2. **Symmetric boundaries** (each was strict-global-only; each now honors
   the flag — DEFAULT OFF ⇒ byte-identical shipped behavior):
   - node-loop announce construction (`filterPolicyAddresses` →
     `filterDialableAddresses`) — env-aware directly, it is a DIAL surface;
   - adapter bootstrap-list filter (bootstrap entries ARE dialed; same);
   - `validatePeerAnnouncement` policy check (both `multiaddrs` and
     `observedExternalAddr`) — **context-gated, NOT env-gated** (see 2a).

2a. **AMENDMENT from code review (BLOCKER)**: the first cut switched the
   validator to env-aware `isDialableMultiaddr`. Rejected: that validator
   feeds block CANDIDATES, apply-block and introductions production — with
   the env read inside it, a flagged miner could anchor a `::1` record and
   unflagged nodes would reject the whole block (fork/halt). Final design:
   `AnnouncementContext.allowLoopbackAddresses?: boolean` — a PURE ctx
   authority (global OR exactly-`::1`; the validator never reads env, even
   indirectly). Only NON-consensus ingest sets it, from
   `loopbackAnnounceAllowed()` (per-call env read): gossip receive,
   `verifyInvite`, address-book ingest (covers boot hint rung), boot-file
   artifact rung. Block candidates, introductions production and apply-block
   keep plain contexts ⇒ **what enters a block is always strictly global**;
   flagged/unflagged mixes cannot diverge on chain data, in either direction.
3. **Honesty stays total**: link-local `fe80::`, ULA, `/ip4`, zones are
   NEVER allowed by anything, flag or no flag (`isLoopbackIp6Multiaddr` is
   strict pure-`::1`). A loopback record CANNOT poison the real network:
   every node without the flag rejects it at validation (never gossiped,
   never blockable). The UI says the truth (below).
4. **UI warning** (the OPEN bar's "worth a UI warning"): the invite panel
   already fetches diagnostics paired with the invite; when an invite
   EXISTS but the machine has NO global IPv6 (`diag.global === 0` — only
   possible under the allowance), render a loud line: the invite carries a
   LOOPBACK address and works ONLY on this machine (a friend dialing `::1`
   dials themselves). New pure fn `describeLoopbackInvite(d)` in
   `ipv6-hint.ts`; zero new IPC.

## Explicitly NOT in scope

- No change to default policy, honesty filter (10.1), or relay law (10.2/3).
- No announce synthesis (::1 already appears; nothing invented).
- The dial-manual probe shortcuts stay (they predate the allowance and
  still pass — its `invite-use` now takes the FULL shipped verify path
  under the flag, which is strictly more honest than its own fallback).

## Tests

- Policy unit rows: `isDialableMultiaddr`/`filterDialableAddresses` off/on
  (global yes always; `::1` only with flag; fe80/ULA/v4/zone never; junk
  no). Existing assertDialable rows must stay green untouched.
- Validator rows (`discovery-announcement.test.ts`, ctx semantics): strict
  ctx ⇒ `::1` rejects (default); CONSENSUS PIN — env flag SET but no ctx
  flag still rejects; ctx flag ⇒ direct/mixed/observed `::1` and the
  all-hop-`::1` circuit (same-machine relay shape) verify; `fe80::`/ULA/v4/
  zone-scoped `::1`/half-local circuits never do.
- Policy rows: twin equivalence, FLAG SET admits ONLY pure `::1` (zone-
  scoped `::1` pinned), DEFAULT filter equals `filterPolicyAddresses`.
- App hint rows: `describeLoopbackInvite` — global>0 ⇒ null; global===0 ⇒
  warning covering BOTH honest readings (dev-loopback local-only AND stale);
  existing describeIpv6 rows untouched.
- LIVE proof (tmp script against built dist): node A signs an invite from
  its REAL announce source (`filterDialableAddresses(listenAddresses())` —
  the `::1` survives under the flag); node B verifies through the FULL
  shipped `verifyInvite` (no probe fallback), dials, both see peers.

## Docs closeout

- deferred-work.md: OPEN entry → SHIPPED pointer (what it is, what stays
  strict, why real networks are immune).
- README: the loopback-flag sentence documents the symmetric dev exemption,
  its local-only honesty, and the strict-consensus invariant. Counts updated.

## Build log

- Implemented per plan + review amendment (ctx-split). First-review findings
  all addressed: BLOCKER (env-dependent block validation) → ctx-split above;
  Major → consensus-pin / zone-`::1` / circuit-shape rows added; Minor →
  `describeLoopbackInvite` reworded for stale invites and computed once in
  `App.tsx`; Minor accepted — the main-process LAN-listen log line stays
  strict `isGlobalIp6Multiaddr` on purpose.
- Second quick-lens pass: MAJOR claim "self-record reaches candidates"
  disproven in code (the candidate gate re-validates EVERY known entry,
  self included, with a plain ctx — `::1` is deleted there every window);
  real finds fixed — the gossip-receive ctx edit had silently not landed
  (now applied; relay/hint-feed honor the flag, candidates/intros stay
  strict), block-grade book ingest never gets the flag
  (`sourceClass !== 'block' && …`), stale purity docstrings corrected.
- Gates: root build + typecheck clean; root suite 489/66 green (heavy
  gossip rows timed out twice under external machine load — 3039s / 1012s
  wall vs ~120s quiet — isolated re-runs of every flagged file green in
  ≤75s ⇒ known env flake); app tsc clean, 52/9 green.
- LIVE proof on this machine (no global IPv6), re-run against the FINAL
  build: strict filter keeps `[]` from the real `listenAddresses()`;
  allowance keeps `/ip6/::1/tcp/<port>`; unflagged `verifyInvite` rejects
  `unsupported-address` (negative control); flagged B verifies through the
  FULL shipped `verifyInvite`, dials, mutual `peers()` — LOOPBACK MESH
  PROOF: PASS.
- deferred-work OPEN → SHIPPED; README counts 489/66 (core 437/57, app
  52/9).
