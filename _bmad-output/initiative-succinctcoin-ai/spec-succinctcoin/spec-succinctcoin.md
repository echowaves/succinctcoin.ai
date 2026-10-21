---
id: SPEC-succinctcoin
companions:
  - stack.md
  - registration-design.md
  - testing.md
  - discovery-design.md
  - ../research-equal-node-js-cryptocurrency-architectur/research-equal-node-js-cryptocurrency-architectur.md
  - ../architecture-succinctcoin/architecture-succinctcoin.md
  - ../research-ipv4-only-cgnat-dialability/research-ipv4-only-cgnat-dialability.md
sources:
  - ../brainstorm-bootstrap-free-auto-discovery/brainstorm-bootstrap-free-auto-discovery.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# SuccinctCoin — equal-node JS cryptocurrency

## Why

A vision to realize: a currency whose protocol makes a running node's chance to mine a function of **uptime alone** — no ASIC, no stake advantage, no way to buy more odds. The backdrop is 2026 cost-theory (arXiv:2605.29651): every deployed family (PoW, PoS, proof-of-space) weighs a *parallelizable* resource, which makes N-identity Sybil near-free — so the coin's novel contribution is the **registration economics** (a non-scaling entry/survival cost), not the crypto. Simplicity is a first-class mandate: any developer must be able to read, build, run, and test the whole node. Networking carries two more ambitions: joining the network must never depend on a hardwired peer (CAP-7), and **every node must be dialable from every other — whatever network it sits on** (CAP-8): an IPv4-only machine behind carrier NAT with no router control joins, is reachable, and mines with zero per-machine configuration.

## Capabilities

- **CAP-1** — slot-based mining
  - **intent:** every running node's probability of winning a mining slot is proportional to its uptime alone — independent of CPU/GPU hashrate and of stake — with the per-slot target trivially reachable by commodity hardware.
  - **success:** in a multi-node simulation, a single always-up node wins slots at the expected slot rate regardless of the hardware it runs on, and no node can win a slot without a valid per-slot ticket.
- **CAP-2** — operator identity with non-scaling sybil cost
  - **intent:** a gate-verified person acquires exactly one base identity through a personhood gate; the protocol enforces an acceptance cap (one valid ticket per identity per window) so a second identity is never cheaper than the first, and the mining reward never scales with identity count.
  - **success:** in a multi-identity simulation, N identities of one operator earn no more slot-eligibility throughput than one (enforced by the acceptance cap, not by challenge hardness); the slot winner is verifiable from public data by any node (public-coin draw); a node not selected by the draw cannot win a slot; lapsing re-attestation loses eligibility.
- **CAP-3** — node network
  - **intent:** nodes join via a trusted invitation — an out-of-band multiaddr (QR / SMS / email / copy-paste) verified as a fresh identity-signed announcement backed by recent mining tickets; ticket-seeded discovery (CAP-7) propagates the rest of the network. Direct addressing is global IPv6-only; inbound-blocked and IPv4-only peers are reached through the volunteer circuit-relay v2 tier, whose hop may be global IPv4 or IPv6 (CAP-8 — AutoNAT reachability truth, seeds, DCUtR); blocks and transactions propagate via gossipsub over tcp+noise+yamux.
  - **success:** a node behind a simulated NAT joins from ONE verified invitation, syncs, and gossips a test block to k peers within a bounded time, with no real sockets in CI and nothing preconfigured beyond the invitation.
- **CAP-4** — desktop app
  - **intent:** an Electron shell runs the node in its main process (plain Node) with a React UI for balance, mining status, and network peers.
  - **success:** the packaged app starts a node on a testnet and shows blocks being mined, while the same core package's test suite passes unchanged under a plain-Node runner with no shell.
- **CAP-5** — exact money
  - **intent:** all balances and transactions are exact decimal amounts in integer base units (big.js); the fee is amount × rate computed exactly once per transaction.
  - **success:** property tests assert conservation of supply, no-negative-balance, and fee invariants over long random transaction sequences, and no float artifact (e.g. `0.1+0.2` drift) ever appears in a persisted balance.
- **CAP-6** — testable in plain Node
  - **intent:** the core's full test suite (unit + property) runs with a plain-Node runner, no desktop shell, and no real network sockets.
  - **success:** CI runs the entire core suite headless in a bare Node environment, with all libp2p-dependent tests on the in-process memory transport.
- **CAP-7** — ticket-seeded bootstrap-free discovery
  - **intent:** a node joining with zero preconfigured peers discovers the network automatically on LAN and internet; presence is proven by artifacts the chain already receives — mining tickets are signed liveness proofs, so forging presence costs mining work — and every learned address is a hint until verified through independent corroboration; no single channel is load-bearing (mechanism: `discovery-design.md`).
  - **success:** Amnesiac Boot Proof — a wiped node with empty config re-enters from ONE block-grade artifact obtained via any non-peer channel (a human-channel invitation qualifies) and reaches ≥ k healthy peers across distinct /64s within 30 s on LAN and NATed-internet testnets; injected forged or hint-grade records never produce a dial or a re-gossip.
- **CAP-8** — universal dialability
  - **intent:** any node — including one with no IPv6 at all, behind carrier-grade NAT, with no router control and zero per-machine configuration — is dialable by every other node at one identity-scoped address (`/…/p2p-circuit/p2p/<peerID>`) whose relay hop may be global IPv4 or global IPv6; relays are dialed family-agnostically from a shipped dual-stack seed list plus discovered volunteers (evidence and change-shape: CGNAT research companion).
  - **success:** Honest Boot Proof — a test fixture with NO global IPv6 (v4-only, CGNAT-shaped) boots with default config, obtains a circuit address through a dual-stack-capable relay, and a v6-only node dials that address and round-trips data; the same proof passes unchanged for a dual-stack node; nothing preconfigured beyond shipped defaults.

