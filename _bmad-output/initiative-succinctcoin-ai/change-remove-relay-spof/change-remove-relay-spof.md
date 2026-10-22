---
title: 'Remove the operated-bootstrap-relay single point of failure'
type: 'change-proposal'
created: '2026-10-22'
status: 'accepted + implemented (autonomous — standing delegation; user review of the decision itself still welcome)'
scope: 'Minor — documentation, ticket status, and code comments only; zero shipped-code behavior change'
initiative: 'initiative-succinctcoin-ai'
epic: 'epic-universal-dialability'
---

# Sprint Change Proposal — No Project-Operated Relay (SPOF removal)

## 1. Issue Summary

**Problem.** The user reviewed the autonomous call recorded 2026-10-21 ("the project
MAY operate ONE bootstrap relay as pool bootstrap" — spec non-goal narrowing; epic
Notes "Autonomous call to confirm") and rejected its shape: *a single operated
relay is a single point of failure, and we want an implementation without single
points of failure.*

**Context.** Discovered while prepping story 11.4 (HITL provisioning of exactly
that one relay). The shipped relay *tier* already has no SPOF — auto-relay holds
through three independent peers, seeds are additive multi-holds, DCUtR makes
relay links transient. The SPOF is precisely the one *unshipped* piece: an
operated endpoint whose IP would ship inside every binary via
`DEFAULT_RELAY_SEEDS`.

**Evidence.**
- Spec non-goals already declare the intent this change restores: "The project
  operates no discovery or registry infrastructure … (kills the bootstrap SPOF at
  the operational layer too)" — the 2026-10-21 narrowing is the exception being
  revoked.
- `discovery-design.md` invariant: "**no channel is load-bearing** — the SPOF dies
  by plurality plus verification, not abstinence."
- CAP-3/CAP-7 make **invitation** the join path; the amnesiac-invite boot proof
  shows one verified invitation is a complete join. The operated relay was only a
  convenience for seed-based cold boot — removing it breaks no shipped proof.
- Architecture doc already assumes "community-run circuit-relay-v2 relays" with a
  recorded launch assumption (line 158/237) — consistent with this change.

## 2. Impact Analysis

**Epic impact.** Epic 11 *cannot close as planned* (11.4 provisions the project
relay; its Notes carry a "gap line" awaiting provisioning). Post-change: 11.1,
11.2, 11.3, 11.5 stay **built** unchanged in behavior; **11.4 is dropped** (its
ticket text itself anticipated this: "If the user amends the autonomous
seed-supply call … this story becomes sourcing a community endpoint instead" —
the runbook deliverable already shipped in `9ea45dd`); the epic closes with a
**decision line** replacing the gap line. No other epic is affected; no resequenc-
ing; no new epic required (gossip advertisement stays parked as a future option).

**Artifact conflicts.**
- `spec-succinctcoin.md`: non-goal narrowing bullet (revoke); CAP-8 intent/success
  wording ("shipped dual-stack seed list", "nothing preconfigured beyond shipped
  defaults" — must become honest); Open Questions seed-supply item (resolve).
- `discovery-design.md`: "software ships a built-in dual-stack seed list (domain
  with A + AAAA…)" paragraph — stale twice over (the flip never happens; `/dns`
  seeds were already proven unimplementable).
- Epic file: R4 text, done-criteria line, Notes bullets, gap line.
- `docs/relay-runbook.md`: title + "bootstrap relay (project-operated instance)"
  section → volunteer-prominence guidance.
- README: two "until seeds ship by default / empty today" phrasings implying an
  imminent flip.
- Code comments only: `net-config.ts` (flip narrative), `honest-boot-proof.test.ts`
  header + one test title ("documented skip" → "empty by design"). No logic, no
  predicate, no constant change — `DEFAULT_RELAY_SEEDS = []` and its pinned-empty
  tests stay as the invariant guard.
