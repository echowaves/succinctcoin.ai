---
title: 'Technical research: IPv4-only CGNAT dialability with zero configuration'
type: 'technical'
topic: 'How does an IPv4-only CGNAT node (no router control, no IPv6) get a globally dialable address other nodes can dial'
decision: 'Pick the reachability architecture to build for SuccinctCoin hidden nodes'
source: 'bmad-deep-recon (technical x select, deep preset)'
status: final
preset: 'deep (user: no token limit, find what works)'
validation: 'high on decision cells — primaries for every load-bearing claim; code-verified integration analysis'
created: '2026-10-21'
updated: '2026-10-21'
---

# Technical research: IPv4-only CGNAT dialability with zero configuration

**Decision this research serves:** which reachability architecture to build so that ANY node — including one behind carrier NAT with IPv4 only and no IPv6 at all, no router control — is dialable by every other node, with zero per-machine configuration.

---

## Executive summary

**There is no mechanism on Earth that hands a CGNAT'd, no-IPv6 host its own globally routable IP address without some third party in the middle.** This is not a tooling gap — it is arithmetic: the carrier's NAT owns the public address, and tunnel brokers that used to mint addresses (SixXS/AICCU) are dead, while 6in4-style tunnels provably don't survive CGNAT (protocol-41 needs full address mapping the carrier doesn't have). Every production system that faced this exact wall — Tailscale, IPFS, TURN/WebRTC — converged on the same answer:

> **Stop giving the node a network address. Give it an identity address that routes through relays.** In libp2p this is exactly `/…/p2p-circuit/p2p/<peerID>`: unique per node, globally dialable by anyone who can reach any relay, requires zero per-machine config, and needs no router control. The Circuit Relay v2 spec addresses by PEER ID; the relay hop beneath it is address-family agnostic — IPv4 hops are the norm in IPFS today.

**Recommendation (pick): dual-stack relay hop.** Keep every direct address in the network strict global-IPv6. Make ONE surgical exception: the *hop* segment of a `/p2p-circuit` address may be **global IPv4 or global IPv6**. Ship one default dual-stack seed relay (domain with A + AAAA records) so a fresh CGNAT'd node reaches the relay pool over IPv4 on first boot — the same trick Tailscale uses shipping a DERP map and Kubo uses shipping bootstrapers. Volunteer nodes with public connectivity (which already serve circuit-relay via ticket 7) add decentralization; the seed is the bootstrap guarantee, not the architecture.

**Why this works where ticket 7 alone doesn't:** ticket 7's auto-relay assumes the node can *reach* a v6 relay. The user's machine has no IPv6 at all — it can only dial v4. Today our own policy (`assertDialable`) rejects `/ip4` seeds, so even an operated dual-stack relay is unreachable by policy (single blocking call site, `adapter.ts` `holdSeed`). Relaxing the hop predicate turns every existing ticket-7 mechanism (reservations, `<seed>/p2p-circuit/p2p/<self>` announces, loss recovery) into a working path for IPv4-only nodes with no operator action.

**Honest cost:** this amends the 9.1/9.5 spec constraint ("/ip4 rejected at every boundary") to "/ip4 permitted ONLY as a circuit hop, only when global." Consensus mechanics (signatures, slots, fork choice) are untouched; the address-shape predicate they consult gets one documented widening — with the precedent of the existing context-gated loopback allowance. At least one operated seed exists at launch → mild centralization at bootstrap, permissionlessly diluted later.

