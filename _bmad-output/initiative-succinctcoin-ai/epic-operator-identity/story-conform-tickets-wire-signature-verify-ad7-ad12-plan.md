---
ticket: "3"
title: "Conform tickets to drawWindow + wire signature verification (AD-7 / AD-12)"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "bf3ef884e03521dcd40f890e35b2aa3553e0da2b"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [E2]
context:
  - packages/core/src/consensus/verify-draw.ts
  - packages/core/src/consensus/draw.ts
  - packages/core/src/consensus/miner.ts
  - packages/core/src/consensus/sim.ts
  - packages/core/src/consensus/index.ts
  - packages/core/src/index.ts
  - packages/core/src/identity/identity.ts
  - packages/core/test/consensus-verify-draw.test.ts
  - packages/core/test/simulation.test.ts
  - packages/core/test/epic-end-to-end.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.3 Conform tickets to drawWindow + wire signature verification (AD-7 / AD-12)

## Story of truth

Conform the real proto `Ticket` to the draw input set and wire the 4.2
identity-bound ticket-signature check into block acceptance, so a block is
accepted **only if the winner ticket verifies the draw AND carries a valid
signature**. The conformance and the signature check are **ONE cohesive
acceptance-path seam** — a real ticket is accepted iff it conforms to the draw
**and** its signature verifies — and are tested together. The signature check is
**ADDITIVE**: it composes with epic-3's `verifyDraw` and does **not** weaken it,
so epic-3's `verify-draw` (12), `sim` (5), and `e2e` (5) suites — which use
**empty-signature** tickets and call `verifyDraw` directly — **stay green**.

This is a NEW-MODULE story (one new `src/consensus/accept-winner.ts` + additive
barrel re-exports + one new test file). It does **NOT** change `verify-draw.ts`
(the `verifyDraw` seam stays byte-identical in behavior — the epic-3 suites
depend on it), `draw.ts` (the draw is imported, never re-implemented — AD-7),
the proto, `ports.ts`, or any identity module. It is the acceptance seam that
**4.8** (multi-identity sim) and **4.10** (closing suite) drive, and the place
the **epic-3 residual replay** (3.4/3.7 note) is closed in the acceptance path.

## The epic requirement this delivers (E2, AD-7 / AD-12)

- **Conformance (AD-7)** — a real proto `Ticket` maps to the draw input set
  `DrawTicket { identityId, nonceCommitment }` for `drawWindow`; the draw is
  **imported, never re-implemented**.
- **E2 (AD-12)** — block acceptance requires the winner ticket to carry a valid
  identity-bound signature over the exact AD-12 digest; a block reusing a
  winner's **public** ticket (a valid commitment but an invalid/empty signature)
  is **rejected**.
- **ADDITIVE** — the signature check composes with `verifyDraw` (neither alone is
  sufficient); epic-3's `verify-draw` (12), `sim` (5), and `e2e` (5)
  empty-signature suites stay green.

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — A NEW acceptance seam, not a `verifyDraw` change.** The ticket's
  "standalone acceptance gate composing with `verifyDraw` (leaving `verifyDraw`
  unchanged) vs an extension of it" → **a standalone gate that composes with
  `verifyDraw` unchanged**. New `src/consensus/accept-winner.ts`:
  (a) `protoTicketToDrawTicket(ticket: ProtoTicket): DrawTicket` — the
  **conformance**: `{ identityId: ticket.identityId, nonceCommitment:
  ticket.nonceCommitment }` (imports `DrawTicket` from `./draw.js`; the
  proto's `challenge`/`windowIndex`/`signature` fields are owned by
  verification, not the draw — the draw consumes exactly these two, AD-7);
  (b) `acceptBlockWinner(block, acceptedTickets: ReadonlyArray<ProtoTicket>,
  weights, challenge): boolean` — the **ONE cohesive acceptance-path seam**:
  it conforms `acceptedTickets` → `DrawTicket[]`, calls `verifyDraw` (the draw
  gate, IMPORTED from `./verify-draw.js` — UNCHANGED), decodes `block.winnerTicket`
  and verifies its AD-12 signature via `verifyTicketSignature` (IMPORTED from
  `../identity/index.js`), and returns `true` iff **both** hold. Because
  `verifyDraw` is left byte-identical and the epic-3 suites call `verifyDraw`
  (not `acceptBlockWinner`), they stay green by construction.
