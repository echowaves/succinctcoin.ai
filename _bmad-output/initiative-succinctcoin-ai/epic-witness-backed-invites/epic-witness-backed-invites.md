---
type: epic
title: "Witness-backed invitations: a texted invite that survives the inviter sleeping"
parent: initiative-succinctcoin-ai
covers: ["CAP-3", "CAP-7"]
after: []
assignee: ""
risk: high
---

# Witness-backed invitations: a texted invite that survives the inviter sleeping

## Description

`scinvite:v1` carries exactly one signed address, so an invitation dies the moment the inviter sleeps — the same ticket-liveness gate that makes stale invites worthless to squatters makes them worthless to friends. This epic builds `scinvite:v2`: the text message additionally carries backup relay candidates, each backed by signed, slot-expiring reachability witnesses, verified behind a k-of-n distinct-signer floor before any candidate is dialed, propagated over the existing announcement gossip so backup knowledge renews from the network instead of aging out of one text. Requirement source: `../spec-scinvite-v2/spec-scinvite-v2.md` (WB-1…WB-6), stage T-B + T-C of `change-ledger-dials`, accepted 2026-11-04.

## Outcome

A fresh node behind CGNAT redeems an `scinvite:v2` whose inviter is offline at redemption and connects through a witnessed backup within seconds — demonstrated headless in CI as a three-node proof; the invitation becomes a seed node you can hold in your pocket: signed, expiring, self-renewing.

## Requirements

- WB-1 — v2 envelope: `scinvite:v2:` one-line text carries the primary announcement (the v1 record verbatim) plus zero or more witnessed backup candidates; copy-paste-tolerant parse; a v1 parser rejects v2 by prefix, never as corruption. (CAP-7 join surface, CAP-3 addressing law)
- WB-2 — witness issuance: `ReachabilityWitness(target identity, address, chainId, firstSeenSlot, expirySlot)` signed by the issuer's identity key; bounded per window, always declinable. (CAP-7 trust channel)
- WB-3 — verification floor: primary verifies exactly as v1; a backup candidate is trusted only with ≥ k=2 distinct-signer, unexpired witnesses spanning the diversity floor; direct-first dial order is law; CAP-8 governs candidate hop addresses, CAP-9 keeps local addresses out. (CAP-3, CAP-7)
- WB-4 — witness propagation: fresh witnesses ride the existing windowed announcement exchange as additive fields; zero new wire protocols; older nodes ignore them without validation change. (CAP-3)
- WB-5 — live-lease UX: the panel presents the invite as a lease, not a permalink — stale-when-offline copy, backup count only when non-zero, refresh via `SelfInviteUpdated`, no polling. (CAP-7 on the CAP-4 app)
- WB-6 — witness-grade ingest: verified witnesses enter the address book above hints, below invitation/block; verify-before-connect, always. (CAP-3)

## Done when

1. Success-signal proof green in CI: three-node headless under `SUCCINCTCOIN_ALLOW_LOOPBACK=1` — inviter offline at redemption, fresh node connects through a witnessed backup and gossips onward; negative pairs (witness-less bundle, expired bundle) dial nothing.
2. Property rows reject single-witness bundles, expired witnesses, duplicate signers, and same-/64 clusters; primary verification is byte-identical to v1's three gates.
3. Golden vectors: v2 round-trip inside a hard length cap; the v1 codec and `verifyInvite` unchanged from pre-change fixtures; a v1 parser rejects the v2 prefix cleanly.
4. Gossip row: C learns a witnessed address of B via A alone with no direct C–B dial; older-node compatibility rows green (additive fields ignored, validation unchanged); PROTO_OK after regeneration.
5. Book grade order pinned (hints < witness < invite < block) with verify-before-connect; renderer rows: stale-when-offline copy present, backup-count line absent at zero, `RENDERER_NO_POLL` holds.
6. Full root + app suites green headless (AD-10).

## Boundaries

One lane through core discovery (`invitation.ts`, witness module, book ingest, announcement exchange) and the app invite surface. Not: the chain-anchored relay registry (T-D) or receipts/rewards (T-E) — RFC/spec tracks per the acceptance record; no new transports, DHT, QR, or push; no change to `MAX_AUTO_RELAYS`, relay serving, AutoNAT, or DCUtR; no witness reputation, scoring, or slashing; witness data never enters blocks or consensus state. v1 invitations stay parseable and verifiable forever at every surface.

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, Requirements (CAP-3, CAP-7)
- spec — `../spec-scinvite-v2/spec-scinvite-v2.md`, Capabilities/Constraints/Success signal; diagrams companion `witness-flow-diagrams.md`
- change — `../change-ledger-dials/change-ledger-dials.md`, stages T-B/T-C + §Stage acceptance (R2: property tests before UI)
- spec — `../spec-succinctcoin/spec-succinctcoin.md`, CAP-3/CAP-7 + addressing law (CAP-8 hop rule, CAP-9 locality)
- architecture — `../architecture-succinctcoin/architecture-succinctcoin.md`, AD-3 (chain-time purity), AD-12 (proto discipline), AD-11 (keys never reach the renderer)

## Notes

- Assumption: k = 2 witnesses and the /64 diversity floor are the initial floors (spec Assumptions), tunable constants.
- Open question: v2 byte budget and max backup count per invite — entry 1 waits (draft: keep 4096, N = 3).
- Open question: diversity metric for global /ip4 candidate hops — entry 3 waits (draft: reject v4 candidates until decided).
- Open question: must witness signers hold recent winner tickets when a chain exists — entry 3 waits (draft: strict distinct identity; ticket liveness soft preference, engaged only with real blocks).
- Open question: witness expiry default in slots — entries 2–3 wait (draft: longer than the 32-slot invite lookback; relay churn is slower than ticket churn).
- Decision: tracer bullet is the envelope itself (13.1) — after it every later slice lives in the v2 world and v1's byte-identical pin catches regressions at once.
- Decision: single lane, strict sequence — proto/codec → issuance+store → verification floor → propagation → grade+mint-with-backups → UX → sweep → closing proof; property tests precede all UI work (change-ledger-dials R2).
- Decision: breakdown of eight entries approved as-is (user, 2026-11-04); the four spec open questions stay entry `unknown`s carrying draft answers — each resolves at its entry's build unless answered earlier.
