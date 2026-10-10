---
type: epic
title: "Node network: libp2p adapter, gossipsub topics, discovery, relay, sync"
parent: initiative-succinctcoin-ai
covers: ["CAP-3"]
after: []
assignee: ""
risk: high
estimate: ""
estimate_basis: ""
---

# Node network: libp2p adapter, gossipsub topics, discovery, relay, sync

## Description

Implement `core/net`: the libp2p adapter over tcp+noise+yamux, gossipsub topics (one per message class: blocks, tx, tickets, peer info), discovery via the genesis bootstrap list + mDNS (LAN), NAT traversal via circuit-relay-v2, and chain sync. The adapter plugs into the core's `net` port; the same code runs on the memory transport in CI. The DHT-threshold question is settled by a spike (deferred by the spine, not an architecture branch).

## Outcome

For the team: a node behind a simulated NAT discovers peers, syncs, and gossips a test block to k peers within a bounded time, with no real sockets in CI — so the node is genuinely networked and the network layer is proven headless.

## Requirements

Reuses the parent's id; the epic adds lines for relay traversal and the DHT-threshold spike.

- R1 (CAP-3) — nodes join via a static bootstrap list (genesis) and mDNS (LAN), propagate blocks and transactions via gossipsub over tcp+noise+yamux.
- R2 (CAP-3) — a node behind a simulated NAT discovers peers, syncs, and gossips a test block to k peers within a bounded time, with no real sockets in CI.
- R3 (AD-8) — protocol messages use protobuf (protons); one stable topic per message class (blocks, tx, tickets, gossip); amounts travel as decimal strings, IDs as 32-byte hex.
- E1 (relay) — home NAT traversal via circuit-relay-v2; if no community relay is assumed available at launch, early NATed nodes fall back to WebSockets outbound (spine Deferred `[ASSUMPTION]`).
- E2 (DHT spike) — a spike settles the DHT threshold: at what node count do bootstrap+mDNS stop sufficing and Kad-DHT become warranted (memory-transport simulation, or adopt DHT day-one for the "always works" story).

## Done when

- A node behind a simulated NAT discovers peers, syncs, and gossips a test block to k peers within a bounded time, with no real sockets in CI (memory transport).
- A block authored by one node propagates via gossipsub to k peers; a ticket and a tx propagate on their own topics.
- The circuit-relay-v2 adapter connects a NATed node through a relay (simulated relay in CI).
- The DHT-threshold spike's recommendation is recorded in the epic Notes; Kad-DHT is NOT wired at launch unless the spike says so (the no-DHT non-goal holds by default).
- `@libp2p/memory` runs the full net suite headless; zero real sockets in CI.

## Boundaries

The node-network capability: `core/net` libp2p adapter, gossipsub topics, discovery (bootstrap + mDNS), relay traversal, and sync. It does NOT implement the block/tx/ticket semantics (epics 2/3/4 — it propagates their validated messages), the ledger, or the shell. Non-goals: no DHT at launch (spike decides the threshold), no browser-runtime node.

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, section Requirements
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections AD-8, AD-10, AD-12, Operational Envelope, Stack
- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section CAP-3
- stack — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/stack.md`
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`

## Notes

- Decision: 2026-10-09 (inception) — **Tracer bullet = entry 5** (block propagation over gossipsub + a fresh node receives the next block): the thinnest path through every layer the epic touches — the memory-transport adapter (1), the protobuf envelopes + topics (2), discovery (3), sync (4), and the live mine→publish→validate→apply loop with 3.2's slot loop + 4.2's signed ticket + 4.3's acceptance path + 4.4/4.5's accepted-set construction. Whatever runs when it is done: three in-process nodes over `@libp2p/memory` where one node's mined block lands in the other two stores and a late joiner catches the next block — headless, zero real sockets (AD-10).
- Decision: 2026-10-09 (inception) — **Sequencing** (build order = tickets.toml table order): 1 deps + adapter scaffold (contracts early: the 1.2 NetPort implemented over memory) → 2 topics + proto envelopes (the one proto change in the epic — 3/4/6/7 consume it; 9/10 assert PROTO_OK) → 3 discovery (bootstrap + mDNS) → 4 sync (the least-certain capability, placed right after its prerequisites per the split guidance) → 5 tracer bullet (the live loop) → 6 ticket/tx own-topic propagation → {7 relay ∥ 8 DHT spike} (the only concurrently-runnable pair; the spike is test-only and shares no code with the relay) → 9 refactor sweep (after all capability work; the OPEN deferred u64be/BE-reader DRY may land here if the survey finds a clean seam) → 10 closing end-to-end suite (TEST-ONLY, the 3.9/4.10 precedent, after the sweep).
- Decision: 2026-10-09 (inception) — **Deferred scope**: no DHT at launch unless entry 8's spike says so (the no-DHT non-goal holds by default — the recommendation is a dated Note, not wiring); no browser-runtime node; the relay's WebSocket-outbound fallback (the spine [ASSUMPTION]) is present as a code path, not exercised in CI; the real tcp/mdns/circuit-relay services are pinned and wired but CI exercises the memory transport only (AD-10); tx verification against the ledger (a real verified-Tx path) is OUT of this epic's Done-when — 6 holds gossiped txs for the ledger path and the verified-Tx ledger path is a follow-up (it needs the BlockTx view seam from 3.6, which epic 5's sync does not re-verify per-tx).
- Open question (spike here): the DHT threshold — bootstrap+mDNS vs Kad-DHT day-one. Deferred by the spine; the spike's answer is recorded in Notes, not wired unless it says so.
- Waits on epic 1 because: it needs the libp2p adapter scaffold and the memory transport wired into the harness (AD-10).
- Waits on epic 3 because: it needs working blocks (from the mining loop) to propagate.
- Waits on epic 4 because: it needs valid tickets + verified identity for block authorship to propagate meaningfully.
- Assumption: at least one community-run circuit-relay-v2 node exists at launch; if not, early NATed nodes fall back to WebSockets outbound (same libp2p stack, no core change).
