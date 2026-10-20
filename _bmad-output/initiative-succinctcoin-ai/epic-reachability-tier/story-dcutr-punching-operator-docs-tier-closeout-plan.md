---
id: dcutr-punching-operator-docs-tier-closeout
status: built
epic: epic-reachability-tier (ticket 10.3)
title: DCUtR punching + operator docs + tier closeout
---

# 10.3 — DCUtR + operator docs + tier closeout — plan

## Build-time unknowns — RESOLVED before code (2026-10-19)

1. **Which dcutr?** `@libp2p/dcutr` 3.0.32 requires
   `@libp2p/interface-internal ^3.2.2` — the SAME Registrar type-identity wall
   autonat-v2 hit (kept at 3.1.13 by the workspace override). **3.0.28** is
   the LAST release on `^3.1.13` (exact pin; 3.0.29 moved to ^3.1.14, 3.0.30+
   to 3.2.x). Install verified clean: no new interface-internal copy, no
   release-age exclusions needed (Aug-2026 package).
2. **Service deps:** declares ONLY `@libp2p/identify` (already registered);
   needs circuitRelayTransport — always wired since 5.7 D9. Options
   timeout/retries stay DEFAULT (no evidence any pin is needed; documented).
3. **Memory transport:** registering dcutr there would be honest-but-useless;
   AD-10 discipline says NO — pure `dcutrEnabledFor(transport)` gate, tcp-only
   (mirrors `autoNatEnabledFor`), memory inert row pinned.

## Design

1. **Adapter**: `dcutrEnabledFor(transport)` (pure, reachability.ts — the
   tier module); services spread
   `...(dcutrEnabledFor(config.transport) ? { dcutr: dcutrService() } : {})`;
   Services type gains `dcutr?: unknown`-shaped member (typed import). No
   config flag needed (the ticket wants it unconditional on real transports;
   AutoNAT keeps its opt-out because it PROVES things, DCUtR only UPGRADES).
2. **App relay-server switch**: net-config `relayServer?: boolean` →
   `relayRole: 'relay'` when true (default false pinned by the exact-config
   row); env `SUCCINCTCOIN_RELAY_SERVER=1` in index.ts glue. The volunteer
   path becomes config, not code — README can then honestly say how.
3. **README Joining section**: replace the "No IPv4, no relay (yet)" bullet;
   add THE REACHABILITY LADDER (direct TCP → AutoNAT honesty (10.1) → circuit
   relay via `SUCCINCTCOIN_RELAY_SEEDS` (10.2) → DCUtR upgrade where firewalls
   allow) + volunteer-relay paragraph (`SUCCINCTCOIN_RELAY_SERVER=1`, share
   the seed line out-of-band; no official endpoint, incentives parked).
4. **dial-manual.mjs relay trio** (loopback-provable under
   `SUCCINCTCOIN_ALLOW_LOOPBACK=1`, skips disclosed honestly like 9.5):
   `relay-new [addr]` prints the SEED line; `node-behind <seed>` holds a
   reservation, announces its circuit address + prints a copy-paste invite
   carrying it; `invite-use-through-relay <scinvite>` verifies (full shipped
   path when the relay hop is global; probe-side sig+chainId only under the
   loopback flag — loud disclosure) and dials the circuit address. PASS line:
   `DIALED THROUGH RELAY`.
5. **Closeout docs**: deferred-work.md relay-tier PLANNED entry → shipped
   pointer (what remains parked: operated endpoints, incentives, gossip
   advertisement of relays); spec-succinctcoin.md open question narrows to
   operator INCENTIVES only.

## Tests

- Pure rows (`net-reachability.test.ts` or new small block):
  `dcutrEnabledFor('tcp')===true`, `('memory')===false`.
- Composition: tcp build registers dcutr / memory does not — pinned via the
  pure gate (same precedent as AUTONAT_ENABLED; building a tcp node in CI is
  AD-10-forbidden).
