---
ticket: "6"
title: "Re-attestation every K windows + lapse = lose eligibility"
epic: epic-operator-identity
status: "built"
route: full
baseline_revision: "d519eb4b894a229d02746af50f39a62c2a6fedcc"
review: quick
review_source: pinned
lenses_ran: ["quick"]
review_loop_iteration: 1
covers: [R4]
context:
  - packages/core/src/identity/gate-verifier.ts
  - packages/core/src/identity/identity.ts
  - packages/core/src/identity/index.ts
  - packages/core/src/ports.ts
  - packages/core/src/config/genesis.ts
  - packages/core/src/index.ts
  - config/genesis.json
  - packages/core/test/identity-gate.test.ts
  - packages/core/test/identity-signature.test.ts
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/epic-operator-identity.md
  - _bmad-output/initiative-succinctcoin-ai/epic-operator-identity/tickets.toml
---

# Story Plan — 4.6 Re-attestation every K windows + lapse = lose eligibility

## Story of truth

Make an identity **re-attest every `K` chain-time windows**: its ticket is
**valid only while the current window is at or below the `GateVerifier`'s
`attestedUntilWindow`**; an identity that **laps** (stops re-attesting) **stops
producing valid tickets within `K` windows and loses eligibility** — its tickets
are no longer accepted (the must-hold (d) made concrete: stop re-attesting and
the identity stops being eligible; a compromised gate's fake IDs die within `K`
of the gate being fixed). Re-attestation **extends** `attestedUntilWindow`. `K`
is the genesis parameter `reattestationK` (`100` in `config/genesis.json`) — the
check is **chain-time** (AD-3), **never** the wall clock.

This is a **NEW-MODULE story** in the **identity** domain: one new
`src/identity/reattestation.ts` + additive re-exports (identity barrel + root
barrel) + one new test file. It ships the **pure re-attestation seams** — the
**lapse gate** (an identity is eligible only while `currentWindow ≤
attestedUntilWindow`) and the **re-attestation cadence** (re-attesting at window
`W` extends the deadline to `W + K`) — that **compose with the 4.1
`GateVerifier`** (imported, **never re-implemented**) and that **4.8**
(multi-identity sim) uses to model the re-attestation cadence and the
**4.10** (closing suite) drives end-to-end.

It does **NOT** change the `GateVerifier` (4.1, `gate-verifier.ts`), the
keypair / ticket-signature (4.2, `identity.ts`), the acceptance seam (4.3,
`accept-winner.ts`), the cap (4.4, `acceptance-cap.ts`), the uptime derivation
(4.5, `uptime.ts`), `draw.ts` (3.3), `sim.ts` (3.7), `apply-block.ts` /
`economics.ts` (3.6), the genesis seam (1.6), `protocol.proto`, or `ports.ts`.

## The epic requirement this delivers (R4 / must-hold (d))

- **Re-attest every `K` windows** — an identity's gate credential is valid only
  up to its `attestedUntilWindow`; to keep being eligible it must re-attest
  before the deadline, extending `attestedUntilWindow` (the cadence is `K`
  windows, chain-time, AD-3).
- **Lapse = lose eligibility** — an identity whose credential has **lapsed**
  (`currentWindow > attestedUntilWindow`) is **ineligible**: it stops producing
  valid tickets and loses eligibility within `K` windows of its last
  attestation (must-hold (d)).
- **`K` = genesis `reattestationK`** — a validated genesis integer ≥ 1 (not a
  protocol-logic choice); the check is **chain-time** (AD-3), never the wall
  clock.
- **Compose, don't re-implement** — the deadline comes from the **4.1
  `GateVerifier`** (`attestedUntilWindow`); 4.6 adds the pure lapse gate +
  cadence that read it. The verifier is the **only credential reader** (AD-4).

## Design Notes (decisions — settle the ticket's `unknown`)

