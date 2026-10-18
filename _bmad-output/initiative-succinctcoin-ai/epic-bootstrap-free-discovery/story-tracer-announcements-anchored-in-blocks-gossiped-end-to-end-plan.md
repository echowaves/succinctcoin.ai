---
title: 'TRACER: announcements anchored in blocks + gossiped end-to-end'
type: 'feature'
ticket: '3'
created: '2026-10-18'
baseline_revision: fea9c88
status: 'built'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** CAP-7's premise is that presence lives ON-CHAIN — signed announcements anchored in blocks are the trust root (block-grade) the whole discovery ladder stands on. Today `PeerAnnouncement` (8.2) exists but goes nowhere: blocks don't carry it, the loop neither produces nor validates it, and nothing relays it.

**Approach:** The thinnest end-to-end path: `Block` gains field 8 INSIDE the canonical digest (protocol change → golden vectors re-pin + genesis `protocolVersion` 1→2); `applyBlock` validates every carried announcement under a budget cap and EMITS the validated set for 8.4's book; the node loop signs a fresh announcement per window, collects gossiped ones, includes them in mined blocks, and relays only what verified. A two-node memory-transport tracer proves zero-config presence.

Pinned build decisions (the ticket defers these):
- **Field type**: `repeated bytes announcements = 8` — each entry is the PROTO-ENCODED `PeerAnnouncement` blob verbatim (the `winnerTicket` precedent: raw bytes inside the digest; validation DECODES — no re-encode canonicity hazard).
- **Digest extension**: `canonicalBlockBytes` appends `u32be(count) ‖ (u32be(len_i) ‖ bytes_i)…` ALWAYS (empty ⇒ 4 zero bytes) — every block hash changes, hence the unconditional protocolVersion bump.
- **Budget cap N = 8** announcements per block; policy: ANY invalid announcement OR count > 8 REJECTS THE BLOCK (throw `SC-ANNOUNCE-1`) — all-or-nothing is deterministic across nodes; no partial-drop ordering to agree on.
- **Freshness at apply time**: validated with `currentSlot = block.slot` (chain-time determinism: identical verdict for every node, whenever synced). Chain scope: `expectedChainId` threaded into `applyBlock` (optional — absent means blocks WITH announcements are rejected when non-empty… NO: absent context + empty announcements = fine; absent context + NON-empty announcements = reject (an unscopeable announcement cannot be trusted)).
- **Gossip path**: NEW class topic `/succinctcoin/announcements/1` + `AnnouncementEnvelope { PeerAnnouncement announcement; string sourcePeerId }` (AD-8 pattern, mirrors peers class); loop-level verify-before-relay: the loop validates BEFORE re-publishing — a forged/expired record is never republished by us (mesh-level blind forwarding stays untrusted bandwidth that dies at every validator/block gate).
- **Relay exactly once** per `(identityId, slotStart)` key (loop-held set); own announcement published fresh each window (own identity excluded from relay set).
- **Block inclusion**: candidates = own + collected-valid, sorted by hex of encoded bytes (deterministic), capped at first 8.
- **Emission handoff (8.4)**: `applyBlock` calls optional `onAnnouncements(decodedRecords, { blockHashHex, slot })` AFTER commit — keyed by originating block as the epic requires.

## Boundaries & Constraints

**Always:** announcements only ever validated through 8.2's `validatePeerAnnouncement`; digest bytes pinned by golden vectors; loop never reads key material (signs via `signPeerAnnouncement`); all new params OPTIONAL so every existing caller behaves identically (no-identity loops mine announcement-free blocks exactly as before); reject-with-code errors follow spine convention (`SC-ANNOUNCE-1`).

**Never:** no address book, no fallback ladder, no app changes beyond threading `genesis.chainId` where the loop is built; no wall clocks; no changes to existing message field numbers; the tracer test stays headless memory-transport (AD-10).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Block with valid announcements | ≤8 valid blobs, scope+fresh at block.slot | applies; emission fires with decoded records + blockHashHex | — |
| Empty/absent announcements | today's blocks | identical behavior, no emission | — |
| Forged announcement in block | bad signature | block REJECTED `SC-ANNOUNCE-1`, nothing committed | ledger/store untouched |
| Expired at block.slot | slotEnd < block.slot | rejected as above | — |
| Over budget | 9 entries | rejected before ANY validation cost | — |
| No chainId context + non-empty | caller omitted scope | rejected (unscopeable) | — |
| Relay: valid gossiped | received once, several windows | republished EXACTLY once per (identityId,slotStart) | — |
| Relay: forged gossiped | bad signature | never republished | — |
| Two-node tracer | shared store + memory net, zero addresses | chain contains both identities' announcements; every applied block's set validates | — |

