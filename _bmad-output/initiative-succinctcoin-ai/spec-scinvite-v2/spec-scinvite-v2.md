---
id: SPEC-scinvite-v2
companions:
  - witness-flow-diagrams.md
  - ../change-ledger-dials/change-ledger-dials.md
  - ../spec-succinctcoin/spec-succinctcoin.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Witness-backed invitations (scinvite:v2)

## Why

Pain to solve, and an opportunity to claim. The invitation is this network's only out-of-band channel, and `scinvite:v1` carries exactly one signed address — which dies the moment the inviter sleeps (the ticket-liveness gate that makes stale invites worthless to squatters also makes them worthless to friends). A texted invite that fails at redemption is indistinguishable from a broken product. This spec closes the one gap the reachability ladder cannot reach: **a first connection that survives an offline inviter with a node that has zero prior knowledge** (change-ledger-dials stages T-B + T-C). The opportunity: make the text message itself a seed node you can hold in your pocket — signed, expiring reachability witnesses traveling inside the invitation, refreshed from the network after first contact.

## Capabilities

- **WB-1** — v2 envelope
  - **intent:** A node can mint an `scinvite:v2:` one-line text carrying its primary announcement (the v1 record verbatim) plus zero or more backup relay candidates, each with signed reachability witnesses; a recipient can parse it from copy-paste-tolerant ASCII.
  - **success:** Golden vectors encode/parse round-trip; the v1 codec and `verifyInvite` are byte-identical to pre-change; prefix-versioning means a v1 parser rejects v2 by prefix, never as corruption.

- **WB-2** — Witness issuance
  - **intent:** Any node can attest that an address of a peer was reachable for it, as a `ReachabilityWitness(target identity, address, chainId, firstSeenSlot, expirySlot)` signed with its identity key; issuance is bounded per window and always declinable.
  - **success:** Property tests: tampering any field fails the signature check; a witness scoped to another `chainId` is rejected at verify; issuance volume is capped (no unbounded signing oracle).

- **WB-3** — Verification floor (eclipse defenses are load-bearing)
  - **intent:** A recipient verifies the primary exactly as v1 (parse → validator → liveness) and trusts each backup candidate only when it carries ≥ k=2 witnesses with distinct signers, unexpired against `currentSlot`, spanning the diversity floor; direct/primary is always dialed before any candidate.
  - **success:** Property tests reject single-witness bundles, expired witnesses, duplicate signers, and same-prefix clusters; a headless row pins dial order (no candidate dialed while the primary answers).

- **WB-4** — Witness propagation
  - **intent:** Nodes share their fresh witnesses with peers through the existing windowed announcement exchange, so a joined node's backup knowledge renews from the network instead of aging out of one text message.
  - **success:** Three-node headless row: C learns a witnessed address of B via gossip from A alone (no direct C–B dial); zero new wire protocols — additive fields that older nodes ignore without validation change.

- **WB-5** — Live-lease UX
  - **intent:** The app presents the invite as a live lease, not a permalink: it states that the invite goes stale when the sender goes offline, shows the backup count only when non-zero, and refreshes through `SelfInviteUpdated` exactly as v1 does.
  - **success:** Renderer tests: copy updated; backup-count line absent at zero backups; no polling timers added (RENDERER_NO_POLL pin holds).

- **WB-6** — Witness-grade ingest
  - **intent:** Addresses that pass witness verification enter the address book at a distinct grade — above LAN hints, below invitation/block — and are never dialed before their bundle verifies.
  - **success:** Book tests: grade recorded and ordered (hints < witness < invite < block); verify-before-connect pin: an unverified bundle yields no dial target.

## Constraints

- Master-spec laws unchanged: primary keeps the invite address law (global v6 or held circuit); CAP-8 governs candidate hop addresses; CAP-9 keeps local addresses out of every invitation. Codec and verification stay AD-3-pure — chain time and liveness arrive via context, never ambient reads.
- v1 invitations remain parseable and verifiable forever; v1 and v2 coexist at every surface (`invite.txt`, panel, boot line). WB-4 rides additive proto fields only: older nodes' validators must accept announcements unchanged.
- Fresh-node trust ceiling: witness signer chain-liveness cannot be demanded beyond what the primary's gate already allows (the pinned empty-chain rule: undecidable → social-trust allow). The k-of-n distinct-signers floor, expiry, and diversity floor are therefore the load-bearing eclipse defenses; strict signer checks engage only once real blocks exist.
- Invite text keeps a hard length cap (the `MAX_INVITE_TEXT_LEN` DoS rule); v2 raises it only by explicit decision, with bounded backups per bundle — the base64 decoder is never handed unbounded input.

## Non-goals

- The chain-anchored relay registry (T-D) and relay receipts/rewards (T-E): RFC and spec tracks per the acceptance record; witness data never enters blocks or consensus state here.
- No new transports (WebRTC/QUIC/WebTransport stay rejected), no DHT, no QR rendering, no push/notification service.
- No change to relay selection policy (`MAX_AUTO_RELAYS`), serving rules, AutoNAT, or DCUtR behavior.
- No witness reputation, scoring, or slashing — witnesses are binary attestations with expiry.

## Success signal

A fresh node behind CGNAT redeems an `scinvite:v2` whose inviter is **offline at redemption**, connects through a witnessed backup within seconds, and gossips — demonstrated headless in CI as a three-node proof under `SUCCINCTCOIN_ALLOW_LOOPBACK=1` (mirroring the relay trio), with WB-2/WB-3 property tests and WB-1 golden vectors green.

## Assumptions

- k = 2 witnesses is the initial floor (change-ledger-dials §6 R2), a tunable constant.
- Diversity floor = distinct /64 prefixes across v6 candidate hops; messenger-first sizing (SMS-friendliness preferred, not contractual).

## Open Questions

- Byte budget for a v2 bundle (primary + max backups + witnesses): what hard cap replaces 4096, and how many backup candidates per invite?
- Diversity metric for global /ip4 candidate hops — the /64 floor has no v4 twin (/24 per-operator heuristic, or another measure)?
- With a chain present, must witness signers hold recent winner tickets to count toward k (strict), or do valid signatures suffice with liveness as soft preference?
- Witness expiry default in slots: reuse the 32-slot liveness lookback, or longer (relay churn is slower than ticket churn)?
