---
type: epic
title: "Reachability tier: AutoNAT truth + volunteer circuit relays + DCUtR"
parent: initiative-succinctcoin-ai
covers: ["CAP-3", "CAP-7"]
after: []
assignee: ""
risk: medium
estimate: "3 stories, S–M"
estimate_basis: "No new consensus or wire-block surface: AutoNAT/DCUtR are js-libp2p service registrations on the real transport only (memory transport untouched, AD-10); circuit-relay v2 shipped in 5.7 (server role + always-wired client transport), so the tier's new work is seed bootstrap, reservation lifecycle, and carrying circuit addresses through the address policy / validator / book / crawl boundaries. The risk concentrates in those boundary rows — a circuit address must never smuggle a non-global relay hop."
---

# Reachability tier: AutoNAT truth + volunteer circuit relays + DCUtR

## Description

Epic 9 made joining an act of trust (one pasted invite) and addressing IPv6-only — but it left a known hole, recorded in `deferred-work.md` since 9.5: a peer whose router drops inbound traffic can join fine yet never be *dialable*, so it cannot serve as anyone's entry point, and two inbound-blocked peers cannot meet at all. The user connectivity review (2026-10-19) evaluated the candidate techniques against the two hard constraints — IPv6-only addressing, invite-over-out-of-band-channel — and decided: AutoNAT for reachability truth, a volunteer circuit-relay v2 seed tier for the reachable-path-through-someone-else, DCUtR on top to upgrade relayed connections to punched-direct ones where possible. UPnP (an IPv4-NAT technology; IGD does not manage v6 firewalls) and WebRTC/QUIC/WebTransport (UDP tax through a v6-only policy; TURN duplicates circuit relay) are rejected in `deferred-work.md`.

The invariant that makes this safe inside our policy: **a circuit address is only ever as public as its relay hop.** `/ip6/<relayGUA>/tcp/N/p2p/<relayId>/p2p-circuit/p2p/<self>` begins with the relay's global unicast — so announce/dial/ingest keep checking exactly one thing, and the tier adds no new address family. The no-operated-infrastructure non-goal holds: seed lists default to EMPTY (like genesis bootstrap), relays are volunteer-run via the 5.7 server role, and invites keep working unchanged — a relayed peer's invite simply carries a circuit address instead of a direct one.

## Outcome

A user behind a firewall that drops inbound IPv6 still gets an invite that works: their node learns it is unreachable (AutoNAT), reserves a circuit on a volunteer relay, announces the circuit address beside any usable direct address, and friends dial through the relay — with DCUtR quietly upgrading the path to direct when both ends can punch. Nothing announced is undialable-by-policy, no infrastructure is operated by the project, and IPv6-only still means what it meant before this epic.

## Requirements

- R1 — reachability truth: on real transports the node runs AutoNAT; when evidence says inbound is blocked, the node's advertised listen set stops claiming a direct address it cannot be reached on (native libp2p filtering if present in the pinned version, adapter-level suppression otherwise — pinned at build). `unknown` (no peers yet, fresh boot) announces exactly what today does.
- R2 — relay seed bootstrap: config gains `relaySeeds: string[]` (default empty); non-empty implies client behavior — dial each seed at start, hold a circuit reservation with bounded retry, surface reservation state; the 5.7 single-`relayAddress` operator shape keeps working. Once reserved, the node's own `/…/p2p-circuit/p2p/<self>` address flows through announce → invite → book → peerbook-serve → crawl like any other address.
- R3 — policy boundary for circuit addresses: a `/p2p-circuit` multiaddr is policy-valid iff its FIRST `/ip6` hop (the relay) is global unicast and it carries no `/ip4`/`ip6zone`; the announcement validator accepts circuit addresses within the existing per-record multiaddr budget; a relay hop that is link-local, ULA, or v4 is rejected at every boundary with the same SC-NET-1 clarity.
- R4 — DCUtR upgrade: on real transports the DCUtR service is registered so a pair sharing a relay attempts simultaneous-open punching and prefers the direct result; memory transport stays fully inert (AD-10).
- E1 — IPv6-only survives untouched: no new address family reaches `assertDialable` except as a circuit wrapper around an already-valid global `/ip6`; the /64 diversity floor keeps counting the RELAY's /64 honestly (a relay is one point of network — pinned, not accidental).
- E2 (AD-10) — everything testable headless: memory-transport relay rows extend the existing 5.7 suite; AutoNAT/DCUtR wiring pinned by composition rows; real-internet punching stays in probes/docs.
- E3 — no operated infrastructure: default seed list empty; volunteer relay documented as configuration, never shipped-on-by-default.

## Done when

1. Memory-transport integration (extends 5.7): relay server + client-with-seed → client's `listenAddresses()` includes its circuit address → a third node dials it THROUGH the relay and exchanges data — headless, zero real sockets.
2. Policy rows: circuit address with global-v6 relay hop accepted at dial/announce/ingest; `/ip4` or `fe80::` or `fd00::` relay hop rejected SC-NET-1; validator round-trip (encode→parse→verify) over a record carrying one direct + one circuit address.
3. AutoNAT wiring: service present on tcp builds, absent on memory; reachability mapping rows pinned; with forced `unreachable`, the advertised set contains only circuit addresses.
4. DCUtR wiring row + README connectivity section (direct → relay → punch ladder, volunteer-relay config, seed env) renders for a new operator.
5. Full suites green headless; both new deps exactly pinned alongside the libp2p stack.

## Boundaries

- No IPv4 anywhere: peers with no IPv6 at all (tunnel-less dual-stack laptops on v4-only ISPs) remain unserved — that is the recorded DECISION, this epic does not revisit it.
- No official relay endpoints; seed propagation UX beyond config/env (e.g., relay gossip) is out of scope.
- No QUIC/WebTransport/WebRTC (recorded DECISION); no UPnP (recorded DECISION).
- The 5.7 verify-before-relay rules and gossip-over-limited-connections behavior stay as shipped; this epic adds addresses, not trust.
- `/64` counting for relayed peers counts the relay hop — accepting that many relayed peers share one /64 is exactly why the floor exists.

## References

- `../deferred-work.md` — the PLANNED relay-tier entry + UPnP and WebRTC/QUIC DECISION entries (2026-10-19).
- `../spec-succinctcoin/spec-succinctcoin.md` — IPv6-only constraint (amended 2026-10-19), no-operated-infrastructure non-goal, relay OPERATOR-INCENTIVES open question.
- `../epic-ipv6-invite-network/` — epic 9 whose invite/announce/book surfaces this epic feeds.
- `packages/core/src/net/adapter.ts` (5.7 D8/D9) + `packages/core/test/circuit-relay-v2.test.ts` — the shipped relay machinery this epic bootstraps.

## Notes

- **Tracer bullet:** 10.2's policy rows land first inside their story — if circuit addresses cannot pass the boundary cleanly, everything downstream (announce, invite, crawl) is blocked and we learn that immediately.
- Sequencing: 10.1 (truth) before 10.2 (announce the truth + relay bootstrap), 10.3 (punching) rides live relay connections from 10.2.
- Build-time unknown to resolve in 10.1: whether pinned js-libp2p already filters `getMultiaddrs()` by AutoNAT status natively; if yes, R1 is nearly free and the adapter just exposes the status for diagnostics.
