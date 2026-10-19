---
id: story-invitation-render-parse-verify-join-seam
ticket: epic-ipv6-invite-network #2 (story)
status: built
covers: [R2, E1, E3]
---

# 9.2 — Invitation: render, parse, verify (sig + freshness + ticket liveness), join seam

## Shape

An invitation IS a `PeerAnnouncement` (8.2) plus proof its signer is alive on the
chain right now. One canonical text form, verified before anything is dialed.

## Decisions pinned at plan time

1. **Wire format:** `scinvite:v1:` + base64url (no padding) of the canonical
   `PeerAnnouncement` proto bytes. Copy-paste tolerant: parse strips ALL
   whitespace anywhere in the input; case-insensitive prefix. Text-only QR
   decision PINNED: no QR lib exists in-tree (lockfile checked) → text-only,
   no new dependency.
2. **Invite is a fifth source class.** The book's taxonomy grows
   `block | invite | log | dns | hint` with rank between block and log and
   REQUIRED_INTRODUCTIONS 0 ("verified at the door": signature + freshness +
   chain + ticket liveness IS the trust event — an invitation cannot be
   squatted because a zero-ticket identity fails verification outright).
   `blockRef` stays exactly-block-provenance (reorg retraction untouched);
   invite entries carry no blockRef. The ladder's artifact rung keeps its
   documented "never fabricate a blockRef" rule — it does NOT change.
3. **Liveness = winner tickets in applied blocks.** `verifyInvite(text, ctx)`
   where ctx = `{ currentSlot, expectedChainId, hadRecentTicket(identityId, currentSlot), lookbackSlots? }`
   (default 32). Pure + caller-supplied getter (AD-3): the core boot supplies a
   getter that scans back `lookbackSlots` blocks from the store head and decodes
   each block's `winnerTicket.identityId`. Gossiped tickets are NOT liveness —
   they are un-anchored; only chain-applied winner tickets prove participation.
4. **Reject taxonomy (pinned, distinct):** parse stage → `malformed-invite`
   (prefix/base64/decode failures collapse here); announcement validator keeps
   ALL its own reasons verbatim (`bad-signature`, `expired`, `not-yet-valid`,
   `chain-mismatch`, `unsupported-address`, …); liveness last → `no-recent-ticket`.
   Verification NEVER yields a dial target on failure (result union, no throw).
5. **Join seam = file + live IPC.** `<userData>/invite.txt` (one invite per
   line, `#` comments, bounded 8 lines) read at boot beside bootstrap.txt;
   verified invites ingest invite-grade and are dialed fire-and-forget (the
   ladder rung pattern). Renderer paste → new command writes the file then
   applies immediately (no restart). Copy side: node-loop gains
   `onSelfAnnouncement?` (fires after own record publishes) → core exposes
   `getInvite()` (latest self-announcement encoded; null until first announce
   window) → read-API. Boot log prints the renderable invite once present
   (replaces/augments the dial-me line).

## Work items

1. **`core/src/discovery/invitation.ts`** (pure): `encodeInvite`, `parseInvite`
   (whitespace-tolerant), `verifyInvite` (8.2 validator + liveness), reason union,
   `INVITE_PREFIX`. Unit suite: round-trip golden, whitespace tolerance, every
   reject row incl. squatter (`hadRecentTicket → false`).
2. **Book:** add `invite` class (rank 3.5→ renumber to 4/3/2/1/0), eligibility 0
   intros, eviction order intact; rows: invite entry dial-eligible immediately,
   worse() ordering pins invite between block and log, self-exclusion applies.
3. **`boot-files.ts`:** `readInviteFile(path)` → never-throw, bounded, comment-
   stripping lines (mirrors hints reader); ladder report gains `invites:
   {found, verified, rejected}` counts only (AD-9).