- App rows: net-config exact-config gains relayRole ONLY when
  `relayServer: true` (default config stays byte-identical — extend the
  NET_TCP_MDNS_LAN_ONLY exact-shape pin discipline with a relayServer row).

## Gates / review / commit

Standard loop + the LIVE proof: run the trio on ONE machine under the
loopback flag against built dist, exit 0 + `DIALED THROUGH RELAY` printed;
transcript excerpt lands in the build log. Full suites green headless.

## Explicitly NOT in scope

- No operated relay endpoint, no relay advertisement over gossip (parked),
  no QUIC/WebRTC/UPnP (DECISIONs stand).
- No dcutr options tuning (defaults; documented).

## Build log

- **Implemented as designed**: `dcutrEnabledFor` (reachability.ts) + services
  spread in buildNode (tcp only); barrels export it; DCUTR_ENABLED pure row;
  app `relayServer` option → conditional `relayRole: 'relay'` key (absent by
  default — exact-config pins untouched) + `SUCCINCTCOIN_RELAY_SERVER=1`
  glue; RELAY_SERVER row deep-equals the opt-in config (review F2).
- **Mid-story design addition (found by the live proof, not guessed):** the
  10.2 seed pre-flight used raw `isGlobalIp6Multiaddr`, which rejects `::1`
  EVEN under `SUCCINCTCOIN_ALLOW_LOOPBACK=1` — but holding a seed IS dialing
  it, and the dial policy (`assertDialable`) is the flag's whole scope.
  Pre-flight now calls `assertDialable`: byte-identical with the flag off
  (review-verified), loopback seeds hold under the dev flag. This made the
  one-machine trio possible; shipped policy unchanged.
- **Live trio proof** (one machine, `SUCCINCTCOIN_ALLOW_LOOPBACK=1`, against
  built dist — every skip disclosed in-band):
  `relay-new` → SEED line; `node-behind <seed>` → `seed HELD` +
  `HELD circuit: /ip6/::1/tcp/…/p2p-circuit/p2p/<self>` + invite carrying
  ONLY the circuit addr; `invite-use-through-relay` → probe-side verify →
  **`DIALED THROUGH RELAY`** + PEERS (relay + hidden node). Driver:
  `=== outsider exit=0 behind exit=0 relay exit=0 ===`, relay
  `SERVED <hiddenId>, <outsiderId>`, behind PEERS = the outsider arrived
  through the circuit → `TRIO PROOF: PASS`.
  Probe-harness lessons (encoded in the modes): each side's PASS must watch
  a DIFFERENT signal (arrival-not-relay for behind, CUMULATIVE served-set
  for the relay), and the dialer settles 15s so the others' 1.5s polls can
  observe the circuit before teardown; a bare `new Set<string>()` in .mjs
  is a syntax error under Node type-stripping.
- **Observed (accepted)**: node-behind logged TWO `seed HELD` events per run
  — one re-hold fires when the reservation's setup connection closes right
  after RESERVE (wireSeedLoss matches any close to the relay). Converges to
  one circuit addr; announce never lied during it. Not a bug at this tier;
  noted for any future hold-loop work.
- **Quick-lens review** (3 lenses): F1 false-PASS guard for seeds without
  /p2p in node-behind — FIXED; F2 deep-equal opt-in config — FIXED; F3
  nit-comment softened; F4 README rung-3 wrongly implied IPv4-only peers
  ride the relay (they cannot even dial a seed) — FIXED, now explicit;
  F5 seed-line wording double-append risk — FIXED ("that whole line is the
  seed"); F6/F7 deferred-work date + env attribution — FIXED. No blockers.
- **Gates**: root build ✓ typecheck ✓; root suite 480/480 in 118s (an
  earlier attempt's 7 failures were the known external-load stall set —
  isolated re-run 27/27 green); app tsc ✓, 50/50. Counts now 480/66 root,
  core 430/57, app 50/9.