</frozen-after-approval>

## Code Map

- `packages/core/proto/protocol.proto` — `Block.announcements = 8 (repeated bytes)` + `AnnouncementEnvelope` message (after PeerInfoEnvelope); regenerate (PROTO_OK).
- `packages/core/src/net/topics.ts` — fifth TOPICS entry `announcements: '/succinctcoin/announcements/1'`; TopicClass grows to five.
- `packages/core/src/net/adapter.ts` — subscribe + `decodeReceived` case + `sendAnnouncement(announcement)` helper (not on NetPort, mirrors `sendPeerInfo`); docstrings "four"→"five".
- `packages/core/src/consensus/pow.ts` — `canonicalBlockBytes` appends the announcements part (u32be count + length-prefixed blobs; reads `block.announcements ?? []`).
- `packages/core/src/consensus/miner.ts` — `BlockTemplate` gains optional `announcements?: Uint8Array[]`, threaded into every attempt's block (digest covers them ⇒ PoW too).
- `packages/core/src/consensus/apply-block.ts` — optional `discovery?: { expectedChainId: string; onAnnouncements?: … }`: count cap → per-entry DECODE (proto) + `validatePeerAnnouncement(currentSlot = block.slot, expectedChainId)`; throw `SC-ANNOUNCE-1` on any failure; emission AFTER commit.
- `packages/core/src/consensus/node-loop.ts` — optional opts `chainId`, `announceValiditySlots` (default 32); per window: sign fresh announcement (identity+chainId only), publish envelope, collect `received.get('announcements')`, validate@slot, relay-once set, block candidates sorted-by-blob-hex capped 8; pass `discovery` into applyBlock incl. emission (loop forwards to new optional opt `onAnnouncements`).
- `config/genesis.json` — `protocolVersion: 2`.
- `packages/core/test/golden-vector.test.ts` (+ any canonical-bytes pins in `consensus-pow.test.ts`) — RE-PIN block digests/wire hex for the new canonical form (announcements-empty tail = `00000000`).
- `packages/core/test/discovery-block-tracer.test.ts` — NEW: matrix rows + two-node tracer (shared in-memory StorePort fake + memory transport pair à la `core-node-loop.test.ts`/`block-propagation.test.ts` fixtures).
- `packages/app/src/main/core-host.ts` (+ index if needed) — thread `genesis.chainId` into the loop opts at wiring.
- Do NOT touch: address book (8.4), boot ladder (8.5), app seed/net-config, existing envelope messages.

## Tasks & Acceptance

**Execution:**
- [ ] proto: Block field 8 + AnnouncementEnvelope; regenerate; PROTO_OK
- [ ] topics.ts + adapter.ts fifth class (subscribe/decode/send)
- [ ] pow.ts digest extension + miner template passthrough
- [ ] apply-block.ts validation + emission (SC-ANNOUNCE-1)
- [ ] node-loop.ts produce/collect/relay/include + opts
- [ ] genesis protocolVersion 2; re-pin golden vectors (+ any canonical pins)
- [ ] tracer test file (matrix rows + two-node zero-address proof + relay once/never rows)
- [ ] app core-host chainId threading

**Acceptance Criteria:**
- Given a block carrying valid announcements, when applied with matching chainId, then it commits and the emission fires keyed by block hash; given forged/expired/over-budget, then `SC-ANNOUNCE-1` and NOTHING committed.
- Given the two-node memory tracer with zero configured addresses, then both identities appear in applied blocks' announcement sets and every set validates at its block's slot.
- Given a valid gossiped announcement seen across many windows, then it is republished exactly once; a forged one never.
- Golden vectors re-pinned; `protocolVersion` = 2; full root suite green headless.

## Implementation Notes

Shipped as planned, all frozen decisions honored. Notables:

