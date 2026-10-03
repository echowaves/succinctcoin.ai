---
title: 'protocol.proto + generated types + golden vector'
type: 'feature'
ticket: 4
created: '2026-10-02'
status: 'built'
baseline_revision: '2eb85b261da37811852673f79a0ad9d9d696b33a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/testing.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no wire schema. The spine (AD-8/AD-12) requires `packages/core/proto/protocol.proto` to be the **single source of truth** for the `Block`, `Tx`, `Ticket`, and `PeerInfo` field sets *and* numbering, with TS protocol types **generated** from it (hand-written protocol types banned) and a **golden round-trip vector** that passes encode→decode with identical bytes. Nothing exists yet, so consensus/identity/net have no canonical encoding to conform to — and a field-number mismatch would silently fail every ticket network-wide.

**Approach:** Author `proto/protocol.proto` (proto3, the four messages, big-endian fixed-width ints inside digests, decimal strings in scalar money fields), wire a `generate:proto` build step that runs the `protons` CLI to emit TS types into `src/proto/`, and ship a golden round-trip test (a fixed Block + Ticket, encoded, stored as hex, decoded, asserted byte-identical). The field numbering is the builder's AD-12 decision and is the substance of this `plan_checkpoint` — approving this plan approves the schema.

## Boundaries & Constraints

**Always:**
- `protocol.proto` (proto3, package `succinctcoin`) is the sole schema owner; TS protocol types are **generated**, never hand-written.
- Inside cryptographic digests all integers are **big-endian fixed-width** (AD-12); money travels as **decimal strings** (AD-5); IDs are 32-byte hex (spine convention).
- The generated file lives in `src/proto/` so `tsc` compiles it into `dist/` and its `protons-runtime`/`uint8arrays`/`uint8arraylist` imports resolve against `packages/core` devDeps.
- The golden vector is a fixed, committed hex artifact; the test re-derives the bytes and asserts identity.

