# Registration design — CAP-2 mechanism (the novel, unproven part)

Companion to `spec-succinctcoin.md`. This is the coin's novel contribution: making a second identity cost ≥ the first **without the cost scaling the reward**. This version is post-adversarial-attack-pass (2026-10-01; red/blue team, security-audit personas, pre-mortem, assumption audit, cascading failure). The design's enforceable parts are plain protocol rules; it is still unproven in deployment — the pre-launch requirement is the executable test suite in `testing.md`, not further paper.

## Why a fee or deposit fails

2026 cost-theory (arXiv:2605.29651v2, Maleki et al., Deusto/UNIR — **unpeer-reviewed preprint**, single group) explains the landscape: a non-scaling entry cost only works if the cost is a **throughput-bounded, non-transferable, window-local** resource:

- Divisible + additive + reusable + transferable resources (money, compute, storage) amortize: `C(s,T) = o(sT)` — N identities share the stock, per-window marginal cost → 0.
- Throughput-bounded, non-transferable, window-local resources enforce `C(s,T) = Ω(sT)`.
- **Resource Substitution:** protocol redesign alone cannot cross this boundary — the resource itself must be non-parallelizable.

Money has all four forbidden properties, so a fixed fee, a refundable stake-scaled bond (the PoS default; Eth 32-ETH is refundable + stake-scaled), and even concave fee→power mappings (Quadratic Voting showed 1,172×–4,039× Sybil amplification on 5 DAOs) all fail. **An absence finding:** no deployed permissionless system has a flat, non-scaling entry cost at survival.

**Post-attack-pass status of these theorems: motivation, not load-bearing.** The enforceable version of the design below does not require the theorems to be correct — it is a set of protocol rules (acceptance cap, chain-time windows, re-attestation, fixed emission) that can be tested directly in CI. The theorems explain *why* the obvious alternatives fail; if they are overturned, this file's caveats shrink, not grow. The one interactive construction from the BPC paper (arXiv:2609.35300) is demoted to an **optional future hardening** (see "Optional hardening").

## The mechanism (post-attack-pass)

The unit of fairness is **the gate-verified person**, not the operator, not the node, not the firm. The protocol enforces four plain rules:

### R1 — Acceptance cap (this is what "τ" actually is)

The protocol can never know who an "operator" is — "τ per operator" is not enforceable. What it *can* enforce, and does:

- **At most one valid ticket per identity per window.** Extra identities from the same person earn no extra eligibility — the cap, not challenge hardness, makes extra compute worthless.
- A **ticket** is a signed response to a per-window challenge `H(last block hash, window index)`, bound to the identity's key.
- **Windows are chain-time** (slot counts), never wall-clock — nodes disagree on clocks; a wall-clock window creates ticket-validity disputes.
- **Fork-replay is dead by construction:** the challenge derives from the last block hash, so a fork changes the challenge and invalidates old tickets.

### R2 — Verifiable election (public-coin draw)

A valid ticket proves *eligibility*, not that this identity *won the draw* — without a verifiable draw, any eligible node could claim any slot and the system degenerates into a broadcast race (network-position advantage, violating equality). Fix:

- **Public-coin weighted draw** (Eppstein random-priority style): each identity commits a nonce in its ticket (`c = H(nonce, challenge)`); the slot winner is the identity minimizing `c^(1/uptime)` (equivalently, the minimum of `H(r, challenge)` with a weight transform). The draw is **recomputable from public data by any node**; the block must carry the winning identity's ticket + nonce, and full nodes verify the draw before accepting the block.
- **Launch gate test:** a node not selected by the draw cannot produce a valid block. This test ships in the core suite.
- **Long-range anchor:** accumulated PoW work (Bitcoin-style). **No VDF** (Ethereum abandoned its Minroot-VDF plan after a discovered attack, IACR 2025/637).

### R3 — Re-attestation

- Gate credentials are **offline-verifiable** (a gate whose credential the network cannot verify without the gate is not accepted — this is a gate-interface requirement).
- The identity **re-attests every K chain-time windows** (periodic, not per-window, gate dependency). Lapse → lose eligibility — this is must-hold (d), made concrete.
- Post-breach: a compromised gate mints fake IDs, but they die within K of the gate being fixed. An *active* compromise is stopped only by the **dual gate** (below).

### R4 — Uptime and emission

- **Uptime = valid tickets / windows over a moving lookback L** (chain-time). New identities ramp from zero over L — no uptime inflation from a fresh identity claiming a long lookback.
- **Slot reward = fixed emission per slot, no stake component.** Richer never means more likely — the compounding ratchet (D1.11) is structurally absent.

## The composition, restated

1. **One-time personhood gate** (World-ID-style: one-time Orb iris+MPC+Semaphore → one human = one id; or an open social-graph like BrightID) mints **one base identity per person** — makes entry *flat and non-buyable*.
2. **Per-window ticket** (R1): a fresh, identity-bound, chain-windowed proof, accepted at most once per identity per window.
3. **Verifiable uptime-weighted election** (R2) among valid tickets — delivers P≈f(uptime) *within* the capped, re-verified set, closing the loop with CAP-1.

