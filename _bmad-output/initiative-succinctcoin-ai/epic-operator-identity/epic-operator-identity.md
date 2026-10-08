---
type: epic
title: "Operator identity: tickets, gate verifier port, re-attestation, acceptance cap"
parent: initiative-succinctcoin-ai
covers: ["CAP-2"]
after: []
assignee: ""
risk: high
estimate: ""
estimate_basis: ""
---

# Operator identity: tickets, gate verifier port, re-attestation, acceptance cap

## Description

Implement `core/identity`: per-window tickets, the offline `GateVerifier` port (`verify(cred, window) → { valid, identityId, attestedUntilWindow }`), re-attestation every K windows with offline-verifiable credentials, the uptime = valid-tickets/lookback-L computation (ramp from zero), and the acceptance cap (≤1 valid ticket per identity per window). Tickets conform to the draw contract and the `Ticket` proto message. Identity keys live in core/main and never cross IPC (AD-11).

## Outcome

For the team: a gate-verified person acquires exactly one base identity, and the protocol enforces (by plain rules) that a second identity is never cheaper than the first and the reward never scales with identity count — N identities of one operator earn no more slot-eligibility throughput than one — while eligibility lapses when re-attestation lapses.

## Requirements

Reuses the parent's id; the epic adds lines for the cap, the verifier, and re-attestation.

- R1 (CAP-2 / R1) — a gate-verified person acquires exactly one base identity through a personhood gate; the protocol enforces an **acceptance cap** (one valid ticket per identity per chain-window) so a second identity is never cheaper than the first, and the mining reward never scales with identity count.
- R2 (CAP-2 / R4) — uptime = valid tickets over a lookback of L windows, ramping from zero for a new identity; the slot reward is a fixed emission with no stake component.
- R3 (AD-4) — the gate is verified **offline**: the verifier port is exactly `GateVerifier.verify(cred, window) → { valid, identityId, attestedUntilWindow }`; `GateCredential = { gateId: string, blob: Uint8Array }` is the only representable credential shape; no module parses credential fields outside the verifier; a `Ticket` carries at most the credential **hash**, never the blob.
- R4 (R3) — re-attestation every K windows with an offline-verifiable credential; lapsing re-attestation loses eligibility (the identity stops producing valid tickets).
- E1 (AD-11) — identity private keys live in the core (Electron main); they never cross the IPC boundary to the renderer in plaintext.
- E2 (AD-12) — the `Ticket` proto message and the ticket signature `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)` are pinned by the schema; tickets conform to the draw's input set (AD-7).

## Done when

- In a multi-identity simulation, N identities of one operator earn no more slot-eligibility throughput than one (enforced by the acceptance cap); a distinct operator running N gate-verified persons wins ~N×.
- The slot winner is verifiable from public data by any node (public-coin draw); a node not selected by the draw cannot win a slot.
- A node whose re-attestation lapses stops producing valid tickets within K windows and loses eligibility.
- The `GateVerifier` port is the only place credential fields are read; a `Ticket` never carries the credential blob (verified by the schema + a test).
- A multi-identity simulation shows identity rental is linear-cost (per-identity floor, not per-operator equality) — the accepted limitation holds.

## Boundaries

The operator-identity capability: `core/identity` tickets, the `GateVerifier` port, re-attestation, uptime, and the acceptance cap. It does NOT implement the draw itself (epic 3 owns `drawWindow` — this epic conforms tickets to it), the ledger, or networking. Non-goals: the spec's non-goals (no proof-of-space, no merge-mining/PoA).

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, section Requirements
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections AD-3, AD-4, AD-7, AD-11, AD-12, Consistency Conventions
- registration — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/registration-design.md`, sections R1–R4, attack-surface table, known/accepted limitations
- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section CAP-2
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`

## Notes