- **D1 — A standalone PURE identity-domain module (the seam composes with the
  verifier).** The re-attestation logic lives in NEW
  `src/identity/reattestation.ts` (identity domain — it is about the
  *attestation* lifecycle, not the draw). It exposes:
  - `isEligibleAtWindow(attestedUntilWindow: bigint, currentWindow: bigint):
    boolean` — the **pure lapse gate**: `true` iff the identity's credential is
    still valid at `currentWindow`, i.e. `0n ≤ currentWindow ≤
    attestedUntilWindow`. A lapsed identity (`currentWindow >
    attestedUntilWindow`) → `false` (loses eligibility — must-hold (d)).
  - `reattestationWindow(currentWindow: bigint, reattestationK: bigint): bigint`
    — the **pure cadence**: re-attesting at chain-window `currentWindow` extends
    the deadline to `currentWindow + reattestationK` (the identity is then
    eligible for the next `K` windows, chain-time, AD-3).
  - `verifyReattestation(verifier: GateVerifier, cred: GateCredential,
    windowIndex: number): Promise<{ valid: boolean; attestedUntilWindow: bigint }>`
    — the **seam that composes with the 4.1 verifier** (imported, **never
    re-implemented**): run `verifier.verify(cred, windowIndex)` (the only
    credential reader, AD-4) → on a **lapse** (rejected) or an invalid verifier
    result → the normal `{ valid: false, attestedUntilWindow: 0n }`; on a valid
    result → `{ valid: isEligibleAtWindow(BigInt(result.attestedUntilWindow),
    BigInt(windowIndex)), attestedUntilWindow: BigInt(result.attestedUntilWindow) }`.
  It does **NOT** change the `GateVerifier` (4.1), the keypair (4.2), the draw
  (3.3 — AD-7), the cap (4.4), the uptime derivation (4.5), or the sim (4.8
  wires the cadence + lapse gate into the sim's per-window eligibility).
- **D2 — The lapse gate is the eligibility predicate (chain-time, AD-3).**
  `isEligibleAtWindow` is a **pure** predicate over two chain-time `bigint`s —
  no RNG, no wall clock (AD-3). The boundary is **inclusive**: a credential
  attested to window `T` is valid **through** `T` (the 4.1 verifier's own
  `windowIndex <= attestedUntilWindow` check) and **lapses at `T + 1`**. This is
  the enforceable form of "valid only while the current window ≤
  `attestedUntilWindow`".
- **D3 — The cadence is `reattestationWindow = currentWindow + K` (pure, AD-3).**
  Re-attesting at chain-window `W` sets the new deadline to `W + K`: the
  identity is then eligible for the next `K` windows. This is the "re-attest
  every `K` windows" rule realized as a **pure function** (chain-time, AD-3 —
  no wall clock): an identity keeps its eligibility by re-attesting before/at
  its deadline. The pure function returns the **raw `W + K`**. When the
  identity re-attests **on schedule** (at/after its current deadline `D`) the
  result `W + K` **exceeds** `D` — so on-schedule re-attestation **extends** the
  deadline; an identity that re-attests **early** (well before `D`) can get
  `W + K ≤ D`, so a caller that must guarantee a monotonic deadline applies
  `max(oldDeadline, W + K)` (4.8's sim wiring — the pure function itself does
  not take the old deadline, by design). `K` is the genesis `reattestationK`
  (an integer ≥ 1); it is a **parameter the function receives**, not protocol
  logic.
- **D4 — Compose with the 4.1 verifier; never re-implement it (AD-4 / AD-7
  pattern).** `verifyReattestation` is the **single** place 4.6 reads a
  credential — and it does so **through** `verifier.verify` (the 4.1
  implementation; the verifier is the **only** credential reader, AD-4). 4.6
  adds **no** blob parsing, **no** MAC check, **no** registry check — those all
  stay in `gate-verifier.ts` (4.1). A **lapsed** credential is a **normal**
  `{ valid: false }` (the `verifyDraw` / `GateVerifier` reject convention),
  never an error. This mirrors the 4.3 `acceptBlockWinner` pattern (composes
  with `verifyDraw`, never re-implements it).
- **D5 — `K` and the windows are chain-time integers (AD-3); no big.js (AD-5).**
  `reattestationK` comes from the validated genesis config (an integer ≥ 1, the
  `reattestationK: 100` in `config/genesis.json`). All window math is over
  `bigint` (chain-time window indices) — **no float** (AD-5), **no** `big.js`
  (the no-float guard's `src/consensus` boundary is untouched; this module is in
  `src/identity` and imports **no** `big.js`), **no** `Math.random`, **no** wall
  clock (AD-3). The proto is **unchanged** (no field added — a `Ticket` carries
  at most a credential **hash**, never the blob, per 4.1 / AD-4).