- **D2 — The signature check is ADDITIVE (composes, never overrides).**
  `acceptBlockWinner` = `verifyDraw(block, conformed, weights, challenge) &&
  verifyTicketSignature(winner.identityId, { windowIndex, challenge,
  nonceCommitment }, winner.signature)`. A valid signature does NOT rescue a
  block the draw rejects (the draw still gates); a passing draw does NOT rescue a
  block with a bad signature (the sig still gates). Neither check alone is
  sufficient — they compose. This is what closes the **residual replay**: the
  3.4 commitment-binding closes every forgery EXCEPT reusing the winner's EXACT
  public ticket (valid commitment) — that case now fails the AD-12 signature
  check (an unselected node can't forge the winner's signature, 4.2).
- **D3 — The winner ticket's signature fields (proto → `TicketFields`).**
  `acceptBlockWinner` decodes `block.winnerTicket` (the same protons decode
  `verifyDraw` uses — a corrupt ticket is a malformed block, the seam's only
  throw path, `DrawError` `SC-CONSENSUS-2`), and feeds the 4.2 verifier the
  proto's `identityId` (hex string), `windowIndex` (the proto `int64` bigint —
  `verifyTicketSignature`'s `coerceWindow` handles bigint), `challenge` (raw
  bytes), `nonceCommitment` (raw bytes), and `signature` (raw bytes). The digest
  is the 4.2 EXACT AD-12 one (imported — never re-implemented).
- **D4 — Reject = a normal `false` (the `verifyDraw` convention).**
  `acceptBlockWinner` returns `false` when the draw rejects OR the signature
  fails (including an empty/foreign/tampered signature); it throws `DrawError`
  `SC-CONSENSUS-2` ONLY for a `block.winnerTicket` that fails `Ticket.decode`
  (a malformed block) — the same single throw path as `verifyDraw`.
- **D5 — Mined test blocks carry SIGNED winning tickets; the epic-3 sim/e2e are
  UNTOUCHED.** The 4.3 tests build real blocks (via `mineBlock`, a real PoW)
  whose `winnerTicket` is a **signed** proto ticket (the winner's keypair signs
  it with the 4.2 `signTicket`), and drive them through `acceptBlockWinner`.
  The epic-3 `sim.ts` / `epic-end-to-end.test.ts` / `consensus-verify-draw.test.ts`
  are NOT modified — they call `verifyDraw` with empty-signature tickets and stay
  green. (4.8 wires signed tickets into the sim; that is a separate story.)
- **D6 — No big.js; the draw is imported (AD-7); no proto change.** `src/consensus`
  still imports no `big.js` (the no-float guard stays green); `drawWindow` +
  `DrawTicket` are imported from `./draw.js` (never re-implemented); the proto
  `Ticket` already has the `signature` field (4.2 confirmed it is not a blob) —
  4.3 adds no field (AD-12).
- **D7 — Threat model (what the signature closes; scope note for review).**
  The AD-12 digest is **pinned by the spine** to the ticket fields
  (`identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment`) — it does
  **not** include the block's PoW nonce. Separately, `applyBlock` (3.6) credits
  the reward to the **winner IDENTITY** (`MINT_ID → winner`), not to the miner.
  So the signature's role in this protocol is **proof-of-ownership of the
  winning identity** (only the identity holding its key can mint a valid
  winning ticket), and the "residual replay" this story closes is the one the
  epic names: an **unselected node that has the winner's PUBLIC ticket fields**
  (`identityId` + `nonceCommitment` + `windowIndex` + `challenge`, all readable
  off the chain) **but does not hold the winner's key**, so it cannot produce a
  valid signature — its block (empty / forged signature) is rejected, while the
  draw gate alone (`verifyDraw`) would have passed. 4.3 implements exactly that
  seam (draw gate AND signature gate, composed); it does NOT change the pinned
  AD-12 digest, and it does NOT claim to bind the signature to the block nonce
  (that would be a spine-level protocol change, out of scope here).

