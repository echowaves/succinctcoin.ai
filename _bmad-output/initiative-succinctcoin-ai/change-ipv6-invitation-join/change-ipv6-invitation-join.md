---
type: sprint-change-proposal
status: approved
created: '2026-10-18'
initiative: initiative-succinctcoin-ai
trigger: field two-device LAN test (epic 8.6 in progress)
affects: [spec CAP-3, spec CAP-7, discovery-design.md, epic-real-network, epic-bootstrap-free-discovery]
mode: batch
---

# Change proposal — IPv6-only addressing + invitation-only join with scored peer exchange

## 1. Trigger & context (checklist §1)

**1.1 Triggering story.** Epic 8.6 *Two-device proof of bootstrap-free join* (planned,
hitl) is being run live on two Macs (.17 / .84). It exposed the issue; the manual-
bootstrap workaround (commit `db7e5fc`) proved unicast TCP joins are possible while
multicast discovery is not.

**1.2 Core problem — category: technical limitation discovered during implementation,
leading to a user-directed strategic pivot.**

- mDNS (`@libp2p/mdns` 12.0.32) is IPv4-link-local multicast only — verified in the
  installed source: `ip = init.ip ?? '224.0.0.251'` → `multicast-dns` defaults to
  `type: 'udp4'`; no IPv6 path is reachable through the libp2p wrapper.
- A real-world middlebox (Norton 360 content/proxy filter) drops that multicast; with
  it off, cross-machine discovery works — but a *currency whose join story depends on
  link-local multicast surviving every firewall/NAC/middlebox on the way is fragile*.
- User decision (owner of the product): **support only IPv6**, and make joining an
  **invitation** act: a trusted party shares its IPv6 address out-of-band (email / SMS
  / copy-paste / QR); the invitee connects, then learns further nodes recursively from
  it — up to 100 total — with reliability ratings on the learned list.

**1.3 Evidence.** Live logs: `[discovery-ladder] {"mdns":true,...}` with zero peers for
90 s under Norton; DISCOVERED within seconds with Norton off; ping/unicast fine both
ways. No IPv6 requirement existed before; today's listen address is `/ip4/0.0.0.0/tcp/N`
and the Amnesiac proof measures /24 diversity of `/ip4/...` records.

## 2. Research findings — is invitation-only join viable? (user asked)

**Prior art (all production-proven):**

| System | Invitation/join mechanism | Recursive learning | Rating |
|---|---|---|---|
| Bitcoin | `addconnect <ip>` — one friend's address in config, out-of-band | `getaddr`/`addr` gossip fills the rest of the network | addrman `new`/`tried` tables: reachability history promotes entries; scored selection for re-gossip |
| Secure Scuttlebutt | **invite code** (host+port+public key) shared by friends via chat/email | first connection syncs, then feeds you peers/social graph | trust = social-graph distance (fibers), not infra |
| Ethereum | ENR (signed node record) pasted/bootstrapped manually or via bootnodes | kademlia-style neighbor queries crawl the DHT recursively | Lighthouse/Besu peer scoring: reputations from custody/validity behavior, gated to *selection*, never validation |
| libp2p itself | multiaddr copy-paste (`/ip6/.../tcp/N/p2p/12D3...`), QR codes in IPFS desktop "Connect" | identify push + peer-exchange (`/ipfs/id/pr/1.0.0`) during queries | peer store tags; circuit-relay v2 for unreachable peers |
| Tox / Session | friend number/link out-of-band | onion-routed relay introduction, then DHT | no infra login required — same "no official discovery infra" stance as our non-goals |

**Feasibility against our stack (verified locally):**

1. **IPv6 listen/dial:** `@libp2p/tcp` is Node `net` under the hood; `/ip6/::/tcp/N`
   binds and `/ip6/...` dials are standard multiaddrs. No new dependency.
2. **Invite needs NO new wire format:** a signed `PeerAnnouncement` (proto, shipped in
   8.3) *is* an invite — identity-signed `{multiaddrs, slotStart/slotEnd}`. Render it as
   text/QR; verify signature + freshness against chain head (chain-time, AD-3) + **the
   identity has recent mining tickets** (CAP-7's own liveness proof: a squatting address
   without tickets fails verification). The human channel (SMS/QR/email) is exactly the
   CAP-7 "any non-peer channel" in the Amnesiac Boot Proof definition — **this pivot
   completes CAP-7 rather than abandoning it.**