**Never:**
- No capability logic — no consensus/ledger/identity/net behavior, no draw, no signature *verification* (the ticket **signature field** ships; the verifier is epic 4). 1.4 owns schema + generation + the golden vector only.
- No hand-written protocol types (banned by AD-12); no runtime dep for encoding (protons-runtime + its uint8* peers are the generated code's own deps).
- No real sockets; no UI imports (AD-1); no browser target.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| GENERATE | `pnpm build` (or `generate:proto`) | `protons` emits `src/proto/protocol.ts`; `tsc` compiles it | a proto syntax error fails the build |
| ROUND_TRIP | golden Block + Ticket (fixed hex) | encode→decode reproduces the identical bytes | a mismatch fails the test |
| DETERMINISM | encode the golden object twice | both encodings are byte-identical | a mismatch fails the test |
| NO_HANDWRITTEN | scan `src/` for protocol message defs | the four messages exist only in the generated `src/proto/protocol.ts` | a duplicate def outside it fails the test |
| TYPES_EXPORTED | import `@succinctcoin/core` | `Block`/`Tx`/`Ticket`/`PeerInfo` (+ codecs) are exported | a missing export fails typecheck/test |

</frozen-after-approval>

## Code Map

- `packages/core/proto/protocol.proto` — new. proto3, `package succinctcoin`, messages `Block`, `Ticket`, `Tx`, `PeerInfo` (field sets + numbering per the schema in Design Notes).
- `packages/core/src/proto/protocol.ts` — **generated** (by `protons`); committed so consumers + CI typecheck without a regen step. Do not edit by hand.
- `packages/core/src/proto/index.ts` — new. Re-exports the generated types + codecs.
- `packages/core/src/index.ts` — re-export the protocol types/codecs (additive; `createCore` untouched).
- `packages/core/package.json` — add devDeps: `protons@10.0.5`, `protons-runtime@8.0.1`, `uint8arrays` (v6), `uint8arraylist` (v3); add `generate:proto` script and make `build` run it before `tsc`.
- `packages/core/test/golden-vector.test.ts` — new. The golden Block + Ticket hex, encode→decode identity, double-encode determinism.
- `packages/core/test/proto-types.test.ts` — new. `NO_HANDWRITTEN` + `TYPES_EXPORTED` rows.
- `.gitignore` — note: the generated `src/proto/protocol.ts` IS committed (it's a build artifact consumers import), so no ignore line for it.
- `packages/core/src/ports.ts`, `events/`, `config/`, other tests — unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/proto/protocol.proto` — author the four messages (field sets + numbering per AD-12) — the single schema owner.
- [x] `packages/core/package.json` — add the protons toolchain devDeps + `generate:proto` script; make `build` regenerate then compile — reproducible generated types.
- [x] `packages/core/src/proto/protocol.ts` + `proto/index.ts` — generate + re-export the types/codecs — the canonical wire types.
- [x] `packages/core/src/index.ts` — re-export the protocol surface — discoverable from the package entry.
- [x] `packages/core/test/golden-vector.test.ts` — fixed Block + Ticket hex, encode→decode identity + determinism — proves the canonical encoding.
- [x] `packages/core/test/proto-types.test.ts` — `NO_HANDWRITTEN` + `TYPES_EXPORTED` — enforces generated-only + export surface.

**Acceptance Criteria:**
- Given `protocol.proto`, when `pnpm build` runs, then the protocol types are generated from it and `tsc` compiles the whole package.
- Given the golden Block + Ticket, when they are encoded then decoded, then the decoded objects re-encode to identical bytes (and encoding twice yields identical bytes).
- Given the generated types, when `@succinctcoin/core` is imported, then `Block`/`Tx`/`Ticket`/`PeerInfo` and their codecs are exported, and the four message definitions appear only in the generated file.

## Implementation Notes

- **protons needs the output dir pre-created.** `protons proto/protocol.proto -o src/proto/` fails with `ENOENT` if `src/proto/` doesn't exist (it does not `mkdir -p`). `src/proto/` is committed (holds `protocol.ts` + `index.ts`), so the dir exists for normal `pnpm build`; the golden vector was first generated with a `mkdir -p src/proto` ahead of the initial run.
- **Re-export is value+type via one statement.** Each message is a namespace merge (interface = type, namespace = codec value). `export { Block } from './proto/index.js'` carries **both** the type binding and the value binding, so no `type`/`value` split is needed at the package entry. `src/proto/index.ts` is the sanctioned re-export layer.
- **`NO_HANDWRITTEN` scan excludes two files** — the generated `src/proto/protocol.ts` (where the `interface <m>` defs belong) and the re-export layer `src/proto/index.ts` (which uses BOTH `export type <m> = succinctcoin.<m>` type aliases and `export const <m> = succinctcoin.<m>` value re-exports). The handwritten detector matches `interface <m>`, `class <m>`, or object-literal `type <m> = {`; the re-export layer's type aliases (no `= {`) and `const` value re-exports do not match.
- **Tests import from `../src/index.js`** (source), not the built `dist/`, to match the existing suite and keep `pnpm test` build-free; `dist/` compiles from the same `src/index.ts` so the export surface is identical (verified by importing `dist/index.js` directly).
- **`Buffer.from` needs `subarray()` for `Uint8ArrayList`.** The `hex()` helper calls `buf.subarray()` first so it type-checks for both `Uint8Array` and `Uint8ArrayList` (strict tsc: `Uint8ArrayList` is not `ArrayLike<number>`).
- **Golden vector field 5 (nonce) must be non-empty to appear in the pin.** proto3 omits default/empty fields; a zero-filled 32-byte nonce encodes as nothing. The committed vector uses a distinct non-empty nonce (`0x00..0x1f`) so the AD-6 "counter included" field is actually exercised by the round-trip.
- **int64 fields decode to `bigint`** (`slot`/`txCount`/`windowIndex`/`uptime`), so test assertions use `7n`/`42n`/`3n`.

## Plan Change Log

(empty)

## Review Triage Log

- **medium — `patch`** — Golden vector pins the protons *wire* form (varint int64), but the proto header comment and Design Notes claimed it "pins the AD-12 canonical (BE fixed-width) form" — a distinct, still-undefined serialization a later epic could mistake for already-pinned. Verified: `BLOCK_HEX` starts `082a` (varint slot=42); generated codec writes `w.int64()` (varint); no BE fixed-width digest encoding exists in the diff. Fix: corrected the proto header comment, the Block `hash` comment, and the Design Notes to state the vector pins the wire form and the digest canonical form is defined with the digest math (epic 3/4). Non-frozen docs only.
- **low — rejected (out of scope)** — `Tx`/`PeerInfo` have no golden pin, so field-number drift in 2 of 4 messages is undetected. The frozen Intent explicitly scopes the vector to "a fixed Block + Ticket," and the ACs restate that scope; the intent itself excludes this, so it is out of scope (not a plan-drawn line). `NO_HANDWRITTEN` still guards names; numbering drift for Tx/PeerInfo is caught by future consumers. No action.
- **false — rejected** — Root `build` hardcodes `packages/core/node_modules/.bin/protons`. The proposed `pnpm --filter @succinctcoin/core build` is infeasible: `pnpm` is not on the script PATH (only `corepack` is; repo convention is direct `.bin` invocation, established in 1.1). The path is stable under the pinned pnpm@12.8.1 strict layout and matches the repo's existing scripts. No real harm in this repo.
- **low — rejected** — `generate:proto` is CWD-relative and doesn't `mkdir -p` the output dir. `src/proto/` is committed (holds `protocol.ts` + `index.ts`), so the dir exists on any checkout; running a package script with root-relative paths is standard pnpm behavior. Adding `mkdir -p` would guard a state we never demonstrated and the CWD issue is inherent to package scripts. No action.
- **low — `patch`** — Implementation Notes described the re-export layer as type-aliases only, but `src/proto/index.ts` also contains `export const <m> = succinctcoin.<m>` value re-exports. Verified against the file; the behavioral claim (detector doesn't match) was already correct, only the description was incomplete. Fix: corrected the notes to mention both alias and const re-export forms. Trivial doc fix.

## Design Notes

- **Schema + field numbering (the AD-12 decision this checkpoint approves).** proto3, `package succinctcoin`:

```proto
message Block  { int64 slot = 1;  bytes  parentHash = 2;  string winnerIdentityId = 3;
                bytes  winnerTicket = 4;  bytes nonce = 5;  bytes hash = 6;  int64 txCount = 7; }
message Ticket { string identityId = 1;  int64 windowIndex = 2;  bytes challenge = 3;
                bytes nonceCommitment = 4;  bytes signature = 5; }
message Tx     { bytes  sender = 1;  bytes recipient = 2;  string amount = 3;   // decimal string (AD-5)
                string fee = 4;  int64 slot = 5;  bytes signature = 6; }
message PeerInfo { string peerId = 1;  repeated string multiaddrs = 2;  int64 uptime = 3; }
```

  `Block` carries the winner's **ticket and nonce** (AD-7). Money is a **decimal string** (`Tx.amount`/`Tx.fee`) — never an int64/float (AD-5). `winnerIdentityId`/`Tx.sender`/`Tx.recipient`/`PeerInfo.peerId` are 32-byte hex strings. `int64` slots/windows are the chain-time scalars (AD-3); **inside digests** the canonical encoding uses big-endian fixed-width ints — a DISTINCT serialization from the protons wire form (`int64` = varint). The golden vector pins the **wire** form (encode→decode round-trip); the **digest** canonical form is defined and pinned when the digest math lands (epic 3 draw / epic 4 verify), so encoder/decoder/verifier/draw agree on *that* form (AD-12). Changing any number later is a protocol change (genesis version bump).
- **Generated file in `src/proto/`, committed.** protons emits `out/sample.ts`-style output that imports `protons-runtime`, `uint8arrays/alloc`, `uint8arraylist`; putting it under `src/` means `tsc` compiles it and those imports resolve against `packages/core` devDeps (added: `protons@10.0.5` CLI, `protons-runtime@8.0.1`, `uint8arrays` v6, `uint8arraylist` v3 — protons-runtime's own peer set). `build` runs `protons proto/protocol.proto -o src/proto/` then `tsc`; the file is committed so consumers typecheck without a regen.
- **Golden vector = canonical-encoding pin.** A fixed `Block` + `Ticket` (deterministic field values) are encoded to hex and committed in the test; the test decodes the hex, re-encodes, and asserts byte-identity, plus encodes the object twice for determinism. This is what makes "encoder, decoder, and (later) the verifier + draw all agree on the bytes" checkable now, before those consumers exist.

## Verification

**Commands:**
- `corepack pnpm build` — expected: `protons` generates `src/proto/protocol.ts`, then `tsc` compiles the package (exit 0).
- `corepack pnpm test` — expected: exit 0; the golden-vector test (round-trip identity + determinism) and proto-types test (no-handwritten + exports) pass.
- `corepack pnpm typecheck` — expected: exit 0, strict tsc clean across the generated + new files.
