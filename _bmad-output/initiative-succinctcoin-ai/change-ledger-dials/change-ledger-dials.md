---
title: 'The Ledger Dials — staged connectivity: candidates over transports'
type: 'change-proposal'
created: '2026-11-04'
status: 'proposed (produced by bmad-advanced-elicitation: Assumption Audit, Comparative Analysis Matrix, ADR, Reverse Engineering, Morphological Analysis; user acceptance of individual stages pending)'
scope: 'Major if fully accepted — T-A is a defaults change, T-B a wire-format version, T-C an announcement extension, T-D/E a consensus-data RFC. No stage blocks another; each ships alone.'
initiative: 'initiative-succinctcoin-ai'
epic: 'cross-cutting (connectivity); touches epic-ipv6-invite-network lineage, epic-reachability-tier lineage, epic-universal-dialability lineage'
---

# Sprint Change Proposal — The Ledger Dials (staged connectivity)

## 0. Trigger

User brief (2026-11-04, verbatim kernel): *"the nodes never find each other even on the local network… creative mechanism for establishing p2p connection… investigate how webRTC does it. Each node will have to serve as a relay. If the node is offline, there should be a list of other nodes that are active that can serve as a relay. Initial connection has to happen by invitation — invitation should come as a text message and should contain dialable address. Check how it can be implemented with libp2p. This is a foundational difference from other cryptos."*

This document is the accepted output of a five-method advanced-elicitation session on that brief. Every finding below was verified against the repo (citations inline).

## 1. Issue Summary — the premise, corrected

**A1 "Nodes never find each other even on the local network" is false at protocol level and true at product default.** Ticket 12.1 field-proved cross-machine mDNS discovery (two Macs, one Wi-Fi, `SUCCINCTCOIN_LAN=1`, accepted 2026-10-22). But the shipped default turns LAN discovery OFF: `packages/app/src/main/net-config.ts` ("9.1: mDNS is OFF by default — its IPv4 multicast is middlebox-hostile", opt-in `SUCCINCTCOIN_MDNS=1` / `SUCCINCTCOIN_LAN=1`). Two friends running the app as shipped on one Wi-Fi will not meet. The protocol works; it ships dark.

**Already built (do not rebuild):** every-node relay serving is automatic unless AutoNAT reports `unreachable` (ticket 7, DECISION REVERSED 2026-10-21 — peerbook is the relay directory, `MAX_AUTO_RELAYS=3`, deterministic selection); AutoNAT reachability truth (10.1), volunteer IP-form seeds via env (10.2), DCUtR punching (10.3); CAP-8 hop law admits global /ip4 circuit hops (11.1–11.3); `scinvite:v1` invitations already ARE text messages carrying dialable addresses, re-pushed live by `SelfInviteUpdated` (commit `60bfc83`).

**The one genuinely missing mechanism (A4/A6):** a first connection that survives an **offline inviter** with a node that has **zero prior knowledge**. The invite's single address goes stale when the inviter sleeps; nothing carries backup endpoints whose liveness is witnessed. This is the design target.

**Pinned constraints any solution must honor:**
- CAP-9: LAN /ip4 never enters announcement/invite/block/guarded dial.
- Invite address law: global IPv6 or held circuit only.
- DECISION 2026-10-22: the project operates NO relay; `DEFAULT_RELAY_SEEDS` pinned empty by a permanent test (anti-SPOF).
- DECISION 2026-10-19: WebRTC/QUIC/WebTransport not supported as transports (ICE needs UDP through the same firewalls; TURN = build the relay twice); recorded revisit trigger: disappointing measured DCUtR punch rates. UPnP rejected (IPv4-NAT technology).
- Epic-10 parked item (b): relay operator incentives — open spec question, closed here by T-E.

## 2. Comparative Analysis (weighted matrix, scores 1–5)

Criteria: First-connection success 0.30 · Decentralization 0.20 · Eclipse-resistance 0.15 · Build cost 0.15 · Coherence with CAP-8/CAP-9/invite law 0.10 · Ops burden 0.10.

