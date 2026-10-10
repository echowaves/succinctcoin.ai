---
ticket: "2"
title: "Gossipsub topics + protobuf message envelopes (blocks / tickets / tx / peer info)"
epic: epic-node-network
status: "built"
route: full
review: quick
review_source: pinned
covers: ["R3"]
baseline_revision: "e0997f6bf6ed77e01a8b8003428834746c1ee50a"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/tickets.toml
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/story-network-deps-adapter-scaffold-plan.md
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - packages/core/proto/protocol.proto
  - packages/core/src/net/adapter.ts
  - packages/core/src/net/index.ts
  - packages/core/src/ports.ts
  - packages/core/test/net-adapter.test.ts
---

# 5.2 — Gossipsub topics + protobuf message envelopes

## Goal

Define the four stable gossipsub topics (one per message class: blocks, tickets, tx,
peer info — AD-8) and the protobuf envelope messages in `protocol.proto` (wrapping the
existing `Block` / `Ticket` / `Tx` / `PeerInfo` with a source peer id), generated via
protons (AD-12). Wire the publish/subscribe plumbing into the 5.1 adapter: each class
publishes on its OWN topic and every other subscribed node receives the DECODED
message. Each class round-trips byte-identical on its own topic.

**This is the ONE proto change in epic 5** — the existing four messages (`Block`,
`Ticket`, `Tx`, `PeerInfo`) must stay **wire-identical** (purely additive: new envelope
messages only, no field-number or type changes to the existing four).

## Design Notes

### D1 — Four distinct envelope messages (NOT one Envelope with a class field)

The ticket's `unknown` offers "a single Envelope message with a class field vs four
distinct messages." **Decision: four distinct messages**, one per class. Rationale:
each class travels on its OWN topic (AD-8 "one stable topic per message class"), so a
`class` discriminator field on the wire would be redundant — the topic already says
which class it is. Four envelopes keep each topic's payload self-describing and let the
receiver decode on the topic alone. Each envelope wraps its payload class + a source id.

```proto
message BlockEnvelope   { Block   block    = 1; string sourcePeerId = 2; }
message TicketEnvelope  { Ticket  ticket   = 1; string sourcePeerId = 2; }
message TxEnvelope      { Tx      tx       = 1; string sourcePeerId = 2; }
message PeerInfoEnvelope{ PeerInfo peerInfo = 1; string sourcePeerId = 2; }
```

### D2 — `sourcePeerId` = the gossipping node's PROTOCOL identity id (64-hex)

`sourcePeerId` is the **protocol identity id** (the 4.2 Ed25519 identityId, a 32-byte
hex string) of the node that published the message — NOT the libp2p transport peer id
(D1 in 5.1). Rationale: the acceptance path (4.3 `acceptBlockWinner`) and the per-window
accepted-set construction (4.4 cap + 4.5 weights) are keyed by the PROTOCOL identityId —
that's the id the origin-agnostic acceptance needs to attribute the message to. The
libp2p transport peer id is a network-layer detail irrelevant to ticket/block/tx
acceptance. Consistency: all four envelopes use the same `sourcePeerId` semantics so
the receiver's accepted-set construction is uniform across classes. The adapter
populates it from its own protocol identity (a config field, `protocolIdentityId:
string`, set by the node operator).

### D3 — Four stable topics (AD-8 "one stable topic per message class")

```
/succinctcoin/blocks/1
/succinctcoin/tickets/1
/succinctcoin/tx/1
/succinctcoin/peers/1
```

Named as a `src/net/topics.ts` module: `TOPICS = { blocks, tickets, tx, peers }` (a
`Readonly` const) + a `type TopicClass = keyof typeof TOPICS`. The trailing `/1` is the
protocol version (AD-8 "stable" — a version bump is a protocol change). One topic per
class, no shared topic (the 5.1 scratch topic is REMOVED).

### D4 — The proto is the schema owner (AD-12); purely additive

