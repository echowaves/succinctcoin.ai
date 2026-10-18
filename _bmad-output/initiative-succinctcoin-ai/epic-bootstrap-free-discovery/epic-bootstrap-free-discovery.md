---
type: epic
title: "Ticket-seeded bootstrap-free discovery"
parent: initiative-succinctcoin-ai
covers: ["CAP-7", "CAP-3"]
after: []
assignee: ""
risk: high
estimate: "6 stories, S–L"
estimate_basis: "One proto addition + one consensus-visible block-field change (digest/golden-vector churn — the L), two pure core modules with property rows, app boot-ladder wiring on the shipped 7.2 seam, and a closing hitl device proof; presence mechanics reuse existing ticket/signing/gossip seams rather than inventing them."
---

# Ticket-seeded bootstrap-free discovery

## Description

Joining the network must never depend on a hardwired peer. Epic 7 made the bootstrap list *optional* (empty = LAN-only, tcp + mDNS shipped); this epic makes it *unnecessary anywhere*: presence proofs the chain already receives — mining tickets are identity-signed liveness attestations whose forgery costs mining work — become the discovery substrate. Signed `PeerAnnouncement` records anchor in blocks (winners and ticket submitters publish theirs), an address book ranks every learned record by source class (block > log > DNS > hint) with chain-time expiry, and hint-grade addresses require independent introductions before a dial. The done-when invariant is the **Amnesiac Boot Proof**: a wiped node with empty config re-enters from ONE block-grade artifact and reaches healthy peers across distinct /24s within 30 s. The project operates no discovery infrastructure of its own — the single point of failure dies by plurality plus verification, not abstinence. Requirement source: `spec-succinctcoin` CAP-7 + amended CAP-3; mechanism companion `discovery-design.md`.

## Outcome

A node with factory-empty configuration joins the network on a LAN or the open internet, trusts only what it can verify, and fails soft to hints it never dials — while every install is a distinct identity, so presence means *someone is there right now*.

## Requirements

- R1 — a node joins with ZERO preconfigured peers on LAN and internet; the genesis bootstrap list is an optional hint source, never required (amended CAP-3).
- R2 — presence is proven at mining cost: signed `PeerAnnouncement` records anchored in blocks (winners + ticket submitters publish theirs), reorg-safe, expiring by slot range, no wall clocks anywhere (AD-3).
- R3 — hints verify before connect: source-classed address book (block > log > DNS > hint); hint-grade becomes dial-eligible only after ≥3 independent signed introductions; forged/expired records are never dialed and never re-gossiped.
- R4 — distinct installs have distinct identities (per-install seed — the CAP-7 prerequisite reversing deferred-work 6.2(3)); the project operates NO discovery infrastructure and ships no hardwired endpoints.
- E1 (AD-3) — all discovery timing is chain-time (slot ranges, block-driven re-announce, slot-budgeted tests).
- E2 (AD-10) — every test runs headless on the memory transport / plain Node; real multicast stays in smoke harnesses.
- E3 (AD-11) — announcement and introduction signing lives where keys live (core/main); nothing key-shaped crosses to the renderer.

## Done when

1. **Amnesiac Boot Proof green in CI:** wiped node + ONE block-grade record → ≥ k healthy peers across distinct /24s within a bounded slot budget, simulated LAN + NATed variants on memory transport.
2. Poison rows prove forged/expired/hint-grade records never produce a dial or a re-gossip; three-introductions gating is exact.
3. Announcements expire by slot range and roll back with reorgs (book ingestion keyed to originating blocks); a source scan shows no wall-clock use in discovery paths.
4. Two fresh installs derive distinct identities, stable across restarts.
5. Repo lint fails on hardwired multiaddrs/seed endpoints outside test fixtures — the anti-seed immune system runs in CI.
6. Full suites green headless (AD-10) and PROTO_OK holds after regeneration.

## Boundaries

- The genesis bootstrap list stays *valid input* (hints), never required; no code path may make it load-bearing.
- Announcements are consensus block data: included in the canonical block digest, version-bumped once (`protocolVersion`), reorg-consistent — no off-chain address state that can desync.
- The project ships and operates nothing: no seed/relay/registry endpoints; volunteer/community tiers stay out of scope (non-goal).
- Parked tiers stay parked (UDP Hello Packet, CT-log, mega-DHT rendezvous, `.scsnap` chain bundles, radio) — this epic is the MVP ladder only.
- AD-1/AD-9/AD-11 seams unchanged: discovery state reaches the UI through events/read-API only.

## References

- `../spec-succinctcoin/spec-succinctcoin.md` — CAP-7 (requirement source), amended CAP-3, non-goal "no operated discovery infrastructure".
- `../spec-succinctcoin/discovery-design.md` — mechanism: announcement records, trust taxonomy, three-introductions, fallback ladder, swarm rules, verification testbeds, parked tiers.
- `../architecture-succinctcoin/architecture-succinctcoin.md` — AD-3 (chain-time), AD-8 (topics), AD-10 (headless), AD-11 (keys), AD-12 (proto/canonical digests); PROTO_OK convention.
- `../deferred-work.md` — 6.2(3) identity seed (reversed by user go-ahead 2026-10-17, scheduled as 8.1); OPEN 2026-10-17 shared-seed entry.
- `../epic-real-network/evidence-two-process-smoke.md` — the shipped mDNS/tcp baseline this epic extends.

## Notes

- **Tracer bullet:** 8.3 is the thinnest path through every layer the epic touches (proto → consensus block validation → node loop → two zero-address nodes seeing each other's presence over memory transport). Everything after it widens; nothing new appears after 8.5 except proof.
- **Sequencing decisions:** 8.1 leads because per-install identity is a prerequisite for presence to mean anything (and the user go-ahead of 2026-10-17 ratified reversing deferred-work 6.2(3) — 8.1's build resolves that OPEN entry and the spec's CAP-7-prerequisite open question). 8.2 is the contract-first slice so 8.3/8.4 share one generated type + validator. The epic gates on 7.1/7.2 via 8.5's `after` (the boot ladder wires onto the boot path they established), NOT on pending hitl 7.3 — whose LAN observation is partially superseded by 8.6's device proof; 7.3 stays open for its own evidence value.
- **MVP artifact decision (autonomous, from set-check):** fallback rung 3 ships as *one block-grade announcement record read from a local file* (exactly what the Amnesiac Boot Proof consumes); full chain-snapshot import (`.scsnap`) stays parked per discovery-design. Spec open question "MVP tier boundary" remains open for post-epic revision with field evidence.
- **Decision: no closing refactor sweep** — every entry builds young code (weeks old, epic 3–7 vintage) and the epic adds two small new modules; cleanup rides the next epic's sweep unless reviews surface otherwise.
- Coverage note from the set check (applied): announcement gossip/relay is owned by 8.3 (verify-before-relay rows); introduction signing/gossip by 8.4 (hints would be inert without a producer); reorg retraction of book records by 8.4.