| Option | FC | Dec | ecl | Cost | Coh | Ops | Weighted |
|---|---|---|---|---|---|---|---|
| O1 Status quo | 2 | 5 | 4 | 5 | 5 | 3 | 3.75 |
| **O2 LAN default-on** | 3 | 5 | 4 | 5 | 4 | 5 | **4.15** |
| **O3 scinvite:v2 witness bundle** | 4 | 5 | 3 | 3 | 4 | 4 | 3.90 |
| **O4 Chain-anchored relay registry** | 5 | 5 | 4 | 2 | 4 | 4 | **4.20** |
| O5 WebRTC transport | 3 | 3 | 3 | 1 | 1 | 2 | 2.40 |
| O6 Operated/curated seed list | 5 | 1 | 2 | 4 | 1 | 2 | 3.00 |

Portfolio recommendation: **O2 + O3 now, O4 as the foundational bet.** O5 rejected again (its ICE host candidates are RFC1918/fe80 — illegal under CAP-8/CAP-9 by construction; where ICE fails, WebRTC's own fallback is TURN = our relay). O6 stays dead by the 2026-10-22 SPOF decision.

## 3. ADR-CONN-1 — how two nodes with zero shared history connect

**Decision: staged connectivity, candidates over transports.**

1. **T-A — LAN discovery default-on.** Local-only overlay; local addresses still never announced/invited/dialed cross-boundary (CAP-9 keeps a local-subnet carve-out law, honest-boot lines unchanged in meaning). The 9.1 middlebox-hostility concern is answered by making it additive: mDNS on by default *in addition to* the existing ladder, never instead of it; one flag flips it off (`SUCCINCTCOIN_MDNS=0` semantics inverted from today's opt-in).
2. **T-B — `scinvite:v2` witness bundle.** The invitation carries: primary dialable address (v1 law) + backup circuit addresses + per-endpoint **signed reachability witnesses** with expiry. Verification non-negotiables (eclipse-resistance, load-bearing not polish): ≥2 independent witness signers per relay entry, TTL enforced at verify, diversity floor (entries span distinct /64 prefixes — the existing floor instinct applied to relays), direct-first preserved (relays are fallback by law, never default).
3. **T-C — witness propagation.** Fresh witnesses ride the existing windowed announcement gossip (the publish path already runs at `NODE_LOOP_TICK_MS=15`); after first contact a node self-seeds backup knowledge. No new protocol needed for T-C alone.
4. **T-D — chain-anchored relay registry (RFC only).** Relay advertise/observe deltas ride as **bounded data in block payloads** — validated, not state-machine-critical; the chain supplies signatures and an ordering clock for free. Freshness is **slot-bounded**: expiry measured in slots against a tip every node already verifies — no wall-clock trust, no clock-skew attack. If the registry goes stale the shipped ladder still works exactly as today (degrades to status quo, never below it). Consensus-safety review is a hard gate before any implementation ticket.
5. **T-E — relay receipts → rewards.** Served-circuit sessions produce signed receipts (provable work); relays earn chain rewards like miners earn PoW. Churn handled by witness expiry: dead relays stop being witnessed and fall out of every bundle within one TTL. No tombstones, no operator. Closes parked open question (b).

**Rejected alternatives:** O5 (WebRTC transport) and O6 (operated seeds) per §2; single-witness or unsigned relay lists rejected under the eclipse-attack analysis (§6 R2); wall-clock TTL alone rejected for T-D in favor of slot-bounding (T-B keeps a wall-clock TTL because the invitee has no chain yet — that is exactly why T-B's k-of-n floor is stricter).

**WebRTC verdict: patterns in, transports out.** The codebase independently reinvented the ICE pattern set: candidate gathering ≈ identify/AutoNAT observed-address truth; candidate racing ≈ the dial queue; TURN ≈ circuit relay v2; signaling ≈ the invitation; **ICE restart ≈ `SelfInviteUpdated`** (the invite re-pushing itself the instant its address set changes — shipped `60bfc83`). Naming this symmetry makes it a design law: *connectivity state is live, never permalinked.* Instrumentation added now (dial-attempt outcome counters) so the recorded O5 revisit trigger becomes measurable instead of anecdotal.

## 4. Reverse-engineered end state (acceptance story)

*Alice texts Bob one line. Bob has never opened the app, sits on hotel CGNAT with no IPv6, and Alice's laptop is closed. Ten seconds later Bob's node is gossiping and mining.*

Backward chain: E1 the text must contain ≥1 endpoint live at redemption → E2 independent of Alice → E3 backup relay endpoints whose liveness was recently witnessed by others (`relayAddr + signerSig + observerSigs + expiry` inside the invite) → E4 after first contact, gossip hands the node fresher witnesses (self-seeding; zero bootstrap servers, ever) → E5 relays stay up because receipts pay → E6 Alice behind CGNAT contributes her held circuit as primary (auto-relay already holds those; `SelfInviteUpdated` already re-pushes) → E7 same-room never needs any of this (T-A).

Product corollary from E6: **an invite is a live lease, not a permalink** — the panel should say "copy it fresh; it goes stale when I go offline."

## 5. Morphological justification of the novel cell

Parameters {first contact, candidate source, relay discovery, trust, freshness clock, incentive} were swept; every degenerate or already-shipped cell maps to today's ladder or a rejected option. The unoccupied corner — *relay discovery = chain registry ∧ freshness = slots ∧ incentive = receipts* — is the proposal's foundational bet: no deployed cryptocurrency uses its own slot clock to keep its network layer alive, and none pays for connectivity as work. Everyone else still hardcodes DNS seeds.

## 6. Risks

- **R1 Consensus coupling (T-D):** block spam becomes relay-list spam; consensus stall could read as partition. Mitigations: bounded per-block records; data-not-state design (registry can go stale harmlessly); consensus-safety review gate before implementation; degradation-to-status-quo proof required as a test class.
- **R2 Eclipse via relay list (T-B):** one-witness or unbounded-age bundles hand a fresh node an attacker-controlled view. Mitigations are the verification non-negotiables (§3.2), pinned by property tests before any UI surfaces v2 invites.
- **R3 Incentive gaming (T-E):** Sybil relays / fake receipts. T-E is spec-only until modeled; rewards may start as reputation-weighted rather than direct issuance.
- **R4 Middlebox hostility returns with T-A default-on:** mDNS noise on hostile networks. Mitigation: additive-not-exclusive discovery, documented kill switch, field telemetry before any release-notes claim.

## 7. Impact Analysis (if accepted)

- **New wire surface:** invite format version (`scinvite:v2`, pure codec + verify first, adapter second — same staging discipline as v1); announcement payload gains optional witness bundles (back-compat: v1 nodes ignore).
- **Consensus data (T-D only):** one new bounded record kind in block payloads + validation path. RFC precedes tickets. Hard gate: this repo's consensus modules carry golden-vector pins; nothing here touches them until the review passes.
- **Defaults (T-A):** `net-config.ts` default flip + rename of the env knob semantics + README/invite-panel copy; LAN honesty law restated in CAP-9 terms (local overlay never crosses the boundary).
- **Deferred-work.md:** parked item (b) resolved-by-design pointer to T-E when accepted; the WebRTC decision entry gains the instrumentation note.
- **Ticket 8.6:** unchanged (still environment), but T-B/T-D shrink its dependency surface — a v4-only pair could complete the proof through witnessed relays instead of requiring global IPv6 on both devices.

## 8. Sequencing

| Stage | Shape | Size | Blocks |
|---|---|---|---|
| T-A LAN default-on | defaults + law restatement + copy | days | nothing |
| T-B scinvite:v2 witness bundle | codec → verify → adapter → UI, property tests first | epic | T-C piggybacks its types |
| T-C witness propagation in gossip | announcement payload extension | story | — |
| T-D chain relay registry **RFC** | design doc + consensus-safety review | RFC | gates T-E spec |
| T-E receipts/rewards spec | open spec (closes parked (b)) | spec | gated by T-D |
| Instrumentation (dial-outcome counters) | telemetry seam, no policy | small | feeds O5 revisit trigger |

Each row ships alone and pays alone. Nothing in this proposal is implemented; nothing here changes any file outside `_bmad-output/`.

## 9. Elicitation provenance

Assumption Audit (A1–A7, weakest = A4 eclipse analysis) · Comparative Analysis Matrix (§2) · Architecture Decision Records persona debate (reliability / threat / purist / product / operator voices → §3 decision text) · Reverse Engineering (§4) · Morphological Analysis (§5). User directive: "let's do them all… unique and innovative and creative."