- **D6 — Guards on the inputs (programming errors throw `IdentityError`
  `SC-IDENTITY-2`).** `reattestationK < 0n`, `attestedUntilWindow < 0n`, or
  `currentWindow < 0n` is a **programming error** (a negative window / cadence
  would silently corrupt the eligibility check) → throw `IdentityError`
  `SC-IDENTITY-2` (the identity-domain error, consistent with `identity.ts`).
  `verifyReattestation` itself **never** throws for a lapsed / invalid
  credential — it returns the normal `{ valid: false, attestedUntilWindow: 0n }`
  (a reject is a normal value, not an error, the 4.1 / `verifyDraw`
  convention); it only propagates a verifier result.

## Frozen I/O matrix (each row a passing test)

Shared deterministic fixture (AD-3: no RNG, no wall clock): a fixed identity
`ID = "0" × 62 + "aa"` (64 lowercase hex — the spine id convention), an accepted
gate `"biometric"`, credentials minted by the **IMPORTED** `issueGateCredential`
(4.1), the verifier built by the **IMPORTED** `createOfflineGateVerifier({
acceptedGates: ["biometric"] })` (4.1). Small `K` (`5n`) for crisp bounds; the
genesis `reattestationK` is `100` (used in the cadence-extension row). `K` is
chain-time.

| Row | Input | Expected |
|-----|-------|----------|
| REATT_ELEGIBLE_THROUGH_DEADLINE | `isEligibleAtWindow(attestedUntilWindow, currentWindow)` over `attestedUntilWindow = 10n`: `currentWindow = 10n` (at the deadline) vs `11n` (one past); and `0n` (fresh) | **inclusive** boundary: eligible **through** the deadline — `10n → true`, `0n → true`; **lapses at `T + 1`** — `11n → false` (an identity whose credential is attested to window 10 is eligible at 10, ineligible at 11 — must-hold (d) "valid only while current window ≤ attestedUntilWindow") |
| REATT_REATTES_TODDLE | a credential attested to `10n`, `K = 5n`: at `11n` (lapsed) call `reattestationWindow(11n, 5n)` → new deadline; then re-check eligibility at `11n` under that new deadline | re-attestation **extends** the deadline: `reattestationWindow(11n, 5n) = 16n`; the identity regains eligibility — `isEligibleAtWindow(16n, 11n) = true` (re-attesting at the first lapsed window re-establishes eligibility for the next `K` windows; the new deadline `16n` > old `10n`) |
| REATT_LAPSED_STOPS | a credential attested to `10n`, `K = 5n`, **no** re-attestation: eligibility at `11n`, `15n`, `20n` | the lapsed identity **stops producing valid tickets** and stays ineligible — `11n → false`, `15n → false`, `20n → false` (once lapsed, without re-attestation the identity never regains eligibility — must-hold (d): "a lapsed identity stops producing valid tickets within `K` windows and loses eligibility") |
| REATT_SEAM_COMPOSES_VERIFIER | the **IMPORTED** `verifier.verify(cred, w)` (4.1) for a credential attested to `10n` at `w = 10` (valid) and `w = 11` (lapsed); `verifyReattestation` (the 4.6 seam) at `w = 10` and `w = 11` | the seam **composes with the verifier** (never re-implements it): at `w = 10` → verifier `{ valid: true, attestedUntilWindow: 10 }` AND `verifyReattestation → { valid: true, attestedUntilWindow: 10n }`; at `w = 11` → verifier **rejects** (`{ valid: false }`) AND `verifyReattestation → { valid: false, attestedUntilWindow: 0n }` (a reject is a **normal** value, not an error — the 4.1 convention); the seam's `attestedUntilWindow` is the **bigint** form of the verifier's number |
| REATT_CADENCE_FROM_GENESIS | `reattestationWindow(1000n, 100n)` (the genesis `reattestationK`); the extension vs the previous deadline `1000n`; eligibility continuity when re-attesting at the first lapsed window `1001n` | the cadence uses the genesis `K` (chain-time, AD-3): `reattestationWindow(1000n, 100n) = 1100n`; the new deadline `1100n` **strictly exceeds** the previous `1000n` (re-attestation **extends**); re-attesting at the first lapsed window `1001n` → `reattestationWindow(1001n, 100n) = 1101n` → `isEligibleAtWindow(1101n, 1001n) = true` (continuous eligibility is maintained by re-attesting before/at the lapse; on-schedule re-attestation extends the deadline — the pure function returns the raw `W + K`, and a caller wanting a guaranteed-monotonic deadline applies `max(oldDeadline, W + K)`) |

