---
type: epic
title: "IPv6-only + invitation join + scored peer-book"
parent: initiative-succinctcoin-ai
covers: ["CAP-3", "CAP-7"]
after: []
assignee: ""
risk: medium
estimate: "5 stories + 1 re-scoped hitl proof, S–M"
estimate_basis: "No new consensus surface: addressing policy is a listen/filter change with test migration; the invitation reuses 8.2's signed announcement + validator; one small proto addition (peerbook) on the established sync-stream pattern; scoring is a pure local module. The risk concentrates in real-world IPv6 inbound reachability, deferred to the hitl proof."
---

# IPv6-only + invitation join + scored peer-book

## Description

Field evidence (two-Mac proof, 2026-10-18): middleboxes in real LANs — Norton-class content filters, AP isolation — drop the IPv4 multicast `@libp2p/mdns` is built on (udp4 / 224.0.0.251 only by construction), so zero-config discovery cannot be load-bearing for a currency's join path. The ratified course correction (`../change-ipv6-invitation-join/`) makes joining an act of trust: a trusted party shares its IPv6 address out-of-band (QR / SMS / email / copy-paste); the invitee verifies it as a fresh, ticket-backed signed announcement, dials, then fills its view of the network recursively from that node — up to 100 entries — ranked by a local reliability score. Addressing becomes IPv6-only end to end: one address family, no NAT for inbound (open the port, be dialable), and macOS rotating privacy addresses absorbed by chain-time re-announce. Requirement source: `spec-succinctcoin` amended CAP-3 + IPv6 constraint + CAP-7 (/64 metric); mechanism companion `discovery-design.md`.

## Outcome

A person joins by pasting (or scanning) one line a friend sent them — no infrastructure, no multicast, no luck — and within moments holds a scored book of up to 100 verified IPv6 peers; every record in it arrived through a channel the node can verify, and nothing it merely heard about is ever dialed.

## Requirements

- R1 — IPv6-only addressing: listen `/ip6/::/tcp/<port>`; announce/dial/ingest accept global `/ip6` only — IPv4, link-local `fe80::`, loopback filtered at every book boundary; mDNS behind an opt-in flag, default off; discovery diversity measured in /64s.
- R2 — invitation join: a fresh identity-signed announcement backed by recent mining tickets renders as copy-paste text (and QR where the UI allows) and verifies (signature + chain-time freshness + ticket liveness) before first dial; boot accepts an invite file beside `bootstrap.txt`.
- R3 — recursive fill: `/succinctcoin/peerbook/1` request/response stream (proto, PROTO_OK); BFS crawl depth ≤ 3, concurrency ≤ 8, 2 s dial budget, book cap 100; at-cap eviction preserves /64 diversity.
- R4 — reliability score is local and selection-only (dial order, re-share top-K, eviction): dial-success EWMA, seen-across-slots stability, served-data validity, corroboration count, latency; a score never grants connect-eligibility or validation trust.
- E1 (AD-3) — invite freshness and score stability use chain-time slot parameters, no wall clocks.
- E2 (AD-10) — all tests headless on memory transport / plain Node; real-device observation stays in the hitl proof + probe scripts.
- E3 (AD-11) — invitation signing uses core-held keys; the renderer receives only the rendered invite string, never key material.

## Done when

1. Amnesiac Invite Boot Proof green in CI: wiped node + ONE verified invitation → ≥ k healthy peers across distinct /64s within a bounded slot budget, book ≤ 100, simulated on memory transport.
2. Invite verification rows: forged signature, expired slot range, and ticket-less (squatter) identities all refuse the dial; a valid invite joins.
3. Crawl respects depth/fanout/cap exactly (memory-transport test with a synthetic mesh); peerbook responses serve top-scored fresh records only.
4. Score property rows: monotonically better history ⇒ higher selection rank; low score never removes connect-eligibility of a block-grade record, high score never grants it to hint-grade.
5. Repo lint fails on `/ip4` multiaddrs outside test fixtures (extends the 8.5 anti-seed lint); mDNS default-off pinned by a boot-config scan.
6. Full suites green headless (AD-10); PROTO_OK after peerbook regeneration.

## Boundaries

- IPv4 stays *parseable* at the multiaddr layer (the library's job) but is **unsupported**: every book/dial boundary rejects it with a clear error naming the parked relay tier as the future path — no dual-stack fallback; memory-transport `/memory/...` addresses are unaffected fixtures.
- The `bootstrap.txt` seam survives as the CLI/headless sibling of the invitation (dev + recovery tool); genesis bootstrap list remains valid optional input.
- No QR *scanner* — rendering only; no new UI framework work beyond the invite affordances.
- Relay escape hatch for IPv4-only networks stays parked (spec open question); this epic ships none.
- mDNS code stays shipped behind its flag — deleting it is not in scope.

## References

- `../change-ipv6-invitation-join/change-ipv6-invitation-join.md` — the approved course-correction proposal (research, prior art, risks).
- `../spec-succinctcoin/spec-succinctcoin.md` — amended CAP-3, IPv6 constraint, CAP-7 (/64 metric).
- `../spec-succinctcoin/discovery-design.md` — invite rung 0, peer-book exchange & crawl, reliability scoring.
- `../architecture-succinctcoin/architecture-succinctcoin.md` — AD-3/AD-8/AD-10/AD-11/AD-12; PROTO_OK convention.
- `../epic-real-network/dial-manual.mjs` + `mdns-smoke.mjs` — probe harnesses the pivot retires/adapts.

## Notes

- **Tracer bullet:** 9.1 is the addressing policy itself — after it every later story lives in the v6 world, and its test migration surfaces the full blast radius early.
- **Sequencing decisions:** 9.2 (invite render/verify) before 9.3 (crawl consumes verified records + serves them); 9.4 scores what 9.3's crawl and re-share consume; 9.5 is proof + docs only. The hitl device proof rides re-scoped 8.6.
- **Honest risk register:** routers default-drop inbound v6 (inviter must allow the port — boot dials a self-reachability check); IPv4-only networks cannot join until the parked relay tier; middlebox behavior on unicast v6 untested until 8.6 runs.
