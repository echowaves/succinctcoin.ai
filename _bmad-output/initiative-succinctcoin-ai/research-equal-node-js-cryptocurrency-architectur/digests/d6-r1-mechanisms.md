# D6 slice C — Mechanism design space + attack surface

Deepening of Open question #1. Round 1, slice C (gathered + synthesized; subagent backend unavailable
this session). Firewall: claims carry sources; items marked **DESIGN** are the lead's synthesis, not
retrieved fact. Access date 2026-09-30.

## Headline
The one mechanism with a *provable* non-scaling cost floor is the **Bounded Participation Channel
(BPC)** — re-verify each identity with a fresh, identity-bound, real-time, throughput-bounded
challenge **in every slot/window** (arXiv:2609.35300, verified this session: C(s,T) ≥ sT/τ_h). The
biggest open risk is not the math but **τ-erosion**: the bound degrades as challenges get solved by
automated channels (the paper measured GPT-4o/Gemini/Claude at 97–100% accuracy yet still
throughput-bounded — but that margin is a *measured fact, not a guarantee*, and solver capability
improves).

## Mechanism comparison
| Family | Achieves non-scaling? | Main attack | Centralization / privacy cost | Status | Source |
|---|---|---|---|---|---|
| **Fixed non-refundable fee** | No — money is parallelizable (Thm 5.1: C(s,T)=o(sT)) | Wealthy attacker mints N identities for N·F | Low; no privacy issue | deployed (many L2 gas costs) | arXiv:2605.29651v2, 2026-05 (verified) |
| **Refundable deposit + slashing** | No — deposit is money + reusable across windows + transferable | "Just deposit more"; slashing only punishes caught misbehavior, not Sybil | Low | deployed (PoS) | ethereum.org/staking 2026-09-30; arXiv:2605.29651v2 |
| **Non-parallelizable entry proof (VDF / space-time / sequential-HBW)** | *Potentially* — if it enforces a per-identity wall-clock τ that can't be parallelized/outsourced | Outsourcing to a farm; a *one-time* VDF doesn't bound *survival* (reusable); VDF-attack risk (cf. D1.5 Minroot abandonment) | Low–moderate | academic (VDF-for-registration studied less than VDF-for-consensus; **DESIGN** note: the security-model difference is that registration only needs a *one-shot* proof, not a continuously-verifiable chain anchor) | arXiv:2605.29651v2 (resource taxonomy); D1.5 (VDF risk) |
| **Proof-of-personhood / social-graph / trust-edge** | *At creation* — caps one-human-one-id; NOT at survival (one-time) | World ID: physical-Orb centralization, fake-iris, exclusion; BrightID: colluding vouching clusters; social-graph: topology-dependent | **High** centralization (Orb network / graph bootstrap) + biometric privacy | deployed | world.org/world-id, brightid.org, 2026-09-30 (verified) |
| **Bounded Participation Channel (per-window re-verification)** | **Yes — provable** C(s,T) ≥ sT/τ_h (identity-bound, fresh, real-time, throughput-bounded, per-window) | τ-erosion by automated solvers; channel leasing/outsourcing; DoS by starving a channel of challenge time | Moderate — needs a challenge source + per-window verification infra | academic (hash-based construction, 4 challenge families, 600-trial AI eval) | **arXiv:2609.35300, 2026-09-28 (VERIFIED this session)** |
| **Rate-limited ticket minting ("one ticket per slot per operator")** | Only if tickets are (a) rate-limited per *operator* and (b) non-transferable & window-local — i.e. it *reduces to* a BPC if the rate-limit is a throughput-bound channel | Ticket hoarding / resale / front-running the mint | Low | **DESIGN** (no deployed instance verified; closest is "registered PoW"/proof-of-activity, none of which is per-operator non-scaling) | — |
| **Hybrid: personhood gate (one id) + uptime-weighted election among verified ids** | The gate gives the *flat, non-buyable* entry; the election gives P≈f(uptime) among the capped set. The *survival* bound still needs a per-window element (pure one-time personhood doesn't re-prove survival) | Gate oracle centralization; exclusion; long-range replay of a verified identity | High (gate) | **DESIGN** (closest studied: World ID + Semaphore for "once per human" claims; no coin combines it with uptime election) | world.org/world-id (Semaphore "once per human"); DESIGN |

## Recommended composition (DESIGN, to carry to a spec)
Take the **Bounded Participation Channel** as the entry/survival primitive, wrapped as:
1. **One-time personhood gate** (World ID-style, or an open social-graph like BrightID) to mint a
   *base identity* — gives the "flat, non-buyable, per-operator" property (one human = one base id).
2. **Per-slot BPC ticket**: to win a slot, the node must present a *fresh* identity-bound proof
   computed within the slot window, over a throughput-bounded channel (rate limit τ per identity).
   This is what makes marginal *survival* cost positive (C(s,T) ≥ sT/τ_h) and what a plain
   fee/deposit cannot do.
3. **Uptime-weighted election** among valid tickets for the slot winner — gives P≈f(uptime) *within*
   the capped, re-verified set.

Properties it must hold (DESIGN): (a) τ is per-*operator*, not per-identity (else N identities = N·τ
= scaling); (b) challenges are window-local (no carry-over); (c) the base-gate is replaceable
(World ID today, open graph later) so the coin isn't hostage to one oracle; (d) a node that stops
re-verifying loses eligibility (no "set-and-forget" Sybil).

## Attack surface (for the per-human-gate + uptime-election design)
1. **Re-DoS / re-enrollment** — attacker churns identities to keep a channel "fresh." Mitigation:
   re-enrollment itself costs (a new base-gate proof); cap churn rate. *(DESIGN)*
2. **Oracle / gate centralization** — the one-time gate (World ID Orb, BrightID bootstrap) becomes a
   trusted point. Mitigation: make the gate pluggable + allow multiple gate providers; degrade
   gracefully to "no gate = no ticket" rather than a single point of failure. *(DESIGN; World ID
   Orb centralization is the documented cost — world.org)*
3. **τ-erosion by AI solvers** — the BPC bound assumes τ holds; better models shrink the human
   advantage. Mitigation: rotate challenge families (the paper characterizes 4 admissible families),
   treat τ as a tunable, monitor solver performance; the paper's 97–100%-but-throughput-bounded
   result is a *starting measurement*, not a permanent wall. *(arXiv:2609.35300 §eval)*
4. **Privacy linkage / exclusion** — a biometric gate excludes (no Orb access) and can leak.
   Mitigation: ZK presentation (Semaphore-style, "once per human" without revealing identity);
   offer a non-biometric gate (social graph) as an alternative. *(world.org FAQ — Semaphore/ZKP; DESIGN)*
5. **Long-range ticket replay** — an old valid ticket replayed later. Mitigation: window-local
   freshness (BPC "freshness" property) + slot-bound nonce. *(arXiv:2609.35300; DESIGN)*
6. **Front-running the ticket mint** — an adversary pre-computes/mints tickets to bias slots.
   Mitigation: the per-slot election is drawn *from* presented tickets, not pre-committed; ticket
   validity is per-window so pre-minting doesn't lock a slot. *(DESIGN)*

## Gaps
- **VDF-for-registration** as a distinct security model — could not retrieve a dedicated paper this
  session; the resource-taxonomy paper (arXiv:2605.29651v2) covers the class, not a concrete
  registration-VDF. Marked DESIGN.
- No deployed instance of "rate-limited per-operator ticket minting" verified — closest
  (proof-of-activity, registered PoW) are not per-operator non-scaling.
- The BPC AI-evaluation numbers (97–100% accuracy, throughput-bounded) are from the authors' 600-trial
  eval — single source, not independently replicated.