## Tasks

- [x] Add `src/identity/reattestation.ts` — `isEligibleAtWindow(attestedUntilWindow:
  bigint, currentWindow: bigint): boolean` (the PURE lapse gate: `0n ≤
  currentWindow ≤ attestedUntilWindow`), `reattestationWindow(currentWindow:
  bigint, reattestationK: bigint): bigint` (the PURE cadence: `currentWindow +
  reattestationK`), and `verifyReattestation(verifier: GateVerifier, cred:
  GateCredential, windowIndex: number): Promise<{ valid: boolean;
  attestedUntilWindow: bigint }>` (the seam that COMPOSES with the 4.1 verifier —
  `verifier.verify` is the only credential reader; a lapse / invalid → normal
  `{ valid: false, attestedUntilWindow: 0n }`). All chain-time (AD-3), no
  `big.js` (AD-5); negative window / cadence inputs → throw `IdentityError`
  `SC-IDENTITY-2` (imported from `./identity.js`). Additive re-exports in
  `src/identity/index.ts` + the root `src/index.ts`. Do NOT change
  `gate-verifier.ts`, `identity.ts`, `ports.ts`, `protocol.proto`, the genesis
  seam, any `src/consensus` module, or `config/genesis.json`.
- [x] Add `test/identity-re-attestation.test.ts` (imports from the ROOT barrel
  `../src/index.js` only — never re-implements the draw or the verifier): the 5
  matrix rows (REATT_ELEGIBLE_THROUGH_DEADLINE / REATT_REATTES_TODDLE /
  REATT_LAPSED_STOPS / REATT_SEAM_COMPOSES_VERIFIER / REATT_CADENCE_FROM_GENESIS),
  with a deterministic fixture (a fixed 64-hex identity, an accepted `"biometric"`
  gate, credentials minted by the IMPORTED `issueGateCredential`, the verifier
  from the IMPORTED `createOfflineGateVerifier`; small `K = 5n` + the genesis
  `reattestationK = 100` in the cadence row; `K` chain-time).
- [x] Run the verification gate; confirm the epic-3 `verify-draw` (12), `sim`
  (5), and `e2e` (5) suites — and the 4.1 `identity-gate` (5), 4.2
  `identity-signature` (5), 4.3 `accept-winner` (5), 4.4 `acceptance-cap` (5),
  and 4.5 `uptime` (5) suites — stay green (the ADDITIVE constraint) and the new
  suite is deterministic.

## Acceptance criteria

