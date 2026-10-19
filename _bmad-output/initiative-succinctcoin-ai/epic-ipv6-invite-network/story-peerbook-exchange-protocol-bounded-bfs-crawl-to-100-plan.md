---
id: story-peerbook-exchange-protocol-bounded-bfs-crawl-to-100
ticket: epic-ipv6-invite-network #3 (story)
status: built
covers: [R3, E1, E2]
---

# 9.3 — Peer-book exchange protocol + bounded BFS crawl to 100

## Shape

One invite dials ONE peer; that peer's book fills the rest — recursively,
bounded. A dedicated request/response stream (the sync.ts pattern, NOT a
gossip topic) serves up to `limit` of the responder's dial-eligible records;
a pure crawler state machine BFSs from the dialed seeds under hard bounds:
depth ≤ 3, concurrency ≤ 8, book cap 100 with /64-diversity-floored eviction.

## Pin list (constants + rules the tests assert)

- `PEERBOOK_PROTOCOL = '/succinctcoin/peerbook/1'`.
- Proto (PURELY ADDITIVE): `PeerBookRequest { uint32 limit = 1 }`;
  `PeerBookResponse { repeated PeerAnnouncement records = 1; repeated
  Introduction witnesses = 2 }`. Witness = FULL `Introduction` reuse (8.4) —
  the server SELF-SIGNS one per served record at the current head slot
  ("I verified this identity"), so the receiver's independence rule applies
  unchanged. No new witness type.
- **PROTO_OK / no protocolVersion bump:** block digests are sha256 over the
  canonical `Block` encoding only (AD-6, consensus/block.ts) — new TOP-LEVEL
  messages are unreachable from any digest input. The pin: golden-vector.test
  + chain-sync goldens stay green WITHOUT regeneration.
- Framing: u32be length-prefix, exactly sync's (`encodeFrame`/`decodeFramed`
  become exported internals of `net/sync.js`; peerbook imports them — one
  framing implementation on the wire).
- `MAX_BOOK_ENTRIES: 64 → 100` (spec: "up to 100 total"; re-pin the 8.4 row).
- `MAX_ENTRIES_PER_64 = 32` (diversity floor: at cap, ≥ 4 distinct /64s;
  eviction may never push a /64 group above 32 when another group could host).
- Crawler bounds: `maxDepth = 3`, `concurrency = 8`, per-address dial budget
  = ONE dial attempt per crawl (the adapter's own timeout is the time bound —
  AD-3 keeps wall-clock out of the pure machine), request limit =
  `cap − book.size()` clamped ≥ 1.

## Crawl trust rule (the poison-row semantics, pinned)

Peerbook records ingest through the NORMAL book path at **hint grade** —
trust classes are preserved exactly (block-grade only via blocks; three-
introductions upgrade untouched). The crawler's dial set is NOT `dialEligible`
(that would deadlock: hint + 1 witness < 3 vouches). Instead, the crawler
dials a learned record ONLY when the response carried a **valid witness for
that subject signed by the responding introducer it dialed this session**
(introducer-corroboration chain, crawl-local set — book classes untouched).

- Record with witness from a dialed introducer → stored (hint) + crawl-dialable.
- Record WITHOUT a corroborating witness → stored (hint), NEVER dialed by the
  crawler either ("never dialed directly" — the poison row): it can only ever
  graduate through the book's own 3-vouch/block paths.
- Quarantine is honoured: a crawl dial failure records `recordDialFailure`
  (book quarantine applies to all future dials); success → `recordDialSuccess`.

## Server serve policy (pure helper `servePeerBook`)

From `book.dialEligible(currentSlot)`: exclude hint-grade, exclude self,
order by **freshness** (`slotEnd` desc, tie `identityId` asc — 9.4 swaps in
score order at the SAME seam), truncate to `limit`; re-emit each record's
SIGNED bytes (the book must retain the announcement signature — see below) +
one self-signed witness per record when the node has an identity.

## Changes by file

1. `packages/core/proto/protocol.proto` — the two messages (+ doc comment,
   PURELY ADDITIVE note). Build regenerates (`protons`), goldens must stay.
2. `net/sync.ts` — export `encodeFrame` / `decodeFramed` (internal API only;
   barrel unchanged).
3. `net/peerbook.ts` (NEW, pure) — `PEERBOOK_PROTOCOL`, `PeerBookSource =
   (limit) => Promise<PeerBookServed>`, `makePeerBookHandler(getSource)`
   (read ONE framed request → one framed response → close; corrupt frame →
   abort), `requestPeerBook(dialer, peer, limit)` structural client.
4. `net/adapter.ts` — register the handler at `start()` next to SYNC with a
   lazy source getter; NetAdapter extension `setPeerBookSource(src | null)` +
   `requestPeerBook(peer, limit)` (mirror the sync pair exactly).
5. `discovery/address-book.ts` — MutableEntry gains `signature: Uint8Array`
   (+ `observedExternalAddr` already there) captured at ingest/refresh and
   exposed on the read view so `servePeerBook` can re-emit signed records;
   `MAX_BOOK_ENTRIES = 100`; capacity contest gains the /64 floor (contest
   win is necessary but not sufficient: installing must not push the
   incoming record's /64 group past `MAX_ENTRIES_PER_64` — if it would, the
   victim MUST come from that same group and still lose the contest, else
   the incoming record is dropped).
6. `net/address-policy.ts` — `ip6Slash64(addr): string | null` (first four
   hextets of the policy-valid /ip6; null when no usable address).
7. `discovery/peerbook-serve.ts` (NEW, pure) — `servePeerBook(book, currentSlot,
   limit, selfIdentityId?, witnessSigner?)` → `{ records, witnesses }`.