3. **Recursive learning:** we already ship gossipsub `peers` + `announcements` topics and
   a stream-protocol pattern (`sync.ts`). A small request/response `peerbook` stream
   protocol (proto, AD-8/AD-12) + BFS crawl policy implements "get others from the node
   you dialed, up to 100" directly. discovery-design.md already specifies Handshake Swap
   (~8 records offered, ~20 kept) — the change formalizes caps (100), depth, and scoring.
4. **Reliability rating:** local-heuristic score per book record (Bitcoin addrman / EL
   peer-scoring precedent): dial success EWMA, seen-across-slots stability, data
   validity (served valid blocks/tickets), corroboration count, latency. Used ONLY for
   selection (dial priority, which records we re-share, eviction at the 100 cap) — never
   for validation (keeps "poisoned hint fails soft" intact).
5. **IPv6-only specifics:** announce global unicast only (filter `fe80::` link-local and
   loopback); macOS privacy-address rotation is absorbed by our chain-time re-announce
   design (announcements expire/re-new by slot — rotating interface IDs are natural);
   diversity metric moves from /24 to /64 prefixes.

**Honest risks (must state):**

- **Inbound IPv6 is not universal**: most home routers *route* IPv6 but default-drop
  *inbound*; the inviter must open the port (our boot log already prints a dial-me line;
  add a reachability self-check via "what source address does my inviter see" — Address
  Grafting, already in design).
- **IPv4-only networks** (some ISPs/hotels) cannot join directly until a relay tier
  exists (circuit-relay v2 is already in the stack table; parked as escape hatch, relay
  must itself be IPv6-reachable).
- mDNS rung removed ⇒ no zero-config LAN join; replaced by scanning a QR on the friend's
  screen — arguably simpler and firewall-proof.
- Norton-class filters on *unicast* v6 TCP untested; if still blocked, Norton must
  allow-list the binary (same caveat as the manual-bootstrap workaround).

## 3. Epic impact (checklist §2)

| Epic | Verdict | Change |
|---|---|---|
| 1–6 (platform, money, mining, identity, node-network, desktop-app) | unaffected | built code keeps working; net adapter config already parameterized |
| 7 *bootstrap-free discovery* — **7.3 planned (hitl)** "two-instance LAN proof" | supersede | mDNS two-instance proof no longer gates the initiative; re-scope to optional regression when `mdns` flag enabled, or cancel |
| 8 *real-network* — **8.6 planned (hitl)** "proof of bootstrap-free join" | re-scope | becomes "two-device **invitation** join proof" — the natural next live test after today's manual-bootstrap run |
| **NEW epic 9 — IPv6-only + invitation join + scored peer book** | add | stories below |

Epic order: epic 9 slots after 8; nothing else resequences. Built tickets are NOT
rolled back (checklist §4.2 evaluated): mDNS already sits behind `DiscoveryPorts.mdnsEnabled`
— flip the default off, keep the code dormant; `bootstrap.txt` stays as a dev/headless
tool (it becomes the CLI sibling of the invite).

**Proposed epic 9 stories:**

- **9.1 IPv6-only addressing policy** — listen `/ip6/::/tcp/N`; announce/dial/ingest
  accept only global `/ip6` (reject `ip4`, `fe80`, loopback at the book boundary); /24 →
  /64 diversity in proofs; config default flip (`mdns:false`); all existing tests migrated.
- **9.2 Invitation encode/verify** — render a fresh signed announcement as invite text +
  QR; verify sig + chain-time freshness + recent-ticket liveness before first dial; app
  UI: "Invite friend" (QR/copy) and "Join via invitation" (paste); boot accepts an invite
  file where bootstrap.txt lives today.
- **9.3 Peer-book exchange + recursive crawl** — proto `PeerBookRequest/Response`
  (PROTO_OK gate); stream protocol `/succinctcoin/peerbook/1`; BFS policy: depth ≤ 3,
  concurrency ≤ 8, 2 s dial budget (existing rule), stop at **100** book entries; loop
  and eclipse guards per discovery-design swarm rules.
- **9.4 Reliability scoring** — local score model above; selection-only use (dial order,
  re-share top-K, eviction at cap); quarantine on invalid data; non-vacuity + poison tests.
- **9.5 Amnesiac Invite Boot Proof + docs** — adapt the shipped Amnesiac proof to the
  invite channel (wiped node + ONE invite → ≥k healthy peers across distinct /64s, ≤100
  cap respected); retire `mdns-smoke.mjs` to legacy; README/UX copy.

## 4. Artifact conflicts & required edits (checklist §3)

**Spec (`spec-succinctcoin.md`) — CAP-level, must be ratified by owner (you):**