1. A ticket / identity is **eligible only while `currentWindow ≤
   attestedUntilWindow`** (the 4.1 verifier's deadline): `isEligibleAtWindow` is
   **inclusive** through the deadline and **lapses at `deadline + 1`** (a
   credential attested to `T` is eligible at `T`, ineligible at `T + 1`).
2. A **lapsed** identity **stops producing valid tickets** and **loses
   eligibility**: once `currentWindow > attestedUntilWindow`, it is ineligible
   and stays ineligible without re-attestation (must-hold (d): stops within `K`
   windows of its last attestation).
3. **Re-attestation extends** `attestedUntilWindow`: `reattestationWindow(W, K)
   = W + K` (the identity is then eligible for the next `K` windows); re-attesting
   at/after the deadline keeps the identity continuously eligible and **extends**
   the deadline (the pure function returns the raw `W + K`; a caller that must
   guarantee a monotonic deadline applies `max(oldDeadline, W + K)`).
4. The seam **composes with the 4.1 `GateVerifier`** (imported, **never
   re-implemented**, AD-4 / AD-7 pattern): `verifyReattestation` reads the
   credential **only** through `verifier.verify`; a lapse / invalid credential →
   the **normal** `{ valid: false, attestedUntilWindow: 0n }` (never an error);
   the verifier's number `attestedUntilWindow` is surfaced as a `bigint`.
5. `K` is the genesis `reattestationK` (an integer ≥ 1) and the check is
   **chain-time** (AD-3, never the wall clock); the change is **ADDITIVE**: the
   epic-3 `verify-draw` (12), `sim` (5), `e2e` (5) suites — and the 4.1
   `identity-gate` (5), 4.2 `identity-signature` (5), 4.3 `accept-winner` (5),
   4.4 `acceptance-cap` (5), 4.5 `uptime` (5) suites — stay green;
   `gate-verifier.ts` / `identity.ts` / `ports.ts` / `protocol.proto` / the
   genesis seam / every `src/consensus` module / `config/genesis.json` are
   **UNCHANGED**; no `big.js` in the new module.

## Never

- NEVER re-implement the gate-credential check — the credential is read **only**
  through the 4.1 `GateVerifier` (`verifier.verify`); 4.6 adds no blob parsing,
  MAC check, or registry check (AD-4: the verifier is the **only** credential
  reader).
- NEVER let a lapsed identity stay eligible — `currentWindow >
  attestedUntilWindow` → **ineligible** (must-hold (d): "a lapsed identity stops
  producing valid tickets within `K` windows and loses eligibility"); the lapse
  gate is the **inclusive** `currentWindow ≤ attestedUntilWindow`.
- NEVER use the **wall clock** for the re-attestation cadence or the lapse
  check (AD-3) — everything is **chain-time** (window indices); `K` is a
  chain-time cadence, not a timer.
- NEVER use a **float** or import `big.js` (AD-5) — the windows and cadence are
  `bigint` chain-time integers; the module imports **no** `big.js`.
- NEVER let an **on-schedule** re-attest shrink the deadline — re-attesting at/after
  the current deadline `D` yields `W + K > D` (an extension). The pure function
  returns the **raw `W + K`** (the frozen D3 formula); a caller that must guarantee
  a **monotonic** deadline (e.g. an identity that re-attests early, `W + K ≤ D`)
  applies `max(oldDeadline, W + K)` — 4.8's sim wiring owns that, the pure cadence
  does not take the old deadline.
- NEVER change `gate-verifier.ts` (4.1), `identity.ts` (4.2), `ports.ts`,
  `protocol.proto`, the genesis seam (1.6), `config/genesis.json`, or any
  `src/consensus` module — the re-attestation logic is a NEW standalone
  identity-domain module (wiring it into the sim's per-window eligibility is
  4.8).
- NEVER make `verifyReattestation` **throw** for a lapsed / invalid credential —
  a reject is the **normal** `{ valid: false, attestedUntilWindow: 0n }` (the
  4.1 / `verifyDraw` convention); only a **negative** window / cadence input is
  a programming error (throws `IdentityError` `SC-IDENTITY-2`).
- NEVER make a `Ticket` carry the credential **blob** — at most a credential
  **hash** (4.1 / AD-4); the proto is unchanged by this story.

## Verification (acceptance gate)

- `corepack pnpm test` → all green; expect **188 prior + 5 new = 193 tests,
  27 files**.
- `corepack pnpm typecheck` → clean.
- `corepack pnpm build` → clean AND `git diff --name-only --
  packages/core/src/proto/` empty (PROTO_OK) — 4.6 adds no proto.
- **ADDITIVE constraint (the HARD one):** `corepack pnpm test
  consensus-verify-draw` → **12 passed**; `corepack pnpm test simulation` →
  **5 passed**; `corepack pnpm test epic-end-to-end` → **5 passed**;
  `corepack pnpm test identity-gate` → **5 passed**; `corepack pnpm test
  identity-signature` → **5 passed**; `corepack pnpm test
  consensus-accept-winner` → **5 passed**; `corepack pnpm test
  consensus-acceptance-cap` → **5 passed**; `corepack pnpm test consensus-uptime`
  → **5 passed** — all UNCHANGED (the re-attestation seams are NEW; they change
  no existing seam).
- Determinism: run `corepack pnpm test identity-re-attestation` TWICE — both pass
  with the identical eligibility / cadence outcomes.
- AD-5 guard intact: `corepack pnpm test no-float-guard` passes (the `big.js`
  import-specifier set over `src/` is still exactly `[ledger/display.ts,
  ledger/fee.ts]` — `src/identity` imports **no** `big.js`).

## Plan Change Log
- **Quick-lens patch 1 (finding 1, medium — REAL, fixed in code + test):** the
  original `verifyReattestation` guarded only `!result.valid`; a `valid: true`
  verifier result carrying a **malformed** deadline / window (NaN / non-integer /
  negative — a non-conforming `GateVerifier`) escaped as a **throw**
  (`BigInt(NaN)` → `RangeError`; `isEligibleAtWindow(-1n, …)` → `IdentityError`),
  contradicting frozen AC-4 / D1 ("a lapse **OR an invalid verifier result** →
  the normal reject") and the seam's own "never throws for credential data"
  claim (AD-4 anticipates a future real gate adapter). **FIXED:** the valid path
  now validates `Number.isInteger && ≥ 0` on the deadline and the window;
  a malformed one → the normal `{ valid: false, attestedUntilWindow: 0n }`.
  New test assertions added to the `REATT_SEAM_COMPOSES_VERIFIER` row (a
  `GateVerifier` double returning `valid: true` with `NaN`/`-1`/`10.5`/`Infinity`
  deadlines, and a negative window — all → the normal reject, never a throw).
- **Quick-lens patch 2 (finding 2, low — doc overclaim, fixed in prose + test;
  NO code change):** the plan's "re-attestation **extends** / a **monotonic
  extension, never a shrink**" was an overclaim — the pure `W + K` **extends**
  the deadline only for an **on-schedule** re-attest (at/after the deadline); an
  **early** re-attest (well before the deadline) yields `W + K ≤ D` and can
  shorten it (e.g. `reattestationWindow(2n, 5n) = 7n < 10n`). The **code** was
  already exactly the frozen D3 formula (`W + K`, correct) — no code change.
  **FIXED the prose** (module docstring + `reattestationWindow` JSDoc + this
  plan's D3 / AC-3 / the matrix row / the Never clause) so the contract is
  accurate: the pure function returns the **raw `W + K`**; a caller that must
  guarantee a **monotonic** deadline applies `max(oldDeadline, W + K)` (4.8's
  sim wiring — the pure cadence does not take the old deadline, by design).
  A clarifying assertion added to the `REATT_CADENCE_FROM_GENESIS` row.

## Review Triage Log
| Lens | Finding (short) | Verdict | Action |
|------|-----------------|---------|--------|
| quick | `verifyReattestation` doesn't map a malformed `valid:true` verifier result to the normal reject — a NaN/negative deadline throws (`RangeError`/`IdentityError`), contradicting frozen AC-4/D1 + the seam's "never throws for credential data" claim | **MEDIUM, real** — verified against the code: `BigInt(result.attestedUntilWindow)` throws on NaN; `isEligibleAtWindow(-1n, …)` throws on a negative deadline; unreachable with the shipped 4.1 verifier but AD-4 anticipates a future real gate adapter | **FIXED** (code + test): the valid path now validates `Number.isInteger && ≥ 0` on the deadline + window; a malformed one → the normal `{ valid: false, attestedUntilWindow: 0n }`. New assertions in the `REATT_SEAM_COMPOSES_VERIFIER` row (GateVerifier double with NaN/-1/10.5/Infinity deadlines + a negative window → normal reject, never a throw). |
| quick | the "re-attestation extends / monotonic extension, never shrinks" invariant is not enforceable by the pure `W + K` (an early re-attest `reattestationWindow(2n,5n)=7n<10n` shrinks) — 4.8 will need `max(oldDeadline, W+K)` | **LOW, doc overclaim** — verified: the code is exactly the frozen D3 formula (correct); only the plan/doc "monotonic/never shrink" prose is wrong for early re-attest; the frozen matrix never tested an early re-attest | **FIXED** (prose + test, NO code change): corrected the module docstring, `reattestationWindow` JSDoc, and the plan's D3/AC-3/matrix-row/Never clause — the pure function returns the raw `W + K`; a caller wanting a guaranteed-monotonic deadline applies `max(oldDeadline, W+K)` (4.8's sim wiring). Clarifying assertion added to the `REATT_CADENCE_FROM_GENESIS` row. |

The reviewer independently re-ran the full gate live (193/193, 27 files; identity-re-attestation 5/5 twice; no-float 6/6; ADDITIVE verify-draw 12 / sim 5 / e2e 5 / identity-gate 5 / identity-signature 5 / accept-winner 5 / acceptance-cap 5 / uptime 5 all unchanged; typecheck clean) and confirmed the 5 frozen matrix rows are faithfully covered (D6 guard assertions folded into the boundary rows; the malformed-result + early-re-attest clarifications added by the patches above).
