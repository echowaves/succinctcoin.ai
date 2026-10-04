---
type: epic
title: "Exact money: ledger, amounts, conservation invariants"
parent: initiative-succinctcoin-ai
covers: ["CAP-5"]
after: []
assignee: ""
risk: medium
estimate: ""
estimate_basis: ""
---

# Exact money: ledger, amounts, conservation invariants

## Description

Implement `core/ledger` on top of the baseline: integer base-unit (`BigInt`) balances, the single fee = amount × rate boundary (big.js), the wire/JSON/disk decimal-string encoding, and the conservation/no-negative-balance invariants enforced only inside `applyBlock` (AD-2). Property tests prove supply conservation and no float artifact over long random transaction sequences.

## Outcome

For the team: money is exact everywhere — a persisted balance never shows a float artifact, supply is provably conserved, and the ledger performs arithmetic/invariants only (no protocol re-validation) — so mining (which credits rewards) and any future economic logic build on a money core that is already invariant-proof.

## Requirements

Reuses the parent's id; the epic adds one line for the store-encoding invariant.

- R1 (CAP-5) — balances are integer base units (`BigInt`) in memory and on the wire; amounts travel as decimal strings on wire/JSON and on disk (AD-5); `big.js` appears at exactly two boundaries (fee = amount × rate; display conversion) and nowhere else.
- R2 (CAP-5) — the fee is amount × rate computed exactly once per transaction at `applyBlock`; no float artifact ever appears in a persisted balance (e.g. `0.1+0.2` drift is impossible).
- R3 (AD-2) — the ledger mutates balances only inside `applyBlock`, invoked by the consensus loop; it performs arithmetic and invariant checks only and never re-validates protocol rules; it is read-only everywhere else including the UI.
- E1 (AD-5) — persisted amounts are decimal strings / exact-precision integer columns; float and int64 amount columns are banned; a property test round-trips random `BigInt`s up to 10³⁰ through the store.

## Done when

- Property tests assert conservation of supply, no-negative-balance, and fee invariants over long random transaction sequences.
- A property test round-trips random `BigInt`s (up to 10³⁰) through the store with no precision loss; a float/int64 amount column is rejected.
- `JSON.stringify` of a balance never throws or drifts (decimal-string encoding); `big.js` is referenced only in the fee and display modules (verified by a lint/import check).
- A direct balance mutation outside `applyBlock` is impossible (the ledger exposes no public mutator); the test suite proves it.

## Boundaries

The exact-money capability: `core/ledger` amount representation, the fee boundary, the store encoding, and the conservation invariants. It does NOT implement mining (the caller of `applyBlock`), identity, or networking — it provides the arithmetic those depend on. Non-goals: the spec's non-goals.

## References

- parent — `_bmad-output/initiative-succinctcoin-ai/initiative-succinctcoin-ai.md`, section Requirements
- architecture — `_bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md`, sections AD-2, AD-5, AD-9, Consistency Conventions
- spec — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/spec-succinctcoin.md`, section CAP-5
- testing — `_bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md`

## Notes

- Waits on epic 1 because: it needs the core skeleton (ports, `core/events/`, the chainstore adapter) and the test harness to build and prove the ledger against.
- Assumption: `big.js` 7.0.1 is the decimal engine at the two boundaries (spine Stack); the integer path uses native `BigInt`.
- Decision: 2026-10-03 (inception) — breakdown approved as 6 stories, build order 1→2→{3, 5}→4→6 (3 and 5 can run in parallel; 4 waits on 3 so it can assert the persisted-balance half). Entry 1 is the tracer bullet (first testable ledger increment: amounts + seam + no-negative + big.js dep). No `plan_checkpoint`/`done_checkpoint` (consistent with epic 1, which had none outside 1.4's schema decision). Estimation OFF.
- Decision: 2026-10-03 (inception) — scope boundary vs epic 3 (consensus): `applyBlock` lives in `core/consensus` (spine structural seed; epic 3 R5). This epic delivers the ledger's balance-mutation + invariant-check seam that `applyBlock` invokes, NOT `applyBlock` itself. Reward credit is out of scope here (mining = epic 3). The seam shape is a code-level decision at 2.1 build time.
- Decision: 2026-10-03 (inception) — `big.js@7.0.1` is added to `packages/core` devDependencies by 2.1 (it is currently a root-only devDep used by bench/). Verified absent from core at inception.
- Open questions (settled at build time, recorded as entry `unknown`s): (a) fee-rate provenance — no source defines it; tests use a fixed rate, real rate likely a genesis emission parameter (protocol change per spine) landing with epic 3; (b) conservation supply model — closed system, fee destination (burn vs credit) + initial allocation settled at 2.4; (c) ledger-state persistence mechanism through StorePort (snapshot vs replay) at 2.3.
