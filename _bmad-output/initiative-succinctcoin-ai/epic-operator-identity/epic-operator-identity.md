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
