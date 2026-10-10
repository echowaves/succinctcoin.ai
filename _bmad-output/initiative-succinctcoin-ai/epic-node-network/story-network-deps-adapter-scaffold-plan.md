---
ticket: "1"
title: "Network deps + libp2p adapter scaffold over @libp2p/memory"
epic: epic-node-network
status: "built"
route: full
review: quick
review_source: pinned
covers: ["R1"]
baseline_revision: "8f072a2f3d140bcceea8bc031e973bb6780f0b66"
lenses_ran: ["quick"]
review_loop_iteration: 1
context:
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/epic-node-network.md
  - _bmad-output/initiative-succinctcoin-ai/epic-node-network/tickets.toml
  - _bmad-output/initiative-succinctcoin-ai/architecture-succinctcoin/architecture-succinctcoin.md
  - _bmad-output/initiative-succinctcoin-ai/spec-succinctcoin/stack.md
  - packages/core/src/ports.ts
  - packages/core/src/index.ts
  - packages/core/package.json
  - packages/core/test/boot-path.test.ts
---

# 5.1 — Network deps + libp2p adapter scaffold over @libp2p/memory

## Goal

Add the five pinned libp2p network deps to `packages/core` and stand up `src/net`: a
libp2p adapter that implements the **full** 1.2 `NetPort` surface (`start` / `stop` /
`sendBlock` / `sendTicket` / `sendTx` / `peers`) over the `@libp2p/memory` transport
(AD-10). Two in-process nodes connect and exchange one raw message on a scratch
gossipsub topic, headless, zero real sockets. The tcp/bootstrap/mdns/circuit-relay-v2
code paths are present and selected by a transport flag but the memory transport is
the only one exercised in CI.

## Design Notes

### D1 — Peer id = libp2p identity keypair (NOT the 4.2 protocol identity)

The adapter uses **libp2p's own identity keypair** (a fresh Ed25519 key auto-generated
when no `privateKey` is passed to `createLibp2p`). This is the **transport-layer**
identity — it identifies the node on the network. It is deliberately **distinct** from
the 4.2 **protocol identity** (the Ed25519 keypair in `src/identity/identity.ts` used
for ticket signing). The net adapter never reads the protocol identity keypair's
`.secret` (AD-11: the 4.7 key-surface scan asserts only `identity/identity.ts` reads
`.secret`). Each node gets its own transport keypair; `peerId()` returns the libp2p
peer ID string (CIDv1 base58 or equivalent) for logging/testing.

### D2 — Adapter factory surface

```typescript
// src/net/adapter.ts
export interface NetAdapterConfig {
  /** 'memory' (CI path) or 'tcp' (production; present but not CI-exercised). */
  transport: 'memory' | 'tcp'
  /** Listen address. Memory: '/memory/<name>'. TCP: '/ip4/0.0.0.0/tcp/<port>'. */
  listenAddress: string
}

export interface NetAdapter extends NetPort {
  /** Explicitly dial a peer by multiaddr string (5.1's connect mechanism;
   *  discovery-driven connecting is 5.3). 10s AbortSignal.timeout. */
  dial(address: string): Promise<void>
  /** The libp2p peer ID string of this node (transport identity — D1). */
  peerId(): string
  /** Raw payloads received on the scratch topic (test observability). */
  readonly receivedMessages: Uint8Array[]
}

export function createNetAdapter(config: NetAdapterConfig): NetAdapter
```

The factory returns `NetAdapter` — `NetPort` (from `src/ports.ts`) plus the
`dial` / `peerId` / `receivedMessages` extensions the 5.1 test needs. Internally it
holds a `Libp2p` instance + `GossipSub` service. `receivedMessages` is test
observability only — the real receive path is the gossipsub `message` handler that
5.2+ will route into the core.

### D3 — Scratch topic (5.1) vs real topics (5.2)

5.1 uses a **single scratch topic** `'/succinctcoin/scratch'` for the send methods.
The `sendBlock` / `sendTicket` / `sendTx` methods serialize their `unknown` argument
as a UTF-8 JSON string (a plain `Uint8Array` payload — 5.2 replaces this with proto
envelopes) and publish on the scratch topic. This is a **placeholder**: 5.2 replaces
it with four class-specific topics + proto envelopes. The scratch topic proves the
gossipsub plumbing works end-to-end (publish → receive → decode).

### D4 — Transport selection + present-but-deferred services