8. `discovery/crawler.ts` (NEW, pure state machine) — `runCrawl(deps, seeds)`
   with injected `request / dial / book / currentSlot`; BFS + worker pool
   (`concurrency ≤ 8`, observed peak exported in the report), depth labels,
   visited address/identity sets, witness-gated dial set (above), returns
   `CrawlReport { stored, dialed, refused, maxDepthReached, maxConcurrency,
   stoppedBy: 'cap' | 'quiet' }` — counts only (AD-9).
9. `packages/core/src/index.ts` — boot wiring after the ladder settles:
   register `setPeerBookSource(servePeerBook(...))` when the adapter exposes
   it; when `book.size() < 100` and seeds exist (dial-eligible non-self), fire
   the crawl (fire-and-forget, same AD-9 report sink via new
   `DiscoveryPorts.onCrawlReport?`). Node-loop untouched — discovery stays
   out of consensus (the loop's only discovery hook remains
   `onSelfAnnouncement`); "node loop starts a crawl after boot" is satisfied
   by the core-owned post-boot scheduler exactly like the 8.5/9.2 ladder.
10. Exports: barrel (`discovery/index.ts`, `src/index.ts`) for peerbook,
    crawler, serve helper, `ip6Slash64`.

## Tests (TDD order)

- `net-peerbook.test.ts` — handler/client over fake streams (dialProtocol
  double): request/response round-trip, limit passthrough, corrupt frame →
  client sees error, source=null → empty response.
- `peerbook-serve.test.ts` — freshness order pinned, hint excluded, self
  excluded, limit honored, witnesses signed by server identity verify +
  subject matches, records carry the ORIGINAL signature (byte-exact).
- `discovery-crawler.test.ts` — SYNTHETIC 150-node star (fake request/dial fns
  over a fixture graph with distance labels): reaches exactly 100 stored,
  depth never exceeds 3 (labels assert), observed concurrency ≤ 8, quarantine
  respected (failing addresses stop after the budget), poison row (no witness
  → stored hint, zero dials), /64 floor survives eviction pressure.
- `discovery-address-book.test.ts` — re-pin cap 100; /64-floor rows (group of
  32 blocks a 33rd same-/64 insert while another group could host; victim from
  the same group when it loses).
- memory-transport round trip (extend `chain-sync.test.ts` pattern, NEW file
  `peerbook-transport.test.ts`): two REAL adapters over /memory — A serves a
  3-record book, B requests limit 2 → exactly 2 + 2 witnesses; corrupt-limit
  path stays clean.
- core wiring row (`core-ladder.test.ts`): fake netExt with peerbook hooks →
  after boot the source is registered and serving book records; crawl report
  lands on the sink (counts only).

## Gates

build PROTO_OK (goldens green WITHOUT regeneration) → typecheck → root suite
→ app suite; quick-lens review; commit.

## Build log

- Delivered: proto `PeerBookRequest`/`PeerBookResponse` (purely additive, no
  protocolVersion bump — block digest untouched); `/succinctcoin/peerbook/1`
  stream (`net/peerbook.ts`, u32be framing SHARED with sync via exported
  `encodeFrame`/`decodeFramed`); adapter seam (`setPeerBookSource` /
  `requestPeerBook`, lazy-source like sync); serve policy
  (`discovery/peerbook-serve.ts`: eligible ∧ non-hint ∧ signature-valid,
  slotEnd-desc, cap by limit, self-signed witnesses, records byte-true);
  crawler (`discovery/crawler.ts`: depth ≤ 3, concurrency 8, one dial per
  address ever, cap 100 via the book); `MAX_BOOK_ENTRIES` 64 → 100; `ip6Slash64`
  exported; core wiring (source at `start()`, null at `stop()`; crawl chained
  after the boot ladder; report → `onCrawlReport`).
- Tests: `net-peerbook` (8), `peerbook-serve` (2), `discovery-crawler` (8 —
  MESH_150 exact-cap/depth/concurrency, poison, quiet, stopped, failure
  budget, multiaddr no-hang, rejected-record, forged-witness),
  `peerbook-transport` (2 real memory adapters), `core-ladder` +2 wiring rows,
  address-book `/64`-floor rows (+4). Root suite 431/60 green; app 37/7.
- Quick-lens review → FOUR fixes, each pinned by a new row:
  1. CRITICAL pump hang — a stale-item drain (record with ≥2 addresses) never
     reached the quiet check; quiet is now evaluated AFTER the fill loop.
  2. CRITICAL follow gate — following no longer trusts bare witness OBJECTS:
     a record is enqueued only if it PASSED ingest AND carries a witness whose
     SIGNATURE VERIFIES from a corroborator (`REJECTED_RECORD_NEVER_DIALED`,
     `FORGED_WITNESS_NEVER_DIALED`). Every valid vouch is ingested (no
     ordering suppression).
  3. MAJOR stream bounds — handler + client race the exchange against
     `PEERBOOK_TIMEOUT_MS` (10 s, dial's precedent) and abort on expiry: a
     silent peer can never pin a crawler worker (`TIMEOUT` row).
  4. MAJOR /64 floor bypass — pruning that freed a slot let a 33rd same-/64
     record install; the floor now holds on EVERY path: book full ⇒ same-group
     victim or drop; book NOT full ⇒ drop (no churn-eviction inside a quiet
     book) (`FLOOR_BELOW_CAP`).
  Plus: identities are CLAIMED at dequeue (a second address of one peer can
  never spawn a parallel crawl — `MULTIADDR_ONE_CRAWL`).
- Env note: this machine's heavy PoW rows flake under CPU contention
  (llama-server + mediaanalysisd); full suite is stable with
  `vitest run --maxWorkers=2..3`.
