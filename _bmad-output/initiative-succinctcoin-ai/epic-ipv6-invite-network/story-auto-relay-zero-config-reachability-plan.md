---
id: auto-relay-zero-config-reachability
status: built
epic: epic-ipv6-invite-network (follow-on to 10.2 relay tier / 10.3 reachability)
title: Auto-relay — zero-config reachability on every node
---

# Auto-relay — plan

## The ask (operator, 2026-10-20)

"I want the most reliable method which requires zero configuration, but works
on every node — creates a unique global address which can be dialed/accessed
from other nodes." The operator has no router control and this machine has no
IPv6 at all (verified: 0 addrs in `2000::/3`, no v6 default route).

## What is physically possible (state it plainly)

A globally dialable address cannot be created by a node alone. Something with
an inbound-open global IPv6 must host the last hop. The only design that gets
"zero configuration for the operator, works on every node" is to make **that
something the network itself**: reachable nodes serve circuit relay
automatically, unreachable ones automatically hold reservations and advertise
`<relay>/p2p-circuit/p2p/<self>`. Uniqueness/dialability come from the
`/p2p/<self>` suffix (the identity key), not from the host.

Rejected alternatives (recorded decisions, unchanged): tunnel brokers need an
account + Protocol-41 passthrough (not zero-config, not universal); ULA/VPN
addresses are non-routable by policy; IPv4 + UPnP ruled out; an official
discovery server is deliberately absent.

**Residual dependency that cannot be removed:** if NO node in the reachable
set has inbound-open IPv6, nobody can host a hop and the hidden node stays
unreachable. Auto-relay removes the *operator's* configuration, not the need
for somebody with a public address.

## Reverses two recorded decisions (this story is the reversal)

- `SUCCINCTCOIN_RELAY_SERVER=1` opt-in serving → serving becomes automatic for
  reachable nodes; the env var stays as a FORCE-on override.
- "deliberately no automatic relay discovery — human/ops question" (README,
  deferred-work) → hop-capable peers already in the peerbook become candidates.

Kill switch (the accepted compromise): `SUCCINCTCOIN_RELAY_AUTO=0` restores
today's explicit-only behavior. Seeds stay additive.

## Design

### Pure policy module `packages/core/src/net/auto-relay.ts` (no libp2p, no env)

- `AutoRelayMode = 'auto' | 'explicit-only'` — resolved by the caller from env.
- `autoServeEnabled(mode, reachability): boolean` — tcp + mode auto + not
  KNOWN-unreachable (`'unreachable'` ⇒ false: a node whose inbound is proven
  dead must not advertise a hop it cannot serve; `'reachable'`/`'unknown'` ⇒
  true — unknown is honest, the probe has not answered yet).
- `autoHoldWanted(mode, reachability): boolean` — hold circuits only where
  direct addressing is PROVEN dead (`'unreachable'` only). `'unknown'` does
  NOT hold: holding on evidence-free startup would have every fresh node burn
  three strangers' reservations for nothing, and the ladder rule says rung 3
  starts where rung 1 leaves off (the optimistic boot announces direct
  addresses until proven wrong). The probe answers seconds after joining,
  and joining requires an invite — so a hidden node has candidates to probe
  through the moment it joins.
- `pickRelayCandidates(candidates, { selfIdentityId, max })` — deterministic
  (sorted peer id order), deduped, self-excluded, only peers we hold a DIRECT
  connection to (an outbound-only or relayed link proves nothing about their
  reachability).

### Adapter wiring (`net/adapter.ts`, additive to 10.2/10.3 seams)

- Serving: register `circuitRelayServer()` when `autoServeEnabled(...)` OR the
  existing explicit `relayRole: 'relay'`. Evaluated at construction from the
  reachability known *then* (pre-start ⇒ `'unknown'` ⇒ serve). Accepted
  limitation, pinned by a row: a node that starts, learns it is unreachable,
  and keeps serving advertises a hop peers cannot use; selection-side failure
  handling makes this self-correcting for the peer (refused/unusable circuit ⇒
  next candidate), and consensus never reads transport truth. Dynamic
  start/stop would require `CircuitRelayServer`'s undeclared `start()/stop()`
  — interface-internal, rejected on the same grounds as the 10.3 pin review.
- Holding: when `autoHoldWanted(reachability())`, pick up to `MAX_AUTO_RELAYS`
  (3) hop-advertising direct peers and run the EXISTING bounded hold episode
  (`holdSeed`) against them — one code path, so circuit addresses, events,
  loss-recovery and the announce surface are identical to manual seeds.
- Env resolution lives in the app glue (like every other flag): `relayAuto`
  config field, default auto on tcp.

### Honesty surfaces

