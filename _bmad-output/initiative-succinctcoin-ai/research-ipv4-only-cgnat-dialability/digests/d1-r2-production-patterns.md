# D1 Round 2 — Production wildcard: what systems that SOLVED this actually do

Date: 2026-07-16 · Dimension: D1 (candidate screen) · Round: 2 (production patterns: Tailscale DERP, IPFS/kubo, libp2p defaults)

## Sources used

1. **Tailscale KB 1118 — "Custom DERP" / DERP overview** (tailscale.com, fetched current) — primary vendor doc
2. **Kubo config.md** (github.com/ipfs/kubo/blob/master/docs/config.md, fetched current, last commit ~June 2026) — PRIMARY for IPFS/libp2p defaults
3. **Tailscale DERP docs**: DERP requires direct internet access; peer relays preferred over operated DERP
4. **@libp2p/autonat npm** (3.0.32, published 2 days ago) — ACTIVE JS package; AutoNAT v2 (`@libp2p/autonat-v2`) recommended
5. chainscorelabs.com summary (secondary): libp2p AutoRelay default-on in modern stacks

## Headline claim for this round (HIGH confidence, multi-source primary)

**Every production system that solved "dialable despite NAT/CGNAT/no-v6" uses a RELAY reachable at a well-known public address, and makes relay usage AUTOMATIC (zero per-node config).** None of them solves it by giving the private node its own globally routable address.

### Evidence — Kubo (IPFS reference implementation), current defaults (primary: config.md)

- `Swarm.RelayClient.Enabled` — **Default: `true`**. Doc wording: "Your node will automatically use public relays from the network if it detects that it cannot be reached from the public internet (e.g., it's behind a firewall) and get a `/p2p-circuit` address from a public relay."
  → Zero-config, automatic, dynamic discovery of Circuit Relay v2 servers. This is EXACTLY the ticket-7 model — and IPFS turned it ON by default years ago.
- `Swarm.RelayService.Enabled` — **Default: `true`** (kubo ≥ ~0.32). Every publicly reachable node serves limited circuit-relay v2 to others, with built-in abuse limits:
  - `ConnectionDurationLimit` 2m, `ConnectionDataLimit` 128 KiB per direction, `ReservationTTL` 1h, `MaxReservations` 128, `MaxCircuits` 16/peer, `BufferSize` 2048
  - Anti-abuse: `MaxReservationsPerIP` 8, `MaxReservationsPerASN` 32
  → The swarm-wide relay POOL is sustained by default-on limited relaying from every public node. No central operator required.
- `Swarm.EnableHolePunching` — **Default: `true`**. Relay-coordinated DCUtR upgrade to direct where possible; "requires Swarm.RelayClient.Enabled = true".
  → Relays are not just a fallback pipe; they are the rendezvous mechanism for hole-punching upgrades.
- `AutoNAT.ServiceMode` — **Default: enabled**. Publicly dialable nodes run AutoNAT v1+v2 service so private nodes can learn their reachability ("helps other nodes determine if they're publicly reachable"). Throttled 30/min, 3/peer.
  → Reachability PROBING is also a default-on, swarm-shared service.
- `Internal.CGNATCheck` — **Default: true**. Kubo explicitly detects RFC 6598 CGNAT / double-NAT and warns the operator that "other peers cannot reach the node directly". `ipfs swarm addrs autonat` reports a `nat` field classification.
  → Even the reference implementation treats "behind CGNAT = not directly reachable, relay is the answer" as settled fact.
- `Addresses.NoAnnounce` / `Swarm.AddrFilters` (server profile) — publish-side vs dial-side split; filters per IANA special-purpose registry. Our v6-only policy is the same pattern, more aggressive.
- **AutoTLS / p2p-forge** (`*.libp2p.direct`, public good run by Interplanetary Shipyard): publicly reachable nodes AUTO-GET a wildcard TLS cert + DNS name encoding their IP (`1-2-3-4.{peerid}.libp2p.direct` resolves to 1.2.3.4, resolved locally without DNS I/O), enabling browser Secure Context connections with zero manual domain setup. Registration proves PeerID key ownership + dialability before issuance (ACME DNS-01 broker).
  → IMPORTANT PATTERN: an operated DNS/TLS broker keyed on peer identity, fully automatic, zero signup. BUT it requires the node to be publicly dialable first — it AMPLIFIES reachability, does not CREATE it. Not a CGNAT solution by itself; a strong candidate pattern for our v6/dual-stack story later.

### Evidence — Tailscale (primary: tailscale.com KB/docs)

- DERP = operated encrypted relays; the fallback when direct WireGuard connections fail. Clients dial DERP over ports 443/80/3478 + ICMP — i.e., DERP endpoints must have DIRECT internet access; a DERP server cannot itself be behind NAT.
- DERP map nodes carry BOTH IPv4 and IPv6 addresses; clients use whichever works (dual-stack dialing of the relay hop). ← direct precedent for candidate (B): relay hop dual-stack, tunnel/payload stays v6.
- Peer Relays (2025): users' own high-throughput tailnet nodes can act as relays when direct fails — preferred over DERP for latency/egress cost. ← same shape as our ticket-7 auto-relay, in a shipped product.
- Self-hosted derper exists but is documented as "advanced operation requiring significant resources" and needs a domain + open ports.

## Synthesis for D1

- The industry answer to "must be dialable, network gives me nothing" is unambiguous: **automatic circuit relay through the swarm (IPFS) or operated relays at known addresses (Tailscale)** — never an address assigned to the private node itself.
- IPFS shows a RELAY POOL can be default-on and decentralized IF: (1) every public node offers limited relay by default with hard resource caps, (2) clients discover relays dynamically via the DHT/identify, (3) reservations are per-IP/ASN-capped. Our ticket 7 is the minimal version of this; what we LACK vs kubo is a discovery path for nodes with NO IPv6 at all (their relay candidates must be dialable over something they have — v4).
- Tailscale shows the OPERATED variant: relays at domain names, dual-stack dialed, zero client config. Cost: egress money + operator dependency; mitigated by peer-relay preference.
- Nobody has a trick that hands a CGNAT'd, no-v6 host a unique global address without some third party (tunnel broker = dead, see d1-r1; relay = alive and default-on).

## Candidate impact

- (A) Tunnel brokers: dead end for CGNAT (d1-r1) — production systems confirm nobody builds on this.
- (B) Dual-stack relay hop (v4-dialable relay, v6-only above): EXACTLY the DERP model; strong.
- (C) Operated VPS relay: the DERP model itself; universality 5/5, cost/lock-in are the trade.
- (D) Peer-volunteer relay pool à la kubo: default-on limited relay + discovery; needs a v4 dial path for no-v6 nodes to join it → converges with (B)/(C).

## Open questions → next rounds

1. D3: js-libp2p — can the circuit-relay-v2 transport dial `/ip4` relay candidates while our policy keeps announce/ingest v6-only? Where exactly do our validators fire? (@chainsafe/libp2p-auto-relay exists? verify)
2. D4: who operates public circuit-relay-v2 servers today (are there permissionless public relays like IPFS's pool), and VPS cost envelope.
3. p2p-forge-style auto-DNS pattern — worth a later ticket for v6 nodes (cert + hostname, zero signup); out of scope for the CGNAT problem but note it.