4. **Core boot (`index.ts`) + `ports.ts`:** `DiscoveryPorts.inviteFilePath?` +
   `onSelfInvite?`; after the ladder, verify+ingest+dial invites with the
   store-scanning liveness getter; wire `onSelfAnnouncement → encodeInvite →
   onSelfInvite`; `getInvite()` on the core.
5. **node-loop:** `onSelfAnnouncement?(record)` option, fired post-publish for
   own record only (one call per successful announce window).
6. **App:** ipc-channels gain `IPC_COMMANDS.applyInvite`, `IPC_READ.invite`;
   core-host tracks latest invite string + `applyInvite(text)` (validate text →
   write file → verify/ingest/dial through a host-injected port); glue wires
   file path + handlers; preload/renderer minimal affordances (copy box, paste
   + Join button) — no key material anywhere (E3 scan updated).
7. **Tests:** core unit + boot integration (memory transport: invite file →
   book invite-grade + dial attempted; squatter row → rejected, never dialed);
   app seam rows (paths, IPC table scan); README untouched (9.5 owns docs).

## Gates

build PROTO_OK (no proto change expected) → typecheck → root suite → app suite;
quick-lens review; commit.

## Build log

Implemented as designed. New pure module `discovery/invitation.ts` (format,
base64url codec, parse/verify), boot rung 0 in `boot-files.ts`, core surface
`getInvite`/`applyInvite` + `createInviteLiveness` factory in `index.ts`, node
loop `onSelfAnnouncement` hook, app IPC/preload/renderer seam.

- **Empty-chain liveness rule (pinned).** `createInviteLiveness` returns an
  allow-all probe while the chain has NO real (non-tracer) block winner: a
  wiped node joining from scratch cannot verify liveness, so trust rests on
  the social channel + the full 8.2 validator gate (sig/freshness/chainId/
  address-policy). Once a real winner is applied the probe goes STRICT (winner
  set of APPLIED blocks over a 32-slot lookback; gossiped tickets are never
  liveness evidence). Documented in the factory docstring + core-ladder rows.
- **Dynamic port (user requirement, verified).** Bind `/ip6/::/tcp/0` → OS
  assigns an ephemeral port → `listenAddresses()` reports it resolved with a
  concrete global-v6 IP → policy-filtered into the self-announcement multiaddrs
  → carried verbatim by invites and stored by peers. Live TCP probe confirmed
  OS-assigned port resolution on this host (which has no global v6 face, so it
  honestly announces nothing).
- **Address-book capacity contest (new).** When full, an incoming record is
  installed only if strictly better than the current weakest under the
  (class, slotEnd, firstSeenSlot, id) total order — a hint can never displace
  an invite-grade observation. Loser dropped silently (ok:true, as self-
  exclusion).
- **Review findings fixed.** (1/major) runtime `applyInvite` no longer dials a
  self-invite (self-check before ingest/dial; pinned with a dial-spy row); the
  boot path already skipped self. (2) two-phase `applyInvites` (verify pass is
  pure-CPU, then store+dial) bounds the boot liveness snapshot's staleness to
  the verify pass — dial timeouts can no longer stretch it. (3) lookback
  symmetry documented at the probe call site. (4) invite persistence prepends a
  newline when an existing file lacks a trailing one (no line splicing). (6)
  renderer↔core reject-reason parity pinned by a compile-time mutual-
  assignability check in core-host.test.ts. (7) `MAX_INVITE_TEXT_LEN` (4 KB)
  caps parse + boot-file reads against megabyte base64 decode.
- **Test gap closed.** Added a runtime remote-valid `applyInvite` row (invite-
  grade ingest + first-success dial on an empty/allow-all chain).

Deferred to 9.5: libp2p connectionGater for identify/mDNS-initiated dials;
bootstrap policy-drop diagnostics; README/docs pass (9.5 owns docs). Custom
`inviteLookbackSlots` wiring into the probe is latent (no port sets it today).

Counts after 9.2: root 405/56, core 368/49, app 37/7.