## Must-holds (post-attack-pass)

- **(a) Acceptance cap per identity per window** — the enforceable form of the old "τ per operator"; N identities = N× the *creation* cost and 1× the *eligibility* each.
- **(b) Chain-time window-locality** — no carry-over; a ticket is not a license; fork changes the challenge.
- **(c) Pluggable gate, redefined** — gates are **addable only by protocol upgrade, never auto-valid**; the network is only as strong as its weakest *accepted* gate. **Dual gate at launch (biometric + social graph) is the recommended config** — the biometric gate's deepfake erosion and the social graph's vouching clusters are each other's hedge.
- **(d) Stop re-attesting → lose eligibility** — re-attest every K windows; no set-and-forget Sybil.

## Known, accepted limitations (stated, not hidden)

- **Identity rental.** The gate controls *creation*, not *use*: an enrolled person can sell/rent their ticket rights. A "node-as-a-service" firm renting 10,000 humans is **linear-cost and theorem-compliant** — it can aggregate *people*, and that is the price of not being permissioned. The protocol promises a **cost floor per identity, not per-firm equality**. This is a stated semantic, not a bug to fix in-protocol.
- **Gate outage = closed network.** No new enrollments during a gate outage; existing nodes are unaffected (offline-verifiable credentials). A long outage concentrates emission on the surviving eligible set (bounded — total emission unchanged) but is a slow centralization tilt. Accepted; documented.
- **Pluggability is a liability if unmanaged.** A cheap weak third gate (lax vouching / fake biometrics) would be the sybil faucet — which is exactly why gates enter only by upgrade.

## Attack surface (post-attack-pass)

| Attack | Status |
|---|---|
| Eligibility inflation via extra identities | **Closed** by acceptance cap (R1) — deterministic, testable |
| Unselected node claiming a slot (broadcast race) | **Closed** by verifiable draw (R2) — launch gate test |
| Stale-ticket / window-edge exploits | **Closed** by strict chain-window index (R1) |
| Fork replay | **Closed** by challenge = H(last block hash, window) (R1) |
| Uptime inflation from fresh identities | **Closed** by lookback ramp (R4) |
| Long-range ticket replay | **Closed** by chain-time window + fork-varying challenge |
| Front-running the mint | **Closed** — slots are drawn *from* tickets presented in-window, never pre-committed |
| **Gate uniqueness** (iris fakery, colluding vouching clusters) | **Open — #1 external trust.** Dual gate + re-attestation bound it; gate-specific attack research is per-gate, not protocol-level |
| Identity rental / node-as-a-service | **Accepted** (see Known limitations) — linear-cost, stated semantic |
| Gate compromise (active or past) | **Bounded** — past: fake IDs die within K; active: dual gate; post-breach: revoke accepted gate + re-enrollment window |
| Gate outage | **Bounded** — closed network; existing nodes unaffected; slow-tilt risk documented |

## Optional hardening (not load-bearing)

- **Interactive BPC challenges** (arXiv:2609.35300): per-window interactive, identity-bound, real-time challenges with a provable `C(s,T) ≥ sT/τ_h` floor; frontier LLMs solve them at 97–100% accuracy yet remain throughput-bounded (authors' 600-trial eval — a measurement, not a wall). Adopt *only if* the acceptance cap proves insufficient (e.g., rental pressure demands a per-use cost, not just a per-creation cost). Keep as a designed-in option, not a dependency.

## Gate precedents (creation-only, not survival)

- **World ID** (world.org): one-time Orb (iris + MPC + Semaphore) → one human, one id; ZK, open-source, Orb-gated. Weaknesses: Orb hardware centralization, fake-iris, exclusion of non-Orb users.
- **BrightID** (brightid.org): open social-graph proof-of-uniqueness. Weakness: colluding vouching clusters.
- **Gitcoin Passport:** Sybil *scoring*, not a hard cap — docs fetch failed twice in recon; **unverified**, left as a gap.
- **Human Challenge Oracle** (arXiv:2601.03923): CAPTCHA/personhood addresses *creation*, not *survival* — **unverified** (subagent-sourced, not re-fetched).

## Honest caveats (post-attack-pass)

- The 2026 preprints (arXiv:2605.29651, arXiv:2609.35300) are **unpeer-reviewed, single research group**. Post-attack-pass they are **motivation and optional hardening, not load-bearing** — the enforceable design is protocol rules testable in CI.
- The design is **theoretically grounded but unproven in deployment**. The pre-launch requirement is the executable test suite in `testing.md` (including the verifiable-draw launch gate test), not further paper.
- **The #1 external trust is gate uniqueness** — everything in-protocol is auditable in tens of lines; the gate is not.
