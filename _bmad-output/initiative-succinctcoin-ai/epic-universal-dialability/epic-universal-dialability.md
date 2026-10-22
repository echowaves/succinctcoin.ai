---
type: epic
title: "Universal dialability: dual-stack relay hop + shipped seeds"
parent: initiative-succinctcoin-ai
covers: ["CAP-8", "CAP-3"]
after: []
assignee: ""
risk: medium
estimate: "4 stories + 1 hitl, S–M"
estimate_basis: "Research D3 verified the blast radius is small and code-local: one blocking seed-dial call (holdSeed -> assertDialable), one pure predicate module to split, and validators that already funnel through it. The risk concentrates in R2 — circuit addresses are consensus-validated chain data, so every widened acceptance needs a pinned rejection twin proving direct /ip4 still rejects everywhere and non-global hops never pass; block rules, signatures, slot math and fork choice stay byte-identical."
---

# Universal dialability: dual-stack relay hop + shipped seeds

## Description

Epics 9–10 and ticket 7 built a complete reachability tier — AutoNAT truth, volunteer circuit-relay v2, DCUtR, automatic hold/serve — but every rung of it assumes the node can **dial out over IPv6**. The operator's own machine broke that assumption: no global IPv6 at all, carrier-NAT'd IPv4 only, and our policy (`assertDialable`) rejects `/ip4` even for relay seeds, so such a node cannot reach any relay we operate or anyone volunteers. The deep-recon run (companion: `../research-ipv4-only-cgnat-dialability/`) screened the candidate space — tunnel brokers (dead or CGNAT-fatal), operated fleets, pure P2P — and landed on the pattern every production system converged on: **relays dialed family-agnostically at a node's identity address**. The spec amendment (2026-10-21): the HOP segment of a `/p2p-circuit` address may be global-scope IPv4 or IPv6; direct addresses keep the strict global-IPv6 law; software ships a built-in dual-stack seed list (pool bootstrap, never a trust root — narrowed non-goal).

The invariant generalizes rather than breaks: **a circuit address is only ever as public as its hop** — now "global scope" in either family, checked by one predicate at every boundary. A CGNAT'd node's invite simply reads `/ip4/<relay>/tcp/N/p2p/<relayId>/p2p-circuit/p2p/<self>`, and any node that can reach the relay dials it.

## Outcome

An operator on an IPv4-only ISP with no router control installs, launches, and within a minute has a unique dialable address other nodes use — v6-only or v4-only — while mining normally. No environment variables, no port forwarding, no accounts. Machines that do have global IPv6 change nothing: direct dials still work, ticket-7 auto-relay still enriches the pool.

## Requirements

- R1 — hop-scope policy: `address-policy` gains a pure relay-hop predicate (global `/ip4` or `/ip6`; rejects RFC1918, CGNAT `100.64.0.0/10`, loopback, ULA, link-local, multicast, zones) and a circuit-shaped validator (`<hop>/p2p-circuit/p2p/<id>` valid iff the hop passes and the remainder carries no IP components); direct-address rules unchanged; ONE module owns every boundary; SC-NET-1 messages name the hop rule.
- R2 — consensus-boundary parity: announcement/invitation validators, address book, crawl, candidates/apply-block/introductions consume the same circuit-shaped predicate; pinned rows prove global-v4-hop circuits ACCEPT in strict contexts while direct `/ip4` and every non-global hop REJECT at every site including block data.
- R3 — adapter seed dialing: `holdSeed` pre-flight and dispatch use the hop predicate for seeds (dev loopback flag governs loopback hops of BOTH families, dial-side only); the direct-dial TCP guard stays strict; held v4-hop circuits flow through announce/invite/book on the untouched ticket-7 machinery.
- R4 — seed seam shipped: a built-in default seed constant in net-config, **shipped EMPTY by design** (amended 2026-10-22: the project operates no relay — see Notes), `SUCCINCTCOIN_RELAY_SEEDS` stays additive; boot lines report which family dialed; README reachability ladder rewritten ("IPv4-only nodes are served through a relay hop"); discovery lint permits `/ip4` only at hop positions (seed config, fixtures).
- E1 — consensus mechanics byte-identical: no block-rule, signature, slot-math, or fork-choice change — only the address-shape predicates they consult widen (spec assumption, pinned by R2 rows).
- E2 — Honest Boot Proof + headless discipline: memory transport untouched (AD-10); a fixture with no global IPv6 obtains a circuit address through a relay and a v6-only dialer round-trips data (CI approximation on loopback under the dev flag for both families; live variant via `dial-manual.mjs` modes, skips disclosed).

## Done when