The four envelope messages are ADDED to `protocol.proto`; the existing `Block`,
`Ticket`, `Tx`, `PeerInfo` are NOT modified (no field-number or type changes). protons
regenerates `src/proto/protocol.ts` (GENERATED — never hand-edited). The hand-written
re-export layer `src/proto/index.ts` (the stable surface the package imports) gains the
four envelope messages (type + codec namespace each), mirroring the existing four.

**Additive proof (non-circular, split two ways):**
- **In-test (`PROTO_ADDITIVE` row):** for each of the four EXISTING messages, encode a
  fixed known instance and (a) round-trip (`decode(encode(x))` deep-equals `x`) and
  (b) pin the EXACT encoded `Uint8Array` bytes as a golden vector. This proves the
  regenerated codecs produce the expected wire bytes for the existing schema.
- **Gate (orchestrator, at review — NOT the test):** `git diff -- packages/core/proto/protocol.proto`
  shows ONLY the four appended envelope messages (no edits to the existing four's field
  numbers/types). This is the independent source-level proof that the schema is
  unchanged, making the in-test byte pin non-circular.

### D5 — Adapter: publish/subscribe on the four topics

The 5.1 adapter's scratch-topic plumbing is replaced:
- `start()` now subscribes to ALL FOUR topics (not the scratch topic).
- `sendBlock(block)` → encode `BlockEnvelope { block, sourcePeerId }` → publish on `TOPICS.blocks`.
- `sendTicket(ticket)` → encode `TicketEnvelope { ticket, sourcePeerId }` → publish on `TOPICS.tickets`.
- `sendTx(tx)` → encode `TxEnvelope { tx, sourcePeerId }` → publish on `TOPICS.tx`.
- The `NetPort.send*` methods take `unknown` per 1.2; the adapter casts to the generated
  proto type (`as Block`, etc.) and encodes. Callers pass proto-conformant objects (the
  generated types).