- `deferred-work.md`: epic-10 parked item (a) UPDATE pointer + epic-11 GAP line →
  permanent DECISION wording.
- Architecture / UX / testing companion: **no conflict found** (already says
  community-run; renderer copy already points at env seeds/volunteers).

**Technical impact.** None on behavior. Seeds remain fully supported via
`SUCCINCTCOIN_RELAY_SEEDS`; auto-relay, DCUtR, multi-hold untouched. The residual
risk is the architecture doc's existing assumption: *someone* must volunteer a
relay for v4-only newcomers who lack an invitation — unchanged from before this
proposal (the operated relay was never yet running).

## 3. Recommended Approach

**Path: Direct Adjustment** (checklist 4.1 — viable, Low effort / Low risk).
Rollback (4.2) is not viable: nothing built depends on the relay existing; rever-
ting would mean deleting proven CAP-8 machinery to remove an endpoint that was
never provisioned. MVP review (4.3): no scope change — invite-first join is the
launch path and its proof stands.

**Design decision encoded (Option A):** the project operates **zero** relays;
`DEFAULT_RELAY_SEEDS` ships empty **by design**, not as a placeholder. v4-only
joiners ride rung 0 (one verified invitation) like every other joiner, then the
3-way auto-relay serves them with zero per-machine configuration. Volunteer-
published seeds remain possible via env; if the community ever curates a release
list (Option B), entries come from independent volunteers — never an operated
endpoint. Gossip relay advertisement (Option C) stays parked as a future spec
story.

**Trade-off stated honestly:** removing all shipped anchors means there is no
address-based cold boot without either an invitation or an operator-set env var.
That is the same anti-censorship posture CAP-7 chose deliberately ("no channel is
load-bearing"), and it removes the one address anyone could block, seize, or
compromise to gate newcomers.

**Effort/risk:** docs+tickets ≈ 30 minutes of edits + full gate re-run; risk:
Low (reversible, local commits only).

## 4. Detailed Change Proposals

1. **spec non-goals** — replace the narrowing sentence with a revocation
   (project operates NO relay; seed list optional AND empty-by-default; v4-only
   rides rung 0; community-curated lists only from volunteers).
2. **spec CAP-8 intent+success** — seeds are operator-pinned/volunteer-published,
   not shipped; success keeps the fixture semantics ("seed arrives exactly as an
   operator pins it").
3. **spec Open Questions** — seed-supply item marked RESOLVED 2026-10-22; remain-
   ing: volunteer incentives + beyond-seed discovery.
4. **discovery-design.md seeds paragraph** — empty built-in list, IP-form seeds,
   no domain/DNS ownership (also fixes the stale A+AAAA wording).
5. **epic file** — R4 + done-criteria + Notes bullets rewritten to the decision;
   gap line replaced by decision line.
6. **ticket 11.4 → dropped** (`tickets.py mark … 11.4 dropped`); runbook remains
   as shipped doc artifact.
7. **runbook** — bootstrap section becomes "Running a prominent volunteer relay";
   seed-delivery item becomes publish-your-own-channels guidance.
8. **README** — two phrasings: empty *by design*, env is the operator channel.
9. **code comments + one test title** — flip narrative → by-design-empty.
10. **deferred-work.md** — both relay-endpoint entries to DECISION wording.
11. **spec memlog** — record the amendment event.

## 5. Implementation Handoff

**Scope: Minor** → Developer agent implements directly (this session, under
standing delegation). Deliverables: the edits above + full gates green + local
commit; never pushed. Success criteria after implementation: root suite green
(549+), pinned-empty seed tests still pass unchanged, no shipped-code logic
touched, every artifact tells one story: *the project operates no relay; there is
nothing to take down.*

**Alternatives kept on record:** Option B (ship ≥3 curated volunteer seeds) and
Option C (gossip relay advertisement) remain available future slices via
`bmad-spec`/`bmad-ticket`; this proposal does not foreclose them.