`transport: 'memory'` → `memory()` from `@libp2p/memory`.
`transport: 'tcp'` → `tcp()` from `@libp2p/tcp`.
Both use `noise()` (connection encrypter) + `yamux()` (stream muxer).
The tcp path is **present in code** (selected by the flag) but **never exercised in
CI** (AD-10: zero real sockets). The test file only uses `transport: 'memory'`.

**Decision — circuitRelayTransport is NOT wired in 5.1.** The ticket description
names it in the adapter, but `circuitRelayTransport()` makes every node an outbound
relay client that probes for relay peers at start — over the memory transport, with
no relay node running, it adds nothing to 5.1's proof and risks start() flakiness.
Wiring it is 5.7's job, where the simulated relay node exists and the transport is
actually exercised. The `@libp2p/circuit-relay-v2` DEP is still added in 5.1 (pinned
in the lockfile now, consumed in 5.7).

**Decision — the `@libp2p/bootstrap` + `@libp2p/mdns` SERVICES are NOT wired in
5.1.** Discovery (bootstrap against the genesis list + mDNS) is entry 3's story, and
5.1's connect mechanism is an explicit `dial(multiaddr)` — the adapter exposes
`dial(address: string): Promise<void>` which resolves the string via
`@multiformats/multiaddr` and calls `libp2p.dial(...)` with a 10s
`AbortSignal.timeout`. The bootstrap/mdns DEPS are added in 5.1 (pinned in the
lockfile now, consumed in 5.3).

### D5 — Gossipsub service

The adapter includes `gossipsub()` as a libp2p service. On `start()`, the adapter
subscribes to the scratch topic. The `send*` methods publish on it. A `message`
handler on the gossipsub service decodes incoming scratch-topic messages (the test
asserts receipt).

### D6 — Dependencies (exact spine pins)

All added to `packages/core/package.json` `devDependencies`:
- `@libp2p/gossipsub@17.1.2`
- `@libp2p/tcp@11.0.28`
- `@libp2p/bootstrap@12.0.32`
- `@libp2p/mdns@12.0.32`
- `@libp2p/circuit-relay-v2@4.2.13`

(Already present: `libp2p@3.3.11`, `@libp2p/memory@2.0.28`, `@libp2p/noise@17.0.3`,
`@libp2p/yamux@8.0.3`, `@multiformats/multiaddr@13.0.3`, `uint8arrays@6.1.1`.)

Install command: `corepack pnpm add -D @libp2p/gossipsub@17.1.2 @libp2p/tcp@11.0.28 @libp2p/bootstrap@12.0.32 @libp2p/mdns@12.0.32 @libp2p/circuit-relay-v2@4.2.13 --dir packages/core`

### D7 — Barrel exports

`src/net/index.ts` re-exports: `createNetAdapter`, `NetAdapterConfig` type.
Root barrel `src/index.ts` adds: `createNetAdapter` (value) + `NetAdapterConfig` (type).

### D8 — AD-11 / AD-5 compliance

- `src/net/**` must NOT import `big.js` (AD-5: big.js only at the 2 ledger boundaries).
- `src/net/**` must NOT read `.secret` from the protocol identity keypair (AD-11).
  The libp2p transport keypair is internal to the libp2p stack; the adapter never
  exposes or reads it directly.
- No `Math.random`, no wall-clock reads (AD-3).

## Code Map

### Files to CREATE

| File | Purpose |
|------|---------|
| `packages/core/src/net/adapter.ts` | `createNetAdapter` factory + `NetAdapterConfig` interface. Implements NetPort over libp2p. |
| `packages/core/src/net/index.ts` | Barrel: re-exports from `./adapter.js`. |
| `packages/core/test/net-adapter.test.ts` | Test file: 5 rows (see Matrix below). |

### Files to MODIFY

| File | Change |
|------|--------|
| `packages/core/package.json` | Add 5 pinned deps to devDependencies. |
| `pnpm-lock.yaml` | Updated by pnpm install. |
| `packages/core/src/index.ts` | Add `createNetAdapter` + `NetAdapterConfig` to exports. |

### Files NOT touched (byte-identical)