1. Policy rows pin the hop rule at dial/announce/ingest/book/crawl identically, with consensus-path rejection twins (direct `/ip4` never enters a block; non-global hops never pass) — full suites green headless.
2. Adapter integration: seeded hold over a v4-shaped hop announces `<hop>/p2p-circuit/p2p/<self>`; third node dials THROUGH the relay and exchanges data (memory-transport rows + loopback real-socket trio on both stacks, dev flag disclosed).
3. Honest Boot Proof row green in CI (fixture without global v6 → circuit address → dial round-trip) plus the `dial-manual.mjs` live variant proven on one machine.
4. Seed seam shipped: default constant pinned by a config test (pinned EMPTY **by design** — the pinned-empty test is the permanent invariant guard), env additive rows green; README ladder renders for an IPv4-only operator; lint updated and green.
5. Build + typecheck + full root/app suites green headless; deferred-work and spec open questions narrowed to what remains (incentives, relay discovery beyond seeds).

## Boundaries

- Direct `/ip4` stays rejected everywhere — this epic serves IPv4-only peers THROUGH a hop, never as direct addresses (recorded DECISION lineage 2026-10-18 → 2026-10-21 amendment).
- No relay gossip/advertisement (parked); no DHT; no QUIC/WebTransport/WebRTC/UPnP (standing DECISIONs).
- The seed list must stay architecturally optional: seeds absent or dead degrades exactly to epic-10 behavior, never breaks boot.
- No domain/DNS/VPS provisioning anywhere in this epic (amended 2026-10-22: the project operates no relay); volunteer operations guidance lives in `docs/relay-runbook.md`, outside the code.
- `/64`-style diversity counting moves per-family on the hop network (v6 /64 as today; v4 per-IP//24) — no new anti-abuse machinery beyond that keying.

## References

- research — `../research-ipv4-only-cgnat-dialability/research-ipv4-only-cgnat-dialability.md`, Executive summary + D3 (integration blast radius, call sites).
- spec — `../spec-succinctcoin/spec-succinctcoin.md`, CAP-8 + amended addressing constraint + narrowed non-goal; companion `discovery-design.md`, "Relay-hop addressing".
- epic — `../epic-reachability-tier/epic-reachability-tier.md`, R2/R3 (seed bootstrap + circuit policy this epic widens).
- code — `packages/core/src/net/address-policy.ts` (predicate home); `packages/core/src/net/adapter.ts` (`holdSeed` pre-flight, dial guard); `packages/app/src/main/net-config.ts` (seed config seam).

## Notes

- **Tracer bullet:** 11.1's policy rows land first — if the hop rule cannot pin cleanly at every boundary (especially consensus paths), everything downstream is blocked and we learn it immediately.
- **Decision:** no separate refactor-sweep story — the surface is two pure modules, one adapter file, and docs; 11.5's closeout carries the lint/docs consistency sweep.
- **Autonomous call RESOLVED (amended 2026-10-22, user):** the 2026-10-21 call (project operates ONE bootstrap relay) is REVOKED — a single operated endpoint is a single point of failure. The project operates NO relay: `DEFAULT_RELAY_SEEDS` ships empty by design; join rides invitation (rung 0) + auto-relay; volunteers publish seeds out-of-band. Story 11.4 dropped to community guidance (its runbook deliverable shipped in `9ea45dd`); 11.5's flip is retired, not skipped — no other story moves. Proposal: `../change-remove-relay-spof/change-remove-relay-spof.md`.
- **Seed-format correction (2026-10-22, pre-provisioning check):** 11.4's "hand the seed multiaddr `/dns/<domain>/…`" is NOT implementable against the shipped laws — `seedShapeOk` requires a global-scope first IP (a dns seed has none to dial) and a `<dns>/p2p-circuit/…` held circuit fails the hop law at record validation. Seeds are IP-form, one per family (`/ip4/<relay>/tcp/N/p2p/<id>`, `/ip6/…`); the domain (A+AAAA) stays a human/docs convenience + health check. IP-form seeds go into `SUCCINCTCOIN_RELAY_SEEDS` (or a future community-curated list) — the built-in constant stays empty **by design** (see the decision line below). Volunteer runbook shipped early as `docs/relay-runbook.md` (11.4 deliverable; volunteer ops are documentation, not code).
- Sequencing: 11.1 (policy) → 11.2 (adapter+proof rows) → 11.3 (config/docs/lint); 11.4 (hitl) runs in parallel from day one; 11.5 integrates and flips seeds.
- **Epic decision line (amends the 11.5 gap line, 2026-10-22):** the CAP-8 machinery is BUILT and proven headlessly (Honest Boot Proof, both variants) + live on loopback (relay-new-v4 trio), and the network ships ZERO default seeds **by design**: the project operates no relay, so there is no endpoint to provision, take down, or censor. `DEFAULT_RELAY_SEEDS` stays pinned empty permanently (the pinned-empty test guards the invariant); v4-only joiners ride invitation + auto-relay with zero per-machine config, and operators who want fixed relays pin volunteer IP-form seeds via `SUCCINCTCOIN_RELAY_SEEDS`. Epic 11 is COMPLETE: 11.1/11.2/11.3/11.5 built, 11.4 dropped by decision (runbook shipped).