## Frozen I/O matrix (each row a passing test)

Shared deterministic fixture (per window): N identities with **fixed seeds**
(e.g. seed `0x00..0x1f`, `0x42`-filled, `0x99`-filled — 4.2's derivation),
**fixed weights** (e.g. `[5n, 3n, 1n]`), the window challenge from
`deriveWindowChallenge(parentHash, slot)`, and each identity's **signed** proto
`Ticket` (`identityId`, `windowIndex=slot`, `challenge`, `nonceCommitment`,
`signature = signTicket(keypair, {…})`). `drawWindow` (over the conformed set)
selects the winner; the test builds a real mined block (`mineBlock`) for the
winner with `winnerTicket = Ticket.encode(winnerProtoTicket)`.

| Row | Input | Expected |
|-----|-------|----------|
| ACCEPT_SIGNED_WINNER | a real mined block whose winner ticket verifies the draw AND carries the winner's valid AD-12 signature (the signed ticket is in the accepted set) | `acceptBlockWinner(block, accepted, weights, challenge)` → **`true`** — the full positive path: the real ticket conforms to the draw, the draw verifies, and the signature verifies (composed) |
| ACCEPT_CONFORMS_TO_DRAW | a real proto `Ticket` → `protoTicketToDrawTicket`; the conformed set drives the draw | the conformed `DrawTicket` is **exactly** `{ identityId, nonceCommitment }` (the two draw-input fields; `challenge`/`windowIndex`/`signature` are NOT draw inputs); `drawWindow` (IMPORTED, never re-implemented) over the conformed set selects the same winner the block claims — the conformance never re-implements the draw (AD-7) |
| ACCEPT_SIG_REJECTS_REPLAY | a block reusing the winner's **PUBLIC** ticket (a valid commitment, the draw passes) but with an **EMPTY** signature (the unselected node cannot forge it) | `acceptBlockWinner` → **`false`** while `verifyDraw(block, conformed, weights, challenge)` → **`true`** (isolates the signature as the reject) — the **epic-3 residual replay is closed in the acceptance path** |
| ACCEPT_DRAW_GATES_OVER_SIG | a block whose winner ticket carries a **VALID** signature, but the draw rejects (the signed ticket is NOT in the accepted set, OR the winner is not the draw-selected winner) | `acceptBlockWinner` → **`false`** while `verifyTicketSignature(…)` → **`true`** (isolates the draw as the reject) — a valid signature does NOT override the draw gate (the two compose) |
| ACCEPT_TAMPERED_SIG_REJECTED | a real signed winner block, but the winner ticket's `signature` is (a) one byte flipped, (b) truncated (63 bytes), or (c) a FOREIGN identity's key over the same four fields | every tampered/foreign signature → `acceptBlockWinner` **`false`** (the wired AD-12 signature check rejects tampering in the acceptance path, exactly as 4.2 does standalone) |

## Tasks

- [ ] Add `src/consensus/accept-winner.ts` — `protoTicketToDrawTicket(ticket) →
  DrawTicket` (the conformance; imports `DrawTicket` from `./draw.js`) +
  `acceptBlockWinner(block, acceptedTickets, weights, challenge): boolean` (the
  ONE cohesive acceptance-path seam: conforms the accepted set, calls
  `verifyDraw` [unchanged, from `./verify-draw.js`] AND verifies the winner
  ticket's AD-12 signature via `verifyTicketSignature` [from
  `../identity/index.js`], returns true iff both; reject = a normal `false`; the
  only throw is a malformed `block.winnerTicket` → `DrawError`
  `SC-CONSENSUS-2`). Extend `src/consensus/index.ts` + additive re-exports in the
  root barrel `src/index.ts`. Do NOT change `verify-draw.ts`, `draw.ts`,
  `protocol.proto`, `ports.ts`, or any identity module.