All of `src/ledger/**`, `src/consensus/**`, `src/identity/**`, `src/config/**`,
`src/events/**`, `src/proto/**`, `proto/protocol.proto`, `src/ports.ts` (NetPort
already defined there — 5.1 implements, doesn't change the interface).

## Tasks

- [x] **T1: Add pinned deps** — Run `corepack pnpm add -D @libp2p/gossipsub@17.1.2 @libp2p/tcp@11.0.28 @libp2p/bootstrap@12.0.32 @libp2p/mdns@12.0.32 @libp2p/circuit-relay-v2@4.2.13 --dir packages/core` from repo root. Verify `packages/core/package.json` devDeps contain all 5 at exact versions. Verify `pnpm-lock.yaml` updated.

- [x] **T2: Create `src/net/adapter.ts`** — Implement `createNetAdapter(config: NetAdapterConfig): NetAdapter` (factory is a PURE constructor — it stores config and returns the object; the libp2p node is created lazily inside `start()`, so `createNetAdapter({transport:'tcp',...})` never touches a socket):
  - `start()`: Build the libp2p node via `createLibp2p({ addresses: { listen: [config.listenAddress] }, transports: [config.transport === 'memory' ? memory() : tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()], services: { gossip: gossipsub() } })`. Start it. Subscribe to the scratch topic `'/succinctcoin/scratch'`. Register a `message` handler that appends each received `Uint8Array` to the `receivedMessages` array.
  - `stop()`: Stop the libp2p node.
  - `sendBlock(block: unknown)` / `sendTicket(ticket: unknown)` / `sendTx(tx: unknown)`: Serialize the argument with `JSON.stringify` → UTF-8 `Uint8Array` → `gossip.publish(topic, bytes)`. (All three share one private `publishScratch(payload: unknown)` helper — 5.2 splits them onto their own topics.)
  - `peers()`: Return `libp2p.getPeers()` (peer ID strings).
  - `dial(address: string)`: `multiaddr(address)` → `libp2p.dial(ma, { signal: AbortSignal.timeout(10_000) })` → `void`.
  - `peerId()`: Return `libp2p.peerId.toString()`.

- [x] **T3: Create `src/net/index.ts`** — Barrel re-exporting `createNetAdapter` + `NetAdapterConfig` type.

- [x] **T4: Add to root barrel** — In `packages/core/src/index.ts`, add `export { createNetAdapter } from './net/index.js'` and `export type { NetAdapterConfig } from './net/index.js'`.

- [x] **T5: Create `test/net-adapter.test.ts`** — 5 rows (root-barrel only imports from `../src/index.js`):
  1. **CONNECT_AND_EXCHANGE**: Node A (memory transport, listens `/memory/a`) + node B (listens `/memory/b`). Both `start()`. B `dial('/memory/a')`. Both `peers()` now show the other's `peerId()` (assert on both sides — dial is bidirectional at the connection level). A `sendBlock({ slot: 1, note: 'hello' })`. Poll B's `receivedMessages` with a bounded deadline loop (≤10s, small sleeps — test-side waiting, not src) until non-empty. Assert B received EXACTLY the UTF-8 bytes of `JSON.stringify({ slot: 1, note: 'hello' })`. Both `stop()` (idempotent, no throw).
  2. **FULL_NETPORT_SURFACE**: `createNetAdapter({transport:'memory', listenAddress:'/memory/surface'})` — assert the returned object has all 6 NetPort methods (`start`, `stop`, `sendBlock`, `sendTicket`, `sendTx`, `peers`) AND the 3 extensions (`dial`, `peerId`, `receivedMessages`) as functions/arrays. `start()`, then `peers()` → `[]` (no throw, honest empty), then `stop()`. This is the contract-shape test — the core sees the full 1.2 surface.
  3. **SEND_TICKET_AND_TX**: Two connected nodes (same setup as row 1). A `sendTicket({ identityId: 'x', windowIndex: 1 })` then `sendTx({ amount: '1.5', fee: '0.001' })` (decimal strings — the AD-5 shape travels intact even as a JSON placeholder). Poll B until `receivedMessages.length === 2`. Assert both payloads round-trip byte-for-byte.
  4. **PEERS_EMPTY_BEFORE_CONNECT**: Create an adapter, `start()` it, assert `peers()` returns `[]` (no peers dialed yet) AND `peerId()` returns a non-empty string. `stop()`.
  5. **TCP_TRANSPORT_PRESENT**: `createNetAdapter({ transport: 'tcp', listenAddress: '/ip4/127.0.0.1/tcp/0' })` does NOT throw — the factory accepts the flag and stays pure (libp2p created only in `start()`). Do NOT call `start()` (would open a real socket — AD-10). This proves the tcp code path is present but not exercised.

  Use explicit `timeout` on the connected rows (gossipsub delivery may take a moment): `it(..., { timeout: 30000 })`.

## Verification

```bash
corepack pnpm test 2>&1 | grep -E "Test Files|Tests "
corepack pnpm typecheck 2>&1 | tail -1
corepack pnpm build 2>&1 | tail -1 && git diff --name-only -- packages/core/src/proto/ && echo PROTO_OK
```

- All prior tests (208/208, 30 files) + 5 new = **213/213, 31 files**.
- Typecheck clean.
- Build succeeds; proto byte-identical (PROTO_OK, empty diff).
- `git diff --name-only -- packages/core/src/` shows ONLY: `src/net/adapter.ts`, `src/net/index.ts`, `src/index.ts` (the barrel line).
- `git diff --name-only -- packages/core/package.json pnpm-lock.yaml` shows the dep additions.
- No new test file imports big.js, reads `.secret`, or uses `Math.random` / wall-clock.

## Matrix

| Row | Done-when / Requirement | What it proves |
|-----|------------------------|----------------|
| CONNECT_AND_EXCHANGE | R1, AD-10 | Two nodes connect over memory (explicit dial), exchange one message via the gossipsub scratch topic, zero real sockets; peers() honest on both sides. |
| FULL_NETPORT_SURFACE | 1.2 NetPort contract | The adapter implements all 6 NetPort methods (+ dial/peerId/receivedMessages extensions); the core sees the full contract. |
| SEND_TICKET_AND_TX | R1, AD-8 (one topic per class — placeholder), AD-5 | All three send methods work (sendBlock/sendTicket/sendTx), not just one; decimal-string amount shape travels intact. |
| PEERS_EMPTY_BEFORE_CONNECT | NetPort.peers | peers() is honest (empty when no peers connected); peerId() non-empty. |
| TCP_TRANSPORT_PRESENT | AD-10, R1 | The tcp transport flag is accepted (code path present) without opening a socket; factory is pure. |

**Ticket wording note:** the ticket verify says “exchange one **protobuf** message”. In 5.1 the scratch-topic payload is a plain JSON-UTF-8 `Uint8Array` placeholder — the proto envelope messages (Block/Ticket/Tx/PeerInfo wrappers) arrive in 5.2, which is the ONE proto change in the epic. 5.1 proves the gossipsub transport plumbing (publish → receive → decode) that 5.2's envelopes ride on; the “protobuf message” requirement is satisfied by 5.2's round-trip rows on the same adapter. This is recorded here so the review doesn't flag the placeholder as an unmet criterion.

## Never

- Do NOT modify `src/ports.ts` (NetPort is already defined; 5.1 implements it).
- Do NOT modify `src/ledger/**`, `src/consensus/**`, `src/identity/**`, `src/proto/**`, or `proto/protocol.proto`.
- Do NOT import `big.js` in `src/net/**`.
- Do NOT read `.secret` from the protocol identity keypair in `src/net/**` (AD-11).
- Do NOT open a real TCP socket in any test (AD-10: zero real sockets in CI).
- Do NOT use `Math.random` or `Date.now()` / wall-clock in `src/net/**` (AD-3).
- Do NOT change the `status:` value in the plan frontmatter.
- Do NOT add any dep version different from the exact spine pins.

## Implementation Notes

Built 2026-10-10. Files created: `src/net/adapter.ts`, `src/net/index.ts`,
`test/net-adapter.test.ts`. Files modified: `packages/core/package.json` (6
pinned devDeps), `pnpm-lock.yaml`, `src/index.ts` (barrel: `createNetAdapter`
value + `NetAdapterConfig` type). `status:` left untouched.

**Verification (from `packages/core/`, all pass):**
- `corepack pnpm test` → `Test Files 31 passed (31)` / `Tests 213 passed (213)`
  (208 prior + 5 new, exactly the plan's expected 213/213, 31 files).
- `corepack pnpm typecheck` → clean (no output after `$ tsc -p tsconfig.json`).
- `corepack pnpm build` → succeeds; `git diff --name-only -- packages/core/src/proto/`
  empty → `PROTO_OK`.
- New test file imports ONLY `../src/index.js` (+ `vitest`); no deep imports
  into `src/net`/`src/proto`. No `big.js`, no `.secret` read, no
  `Math.random`, no wall-clock read (`Date.now`/`new Date`/`performance.now`)
  in `src/net/**` or the test (the only timer is the sanctioned `sleep` helper
  using `setTimeout` for bounded test-side waiting).
- `git status --porcelain -- packages/core/src/` → only `src/index.ts` (M) and
  `src/net/` (new). `package.json` + `pnpm-lock.yaml` changed as expected.

**Notes / decisions at build time:**
- **`Services` type is a local `type` alias, not an `interface`.**
  `createLibp2p<T>` requires `T extends Record<string, unknown>`; an
  `interface` would drop the index signature and fail TS2344. Also,
  `ServiceMap` is NOT re-exported from the `libp2p` package (it's declared
  locally in its `.d.ts`), so it cannot be imported — the alias inlines the
  same `Record<string, unknown>` shape plus `{ gossip, identify }`.
- **First publish is retried in the test, not in src.** A publish on the
  scratch topic can land before B's `SUBSCRIBE` reaches A's gossipsub, in
  which case gossipsub rejects `PublishError.NoPeersSubscribedToTopic`
  (verified in `@libp2p/gossipsub` source: `selectPeersToPublish` finds no
  topic peers → throws unless `allowPublishToZeroTopicPeers`, default false).
  The test-side `publishUntilAccepted` bounded retry (≤10s, `setTimeout`
  sleeps) is test-side waiting, never src. The adapter's send methods are
  single-shot.
- **Gossipsub is registered before `node.start()`** so the scratch-topic
  `message` handler is attached before any message can be delivered.
- **`stop()`/`start()` are idempotent** (row 1 calls `stop()` twice); a
  `start()` after `stop()` re-creates a fresh node (memory-transport global
  `connections` map is keyed by listen address and cleaned up on listener
  stop, so re-start on the same address is safe).
- All 5 rows pass on 4 consecutive runs (no observed flakiness).

## Plan Change Log

- 2026-10-10 (build) — **Added `@libp2p/identify@4.1.14` to
  `packages/core` devDependencies** (not in the plan's D6 list). Reason:
  gossipsub 17.1.2 declares the `@libp2p/identify` capability as a hard
  `serviceDependency` (gossipsub `dist/src/gossipsub.js` `[serviceDependencies]
  = ['@libp2p/identify']`), and libp2p 3.3.11 ships **no** defaults —
  `createLibp2p` throws `UnmetServiceDependenciesError` at node construction
  without `identify()` registered. `@libp2p/identify` is not bundled in the
  libp2p core and was not otherwise in the tree. Pinned to **4.1.14** (not the
  latest 4.1.15) so its `@libp2p/interface` range (`^3.3.0`) exactly matches
  libp2p 3.3.11's own range, deduping to the existing interface 3.3.0 with no
  second interface copy in the lockfile (4.1.15 requires `^3.3.1`, which would
  pull a second, duplicate interface version). This is a dep addition the
  plan's D6 omitted; it does not change any existing spine pin. The adapter
  registers `services: { gossip: gossipsub(), identify: identify() }`.

## Review Triage Log

Quick lens (2026-10-10): all 10 per-story scrutiny points PASS (NetPort
surface exact; 5 pins exact + identify deviation verified justified —
gossipsub `serviceDependencies` + single interface@3.3.0 in lock; memory-only
CI; no `.secret`/keypair exposure; no big.js; no RNG/wall-clock; root-barrel-
only imports; 5 rows honest incl. real byte-for-byte round-trip; purely
additive diff, 213/213 live; handler registered pre-start + emitSelf-off ⇒
exactly-one sound). 3 findings:

1. **Single-shot send (no retry/backpressure)** — `publishScratch` does one
   `gossip.publish` and propagates the reject; a transient mesh gap (e.g.
   `NoPeersSubscribedToTopic` — verified `gossipsub.js:1772–1774`)
   drops the message. **Disposition: NO ACTION for 5.1** (scaffold is
   intentionally single-shot; the test carries the bounded retry; 5.1 proves
   publish→receive plumbing). **FORWARD NOTE → 5.2 PLAN: when the send path
   becomes load-bearing (5.5's live loop), the adapter needs a retry or an
   explicit `allowPublishToZeroTopicPeers` decision — record it in 5.2's
   Design Notes so the consensus loop never silently drops a block/ticket/tx.**
2. **SEND_TICKET_AND_TX order-preservation comment misattributed** — it
   credited the `await` for ordering; gossipsub `sendRpc` is fire-and-forget
   (synchronous `outboundStream.push`, verified `gossipsub.js` sendRpc),
   ordering comes from the shared ordered outbound stream for the single
   peer. **Disposition: FIXED (comment only, this review pass — assertion
   unchanged and still correct).**
3. **File-header "(+ node builtins)" inaccurate** — the test imports only
   `vitest` + the barrel, no node builtins. **Disposition: FIXED (header
   comment only; the root-barrel-only rule was already satisfied).**

Post-fix gate re-run: 213/213 (31 files), typecheck clean, PROTO_OK.