- The invite/announce already renders held circuits — nothing new to lie about.
- App panel: when an invite exists and its address is a circuit, say it is
  relayed (works from anywhere, rides `<relay>`), distinct from the dev-loopback
  warning shipped today.

## Tests

- Policy rows: serve/hold matrices over `reachable|unknown|unreachable` ×
  mode; candidate selection determinism, self-exclusion, direct-only, cap.
- Adapter rows (memory transport + injected reachability source): unreachable
  node + one hop-capable direct peer ⇒ circuit address announced and dialable
  by a third node; reachable node ⇒ does NOT hold; `relayAuto: 'explicit-only'`
  ⇒ no auto serve/hold (today's behavior byte-identical).
- Existing 10.2/10.3 rows stay green untouched (seeds + trio harness).

## Not in scope

- No new wire protocol, no relay authentication/trust ranking (a malicious
  relay can only drop/observe traffic it already could observe by being a peer;
  consensus is unaffected — record as accepted).
- No headless node runner (separate gap — shipped since by ticket 8), no
  official relay endpoint.

## Build log (2026-10-21)

**Shipped.** Policy module `net/auto-relay.ts` (committed first, `e38b76d`):
`autoServeEnabled` / `autoHoldWanted` / `pickRelayCandidates` /
`MAX_AUTO_RELAYS = 3` — pure, 8 rows. Adapter wiring (`net/adapter.ts`):

- **Serve** at CONSTRUCTION: `autoServeEnabled(relayAuto, 'unknown')` OR
  explicit `relayRole: 'relay'` adds `circuitRelayServer()`. Pinned
  limitation row SERVES_WHEN_UNREACHABLE (server never stops mid-run;
  `CircuitRelayServer.start/stop` are undeclared on the pipeline object —
  dynamic toggle rejected as planned).
- **Hold** on the TRANSITION EDGE into `'unreachable'` inside the
  reachability report wiring (not polling): edge arms a self-rescheduling
  round chain (`autoRelayRetryMs`, default 15 s) that stands down by itself
  the moment holding stops being wanted. Round = policy pick over the FULL
  sorted candidate list, dispatch walks rank order until round room is spent;
  candidates = libp2p `conn.direct` ∧ peerStore protocols include
  `RELAY_V2_HOP_CODEC` (no record ⇒ identify pending ⇒ skip); seeds are the
  live `conn.remoteAddr` + `/p2p/<id>` (endsWith guard — remoteAddr is
  ALREADY peer-encapsulated; the naive append built `/p2p/<id>/p2p/<id>`, the
  bug that first broke AUTO_HOLD), fed through the existing `holdSeed`
  episode so circuits/events/announce are identical to manual seeds.
  Auto seeds skip operator manual seeds; explicit-only never arms even a
  timer; all auto state cleared in `stop()`.
- **Cooldown fairness** (review MAJOR): a failing candidate is benched
  `AUTO_FAIL_COOLDOWN_ROUNDS = 4` rounds (ROUND-counted, AD-3 no clock) so a
  top-ranked broken relay cannot starve lower candidates; cleared on stop;
  loss-triggered re-hold deliberately bypasses the cooldown (recovery path,
  not refusal). Held auto circuits are NOT force-released when reachability
  returns — the pinned reservation store has no release API; TTLs expire
  them (resolves the ticket's recorded `unknown`).
- Review m1: reachability is wired AFTER `holdRun` is opened, so a
  synchronous source at start cannot arm a retired run.

**App glue:** `resolveRelayAuto(env)` (`SUCCINCTCOIN_RELAY_AUTO=0` ⇒
`'explicit-only'`, else auto) in `main/net-config.ts`, threaded through both
boots (Electron `index.ts`, runner `run-node.ts` — env knob, deliberately NO
argv flag: network policy, not a per-run preference). `defaultNetConfig`
gains an optional `relayAuto` (key absent unless passed — exact-config pins
untouched).

**Honesty surface:** renderer `describeCircuitInvite(text)` base64url-decodes
the invite text and substring-scans for `/p2p-circuit` (cap 4096, never
throws; AD-1: no core import in the renderer) — honest "rides a relay…
expect slightly higher latency" hint under BOTH the own-invite panel and the
paste box.

**Rows added:** core `net-auto-relay-adapter.test.ts` (5: AUTO_HOLD, AUTO_
SERVE, REACHABLE-does-not-hold, EXPLICIT_ONLY byte-identical,
SERVES_WHEN_UNREACHABLE pin); app +5 (`net-config`, `ipv6-hint`, `run-node`).

**Gates:** root build ✓ typecheck ✓ app tsc (both tsconfigs) ✓; core 450/59,
app 66/10, root 516/69 — all green in one pass. README reachability-ladder /
relay-serving sections rewritten (reversal documented); deferred-work carries
the DECISION REVERSED record.