- Open question: which two gates at launch + re-attestation cadence K — deferred; the architecture binds the verifier interface only (AD-4). Gate choice is a spec open question, not an architecture call.
- Open question: K and L values — genesis parameters (epic 1 authors `config/genesis.json`); the architecture binds the interface, not the numbers.
- Waits on epic 1 because: it needs the proto `Ticket` message (AD-12) to encode tickets.
- Waits on epic 3 because: tickets must conform to the `drawWindow` contract and its fixed test vectors (AD-7); the input set and signature shape are defined there.
- Assumption: dual gate at launch (biometric + social graph) is the recommended config (spec open question), not a load-bearing dependency.
- Decision: 2026-10-07 (inception) — epic sliced into 10 stories (build order = table order in tickets.toml): 4.1 GateVerifier port (R3) → 4.2 identity keypair + ticket signature AD-12 (E2) → 4.3 conform tickets to drawWindow + wire signature verification AD-7/AD-12 (E2) → 4.4 acceptance cap (R1) → 4.5 uptime = valid tickets / lookback-L (R2) → 4.6 re-attestation every K + lapse (R4) → 4.7 key material boundary AD-11 (E1) → 4.8 multi-identity sim (R1, R2) → 4.9 refactor sweep → 4.10 closing end-to-end suite (R1–R4 + E1/E2). Single-lane (all entries touch core/identity + the consensus acceptance path) — no parallelism.
- Decision: 2026-10-07 (inception) — NO spike: the enforceable parts are plain protocol rules testable in CI (registration-design: "the pre-launch requirement is the executable test suite in testing.md, not further paper"); the ticket-signature scheme is a code-level decision settled at 4.2, not a spike.
- Decision: 2026-10-07 (inception) — the GateVerifier enforces the ACCEPTED-GATE REGISTRY (must-hold (c): "gates are addable only by protocol upgrade, never auto-valid"): a credential whose gateId is not in genesis's accepted-gates list is rejected; the verifier is the ONLY credential reader (AD-4). (Set-validation finding, applied.)
- Decision: 2026-10-07 (inception) — 4.3 (conformance + signature wiring) is ONE cohesive acceptance-path seam: a real ticket is accepted iff it conforms to the draw AND its signature verifies. The two code changes (AD-7 conformance + AD-12 signature check) are tested together, not split; the signature check is ADDITIVE and composes with epic-3's verifyDraw, so epic-3's verify-draw (12), sim (5), and e2e (5) empty-signature suites stay green. (Set-validation single-lane flag declined as one feature.)
- Decision: 2026-10-07 (inception) — the ticket signature (AD-12: sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)) closes the EPIC-3 RESIDUAL REPLAY: an unselected node reusing the winner's EXACT public ticket (its identityId + nonceCommitment are readable off the chain) still passes epic-3's set+window binding; the identity-bound signature makes that replay fail, and the check is ADDITIVE (epic-3 tests use empty signatures and stay green).
- Decision: 2026-10-07 (inception) — K (reattestationK=100) and L (uptimeLookbackL=50) are GENESIS parameters (epic 1's config/genesis.json), not protocol-logic decisions; the identity logic reads them from the validated genesis config (chain-time, AD-3).
- Decision: 2026-10-07 (inception) — AD-11 (keys never cross IPC) is split: 4.7 guards the CORE half (identity private keys never exposed through the core read API / event payloads in plaintext); the renderer/preload IPC half is EPIC 6 (CAP-4).
- Deferred scope (inception): the registration-design "Optional hardening" (interactive BPC challenges, arXiv:2609.35300) is NOT in this epic — adopted only if the acceptance cap proves insufficient (a per-USE cost, not per-creation); identity rental is a stated accepted limitation (linear-cost, per-identity floor), not a bug to fix in-protocol.
- Tracer bullet (inception): 4.1 → 4.2 → 4.3 makes REAL signed tickets flow through epic-3's existing draw (3.3) + verify (3.4) acceptance path; 4.4–4.6 layer the acceptance cap / uptime / re-attestation on top; 4.8–4.10 prove the Done-when.