- [ ] Add `test/consensus-accept-winner.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the draw, the digest, or the
  signature): the 5 matrix rows (ACCEPT_SIGNED_WINNER / ACCEPT_CONFORMS_TO_DRAW /
  ACCEPT_SIG_REJECTS_REPLAY / ACCEPT_DRAW_GATES_OVER_SIG /
  ACCEPT_TAMPERED_SIG_REJECTED), with a deterministic signed-ticket fixture
  (fixed seeds, fixed weights, real mined blocks via `mineBlock`).
- [ ] Run the verification gate; confirm the epic-3 `verify-draw` (12), `sim` (5),
  and `e2e` (5) suites stay green (the ADDITIVE constraint) and the new suite is
  deterministic.

## Acceptance criteria

1. A real proto `Ticket` conforms to the draw input set (`DrawTicket
   { identityId, nonceCommitment }`) via a conformance function; the draw is
   imported (`drawWindow`), never re-implemented (AD-7).
2. A block whose winner ticket verifies the draw AND carries a valid AD-12
   signature is accepted (`acceptBlockWinner` → `true`).
3. A block reusing a winner's **public** ticket (valid commitment) with an
   invalid/empty signature is **rejected** — the epic-3 residual replay is closed
   in the acceptance path.
4. A valid signature does NOT override the draw gate (a draw-rejected block with a
   valid signature is still rejected); a passing draw does NOT override the
   signature gate. The two checks compose — neither alone suffices.
5. A tampered / foreign signature is rejected in the acceptance path.
6. The signature check is **ADDITIVE**: `verifyDraw` is unchanged and epic-3's
   `verify-draw` (12), `sim` (5), and `e2e` (5) empty-signature suites stay green;
   `draw.ts` / `protocol.proto` / `ports.ts` / the identity modules are UNCHANGED;
   no `big.js` in `src/consensus`.

## Never

- NEVER change `verifyDraw`'s behavior or signature (the epic-3 suites depend on
  it; 4.3 adds a NEW seam that composes with it, not a modification).
- NEVER re-implement the draw — `drawWindow` + `DrawTicket` are imported from
  `./draw.js` (AD-7); the conformance maps a proto ticket to the draw input set,
  it does not compute the draw.
- NEVER weaken `verifyDraw` or bypass it — `acceptBlockWinner` requires the draw
  to pass AND the signature to verify (both).
- NEVER let a valid signature override the draw gate or a passing draw override
  the signature gate — the two compose.
- NEVER re-implement the AD-12 digest or the signature — `verifyTicketSignature`
  is imported from the identity module (4.2 owns it).
- NEVER modify the epic-3 `sim.ts` / `consensus-verify-draw.test.ts` /
  `epic-end-to-end.test.ts` (they use empty-signature tickets + `verifyDraw` and
  stay green; wiring signed tickets into the sim is 4.8).
- NEVER import `big.js` in `src/consensus` (AD-5 / the 2.5 no-float guard).
- NEVER change the proto `Ticket` message (AD-12).

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **173 prior + 5 new = 178 tests,
  24 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.3 adds no proto.
- **ADDITIVE constraint (the HARD one):** `corepack pnpm test
  consensus-verify-draw` → **12 passed**; `corepack pnpm test simulation` →
  **5 passed**; `corepack pnpm test epic-end-to-end` → **5 passed** — all
  UNCHANGED (the empty-signature suites stay green; the signature check composes
  with `verifyDraw`, it does not weaken it).
- Determinism: run `corepack pnpm test consensus-accept-winner` TWICE — both pass
  with the identical acceptance outcomes.
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]`).

