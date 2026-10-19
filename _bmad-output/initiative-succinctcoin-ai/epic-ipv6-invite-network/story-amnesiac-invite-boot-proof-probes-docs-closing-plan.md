---
id: story-amnesiac-invite-boot-proof-probes-docs-closing-plan
ticket: epic-ipv6-invite-network #5 (story, closing)
status: built
covers: [R1, R2, R3, E2]
---

# 9.5 — Amnesiac Invite Boot Proof + probes + docs (closing)

## Shape

The epic's acceptance test: prove the whole join story end-to-end in one
bounded headless row, make the two-device proof runnable on a real probe,
and put the truth in the README. No new protocol behavior; the only shipped
code change is an explicit, default-off loopback allowance so the probe can
run on ONE machine — pinned so it cannot weaken anything else.

## A. Amnesiac Invite Boot Proof (`test/invite-amnesiac-boot.test.ts`)

Reuses 8.5's proven mesh pattern (seven memory-transport loops, ring, real
announce/introduce gossip, fake `/ip6` announces across five /64s, simulated
dial map, bounded polls, head-slot budget — zero wall-clock asserts).

- POSITIVE — wiped node, EMPTY config, ONE verified invitation:
  - Every mesh peer gets its own `AddressBook` fed by its loop's real hooks
    (same ingest functions as 8.5) and a `setPeerBookSource(servePeerBook…)`
    with its identity as witness signer — so the crawl has something true
    to serve.
  - The wiped node's ONLY boot input is `<tmp>/invite.txt` containing one
    `encodeInvite()` line (a freshly signed announcement of one mesh peer,
    slotStart 0 / generous slotEnd). Liveness getter = real
    `createInviteLiveness(wipedStore, head)` — the fresh store decides
    allow-all (the 9.2 EMPTY-CHAIN RULE exercised for real, not faked).
  - `runBootLadder({ inviteFilePath })` — no artifact, no hints, no
    bootstrap. Then the CORE's own follow-on: `runCrawl` with the dial map
    wrapper and `requestPeerBook` mapped fake→memory addresses.
  - PROOF (bounded): exactly one dial by the ladder = the invite's address;
    ≥3 dialEligible identities spanning ≥3 distinct /64s within 60 head
    slots (8.5's constants); crawl settles ('quiet'|'cap') with
    `book.size() ≤ MAX_BOOK_ENTRIES` (100 — cap respected by construction
    and never exceeded); EVERY book record carries a history and a score
    in [0,1] (`entries().every(e => e.history.seenSlots.length ≥ 1 &&
    0 ≤ book.score(id) ≤ 1)`), and at least one entry has real reliability
    evidence (sourcedTotal > 0 — the crawl fed the sink).
- NEGATIVE (squatter pair): same invite file, `hadRecentTicket: () => false`
  (a chain whose recent winners do NOT include the inviter — exactly what
  `createInviteLiveness` returns once real tickets exist). Report:
  invites.verified 0 / rejected 1, ZERO dial calls ever, book empty. No
  mesh needed — the ladder is the seam under test.

## B. Probes (`_bmad-output/.../epic-real-network/`)

- `dial-manual.mjs` gains INVITE modes (against built `packages/core/dist`):
  - `invite-new` — derive a keypair, sign a `/ip6` announcement for this
    machine's real listen address family, print the `scinvite:v1:…` line.
  - `invite-use <text>` — `parseInvite` → `verifyInvite` (allow-all liveness
    is PRINTER-ONLY context; the probe prints every gate result) → prints
    the record's addresses → dials them (90s retry loop, then peers()).
  - Loopback on one machine: shipped policy stays absolute by default;
    `assertDialable` accepts `/ip6/::1` ONLY when env
    `SUCCINCTCOIN_ALLOW_LOOPBACK=1` is set explicitly (new pinned rows:
    default still rejects ::1; flag accepts ::1 and NOTHING else — global
    addresses unaffected, announce policy untouched). Probe docs show the
    env prefix on both sides. Header examples updated to /ip6 realities.
- `mdns-smoke.mjs` → `epic-real-network/legacy/mdns-smoke.mjs` (git mv) with
  a `legacy/README.md` note (kept for the opt-in mDNS flag, pre-IPv6 LAN).

## C. Docs

- README "Joining a network" REWRITTEN: IPv6-only statement (global v6
  announce/dial; inbound needs router NDP/port-forward — consumer routers
  with stateful NAT64/middleboxes (e.g. Norton) may still block inbound —
  outbound always works); the INVITE flow as the primary join (app panel:
  MY INVITE copy → send → JOIN paste; boot file `<userData>/invite.txt`);
  bootstrap list DEMOTED to a dev-tool subsection (multiaddr examples now
  `/ip6/…`, ::1 note).
- `deferred-work.md`: (1) relay-tier open question pointer (IPv6-only +
  NAT'd peers ⇒ future relay/reachability tier undecided); (2) IPv4-
  unsupported DECISION recorded (policy rejects /ip4 everywhere; rationale
  + reversal cost).

## Tests

- New `invite-amnesiac-boot.test.ts` (2 rows above; positive timeout 180s —
  mining mesh under host load).
- address-policy rows (+2): SUCCINCTCOIN_ALLOW_LOOPBACK default-off / exact
  ::1-only scope.
- discovery-lint untouched (9.1 rule already bans /ip4 literals in src).

## Gates

build → typecheck → root suite `--maxWorkers=3` (mesh rows are the slow
ones) → app tsc+test → quick-lens review → commit. Headless-only: probes
are run by humans; their code must at least parse (`node --check`).

## Build log

- Amnesiac Invite Boot Proof shipped: `invite-amnesiac-boot.test.ts` (2
  rows, ~25 s): wiped node + ONE `encodeInvite` line in invite.txt, real
  `createInviteLiveness` over the empty store (empty-chain rule end-to-end),
  exactly one ladder dial = the invite address, ≥3 eligible / ≥3 /64s within
  60 head slots, crawl capped (`size ≤ 100`, `served ≥ 1`), EVERY book entry
  carries history + score in [0,1] with `anySourced` non-vacuity; SQUATTER
  pair: `hadRecentTicket:false` ⇒ verified 0 / rejected 1, ZERO dials, empty
  book. Mesh peers run real books + `setPeerBookSource(servePeerBook…)` so
  the crawl crosses real round trips.
- Loopback allowance shipped minimal: `assertDialable` alone consults
  `SUCCINCTCOIN_ALLOW_LOOPBACK=1` (read per call, default off) and admits
  EXACTLY `::1` via new exported `isLoopbackIp6Multiaddr`; announce/ingest/
  bootstrap paths untouched (bootstrap is filtered strictly — even stricter
  than dial). Pinned by 2 policy rows incl. near-miss rejections (`::2`,
  fe80::1, fd00, v4-mapped).
- LATENT BUG FIXED en route: `expandHextets` dropped the tail of a LEADING
  `::` address (once turned `::1` into all-zero). Invisible before (leading
  `::` is never global, and both callers gate on `ip6IsGlobalUnicast`),
  load-bearing for the loopback predicate. Covered by the compressed forms
  in the policy rows (`::1`, `0:0:…:1`, `::0:1`).
- Probes: dial-manual.mjs gained `invite-new` (starts FIRST, signs its real
  listen address + /p2p peer id into the invite; loopback rewrite under the
  flag) and `invite-use` (parse → verify → print → 90s-retry dial → peers).
  Loopback path verifies probe-side signature+chainId with ALL skips
  disclosed loudly (review F1). PROVEN live on this machine: side A +
  side B over ::1 → DIALED + PEERS both sides, exit 0. mdns-smoke.mjs →
  legacy/ with README note; root path depth fixed.
- Docs: README "Joining a network" rewritten (IPv6-only statement, router/
  Norton inbound caveat, invite flow generate→send→paste, bootstrap demoted
  to dev tool, loopback flag documented); deferred-work.md gained the
  relay-tier OPEN question + the IPv4-not-supported DECISION entries.
- Env notes: proof rows run ~25 s under load; full suites `--maxWorkers=3`.
  Root 448/62 green (core 411/55, app 37/7 + tsc). Review quick-lenses:
  one LOW (F1 disclosure) fixed; policy/security and test lenses clean.
