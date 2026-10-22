---
ticket: 5
title: Fallback-ladder boot + Amnesiac Boot Proof + discovery lint
baseline_revision: dd8902a
status: done
route: full
review: quick
covers: [R1, R4, E2, E3]
---

# Ticket 8.5 — Fallback-ladder boot + Amnesiac Boot Proof + discovery lint

## Summary

Wire the fallback ladder (design §"The Ladder") on the 7.2 seam so a node with
NO live peers still finds its way: rung 1 mDNS (shipped, 7.2 — reported),
rung 2 a LAN shared address-book FILE whose records enter the book
hint-grade (never dialed without vouchs), rung 3 a block-grade artifact FILE
of signed announcement records read at boot and dialed directly after
self-validation (the epic Notes MVP: one record from a local file — exactly
what the Amnesiac Boot Proof consumes), rung 4 announcements from applied
blocks (shipped 8.3/8.4 via `chainId` — reported). Plus: the Amnesiac Boot
Proof as a deterministic memory-transport sim, and a discovery lint CI row
(repo-wide scan failing on hardwired multiaddrs / seed endpoints outside
test fixtures) with the E3 key-material scan of preload/renderer.

## Frozen decisions (unknowns resolved here)

- **Artifact format (rung 3):** JSON `{version: 1, blobs: [hex...]}` — each
  hex is a canonical `PeerAnnouncement` wire blob (proto-encoded), so every
  record self-validates via decode + `validatePeerAnnouncement(chainId,
  currentSlot)`. Atomic write (tmp + rename). Reader NEVER throws on junk
  (missing file = `{found:false}`; bad entry = skipped count); bounded to
  `MAX_ARTIFACT_RECORDS = 64`. Module: NEW
  `packages/core/src/discovery/boot-files.ts` — fs allowed HERE, documented
  (precedent: the genesis loader; this module is NOT in any purity-scan set;
  the ladder's PURE parts stay pure — the reader/writer take explicit paths).
- **LAN hints file (rung 2):** same record format (`blobs`), OS-appropriate
  shared default via a pure `defaultLanBookPath(platform, env, sharedDir)`
  (override `SUCCINCTCOIN_LAN_BOOK`; darwin `/Users/Shared`, linux
  `/var/tmp` — world-writable, unlike `/srv` (a shared LAN book must be
  writable by every user on the segment), win32 `C:\Users\Public`, + `/succinctcoin/address-book.json`),
  overridable by the host. Records ingest into the book as **hint-grade** —
  stored, NOT dialed; poison fail-soft is automatic (hint needs 3 vouchs).
- **Artifact records bypass the book for dialing:** a file carries no block
  proof, so the book's `block` class (needs a real `blockRef`) cannot be
  fabricated from one. The ladder returns artifact records as DIAL TARGETS
  after validation ("read before dial" on own signature); dial failures are
  reported, never fatal. (Vouchs arrive later via gossip/introductions and
  enter the book through the normal rungs.)
- **Ladder seam:** NEW pure core orchestrator `runBootLadder(opts)` in
  `boot-files.ts` — explicit deps `{hintsFilePath?, artifactFilePath?,
  chainId, currentSlot, book?, dial?}` → `LadderReport {mdns, hints:
  {found, ingested, skipped}, artifact: {found, targets, skipped}, blocks}`.
  Counts only — AD-9-safe (no keys, no PII beyond public multiaddrs). The
  app seam (`packages/app/src/main/discovery-ladder.ts`, pure, NO electron)
  supplies OS paths; `index.ts` (electron glue) passes `app.getPath(...)` +
  a `dial` bound to the net adapter through `CoreHostOptions.discovery` →
  `CorePorts.discovery`.
- **createCore wiring:** `CorePorts.discovery?: {hintsFilePath?,
  artifactFilePath?, announceAddresses?: () => string[], onLadderReport?}`.
  When set + after genesis: run the ladder at `currentSlot = headSlot()`,
  fire-and-forget dials for artifact targets, report via callback. The loop
  gets `announceAddresses` (host hook) and — when `chainId` is present — a
  core-owned `createAddressBook({chainId})` exposed as
  `CoreInstance.addressBook?` (8.4's loop already builds its own book; the
  instance-level one is what the ladder + host observe). mDNS rung = report
  field only (config truth lives in `defaultNetConfig`).
- **Listen addresses:** NEW `NetAdapter.listenAddresses(): string[]` (5.4
  extension) — real: libp2p `getMultiaddrs()` strings; memory: the node's
  own listen id. The app wires `announceAddresses: () => net.listenAddresses()`
  so announcements carry REAL dialable addresses (the 8.3/8.4 "unset at this
  layer" note resolves here).
- **Amnesiac Boot Proof constants:** K = 3 eligible peers, distinct-/24 ≥ 3,
  boot budget ≤ 40 windows (test constants; "<30 s" is wall-clock language —
  the deterministic analog is a bounded window count, AD-3). Sim: healthy
  mesh P1..P7 (memory transport, real loops, `introduce:true`, fake
  `/ip4/10.<a>.<b>.<c>/tcp/4001` announce addresses across ≥3 /24s) → take
  ONE block-grade record from an APPLIED block → wiped node W (fresh store +
  identity, NO mesh history) gets exactly that one artifact record, dials
  its author via the simulated `/ip4 → /memory` dial map, syncs, and must
  reach ≥K dialEligible entries across ≥3 distinct /24s within budget.
- **Discovery lint:** pure scanner `scanForHardwiredEndpoints(path, text)` →
  findings; patterns: `/ip4/` with a non-zero first octet (LAN_LISTEN_ADDRESS
  `/ip4/0.0.0.0` allowed), `/dns4/`, `/ipfs/Qm`, `seed.succinctcoin`. CI row
  = root vitest file scanning the REAL repo (walk `packages/*/src`, skip
  tests/fixtures/dist/docs) asserting ZERO findings, plus an embedded
  fixture-violation row asserting the scanner FIRES. E3 rows: preload +
  renderer sources contain none of `deriveIdentityKeypair|createIdentityFromSeed|
  signTicket|signPeerAnnouncement|signIntroduction`.

## Tasks

- [x] T1 — `discovery/boot-files.ts`: artifact/hints reader+writer (atomic,
  bounded, never-throws), `defaultLanBookPath`, `runBootLadder` →
  `LadderReport`; exports via `discovery/index.ts` + root barrel. Unit tests
  `discovery-boot-files.test.ts` (round-trip, junk rows, missing-file rows,
  poisoned-hint stored hint-grade + NOT dialEligible, artifact target rows,
  atomicity (tmp cleaned), cap row).
- [x] T2 — `NetAdapter.listenAddresses()` (real + memory); adapter test row.
- [x] T3 — `CorePorts.discovery` + createCore ladder run after genesis
  capture + loop `announceAddresses` wiring; `CoreInstance.addressBook?`;
  rows in the existing core integration suite style (`core-ladder.test.ts`:
  boot with hints+artifact files in a tmp dir, report flows, dial called for
  targets only).
- [x] T4 — app seam: `main/discovery-ladder.ts` (pure path wiring) +
  `index.ts` electron glue (`app.getPath`, `net.listenAddresses`); rows in
  the existing app main suite (seam purity: no electron import in the pure
  module; defaultLanBookPath per-platform rows).
- [x] T5 — Amnesiac Boot Proof sim `discovery-amnesiac-boot.test.ts`
  (constants above; bounded event-driven waitFor, distinct-/24 assertion via
  the REAL book's dialEligible).
- [x] T6 — `discovery-lint.test.ts`: real-repo scan ZERO + fixture-violation
  FIRES + E3 preload/renderer rows. README status row.

## Verification

- `corepack pnpm build` (PROTO_OK), `corepack pnpm typecheck`, root suite,
  app suite — all green headless.
- Lint CI row passes on the repo; fixture violation detected.
- Poisoned-hint fail-soft: LAN-file record stored hint-grade, never
  dialEligible without 3 vouchs.

## Implementation Notes

Shipped as planned; gates at commit: build PROTO_OK, typecheck, root suite
379/54 files, app suite 32/7. Files: `discovery/boot-files.ts` (codec +
ladder), `ports.ts` (`DiscoveryPorts`), `index.ts` (createCore wiring: book
with self-exclusion, fire-and-forget ladder, loop discovery opts,
`addressBook` getter), `events/types.ts` (`CoreDiscoveryAccess`),
`net/adapter.ts` (`listenAddresses()`), app `discovery-ladder.ts` + glue,
tests `discovery-boot-files` / `core-ladder` / `discovery-ladder` (app) /
`discovery-amnesiac-boot` / `discovery-lint`, README count row.

The Amnesiac Boot Proof (the ticket's headline): a wiped node (fresh seed,
empty everything) boots with ONLY an artifact file, dials its single author
through a simulated dial map, and reaches >=3 dial-eligible entries across
>=3 distinct /24s within 60 slots — measured through the REAL book's
`dialEligible`, zero hardwired peers (R1). Test fakes serve `getBlock(head)`
(the 8.4 lesson) or loops pin to one window.

## Plan Change Log

- LAN shared-book Linux path frozen as `/var/tmp` (plan originally said
  `/srv`; `/srv` is not world-writable, defeating a cross-user shared file).
  Doc amended pre-commit (review F4).
- Added `AddressBookOptions.selfIdentityId` (not in plan): the wiped node's
  own self-announcement anchors in its own mined block and re-enters via
  rung 4; self must never occupy book capacity or appear in `dialEligible`
  (`discovery-amnesiac-boot` self-exclusion assertion). Accepted-and-ignored
  like a stale record; createCore passes `ports.identity?.identityId`.
- Sim wires rung 4 (`onAnnouncements`, block-grade with real blockRefs)
  exactly as createCore does: with lagging honest chains, every gossiped
  Introduction is `future-observation`-rejected early, so hint promotion is
  NOT the boot path — block-class entries (0 vouches) are. Hints/intros
  still flow and add vouchs; the proof must not depend on them.
- Review fixes post-lens: slash24 regex captured full host not /24 (proof
  assertion was weaker than documented — fixed); tmp unlink on failed write/
  rename; hints-rung self count = skipped; `DiscoveryPorts.mdnsEnabled` so
  the ladder report is honest when a host disables mDNS.

## Review Triage Log

Quick lens (context-free, diff packet /tmp). Verdict FIX-FIRST — all fixed
pre-commit, no re-review needed (each fix pinned by a test row or re-run):

- F1 (medium, patch): `slash24()` returned the full host IP, not the /24
  prefix — network-diversity assertion unsound as written. Fixed regex to
  three-octet capture; sim re-greened.
- F2 (low, patch): ladder report hardcoded `mdnsEnabled: true` while comment
  claimed config truth → added `DiscoveryPorts.mdnsEnabled` (default true).
- F3 (low, patch): `writeAnnouncementFile` orphaned the tmp file when write/
  rename fails → unlink-on-error + new test row (directory at target).
- F4 (low, patch): plan doc froze `/srv` while code/tests ship `/var/tmp` →
  doc amended with rationale.
- F5 (low, patch): hints rung counted self-records as `ingested` while the
  book ignores them and the artifact rung counts `skipped` → self pre-check
  in the hints loop + test row.
Clean per reviewer: AD-3/4/9/10/11 posture, never-throws contract, caps,
lint non-vacuity, self-exclusion field names.