- `canonicalBlockBytes` tail (`u32be(count) ‖ (u32be(len)‖blob)…`, always) →
  consensus-pow golden constants RE-PINNED (CANONICAL_HEX + `00000000` tail,
  canonical length 322→326, FIXED/PASS digests, PASS_NONCE 76735→90322);
  genesis `protocolVersion` 1→2. Wire (`Block.encode`) pins UNCHANGED for
  empty announcements (proto3 repeated adds zero bytes) — net-adapter golden
  hex proves the additive-only claim.
- `signPeerAnnouncement` returns the SIGNATURE only (8.2 shape kept); slots
  normalize to wire-native bigint at the digest boundary via `coerceSlot`,
  and `AnnouncementContext.currentSlot` widened to `number | bigint` so
  applyBlock passes `block.slot` (bigint) directly.
- Loop known-set: ONE entry per identityId (newest `slotStart` wins); the
  newest-wins replace IS the relay dedup — a record enters the set at most
  once per `(identityId, slotStart)` and only entry-entries relay. Expired
  entries drop out when candidate filtering re-validates at the current slot.
- Field-name note: the loop's known-set entry field is `wire`, never
  `.blob` — the literal member name belongs to the gate credential's single
  reader (AD-4 scan would flag it; hit exactly that, renamed).
- `sendAnnouncement` follows the `sendPeerInfo` pattern: NOT on `NetPort`
  (ports.ts untouched); the loop's net type gains it as an optional adapter
  extension beside `received`. `createNodeLoop` stays OFF the root barrel
  (core-surface pins that) — the tracer deep-imports the consensus sub-barrel.
- `createCore` threads genesis `chainId` into the loop; `announceAddresses`
  deliberately unset at that layer (the listen/relay address source is the
  8.5 host wiring). Gossip validation + relay + block anchoring work without
  it; only own-publish waits for 8.5.
- Tracer rows: 12 (applyBlock matrix ×8 incl. throwing-listener + no-context
  + over-budget-count-first + undecodable; loop two-lifetime shared-store
  tracer; forged-never-relayed/never-anchored; no-chainId pre-8.3 pin; real
  adapter envelope round-trip on the announcements class, memory transport).
- Suite: 311 tests / 46 files root, app 27/6 green; typecheck green.
- Review loopback 1 (see triage log): syncChain scope threading (+2 rows →
  313/46 final), forged-row tightening, exact relay-once pin, MAX_MULTIADDRS
  slice at own-announce, emission provenance note.

## Plan Change Log

- 8.3 review loopback 1: `sync.ts` was not in the Code Map — the plan froze
  applyBlock's scope rule without carrying it to the SYNC caller (bad_plan,
  patched same commit): `SyncChainParams.discovery?` forwards the scope.
- DEFERRED (triage #3): per-window revalidation of the adapter's append-only
  announcements inbox is O(history) — a permissionless-key flood grows it.
  The tickets class has the identical shape since 6.1 (accepted precedent);
  one shared cursor/prune design should cover both in an epic-9 hardening
  ticket, not half of it here.

## Review Triage Log

| # | Finding (quick lens) | Verdict | Route | Action |
|---|----------------------|---------|-------|--------|
| 1 | `syncChain` applies without discovery scope → sync stalls at first announcement block | high, real | patch | `SyncChainParams.discovery?` threaded into `applyBlock`; 2 new rows (SYNC_ANNOUNCED_CATCHUP / SYNC_NO_SCOPE) |
| 2 | FORGED loop row used a future-slot forgery — freshness masked the signature gate; vacuous uniqueness assert | medium, real | patch | forgery now fresh-window (0..32) + corrupt sig; asserts C never relayed AND never anchored, A proves liveness |
| 3 | Inbox revalidation grows with history (flood DoS, quadratic CPU) | medium, real but cross-cutting | defer | same shape as the tickets class since 6.1 — one shared fix in epic-9 hardening (Change Log) |
| 4 | Relay-once pinned only as an upper bound | low, real | patch | relayed set == distinct inbox keys EXACTLY (both directions) |
| 5 | `addrs.length <= MAX_BLOCK_ANNOUNCEMENTS` conflates per-block budget with per-record ceiling; silent never-announce past 8 addrs | low, real | patch | exported `MAX_MULTIADDRS`; own announce slices to the record ceiling (presence stays alive) |
| 6 | Emitted records = canonical decode, may differ byte-wise from a non-canonical anchored blob | low, by-design | rejected | every node decodes identically (determinism holds); 8.4 consumes attested FIELDS, the chain anchors the bytes — provenance note added at the emission site |