**Runner-up / hedge:** fully operated relay fleet (DERP model). Same code change; more ops burden and lock-in; keep as scaling decision, not architecture. **Rejected:** tunnel brokers (dead/CGNAT-fatal), pure P2P auto-relay with no v4 path (demonstrably fails this machine — it's what we ship today).

---

## The frame (approved at plan gate)

Hard gates: ① zero per-machine signup/config ② dialable by every other node ③ consensus/security semantics preserved ④ no router control assumed.
Weights: universality ×3, decentralization ×3, build cost ×2, privacy ×1, ops ×1.
Note on gate ③: read as "consensus *mechanics* untouched" — any solution that changes which addresses validate touches validation predicates by definition. The minimal-diff form keeps block rules, signatures, and fork choice byte-identical.

## D1 — Candidate screen

*(digests: `d1-r1-tunnels.md`, `d1-r2-production-patterns.md`)*

**Finding 1 (HIGH): automatic IPv6 tunnel brokers are dead or CGNAT-fatal.** SixXS/AICCU (the AYIYA UDP-encap path that DID work behind NAT) shut down ~2018; no maintained client exists (TAYIC site unreachable). HE 6in4 works through double-NAT only when the NAT passes IP protocol 41 with full mapping — "with CGNAT, this wouldn't work" (binaryfury.wann.net, Dec 2023); HE forums consensus: nope, use a VPS. Gate ① and gate ④ both fail even if a broker lived. **Candidates A eliminated.**

**Finding 2 (HIGH, primary): every production system that solved this uses relays, automatically.**
- **Kubo defaults** (config.md, current): `Swarm.RelayClient.Enabled` **default true** — "your node will automatically use public relays from the network if it detects that it cannot be reached… and get a `/p2p-circuit` address"; `Swarm.RelayService.Enabled` **default true** with hard caps (2 min / 128 KiB per connection, 128 reservations, per-IP 8 / per-ASN 32); hole punching default true; AutoNAT service default enabled. IPFS made ticket 7's model a network-wide default years ago — and even ships `Internal.CGNATCheck`, warning CGNAT'd operators that "other peers cannot reach the node directly."
- **Tailscale**: DERP relays at known domains, dialed dual-stack (maps carry both v4 and v6 per relay), automatic when direct fails; peer relays (your own reachable nodes) preferred over operated DERP. A DERP server itself must have direct internet access — relays are never behind NAT.
- **p2p-forge / AutoTLS** (`*.libp2p.direct`): an operated DNS+TLS broker keyed on PeerID with zero signup — but it *amplifies* existing reachability, never creates it. Noted for a future ticket; not the CGNAT answer.

**Finding 3 (HIGH): the "unique global address" already exists at the identity layer.** Circuit-v2 addresses are `/…/p2p-circuit/p2p/<peerID>` — unique, stable, dialable by anyone reaching any hop. The relay spec's own rationale: v1 open relays were "an expensive proposition requiring dedicated hosts," so v2 ships limited relays + reservations for "an army of relays… extreme horizontal scaling." The protocol was *designed* for exactly the volunteer-pool architecture ticket 7 started.

## D2 — Architecture patterns & failure lessons

*(evidence in `d1-r1-tunnels.md`, `d1-r2-production-patterns.md`, `d3-integration.md`)*

1. **Relay hop ≠ consensus address.** DERP maps, IPFS circuit records, and ICE candidates all separate "how I'm reached" (transport detail, mutable, multi-family) from "who I am" (identity). Our invariant "one honest point of network per record" survives by keying on the HOP — which `ip6Slash64` already does for v6; a v4 equivalent (/24 or per-IP cap) is required.
2. **Open relaying failed; limited relaying won.** Spec-sourced (circuit-v2 rationale): unbounded relays → abuse + cost collapse. Kubo's default-on service ships with aggressive caps. Lesson: any relay we operate or accept defaults to kubo-grade limits (`circuitRelayServer()` ships them).
3. **Broker single-points die.** SixXS ran the same "free global addresses, zero config" pitch for a decade and vanished — candidate A's whole lineage is a cautionary tale against dependency on an external address mint. An operated *seed relay* is a weaker dependency (anyone can run one; spec-compatible; our own nodes volunteer) but it must be architecturally optional — dialers should treat the seed list as pool bootstrap, not root of trust.
4. **STUN-only (address-discovery without relays) fails on symmetric NAT/CGNAT** — the ICE lineage discovered this in production; TURN exists because discovery can't fix absence of mapping. Reinforces: no amount of cleverness dials into CGNAT from outside; only a host with its own public address can be dialed and vouch.
5. **Zero-config always ships as default config.** Tailscale ships DERP maps in the client; kubo ships bootstrapers + AutoConf manifests (even fetching updated lists from `conf.ipfs-mainnet.org`). "Zero configuration" has never meant "no defaults" — it means *the software ships the right defaults*. Our answer to gate ① is a built-in seed list at a domain, not magic.

## D3 — Integration reality (code-verified)

*(digest: `d3-integration.md`)*

- Circuit-v2 is **family-agnostic by spec**; reservation/announce machinery from ticket 7 works unchanged with v4 hops.
- **The blocking line exists and is one call:** `holdSeed` → `assertDialable(seed)` rejects `/ip4` seeds — today the user's machine cannot dial even an operated dual-stack relay. Direct-target dials stay strict via the separate guard at the TCP dial path.
- Required change shape (small, additive): ① `isRelayHopDialable` predicate (global v4 OR v6; rejects RFC1918/CGNAT/loopback/link-local/multicast); ② circuit-aware ingest predicate — hop per ①, tail pure `/p2p…` (already the shape), direct addresses unchanged; ③ two call sites in `adapter.ts`; ④ built-in dual-stack seed config; ⑤ v4 anti-abuse keying beside `ip6Slash64`.
- No maintained JS autorelay package exists to adopt — ticket 7's module is the implementation. `@libp2p/autonat` (active, v2 available) can later drive reachability classification for smarter triggering.
- Blast radius on tests: policy table-tests gain rows; consensus-path validation tests need explicit cases proving direct `/ip4` still rejects everywhere and non-global hops reject.

## D4 — Ecosystem health, cost, lock-in

- **Relay direction is the libp2p-endorsed present** (spec Active; Go defaults on; JS packages actively published — autonat shipped 2 days ago). Tunnel-broker ecosystem: extinct. Confidence HIGH.
- **Cost:** a seed relay is an ordinary $5–10/mo VPS class box (operator estimate, not sourced — verify at procurement); limited-relay caps bound volunteer exposure by design (spec rationale: horizontal scaling "without excessive bandwidth costs"). Tailscale's own economics made them *prefer* peer relays over operated DERP — same incentive will favor our volunteers.
- **Lock-in:** seed is a DNS name we control; swapping or diluting it is config, not migration. The wire protocol is the public circuit-v2 spec — interoperable with the entire libp2p relay ecosystem, no proprietary dependency. Reversal cost (dropping v4 hops later) = revert predicate + drop seeds; chain data unaffected if rolled out before records depend on it (records already carry circuit addresses today).

## Verdict matrix

Scores 1–5 (5 best). Weighted total /30 max.

| Candidate | Univ ×3 | Decen ×3 | Build ×2 | Priv ×1 | Ops ×1 | Total |
|---|---|---|---|---|---|---|
| **B — dual-stack relay hop + shipped seed + volunteer pool** | 5 (15) | 4 (12) | 4 (8) | 3 | 3 | **41** |
| C — fully operated DERP-style fleet | 5 (15) | 2 (6) | 4 (8) | 3 | 2 | 34 |
| D — pure P2P autorelay, strict v6-only hops (today) | 1 (3)* | 5 (15) | 5 (10) | 4 | 4 | 32* |
| A — auto IPv6 tunnel broker | 1 (3) | 2 (6) | 1 (2) | 3 | 2 | 16 |

\* D fails hard gate ② for the target machine class — its universality is 1 *for this decision* regardless of how elegant the rest is. It is what ships today and it demonstrably does not dial this user's node.
Privacy note (B/C/D): relay sees metadata, never payloads — libp2p security runs end-to-end across the circuit (spec: endpoints upgrade the relayed connection themselves). Same posture ticket 7 already accepted.

**Pick: B.** **Runner-up: C** (same code; becomes relevant if volunteer supply disappoints — decide at scale, not now). **Hedge on reversibility:** seed list is config; predicate widening is a diff-revert; nothing in chain history depends on the exception existing.

## What "works on every node" concretely looks like

1. Fresh node boots, no env vars, on any network (v6, v4-CGNAT, double-NAT, hostile firewall).
2. Reads built-in seed list (`relay.succinctcoin.example` — A and AAAA records; dialer tries both families like a DERP client).
3. Reserves slots on reachable relays (ticket-7 machinery), announces `<hop>/p2p-circuit/p2p/<self>`.
4. Every other node — v6-only, v4-only via a v4 hop, or both — dials that one unique address. Direct v6 dials still work when possible; auto-relay (ticket 7) still enriches the pool whenever outbound v6 exists.
5. Operator does nothing. Ever.

## Next step (decision for the user)

Amend the spec constraint (9.1/9.5 decision text: "/ip4 rejected at announce/dial/ingest" → circuit-hop carve-out with global-scope requirement + hop-keyed anti-abuse), then ticket it: predicate split, two adapter call sites, seed config + DNS, consensus-path validation tests, v4 /24 keyed bookkeeping.

## Source register

Primary: Kubo config.md (current); libp2p circuit-v2 spec (Active r3); tailscale.com DERP/peer-relay docs; binaryfury.wann.net (Dec 2023) on 6in4-through-NAT; HE forums (2021-22); @libp2p/autonat npm (3.0.32, current). Secondary: chainscorelabs libp2p defaults summary (corroborated by kubo primary). Negative results: TAYIC unreachable; `@chainsafe/libp2p-auto-relay` 404 (npm + GitHub); docs.libp2p.io circuit-relay page extraction failed (spec fetched instead). Code-verified: `address-policy.ts`, `adapter.ts` (2026-10-21). Unverified estimate flagged in D4 (VPS pricing).
