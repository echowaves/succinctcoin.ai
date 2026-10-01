# D6 slice A — Theory & impossibility of non-scaling identity cost

Deepening of Open question #1 (the registration design). Subagent fan-out, round 1, slice A.
Firewall: all claims from sources retrieved this session.

## Headline
2026 preprint theory shows non-scaling identity cost is achievable *only if* the entry cost is
denominated in a **throughput-bounded, non-transferable, window-local** resource (per-human /
per-device real-time capacity). Any cost denominated in money, compute, or storage is
structurally amortizable, so a wealthy attacker's marginal identity cost → 0 over time. The base
impossibility (Douceur 2002) stands: without a trusted authority or per-entity scarce resource,
unlimited identity is always possible.

## Claims
1. **Sybil theorem:** "no logically central, trusted authority to vouch for a one-to-one
   correspondence between entity and identity, it is always possible for an unfamiliar entity to
   present more than one identity." — J. R. Douceur, "The Sybil Attack," IPTPS 2002, Springer LNCS
   2429:251–260, 2002-03, accessed 2026-09-30.
2. **Adversarial cost framework:** C(s,T) = min new expenditure to sustain influence of s
   independent participants over T windows; sharp asymptotic separation between resource classes.
   — Maleki, Sainz, Legarda, Santos-Grueiro, "Scarcity Is Not Enough: Structural Limits of Linear
   Sybil Cost Under Parallelizable Resources," arXiv:2605.29651v2, 2026-05/06, accessed 2026-09-30.
3. **Thm 5.1 (amortization):** any resource-mechanism pair with divisibility + additivity of
   influence + temporal reusability + identity transferability yields C(s,T) = o(sT), marginal cost
   Δ(s,T) = o(T). — arXiv:2605.29651v2, 2026-05, accessed 2026-09-30.
4. **Thm 6.1 (linear lower bound):** throughput-bounded resources (per-identity dedicated channel
   with rate limit τ, non-transferable output, window-local allocation) enforce C(s,T) ≥ c·sT,
   Δ(s,T) = Ω(T). — arXiv:2605.29651v2, 2026-05, accessed 2026-09-30.
5. **Resource Substitution Theorem (7.2):** any mechanism targeting C(s,T) = Ω(sT) must ground
   participation in a resource violating ≥ 1 parallelizability property; protocol-level changes
   alone cannot cross the boundary. — arXiv:2605.29651v2, 2026-05, accessed 2026-09-30.
6. **Proof of Commitment:** PoW/PoS use "parallelizable resources like computation or capital.
   Once acquired … subdivided across many identities at negligible marginal cost, making linear
   Sybil cost fundamentally unattainable"; separation: parallelizable → zero marginal Sybil cost,
   human-time engagement → strictly linear. — arXiv:2601.04813, 2026-01, accessed 2026-09-30.
7. **Human Challenge Oracle:** CAPTCHAs / one-time proof-of-personhood address identity *creation*,
   not long-term participation; sustaining s active identities costs linearly in s per window.
   — arXiv:2601.03923, 2026-01, accessed 2026-09-30.
8. **Bounded Participation Channel:** "Most anti-Sybil defenses price identity creation rather than
   identity survival"; C(s,T) ≥ sT/τ_h; solver-agnostic (human/AI/hybrid); GPT-4o, Gemini 2.5
   Flash, Claude Sonnet 4.5 hit 97–100% accuracy yet remain throughput-bounded — "solvability does
   not imply unlimited throughput." — arXiv:2609.35300, 2026-09, accessed 2026-09-30.
9. **Concave money mappings don't save you:** any balance-derived rule where some wallet yields
   nonzero power admits Sybil splitting with total power growing ≥ linearly in holdings; measured
   1,172×–4,039× amplification under Quadratic Voting on five major DAOs. — Bennett et al.,
   arXiv:2605.18990, 2026-05, accessed 2026-09-30.
10. **Standard relaxations** to one-identity-per-human: trusted identity validation (spoofable),
    social trust graphs (SybilGuard/SybilLimit — "cannot prevent Sybil attacks entirely"), economic
    cost (PoW/PoS), personhood validation ("many usability and security issues remain"). — Wikipedia
    "Sybil attack" (citing Douceur 2002; Yu et al. 2006/2008; Borge et al. 2017), last edited
    2026-09-22, accessed 2026-09-30.

## The formal requirement
For marginal identity cost to be positive (C(s,T) = Ω(sT)), the security resource must satisfy all
three of Def. 4.5 (arXiv:2605.29651v2):
(i) **throughput-boundedness** — each identity has a dedicated participation channel with rate
limit τ;
(ii) **non-transferability** — the channel's output cannot be credited to another identity;
(iii) **window-locality** — no carry-over; every identity re-pays in every window.
Violating ≥ 1 of {divisibility, additivity, temporal reusability, identity transferability} is
necessary (Thm 7.2); the throughput-bounded class is proven sufficient (Thm 6.1). Concretely:
per-human/per-device real-time capacity (human challenges, TEE-bound execution) or social trust
edges, **re-verified per window**. The guarantee holds only insofar as channels can't be leased,
outsourced, or automated (τ degrades) (§10.1).

## Why a plain fee fails
A per-identity fee (refundable deposit or burn) is denominated in money, and money has all four
parallelizability properties: it splits across 1000 identities, reuses across windows (deposit),
transfers between identities, and influence is additive in it. By Thm 5.1, C(s,T) = o(sT) — once
the stock is bought, per-window marginal cost vanishes — so the cost is linear in *money*, which a
wealthy attacker scales without bound. Per-window burns don't help: the attacker can pay the fee on
any identity's behalf, because money is not non-transferable per channel. Concave fee→power
mappings don't help either (claim 9). Formally, "non-scaling per operator" means the cost must be
incurred per identity, per window, through a non-transferable channel (Def. 4.5); money cannot be
so denominated (arXiv:2605.29651v2; arXiv:2605.18990).

## Gaps
- **Adar & Bernstein 2007** ("identity thresholds"): UNVERIFIED this session — could not retrieve
  (ACM 403). The canonical impossibility is Douceur 2002; the parallelizable-resource framing is
  the 2026 cluster's.
- All cost-theoretic separation results (claims 2–8) are **2026 arXiv preprints from one research
  group (Deusto/UNIR)** — unpeer-reviewed, not yet field consensus.
- Douceur's exact wording verified via search snippets of the Springer PDF + secondary pages, not
  full-text reading.
- Open problems acknowledged in the literature: identity/credential markets, outsourcing, and
  solver progress erode the τ bound; intermediate scaling under partial property violations
  uncharacterized.