## Plan Change Log
- Pre-implementation (orchestrator): added **D7** (threat-model scope note) to
  preempt a review surprise — the pinned AD-12 digest covers the ticket fields
  only (not the block PoW nonce); `applyBlock` (3.6) credits the reward to the
  winner IDENTITY, so the signature is proof-of-ownership of the winning
  identity and the closed replay is the unselected-node-with-public-fields case.
  No AC / matrix / Never change; the design notes only.

## Review Triage Log
| Lens | Finding (short) | Verdict | Action |
|------|-----------------|---------|--------|
| quick | (none) | n/a | The quick lens returned 0 findings; it independently verified every scrutiny question (a)–(j) with evidence: strictly additive (only the two barrels + new module + new test touched; `verify-draw.ts`/`draw.ts`/`protocol.proto`/`ports.ts`/identity modules/`sim.ts`/the three epic-3 test files byte-identical); AD-7 conformance returns exactly `{identityId, nonceCommitment}` with `drawWindow` imported never re-implemented; the two gates compose (`drawOk && sigOk`, no short-circuit) and each is isolated (verifyDraw true + accept false / verifyTicketSignature true + accept false); the residual replay is closed (public ticket + empty sig rejected); no big.js in `src/consensus` (no-float 6/6); TS 5.9 typed-array bridging correct (typecheck clean); AD-3 determinism (5/5 twice); the single throw path + the belt-and-suspenders decode honestly documented. No action required. |

## Implementation Notes

**Built (4.3).** One new module `src/consensus/accept-winner.ts` with exactly two
exports: `protoTicketToDrawTicket(ticket) → { identityId, nonceCommitment }` (the
AD-7 conformance — the two draw-input fields only; the draw is imported, never
re-implemented) and `acceptBlockWinner(block, acceptedTickets, weights,
challenge): boolean` — the ONE cohesive acceptance-path seam: conforms the
accepted set, calls `verifyDraw` (imported from `./verify-draw.js`, UNCHANGED),
decodes `block.winnerTicket` (the seam's only throw path, `DrawError`
`SC-CONSENSUS-2`), and verifies the winner's AD-12 signature via
`verifyTicketSignature` (imported from `../identity/index.js` — the digest is
never re-implemented). Returns `true` iff **both** gates hold; a reject (either
gate, incl. empty/foreign/tampered sig) is a normal `false`. Additive barrel
re-exports in `src/consensus/index.ts` + `src/index.ts`. One new test
`test/consensus-accept-winner.test.ts` (root-barrel imports only; deterministic
signed-ticket fixture: seeds `0x00..0x1f`/`0x42`/`0x99`/`0x55`, weights
`[5n,3n,1n]`, fixed non-zero 32-byte parent, per-identity sha256 commitments,
real `mineBlock` blocks) covering the 5 matrix rows. `verify-draw.ts` /
`draw.ts` / `protocol.proto` / `ports.ts` / identity modules / `sim.ts` / the
three epic-3 test files are UNCHANGED (byte-identical).

**Verification gate (all exact outputs).**
- `corepack pnpm test consensus-accept-winner` → **5 passed** (run twice — both
  `5 passed`, identical acceptance outcomes).
- **ADDITIVE (hard) constraint:** `corepack pnpm test consensus-verify-draw`
  → **12 passed**; `corepack pnpm test simulation` → **5 passed**;
  `corepack pnpm test epic-end-to-end` → **5 passed** — all UNCHANGED.
- `corepack pnpm test` → **178 passed (178), 24 files** (173 prior + 5 new).
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (**PROTO_OK** — 4.3 adds no proto).
- AD-5 guard intact: `corepack pnpm test no-float-guard` → **6 passed** (no
  `big.js` import in `src/consensus`).