- A `sendPeerInfo(peerInfo)` helper (NOT on the `NetPort` — peer info is the gossip/discovery
  surface, 5.3's job to drive) encodes `PeerInfoEnvelope` → publishes on `TOPICS.peers`, so the
  peer-info class is round-trip-testable in 5.2.
- The `message` handler now DECODES each received envelope (on its topic) and stores the
  decoded payload in a `received` map: `Map<TopicClass, Array<{ sourcePeerId: string; payload: unknown }>>`.
  The 5.1 `receivedMessages: Uint8Array[]` scratch collector is REMOVED (replaced by the
  decoded `received` map).

### D6 — Forward note from 5.1 (send retry / backpressure)

5.1's Quick lens forward note: the send path is single-shot; when it becomes
load-bearing (5.5's live loop), the adapter needs a retry or an explicit
`allowPublishToZeroTopicPeers` decision so the consensus loop never silently drops a
block/ticket/tx. **5.2 does NOT make the send path load-bearing** (5.2 proves
publish→receive plumbing, not the live loop), so 5.2 keeps the single-shot send and
DEFERS the retry decision to 5.5 (recorded here so it is not lost). 5.2's tests use the
same bounded test-side retry the 5.1 test used (the first publish can race the peer's
SUBSCRIBE).

### D7 — 5.1 test update (scratch topic superseded)

The 5.1 `test/net-adapter.test.ts` rows that asserted the scratch-topic JSON round-trip
(`CONNECT_AND_EXCHANGE`, `SEND_TICKET_AND_TX`) are UPDATED to use the class topics +
proto envelopes (the scratch topic is removed in D5). The contract-shape rows
(`FULL_NETPORT_SURFACE`, `PEERS_EMPTY_BEFORE_CONNECT`, `TCP_TRANSPORT_PRESENT`) are
updated for the new `received` map + `sendPeerInfo`. The file's header comment
("scratch gossipsub topic") is corrected to "four class topics." This is a test update
driven by the 5.2 design (the scratch topic no longer exists); the 5.1 connection
mechanism (dial) is unchanged.

## Code Map

### Files to MODIFY

| File | Change |
|------|--------|
| `packages/core/proto/protocol.proto` | ADD the four envelope messages (`BlockEnvelope`, `TicketEnvelope`, `TxEnvelope`, `PeerInfoEnvelope`). Existing four messages UNCHANGED. |
| `packages/core/src/proto/protocol.ts` | Regenerated by protons (GENERATED — not hand-edited; new envelope messages + unchanged existing). |
| `packages/core/src/proto/index.ts` | HAND-WRITTEN re-export layer: add the four envelope messages (type + codec namespace each), mirroring the existing four. |
| `packages/core/src/net/adapter.ts` | Replace scratch-topic plumbing with the four class topics (D5); `send*` encode envelopes; `sendPeerInfo` helper; `message` handler decodes into the `received` map; `protocolIdentityId` config field; remove `receivedMessages`. |
| `packages/core/src/net/index.ts` | Barrel: add `TOPICS` + `TopicClass` re-exports. |
| `packages/core/src/index.ts` | Root barrel: add the four envelope messages (type + value) to the proto re-export section (lines ~305–316) + `TOPICS` (value) + `TopicClass` (type). |
| `packages/core/test/net-adapter.test.ts` | Update the scratch-topic rows to the four class topics + proto envelopes (D7); add the 5.2 round-trip rows. |

### Files to CREATE

| File | Purpose |
|------|---------|
| `packages/core/src/net/topics.ts` | The four stable topic constants (`TOPICS`) + `TopicClass` type (D3). |

### Files NOT touched (byte-identical)

`src/ledger/**`, `src/consensus/**`, `src/identity/**`, `src/config/**`, `src/events/**`,
`src/ports.ts` (the `NetPort` `send*(unknown)` signatures are unchanged — the adapter
casts internally). The existing four proto messages' field numbers/types.

## Tasks

- [x] **T1: Add the four envelope messages to `protocol.proto`** — Append `BlockEnvelope`, `TicketEnvelope`, `TxEnvelope`, `PeerInfoEnvelope` (D1: each wraps its payload class as field 1 + `string sourcePeerId = 2`). Do NOT modify the existing four messages.

- [x] **T2: Regenerate proto + update the re-export layer** — `corepack pnpm build` (runs protons → regenerates `src/proto/protocol.ts`). Verify the generated `protocol.ts` now has the four envelope messages AND the existing four are present. THEN update the hand-written `src/proto/index.ts` re-export layer to expose the four envelope messages (type + codec namespace each), mirroring the existing four (do NOT edit the generated `protocol.ts`).

- [x] **T3: Create `src/net/topics.ts`** — `export const TOPICS = { blocks: '/succinctcoin/blocks/1', tickets: '/succinctcoin/tickets/1', tx: '/succinctcoin/tx/1', peers: '/succinctcoin/peers/1' } as const` + `export type TopicClass = keyof typeof TOPICS`.

- [x] **T4: Update the adapter** — (a) add `protocolIdentityId: string` to `NetAdapterConfig`; (b) replace the scratch-topic subscribe/publish with the four class topics (D5): `start()` subscribes to all four; `sendBlock`/`sendTicket`/`sendTx` encode the matching envelope (casting the `unknown` arg to the generated type) and publish on the class topic; add a `sendPeerInfo` helper; (c) the `message` handler decodes each received envelope on its topic into a `received: Map<TopicClass, Array<{ sourcePeerId: string; payload: unknown }>>`; (d) remove the 5.1 `receivedMessages` scratch collector.

- [x] **T5: Update the barrels** — `src/net/index.ts` (re-export `TOPICS` + `TopicClass`) + root `src/index.ts`: (a) add the four envelope messages (type + value) to the proto re-export section so the test can import `BlockEnvelope`/`TicketEnvelope`/`TxEnvelope`/`PeerInfoEnvelope` (and `Block`/`Ticket`/`Tx`/`PeerInfo`) from the root barrel, and (b) export `TOPICS` (value) + `TopicClass` (type) for the test.

- [x] **T6: Update `test/net-adapter.test.ts`** — Update the 5.1 scratch-topic rows to the four class topics + proto envelopes (D7), and ADD the 5.2 round-trip rows (root-barrel only; import the generated proto types + `TOPICS` from the root barrel). Rows:
  1. **BLOCK_ROUNDTRIP**: A `sendBlock(a real proto Block)` → B decodes a `BlockEnvelope` on `TOPICS.blocks`; assert the decoded `block` fields equal the original (byte-identical) AND `sourcePeerId` === A's `protocolIdentityId`.
  2. **TICKET_ROUNDTRIP**: A `sendTicket(a real proto Ticket)` → B decodes on `TOPICS.tickets`; fields byte-identical + sourcePeerId correct.
  3. **TX_ROUNDTRIP**: A `sendTx(a real proto Tx with decimal-string amount/fee)` → B decodes on `TOPICS.tx`; the decimal-string amount/fee travel INTACT (spine AD-5 / R3); sourcePeerId correct.
  4. **PEERINFO_ROUNDTRIP**: A `sendPeerInfo(a real proto PeerInfo)` → B decodes on `TOPICS.peers`; fields byte-identical; sourcePeerId correct.
  5. **TOPIC_ISOLATION**: A `sendBlock` → assert B receives it ONLY on `TOPICS.blocks` (NOT on tickets/tx/peers); a `sendTicket` → ONLY on `TOPICS.tickets`. (One topic per class — a block never on the tickets topic.)
  6. **PROTO_ADDITIVE**: for each of the four EXISTING messages (`Block`/`Ticket`/`Tx`/`PeerInfo`), build a fixed known instance, `encode` it, and (a) assert `decode(encode(x))` deep-equals `x` (round-trip) and (b) pin the EXACT encoded `Uint8Array` bytes as a golden vector (byte-for-byte). This proves the regenerated codecs produce the expected wire bytes for the existing schema; combined with the gate-level check that `protocol.proto` only gained appended messages (D4), the existing schema is proven unchanged (purely additive).

  Use explicit `timeout` (30s) on the connected rows; reuse the 5.1 `publishUntilAccepted` + `pollUntil` bounded-retry helpers (D6).

## Verification

```bash
corepack pnpm test 2>&1 | grep -E "Test Files|Tests "
corepack pnpm typecheck 2>&1 | tail -1
corepack pnpm build 2>&1 | tail -1
```

- All tests pass. The 5.1 net-adapter rows are UPDATED (not deleted) + 6 new 5.2 rows.
  Prior suites (epic 1–4, the 208) stay green — the proto change is purely additive.
- Typecheck clean. Build succeeds (protons regen).
- **PROTO_ADDITIVE gate (split two ways, D4):** (a) the in-test `PROTO_ADDITIVE` row
  round-trips + pins exact bytes for the four existing messages; (b) the ORCHESTRATOR
  independently verifies `git diff -- packages/core/proto/protocol.proto` shows ONLY the
  four appended envelope messages (no edits to the existing four's field numbers/types).
  This REPLACES the 5.1 "empty proto diff" gate — 5.2 is the ONE proto change, so the
  generated file legitimately gains the four envelope messages; the invariant is that the
  EXISTING messages' encodings are unchanged.
- `git diff --name-only -- packages/core/src/ledger/ packages/core/src/consensus/ packages/core/src/identity/` is EMPTY (no ledger/consensus/identity changes).
- The existing four proto messages' field numbers are unchanged in `protocol.proto` (only the four envelope messages appended).
- The new/updated test imports only from the root barrel `../src/index.js` (+ node builtins + vitest).
- `src/net/**` has no big.js, no `.secret` read, no `Math.random`/wall-clock.

## Matrix

| Row | Done-when / Requirement | What it proves |
|-----|------------------------|----------------|
| BLOCK_ROUNDTRIP | R3, AD-8, AD-12 | A Block round-trips on its own topic (encode → publish → decode), byte-identical + sourcePeerId attributed. |
| TICKET_ROUNDTRIP | R3, AD-8, AD-12 | A Ticket round-trips on its own topic, byte-identical + sourcePeerId. |
| TX_ROUNDTRIP | R3, AD-5, AD-8 | A Tx round-trips on its own topic with the decimal-string amount/fee INTACT (spine AD-5 / R3). |
| PEERINFO_ROUNDTRIP | R3, AD-8 | A PeerInfo round-trips on its own topic, byte-identical. |
| TOPIC_ISOLATION | R3, AD-8 (one topic per class) | Each class travels ONLY on its own topic (a block never on the tickets topic). |
| PROTO_ADDITIVE | AD-12 (proto schema owner) | The four existing messages' wire encodings are unchanged — the envelope messages are purely additive (the ONE proto change). |

## Never

- Do NOT modify the existing four proto messages (`Block`/`Ticket`/`Tx`/`PeerInfo`) — no field-number or type changes (purely additive: the four envelope messages only).
- Do NOT modify `src/ledger/**`, `src/consensus/**`, `src/identity/**`, or `src/ports.ts` (the `NetPort` `send*(unknown)` signatures are unchanged — the adapter casts internally).
- Do NOT import `big.js` in `src/net/**` (AD-5).
- Do NOT read `.secret` from the protocol identity keypair in `src/net/**` (AD-11); the adapter takes `protocolIdentityId` as a plain string config field.
- Do NOT open a real TCP socket in any test (AD-10: memory transport only).
- Do NOT use `Math.random` / `Date.now` / wall-clock in `src/net/**` (AD-3).
- Do NOT keep the 5.1 scratch topic (it is replaced by the four class topics).
- Do NOT change the `status:` value in the plan frontmatter.

## Implementation Notes

2026-10-10 (build, baseline e0997f6): Implemented T1–T6 exactly as planned; no
deviations.

- **T1 (proto):** appended the four envelope messages to `protocol.proto`
  (`BlockEnvelope`/`TicketEnvelope`/`TxEnvelope`/`PeerInfoEnvelope`, each
  payload = field 1 + `string sourcePeerId = 2`), plus a header comment block
  documenting the topic→envelope mapping and the additive invariant. `git diff
  -- packages/core/proto/protocol.proto` = 54 insertions, 0 deletions (purely
  appended; the existing four messages are byte-identical).
- **T2 (regen + re-exports):** `corepack pnpm build` regenerated
  `src/proto/protocol.ts` via protons (diff = 662 insertions, 0 deletions —
  additive only). The hand-written `src/proto/index.ts` gained the four
  envelopes (type + codec namespace each), mirroring the existing four; the
  generated file was not hand-edited.
- **T3 (topics):** new `src/net/topics.ts` with `TOPICS` (`as const`:
  `/succinctcoin/{blocks,tickets,tx,peers}/1`) + `TopicClass`.
- **T4 (adapter):** `NetAdapterConfig.protocolIdentityId` added (required,
  plain string — AD-11); scratch topic + `receivedMessages` removed; `start()`
  subscribes all four topics; `sendBlock`/`sendTicket`/`sendTx` cast the
  `unknown` arg to the generated type, encode the envelope, publish on the
  class topic; new `sendPeerInfo` helper (not on `NetPort`); the `message`
  handler decodes per topic into `received: Map<TopicClass,
  ReceivedEnvelope[]>` (`ReceivedEnvelope { sourcePeerId, payload }`, exported
  type). Send stays single-shot (D6 → 5.5).
- **T5 (barrels):** `src/net/index.ts` re-exports `TOPICS`/`TopicClass`
  (+`NetAdapter`/`ReceivedEnvelope` types); root `src/index.ts` re-exports the
  four envelopes (type + value), `TOPICS`, `TopicClass`, and the adapter
  surface.
- **T6 (test):** `test/net-adapter.test.ts` — the five 5.1 rows UPDATED in
  place (scratch-topic JSON assertions → class topics + decoded proto
  envelopes; `receivedMessages` → `received` map; `sendPeerInfo` in the
  surface row) + the six 5.2 rows added (BLOCK/TICKET/TX/PEERINFO_ROUNDTRIP,
  TOPIC_ISOLATION, PROTO_ADDITIVE). PROTO_ADDITIVE pins the EXACT encoded
  bytes of the four existing messages over the file's fixtures
  (`GOLDEN_BLOCK_HEX`/`GOLDEN_TICKET_HEX`/`GOLDEN_TX_HEX`/
  `GOLDEN_PEERINFO_HEX`) — computed with a throwaway vitest file and written
  in programmatically (no manual hex transcription), then the throwaway was
  deleted. Byte-identity on the round-trip rows is asserted as
  `X.encode(decoded) === X.encode(original)` (protons codec round-trip, the
  same idiom as `golden-vector.test.ts`).
- **Verification (from `packages/core`):** `corepack pnpm test` → Test Files
  31 passed (31), Tests 219 passed (219) (208 pre-epic-5 + 5 5.1 updated + 6
  new 5.2); `corepack pnpm typecheck` → clean (tsc, no output); `corepack
  pnpm build` → clean (protons regen + tsc). `git diff --name-only --
  packages/core/src/ledger/ packages/core/src/consensus/ packages/core/src/identity/`
  → EMPTY. Test imports: root barrel `../src/index.js` + `vitest` only. No
  real sockets (memory transport only, AD-10). `src/net/**` hygiene (no
  big.js import, no `.secret` read, no RNG/wall-clock) holds — the
  guard tests (`no-float-guard`, `identity-key-surface`) pass.

## Plan Change Log

(to be filled at build)

## Review Triage Log

Quick lens (2026-10-10): all 12 per-story scrutiny points VERIFIED PASS
(purely-additive proto — 51 insertions/0 deletions, existing four messages
byte-identical; envelopes match D1 with `sourcePeerId` = the 4.2 PROTOCOL
identity id, NOT the transport peer id; exactly four stable topics one per
class; AD-5 decimal strings intact; AD-11 plain-string config; AD-12
generated types + correct hand-written re-export layer, generated
`protocol.ts` confirmed a clean protons regen; PROTO_ADDITIVE honest AND
non-circular — golden hexes spot-checked against the schema + the
source-level additive gate; AD-10 no real socket; AD-3 no RNG/wall-clock;
208 prior + 5 updated 5.1 + 6 new 5.2 = 219/219 live, root-barrel-only
imports; the `send*` cast is the designed 1.2 seam, not a type hole; D6
single-shot send correctly deferred to 5.5). 1 finding:

1. **Receive-path decode has no error containment on a KNOWN topic with a
   corrupt payload** — the gossip `message` listener calls
   `decodeReceived(msg.topic, msg.data)` with no `try/catch`; protons
   `BlockEnvelope.decode` THROWS on malformed/garbage bytes (empirically
   probed: 3×0xff → `RangeError index out of range`; truncated varint →
   `RangeError`; empty → decodes to defaults, no throw). A bad envelope on
   one of the four class topics would throw an uncaught exception inside the
   libp2p event callback. **UNREACHABLE in 5.2** (the only publisher is the
   adapter itself, which always encodes well-formed envelopes) — not an
   unmet 5.2 criterion. **Disposition: NO ACTION for 5.2.**
   **FORWARD NOTE → 5.5 PLAN: when the receive path becomes load-bearing
   (arbitrary/malicious peers publishing), contain the decode — a throw on a
   known topic must NOT take down the handler; a corrupt envelope must be a
   normal REJECT (the spine rule "reject = normal false/REJECT, never a
   throw") so the acceptance path can drop it. This is the receive-side
   analog of D6's send-retry note — record it in 5.5's Design Notes so it is
   not lost.**