- **CAP-3 intent**: "nodes join with no preconfigured peer — mDNS on LAN, ticket-seeded
  discovery beyond it" → "nodes join via a **trusted invitation** (out-of-band IPv6
  multiaddr: QR/SMS/email/copy-paste); ticket-seeded discovery propagates the rest;
  addressing is IPv6-only; circuit-relay v2 remains the parked NAT escape."
- **CAP-7**: keep unchanged — invite = "non-peer channel" artifact; success line gains
  "(an invitation over a human channel qualifies as the one artifact)".
- **Constraints**: add "Network addressing is IPv6-only: listen/announce/dial accept
  global `/ip6` multiaddrs only; link-local and IPv4 are filtered at every book boundary."
- **Non-goals**: amend "No DHT at launch — bootstrap + mDNS" → "…— invitation + peer
  exchange; mDNS retained only behind an opt-in flag for LAN dev."
- **Open questions**: the ladder-MVP question resolves (invite is rung 0); new open
  question: relay-tier criteria for IPv4-only networks.

**`discovery-design.md`**: fallback ladder rung 1 becomes **Trusted invite (human
channel)** — mDNS demoted to optional dev rung; add "Peer-book exchange & crawl" and
"Reliability scoring" sections (swarm rules mostly survive as-is: dial budget, eclipse
guard, grafting now load-bearing for IPv6 self-observation).

**Architecture spine**: no AD changes needed (AD-8/AD-12 already own proto + stream
conventions; the spine binds CAP-1..6 and none is touched). Stack table note: mdns
"optional, off by default". New proto messages go through the PROTO_OK gate as usual.

**UX**: no ux-* documents exist; CAP-4 gains two affordances (invite render, invite
paste) — recorded in epic 9 stories instead.

**Testing/CI**: root/app suites migrate ip4 fixtures → ip6; discovery lint extends to
"no /ip4 multiaddrs outside tests"; probes: `mdns-smoke.mjs` legacy, `dial-manual.mjs`
superseded by an invite-dial probe reusing the same harness.

## 5. Path forward (checklist §4)

- **Option 1 — direct adjustment** (re-scope within epics 7–8): *not sufficient* alone —
  this changes protocol-level addressing and adds wire surface; but its "add stories"
  half is right. Effort Medium, risk Medium.
- **Option 2 — rollback of mDNS/bootstrap work**: *not viable*. Zero gain: both are
  flag-gated/config-gated already; rollback burns built-test history.
- **Option 3 — MVP redefinition**: *not needed*. The spec's success signal runs on
  memory transport (CAP-6) and is untouched; Amnesiac Boot Proof survives via the invite
  channel. Deferred to post-MVP: zero-config LAN join, IPv4-relay escape.
- **Selected: hybrid of Option 1 + spec amendment.** Ratify CAP/constraint edits through
  `bmad-spec` (update mode), slice epic 9 with `bmad-ticket`, re-scope 7.3/8.6, then
  `bmad-build` per story. Effort Medium (~5 stories); risk concentrated in real-world
  IPv6 inbound reachability — mitigated by 9.1's dial-me/reachability check and by
  keeping the manual bootstrap.txt path working throughout.

## 6. MVP impact & action plan (checklist §5)

**MVP: intact.** Sequence:

1. **[you]** approve/ratify this proposal (esp. the CAP-3 rewrite + IPv6 constraint).
2. `bmad-spec` update → spec + discovery-design edits (this file is the input).
3. `bmad-ticket` → add epic 9 to `tickets.toml`, re-scope 7.3 (→ optional/cancelled) and
   8.6 (→ invitation join proof).
4. `bmad-build` 9.1 → 9.5 in order; each lands with green gates as usual.
5. **[you, two devices]** run the 8.6 re-scoped proof: generate invite on .84, paste/scan
   on .17, watch the book fill (≤100) and scores settle.

**Handoffs:** spec owner = you (approval) → `bmad-spec` (documents) → `bmad-ticket`
(board) → `bmad-build`/Amelia (implementation) → you (field proof).

## 7. Approval

- [x] **APPROVED as written — user, 2026-10-18**, hardened same day: IPv4 is not
  supported at all (no dual-stack fallback; boundary rejects name the parked relay tier).
  Executed: spec memlog entries 54–64 + kernel/discovery-design re-derivation; epic 9
  (`epic-ipv6-invite-network`, 5 stories) sliced; 7.3 marked superseded, 8.6 re-scoped to
  the two-device invitation join proof. Manual-bootstrap workaround (`db7e5fc`) stays the
  live join path until epic 9 lands.
