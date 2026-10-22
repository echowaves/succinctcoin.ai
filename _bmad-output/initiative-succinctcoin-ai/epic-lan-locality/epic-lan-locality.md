---
type: epic
title: "Local-testnet locality (SUCCINCTCOIN_LAN=1)"
parent: initiative-succinctcoin-ai
covers: ["CAP-9"]
after: []
assignee: ""
status: done
risk: low
estimate: "1 story, S — BUILT out-of-band (prototype), recorded here"
estimate_basis: "Surface verified before the prototype and unchanged since: one opt-in bind swap in net-config, one loopback wire filter in the adapter's announce path, one bootstrap-filter branch, boot-line UX, plus lint exemption. Chain-level law untouched; default config byte-identical (exact pins)."
---

# Local-testnet locality (SUCCINCTCOIN_LAN=1)

## Description

Field failure 2026-10-22: two machines on one LAN with no global IPv6 could not
see each other. tcpdump proved mDNS itself works — but our `/ip6/::` wildcard
bind expands through `getThinWaistAddresses`, which skips link-local, so the
mDNS TXT announced junk (`/ip6/::1`). The discovery-dial path already dials
whatever is announced; the only missing link was a *real* announced LAN address.

The capability (spec CAP-9): an operator runs several machines on ONE local
network segment as a working p2p testnet with zero global-IPv6 dependency and
one env var. `SUCCINCTCOIN_LAN=1` binds the IPv4 wildcard instead of v6,
implies mDNS, drops loopback-family addresses from the wire view (identify and
mDNS carry only real LAN addresses), widens the bootstrap filter to private/
loopback v4 pins (public `/ip4` never), and prints `[boot] LAN dial: <addr>
(local testnet — not an invite)`. The addressing law is amended by exception,
not relaxation: LAN `/ip4` never enters a chain announcement, invitation,
block, or the policy-guarded dial; flag-off config is byte-identical.

## Outcome

Two laptops on one Wi-Fi: `SUCCINCTCOIN_LAN=1 corepack pnpm start` on each →
each lists the other under Network peers within seconds, heights climbing in
step. Nothing else about either node changes; kill the flag and the node is a
strict IPv6-only citizen again.

## Requirements

- R1 — opt-in bind + discovery: `SUCCINCTCOIN_LAN=1` (app + headless runner) replaces the v6 wildcard bind with `/ip4/0.0.0.0/tcp/<port|0>` (single listener; port flag/env ride the same rewrite) and implies mDNS on. Flag unset ⇒ exact-config pins byte-identical.
- R2 — wire honesty: core config `lanMode: true` drops loopback-family (`::1`, `127/8`) direct addresses from the announce filter, so identify/mDNS carry only real LAN addresses; circuits untouched; absent key ⇒ byte-identical.
- R3 — bootstrap pinning: in LAN mode ONLY, the bootstrap filter accepts private-RFC1918/127 v4 pins (direct or circuit-hop) so the `[boot] LAN dial:` line works pasted into `bootstrap.txt` when multicast is blocked; public `/ip4` still never survives.
- R4 — honest labeling + lint: boot line prints `[boot] LAN dial: … (local testnet — not an invite)` with the same bootstrap-hints suffix as the v6 line; discovery lint exempts ONLY the wildcard-bind constant in net-config by name, file AND value (a concrete endpoint behind the exempt name still fires).
- E1 — law preservation: no chain-level change — `/ip4` never enters announcement, invite, block, or the guarded `dial()`; consensus paths byte-identical.

## Done when

1. Two machines on one segment boot with the flag and list each other as peers over `/ip4` (field demo, 2026-10-22: PASS on two Macs).
2. All policy/config/boot-line rows green; default path byte-identical (exact pins + lint real-repo scan); full suites green headless.

## Boundaries

- One broadcast domain: multicast never crosses subnets/NAT/tethering — cross-network reachability is CAP-8's relay tier, never LAN mode (spec non-goal, field-proven boundary).
- No dual-bind: LAN mode trades WAN-v6 for LAN-v4 deliberately ("local-first testnet" honesty, documented in README).
- No UI affordance beyond the existing peers panel; no new IPC.

## References

- spec — `../spec-succinctcoin/spec-succinctcoin.md`, CAP-9 + addressing-law carve-out + boundary non-goal.
- plan — `../plan-lan-locality-prototype.md` (build record: design, edit list, Review Triage Log F1–F5, gates).
- code — `packages/app/src/main/net-config.ts` (bind + opts), `packages/core/src/net/adapter.ts` (`lanMode`, announce/bootstrap filters), `packages/core/src/net/address-policy.ts` (`lanModeDropsAddress`, `isLanBootstrapMultiaddr`), boot lines in `index.ts`/`run-node.ts`.

## Notes

- **BUILT out-of-band as a prototype** (bmad-build, quick review) at commit `15117a4`; gates: root 556/70 + app 76/10. This epic records the capability in the tree; story 12.1 exists to hold the acceptance decision.
- Field probe added alongside: `../epic-real-network/mdns-lan.mjs` (two-node LAN smoke, PASS one machine incl. cross-process discovery of a running app).
- Norton-class middleboxes may still block multicast on real LANs (documented); the bootstrap-pin path (R3) is the fallback and needs no multicast.
