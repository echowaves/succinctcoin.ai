# D6 slice B — Deployed precedents for non-scaling identity cost

Deepening of Open question #1. Round 1, slice B (gathered directly; subagent backend unavailable this session).
Firewall: all claims from sources retrieved this session. Access date 2026-09-30.

## Headline
No deployed permissionless system achieves a *flat, non-buyable, per-operator* entry cost that does
not scale the reward. The two closest deployed primitives are **proof-of-personhood gates** (World
ID, BrightID) — which cap one-identity-per-human but are *creation-time* (one-time) — and **PoS
bonds** (Ethereum 32-ETH) — which are refundable and *explicitly* stake-scaled (more stake → more
reward). Neither, alone, is "non-scaling entry."

## Precedent table
| System | Gate | Per-identity? | Refundable? | Scales reward? | Status / scale | Known attack | Source (accessed) |
|---|---|---|---|---|---|---|---|
| **World ID** (World Foundation) | Biometric iris at a physical "Orb" → MPC-fragmented code → Semaphore ZK proof of "unique human" | Yes — "verify you have never verified before"; one World ID per human | n/a (not a bond) | No | Deployed; open-source protocol (github.com/worldcoin); physical-Orb-gated; scale number UNVERIFIED this session | Physical-Orb centralization (must visit an Orb); biometric exclusion of those without access; fake-iris / replay (reported attack class) — UNVERIFIED detail | world.org/world-id + FAQ, 2026-09-30 |
| **BrightID** | Social-graph "proof of uniqueness" — a new identity needs verifications from existing unique humans | Yes — "only one account"; connection-party onboarding | n/a | No | Deployed; open-source; "70K+ sponsored," 15 apps integrated | Colluding clusters (a group vouching for each other) — the documented design weakness; UNVERIFIED incident detail | brightid.org, 2026-09-30 |
| **Gitcoin Passport** | Scored "Sybil resistance" from a weighted set of badges (incl. BrightID, ENS age, GitHub, etc.) | Soft — a *score*, not a hard cap | n/a | No | Deployed (grants) | Score-gaming / badge-farming | **UNVERIFIED** — docs.passport.gitcoin.co failed to extract (2×) |
| **Ethereum validator** | 32-ETH bond to activate a validator (up to 2048 ETH per validator) | Per-validator | **Yes** (exit/withdraw) | **YES — stake-weighted** (more stake → more validators/reward) | Deployed; 43.7M ETH staked (35% of supply) per page header | A wealthy attacker stakes more → strictly more power (the anti-pattern we must avoid); centralization of large pools | ethereum.org/staking, 2026-09-30 |
| **Cosmos / Tezos / Algorand / Casper** | Bonded-stake validators | Per-validator | Yes | **Yes — stake-weighted** | Deployed | Same stake-scaling anti-pattern | UNVERIFIED individually this session (class-level, not per-chain) |

## Closest to the goal
1. **World ID** — the only deployed system with a *hard* one-human-one-identity cap that does not
   scale reward. What's missing: it's **one-time** (creation-time), so a stolen/leased/proven identity
   is reusable forever; no per-window re-verification. (This gap is exactly what slice A's
   "Human Challenge Oracle" claim 7 and the BPC paper name: creation vs *survival*.)
2. **BrightID** — decentralized (no biometric hardware) one-identity gate, but its security is the
   *social graph*, which is topology-dependent and cluster-gameable.
3. **The PoS bond family** — proves the *opposite*: refundable + stake-scaled is the industry default,
   confirming that "flat, non-scaling" is genuinely absent from deployed practice.

## What broke (cited)
- No *new* specific incident verified this session. The standing, documented failure classes are:
  (a) World ID's physical-Orb dependence (access/exclusion + hardware trust) — world.org FAQ;
  (b) BrightID cluster-collusion (a vouching ring) — brightid.org design; (c) PoS stake-scaling
  centralization — ethereum.org/staking. Specific dated incidents: **UNVERIFIED** (would need a
  second pass on crypto press; recorded as a gap, not asserted).

## Gaps
- **Gitcoin Passport** — could not verify (docs fetch failed twice). Left as UNVERIFIED.
- **World ID total verified count** — not on the page fetched; UNVERIFIED.
- **Fake-iris / World ID replay incident** — known attack class, but no dated source retrieved; UNVERIFIED.
- Per-chain bond details for Cosmos/Tezos/Algorand/Casper — class-level only, not individually verified.