## Constraints

- One language for core + shell + tests (JS/TS); building, running, or testing the core must not require any second language's toolchain.
- big.js records all money; js-libp2p provides networking, discovery, and bootstrap (user-mandated, not a choice).
- Addressing law (amended 2026-10-21 for CAP-8): DIRECT addresses are global IPv6 unicast only at listen/announce/dial/ingest — `/ip4` direct is rejected everywhere with SC-NET-1. A `/p2p-circuit` address is valid iff its HOP segment is a **global-scope** `/ip4` or `/ip6` (RFC1918, CGNAT `100.64.0.0/10`, loopback, link-local, ULA, multicast, and zones rejected at every boundary) and the remainder carries no IP components; the exception lives in ONE predicate module and touches only address-shape validators and their dial call sites — block rules, signatures, slot math, and fork choice are byte-identical.
- Relay anti-abuse keys on the HOP network: a relayed entry counts one point of network per relay `/64` (v6) or per-IP/`/24` (v4); relay service limits stay the kubo-grade `circuitRelayServer()` defaults (duration/data caps, per-IP/per-ASN reservations). Discovery diversity is measured in /64 prefixes (direct) and hop networks (relayed).
- Registration/survival cost is enforced by plain protocol rules: an acceptance cap (one valid ticket per identity per window), tickets windowed in **chain-time**, a periodic re-attestation, and a slot reward that never scales with identity count. Money, compute, and storage are structurally disqualified as cost bases (C(s,T)=o(sT), arXiv:2605.29651 — motivation for this constraint, not a load-bearing dependency).
- No VDF anywhere as a time anchor (Ethereum abandoned its Minroot-VDF plan after a discovered attack); long-range anchoring is PoW-like accumulated work.
- The per-PoW-attempt path must not call big.js `times` (~1000× slower than `plus`, measured) nor pure-JS keccak (~35× slower than native sha256, measured); node:crypto sha256 + plain integer counter only.
- The node core (libp2p + consensus + ledger + chain store) is a pure Node package with zero UI imports; only the shell imports electron.
- Discovery state is chain data: announcements expire by slot count, re-announce on block-applied events, and roll back with reorgs — no wall-clock expiry or clocks anywhere in discovery (AD-3 native).
- Verify-before-connect: no single channel is ever trusted for reachability; sub-block-grade records need independent corroboration before dialing or re-gossiping, and a poisoned hint must fail soft — never fork trust.

## Non-goals

- No DHT at launch — invitation join + peer-book exchange; mDNS retained only behind an opt-in flag for LAN dev (its IPv4 multicast is middlebox-hostile); Kad-DHT deferred until the network outgrows them.
- The project operates no discovery or registry infrastructure — no seed, registry, or rendezvous endpoints it runs (kills the bootstrap SPOF at the operational layer too). Narrowed 2026-10-21: the project MAY operate ONE bootstrap relay as pool bootstrap — never a trust root; the built-in seed list must stay architecturally optional (seeds absent or dead degrades exactly to epic-10 behavior), and volunteer dilution is the goal.
- No browser-runtime node (the node is a Node.js process; browser transports are not in scope).
- No proof-of-space.
- No EVM-compatible execution layer.
- No merge-mining / proof-of-authority.

## Success signal

In a multi-node simulation over the in-process transport, slot odds track uptime alone: an operator running N identities wins no more than the acceptance cap allows, while a distinct operator running N gate-verified persons wins ~N×; and every slot winner is verifiable from public data — a node not selected by the draw cannot win a slot. And the core's full test suite passes in plain-Node CI with no shell and no sockets.

## Assumptions

- TypeScript + Vitest + pnpm + Node 24 toolchain (settled by two independent production JS consensus clients, Lodestar and EthereumJS).
- Small community scale at launch (10 → few thousand mostly-stable nodes); invitation join + peer-book crawl suffice at that size.
- Block metadata can carry small announcement records without breaking block-size or validation budgets — verify by measurement at build time; the proto change runs the PROTO_OK gate.
- The CAP-8 hop exception touches only address-shape predicates and their call sites (research D3: one blocking seed dial + circuit-aware validators); consensus-path rows pin that direct `/ip4` still rejects in candidates, apply-block, and introductions.

## Open Questions

- At what node count do invitation join + peer-book crawl stop sufficing and Kad-DHT become warranted? (Resolve by memory-transport simulation, or adopt DHT day-one for the "always works" story.)
- Personhood gate: dual gate at launch (biometric + social graph) is the recommended config after the attack pass (a cheap weak gate is the sybil faucet — gates are addable only by protocol upgrade, never auto-valid). Residual: which two gates, and the re-attestation cadence K.
- τ-erosion: AI-solver throughput trend is unknown (the BPC paper's 97–100%-yet-throughput-bounded result is a snapshot, not a trend line); challenge-family rotation cadence is undecided.
- Gate uniqueness: the #1 external trust is the personhood gate (iris fakery, colluding vouching clusters); the dual-gate config and re-attestation bound the damage, but gate-specific attack research is per-gate, not protocol-level.
- Address rotation / privacy policy for announced multiaddrs: on-chain presence is linkable; one-identity-many-addresses dedupe exists, but the rotation cadence is undecided.
- Relay volunteers + seed supply: what makes volunteers run dual-stack relays, and how does a v4-only node discover relays beyond the built-in seed list (chain announcements can carry v4-hop circuit addresses; gossip advertisement stays parked)? Seed-domain ownership and DNS ops are a hitl ticket in epic 11. The seed-supply call itself (project operates ONE bootstrap relay) was made autonomously 2026-10-21 while the user was absent — confirm or amend on review.
