# Adversarial Seam Review — `architecture-succinctcoin.md` (AD-1..AD-11)

**Verdict: CONDITIONAL — the spine is strong on ownership/direction seams (who mutates, who imports, who writes, where keys live) and those ADs genuinely close; but it leaves every byte-level protocol contract unpinned — the draw function, the PoW hash input, the Block/Ticket/Tx schemas, the gate-credential interface, and the on-disk money encoding — so pairs of units can obey all eleven ADs to the letter and still fork the chain, reject every block, or silently drift balances.**

**Method.** For each plausible pair among the eight units one level down — consensus (C), ledger (L), identity (I), net (N), chainstore (S), Electron main (M), React UI (U), test harness (T) — I constructed two different implementations, each obeying every AD's Rule text, and asked whether the Rule text actually prevents the clash. Classifications: **hole** = no AD's Rule text covers it; **under-specified AD** = covered in spirit, not in enforceable letter; **fine** = the Rule text truly closes it. Rule quotes below are verbatim from the spine.

Note on scope: within one repo, shared TypeScript types catch many shape divergences at build time. The findings below are the ones that survive that — divergences between *cryptographic constructions*, between *a unit and its independent test oracle*, between *in-memory and serialized forms*, and between *two nodes built from the same spine but different readings of it*. Those are exactly the divergences a compiler cannot see.

---

## Findings, ranked by exploitability for "a simple, equal-node, well-tested coin"

### F1 — CRITICAL · hole · C × T — the draw function is pinned in class, not in form

**(a) Consensus's compliant choice.** C implements the draw as `winner = argmin_ticket sha256(nonce ‖ challenge)^(uptime)` interpreted so higher uptime wins (the *intent* of R4: "Uptime = valid tickets / windows over a moving lookback L", "Richer never means more likely"). One function, `drawWindow(tickets, challenge, weights)`, used by both block construction and the verifier in `applyBlock`.

**(b) Test harness's compliant choice.** T, following the standard property-testing pattern of an *independent reference implementation*, reads `registration-design.md` R2 literally: "the slot winner is the identity minimizing `c^(1/uptime)` (equivalently, the minimum of `H(r, challenge)` with a weight transform)" — and implements that literal formula as its oracle, then runs the spec's launch gate test ("a node not selected by the draw cannot produce a valid block") against it.

**(c) The concrete clash.** Both f and f′ obey AD-7's Rule to the letter: each is "`f(valid tickets, per-window challenge, uptime weights)` with no RNG source other than nonces committed in tickets and no network-position term", and "any node can recompute the winner". Three failure modes:
1. **Vacuous gate test.** The launch gate test — the spec's stated pre-launch requirement — verifies f′, not f. It can be green while testing the wrong function. No AD says the harness must *import* the production draw rather than re-implement it; "any node can recompute" actively invites a second implementation.
2. **The literal formula inverts CAP-1.** Worked example: established identity A (uptime 1.0) vs fresh identity B (uptime 0.01), each `c ~ U(0,1)`. Under the literal "minimize `c^(1/uptime)`": P(B wins) = E[`c_A^(0.01)`] = 1/1.01 ≈ **0.99** — the *fresh* identity wins ~99% of slots because `c^(1/u) → 0` as `u → 0`. The correct direction (minimize `c^uptime`) gives P(A wins) ≈ 0.99. The companion doc's "(equivalently, the minimum of `H(r, challenge)` with a weight transform)" is not actually an equivalent restatement — it's a second, vaguer formula. So two compliant builders, both "obeying" the same documents, can implement fairness or its exact inverse, with every AD satisfied and the launch gate test green.
3. **Cross-node fork.** A second node built from the same spine (the future headless daemon AD-1 demands) reading R2 literally deploys f′ while the Electron node deploys f. Same tickets, same challenge, same weights — different winners → the chain splits at the first contested slot.

**(d) Hole.** AD-7's Rule pins the *class* of functions (inputs, no-RNG, recomputable) and the *rejection rule* ("a block whose (ticket, nonce) does not verify the draw is rejected"), but never the *member of the class*. No AD names a single implementation that verifier and tests must share, and no AD or companion pins a fixed test vector that would make a changed f a detectable protocol break.

**Suggested AD-12 (or tightened AD-7):** "The draw is exactly: for each valid ticket, `priority = sha256(nonce ‖ challenge)` read as a uniform `c ∈ (0,1)`; the winner is the ticket minimizing `c^(1/uptime)` is WRONG-by-inversion — [pin the exact formula once, with one worked example and ≥3 fixed test vectors (ticket set → expected winner) in the repo]. The draw is a single exported function `drawWindow(tickets, challenge, weights)` in `core/consensus`; the block verifier and *all* tests must import it — re-implementation is banned. Changing the draw is a protocol change requiring a version bump in the genesis config."

---

### F2 — CRITICAL · hole · C × N — the PoW hash input and the block's canonical bytes are undefined

**(a) Consensus's compliant choice.** Per-attempt mining: `candidate = sha256(prefix ‖ u64be(counter))` where `prefix` is a hand-chosen canonical concatenation of block fields in a hand-chosen order: `prevHash(32) ‖ u64be(window) ‖ ticketBytes ‖ u256be(nonce) ‖ sha256(txList)`. The block hash stored in the block is `candidate` at the winning counter.

**(b) Net's compliant choice.** N owns the `.proto`: `message Block { bytes prev_hash = 1; uint64 window = 2; Ticket ticket = 3; bytes nonce = 4; repeated Tx txs = 5; uint64 counter = 6; bytes hash = 7; }`. The receiving node's verifier, taking AD-8's "one encoding" as its cue, re-hashes **the protobuf serialization** of the received message to check the proof.

**(c) The concrete clash.** Protobuf bytes (tags, varints, length prefixes) are not the hand-concatenated prefix. A block for which C found a valid counter is **rejected by every other node** — network-wide liveness death, with both units obeying everything: AD-6's Rule ("per-attempt PoW = `node:crypto` sha256 + plain integer counter" — both use exactly that; no big.js, no keccak) and AD-8's Rule ("protocol messages use protobuf… one stable topic per message class (blocks, tx, tickets, gossip)" — N encodes blocks as protobuf on the blocks topic ✓). Sub-variants, all compliant: (i) N's schema omits `counter` entirely, treating the proof as attached outside the message — the verifier can't even locate the counter; AD-8 never says the proof travels *inside* the block message; (ii) C includes the `hash` field in its own prefix (self-referential) while N derives it; (iii) counter encoded little-endian by C, varint by the schema.

**(d) Hole.** No AD defines *what bytes* the PoW hashes. AD-6's Rule pins the primitive (sha256 + integer counter) and bans slow primitives — it says nothing about the digest input. AD-8's Rule pins the encoding of "protocol messages"; the hash-chain object's canonical form, and whether the block hash is over the wire encoding, is not in its letter. The "canonical serialization" concept simply does not exist in the spine.

**Suggested (tighten AD-6 + AD-8):** "The block hash is `sha256` over the protobuf encoding of the `Block` message as defined in `packages/core/proto/protocol.proto` — the single source of truth for all protocol message fields and numbering. The counter is a field of that message. The PoW check re-hashes exactly those bytes. Core TypeScript entity types are generated from the `.proto` (protons); hand-written protocol types are banned."

---

### F3 — HIGH · hole · I × C (through N) — Ticket/Block/Tx field sets and the signed-message construction are unpinned

**(a) Identity's compliant choice.** I mints tickets as `{ identityId, windowIndex, challenge, nonceCommitment, signature }` with `signature = sign( sha256( identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment ) )` — "a signed response to a per-window challenge, bound to the identity's key" (R1) ✓, amounts as decimal strings and IDs as 32-byte hex (AD-8) ✓.

**(b) Consensus's compliant choice.** C's verifier expects `{ identityId, windowIndex, c, signature, attestationRef }` — it drops `challenge` (derivable from `prevHash + windowIndex`, so "not worth the bytes"), *adds* `attestationRef` (it wants to check re-attestation lapse at `applyBlock` time, and believes AD-4's "signature/credential check only" licenses reading credential fields directly — see F5), and signs/verifies over `identityId ‖ windowIndex-as-decimal-string ‖ c` — decimal string because the consistency conventions say amounts/IDs are decimal strings on the wire and C generalized that to all scalars.

**(c) The concrete clash.** Every ticket fails signature verification → no identity is ever eligible → no block is ever valid (silent liveness death — nothing throws, the draw just never finds a winner). The insidious variant: I and C agree on field *names* in TS but N's `.proto` encodes I's shape; C's schema has different field numbers, and **protobuf silently discards unknown fields on decode** — so the deserialized ticket is zero-filled where the shapes differ. No crash, no error, every ticket invalid, and all three units obey every AD. AD-7's Rule only fixes that "a block whose (ticket, nonce) does not verify the draw is rejected" — i.e., it guarantees *rejection*, which is exactly what the mismatch produces.

**(d) Hole.** AD-8's Rule pins the encoding rule ("protocol messages use protobuf… amounts travel as decimal strings; IDs as 32-byte hex. One stable topic per message class") — not a single message field. The structural seed is explicitly "Core entities (names + relationships only)". No AD names the `.proto` as source of truth, requires generated types, or fixes the signed-digest construction (field order, integer byte order, what is inside the signature).

**Suggested (fold into AD-12 from F2):** "The `.proto` fixes the field set *and numbering* of `Block`, `Tx`, `Ticket`, `PeerInfo`. The ticket signature is over `sha256(identityId ‖ u64be(windowIndex) ‖ challenge ‖ nonceCommitment)` — all integers big-endian fixed-width inside digests, always; decimal strings only in JSON/wire scalar fields, never inside cryptographic digests. A golden-vector test ships: one fixed ticket+block hex string that encoder, decoder, signature verifier, and draw must all round-trip."

---

### F4 — HIGH · hole · C(node A) × C(node B) — the draw's input set and snapshot moment are undefined

**(a) Node A's compliant choice.** A verifies a block's draw over *the tickets currently in its store* at verification time ("f(valid tickets, per-window challenge, uptime weights)" — "valid tickets" = whatever my store holds right now).

**(b) Node B's compliant choice.** B verifies over *the ticket set snapshotted at the previous window's last block* (a fixed point in chain time, per AD-3's "slot count + last block hash").

**(c) The concrete clash.** Tickets gossip asynchronously (AD-8: tickets get a topic; CAP-3 requires gossip delivery "within a bounded time" — bounded, not *before the draw*). Node A saw ticket T (priority 0.02); node B did not (gossip lag). The block's ticket has priority 0.05. A rejects (T beats it); B accepts (it's the minimum of B's set). **Both nodes, each obeying every AD, fork the chain** — and the fork is *asymmetric and persistent*: every window where the two nodes' ticket sets differ is a fork point. The reverse asymmetry (B's set ⊋ A's) makes B reject blocks A accepted. AD-7's "any node can recompute the winner" presumes all nodes recompute over the *same set* — no AD defines that set or the moment it closes.

**(d) Hole.** AD-7's Rule says "f(valid tickets…)" without defining "valid tickets" as a set with a determinate membership rule and snapshot moment. AD-3's Rule puts "ticket validity" in chain time — but validity is a per-ticket property, not a set-membership/snapshot rule. Compounding factor for the "well-tested" goal: AD-10's in-process memory transport is fast and nearly deterministic, so ticket-view divergence **never manifests in CI** — the coin's stated safety net is structurally blind to this exact fork.

**Suggested (tighten AD-7):** "The draw's input set is the tickets accepted into the chain at or before the previous window's last block (i.e., derivable from the block's ancestry + gossiped-and-verified tickets up to that fixed chain point). A verifier must accept a block whose ticket is the minimum of that set even if the verifier's store later grows with lower-priority tickets; late tickets never invalidate an accepted block. The block carries the winner's ticket + nonce; nothing more is required for verification."

---

### F5 — MEDIUM · under-specified AD-4 · I × C — "opaque" credential with no defined verifier interface

**(a) Identity's compliant choice.** I stores the gate output as `{ gateId, blob }` and derives eligibility *only* through the gate-verifier port it owns (structural seed: `core/identity/ # tickets, re-attestation, gate-verifier port (AD-4)`): `verify(cred, window) → { valid, lapsesAt }`.

**(b) Consensus's compliant choice.** At `applyBlock`, C enforces must-hold (d) — "stop re-attesting → lose eligibility" — by parsing credential fields directly: `if cred.lastAttestationWindow + K < window: reject ticket`. C's reading of AD-4: verification is "a **signature/credential check only, no network call**" — a direct field check is a credential check, offline, no network. C assumes the layout `{ gateId, lastAttestationWindow, signature }`.

**(c) The concrete clash.** The gate's actual blob matches I's assumed layout, not C's. C's parser reads garbage → either (i) valid identities are judged lapsed and lose eligibility — an equality/liveness failure for honest nodes, or (ii) C's field check passes a lapsed credential that I's verifier would reject — a sybil survives re-attestation lapse, breaking CAP-2's success criterion ("lapsing re-attestation loses eligibility"). Both units obey AD-4's letter: offline ✓, "the gate is never a per-window dependency" ✓, credential validated "by a registered **gate-verifier interface**" (I does; C's direct check is a "credential check"). The test harness compounds this: T's stub gate must implement the same port — but the port's signature is never fixed, so T's stub can accept a credential shape the production path never sees.

**(d) Under-specified AD.** AD-4's Rule *declares* opacity — "Gate output is an opaque credential validated by a registered gate-verifier interface" — but defines neither the interface's signature, nor where the credential lives (Identity record on disk? inside the Ticket on the wire? a hash reference?), nor forbids field access outside the verifier. "Opaque" is a stated property with no enforcement mechanism — nothing in the spine (type, rule, or convention) makes non-verifier field reading a violation.

**Suggested (tighten AD-4):** "The gate-verifier port is `GateVerifier.verify(cred: GateCredential, window: WindowIndex): Eligibility` with `GateCredential = { gateId: string, blob: Uint8Array }` — the only representable credential shape (blob is unreadable outside the verifier by type). Consensus may query eligibility only via this port (owned by `core/identity`); no module may parse credential fields. A Ticket carries at most the credential hash (`attestationRef`), never the blob."

---

### F6 — MEDIUM · under-specified AD-5 · L × S — on-disk money encoding is outside AD-5's letter

**(a) Ledger's compliant choice.** Balances are `BigInt` in memory (AD-5: "amounts are integer base units (`BigInt`) in memory and on the wire"); `applyBlock` calls the store API with `setBalance(id, BigInt)`.

**(b) Chainstore's compliant choice.** S persists to SQLite with `amount REAL` (or `INTEGER`, i.e., int64) — its "code-level choice", which AD-9's Rule explicitly licenses: "Store engine (SQLite / LevelDB / custom) is a code-level choice, not an invariant."

**(c) The concrete clash.** A balance of `10^18` base units exceeds `2^53 − 1 = 9,007,199,254,740,991`. Persisted as `REAL`, it round-trips as `100000000000000000000.000000` → read back as a different `BigInt`; as int64 with intermediate `Number` conversion, it silently rounds. The UI (via the read-API) shows wrong balances; the ledger's conservation property (CAP-5: "conservation of supply, no-negative-balance… no float artifact ever appears in a **persisted** balance") is violated *by a unit that obeys every AD* — because AD-5's Rule covers "in memory and **on the wire**" and "Wire/**JSON** encoding is a decimal string". The store's on-disk binary encoding is neither "wire" nor JSON, and AD-9 actively disclaims the engine. The divergence is silent: no throw, just wrong numbers after restart.

**(d) Under-specified AD.** AD-5's *Prevents* clause names the disease ("float drift in balances, and serialization divergence") but its *Rule* text stops at "memory and on the wire / JSON". The persistence boundary — the one place BigInt must be re-materialized — is the gap.

**Suggested (tighten AD-5):** "All *persisted* amounts are decimal strings (or exact arbitrary-precision integer columns); float and int64 amount columns are banned. The store must round-trip `BigInt` exactly — property test: random `BigInt` up to `10^30` persist and read back equal."

---

### F7 — LOW-MEDIUM · under-specified AD-1/AD-9 · C × U (and N × U) — read-API surface and event payload shapes have no owner

**(a) Consensus's compliant choice.** C emits `BlockApplied { hash, window, winnerIdentity, txCount, reward }` (summary) and exposes a read-API `getBalance(id): bigint`, `getBlock(hash): Block` — the "typed read-API" of AD-1's Rule ("Core's public surface is: events (out), commands (in), typed read-API").

**(b) UI's compliant choice.** U builds on the convention "core emits typed events; UI subscribes; **no polling**" — reading "no polling" as "the event stream is a complete data source" — and expects `BlockApplied` to carry the block's transactions and mining-progress fields (`hashesPerSecond`, `currentWindow`), plus `getPeers() → { peerId, address, latency, inbound }[]` (the shape U's peers view was designed around). N, asked to feed `getPeers()`, more naturally returns `{ peerId, multiaddrs: string[] }` (its own peer table, straight from libp2p).

**(c) The concrete clash.** U's block-detail view is empty (event is summary-only; the `getBlock` U needs was never specified), mining status renders `NaN`, peers view throws on missing fields — while every unit obeys its AD: events are PascalCase nouns ✓ ("core events PascalCase nouns (`BlockApplied`, `SlotWon`, `IdentityLapsed`)"), typed ✓, U reads via the read-API, never the store ✓ (AD-9: "UI and net read via the core read-API, never the store directly"), no polling ✓. Second seam in the same family: the convention's **disjunction** — "Commands return a promise **or** emit a result event" — is never assigned per command. M/preload resolves `enrollIdentity` by promise; C emits `IdentityEnrolled` without resolving it → the UI double-renders or the promise hangs. Each side picked one branch of the "or"; both branches are compliant.

**(d) Under-specified ADs.** AD-1's Rule names the surface ("events (out), commands (in), typed read-API") without owning its shape; AD-9's Rule names the read-API as the access path without enumerating it; the conventions fix event *names* and allow the promise/event disjunction, but no AD assigns either the payload types or a per-command result mode. The structural seed's `events/ # typed events + commands (core public surface)` suggests an owner, but a seed is a diagram, not a Rule.

**Suggested (tighten AD-1 + AD-9):** "`core/events/` is the single owner of all event payload types and all read-API signatures; the read-API surface is enumerated there (including `getPeers()` and `getBlock(hash)`). Every fact the UI displays is either in an event payload or a named read-API function — the event stream plus the read-API is the complete data source (no polling means: never poll; it does not mean: events alone suffice). Every command resolves its promise; result events are optional additions, never replacements."

---

### F8 — LOW · hole · M × S (second instance) — "exactly one writer" has no cross-instance exclusion

**(a) Electron main's compliant choice.** M hosts the core; "the consensus loop in the main process" is the only writer — AD-9's Rule verbatim: "exactly one writer — the consensus loop in the main process."

**(b) A second instance's compliant choice.** AD-1's rationale requires the core to run in three hosts, "including a future headless daemon". That daemon on the same machine, pointed at the same data directory, has *its own* "consensus loop in the main process" — AD-9's wording is satisfied per process.

**(c) The concrete clash.** Two processes writing one SQLite file → lock errors or corruption; or, if the store tolerates concurrent open, two divergent tips in one store → the app displays impossible state after the user restarts.

**(d) Hole.** AD-9's Rule establishes single-writer *within* the architecture but specifies no cross-instance exclusion mechanism (directory lockfile, PID check), and its "in the main process" phrasing is host-relative inside an invariant that AD-1 makes host-agnostic.

**Suggested (tighten AD-9):** "The store opens with an exclusive lock (SQLite write lock + data-directory lockfile). A second instance against the same directory must fail at boot with a clear error, not degrade."

---

## Seams the ADs genuinely close (fine — said so)

| Seam attacked | Closed by | Why the Rule text holds |
| --- | --- | --- |
| Two owners of one balance (U optimistic credit vs N-apply vs C-apply — AD-2's own example) | **AD-2** | Rule names the single function and its sole invoker: "all chain + ledger state mutation happens in one `applyBlock(block)` function, invoked **only by the consensus loop**… **No module may mutate balances directly**." A UI or net unit crediting a balance is a direct, textually impossible move. Fine. |
| Core↔shell import inversion (renderer importing core, core importing electron) | **AD-1** | "zero imports of `electron`, the renderer, or any UI library. Shell imports core; never reverse." Lint-enforceable at import level. Fine. |
| Wall-clock ticket windows / nondeterministic validity | **AD-3** | Rule enumerates the decision classes — "window index, lookback L, ticket validity, draw, difficulty uses chain time" — and bans wall clock outside "UI display". A unit building a wall-clock window has no compliant reading. Fine. |
| Wire amount/ID encoding split (binary uint64 vs decimal string) | **AD-5 + AD-8** | "Amounts travel as decimal strings; IDs as 32-byte hex" is exact and textual. Fine *for the wire* (the disk boundary is F6). |
| Hot-path crypto regression (big.js/keccak in the mining loop) | **AD-6** | "big.js and pure-JS keccak are banned from per-attempt code paths" — ban is textual, lint/perf-test enforceable. Fine. |
| Renderer seeing identity keys | **AD-11** | "identity private keys live in the core… They never cross the IPC boundary to the renderer in plaintext — the UI receives only peer IDs, status, and signed artifacts." Tight and textual. Fine. |
| Gate as per-window network SPOF | **AD-4** | "the protocol verifies gate credentials **offline**… The gate is never a per-window dependency." Closes the SPOF threat specifically. Fine (the credential *shape* is F5 — a different seam). |
| Tests needing real sockets / desktop shell | **AD-10** | "all core tests run plain-Node with `@libp2p/memory`… zero real sockets in CI." Textual. Fine. |

---

## Summary of suggested spine changes

1. **New AD-12 — Canonical protocol encoding.** One `.proto` file as the single source of truth for `Block`/`Tx`/`Ticket`/`PeerInfo` field sets and numbering; core TS types generated from it; integers big-endian fixed-width inside all cryptographic digests (decimal strings never inside digests); a golden round-trip vector (fixed block+ticket hex) that encoder, decoder, signature verifier, and draw must all pass. (Closes F2, F3; de-risks F1's cross-node variant.)
2. **Tighten AD-7.** Pin the exact draw formula *with a direction check and fixed test vectors*; require the single exported `drawWindow()` to be imported by verifier and all tests (re-implementation banned); define the draw's input set as tickets accepted at or before the previous window's last block, with late tickets never invalidating an accepted block. (Closes F1, F4.)
3. **Tighten AD-6.** "The PoW hash is sha256 over the protobuf encoding of the `Block` message, counter included as a field of that message." (Closes F2.)
4. **Tighten AD-4.** Define the gate-verifier port signature and `GateCredential = { gateId, blob }` as the only representable shape; ban field access outside the verifier; pin that tickets carry at most a credential hash. (Closes F5.)
5. **Tighten AD-5.** Extend the decimal-string/exact-integer encoding requirement to *persisted* amounts; ban float/int64 amount columns; BigInt round-trip property test. (Closes F6.)
6. **Tighten AD-1 + AD-9.** `core/events/` owns event payload types and the enumerated read-API; events+read-API is the complete UI data source; every command resolves its promise. (Closes F7.)
7. **Tighten AD-9.** Exclusive store lock; second instance against the same directory fails at boot. (Closes F8.)

**Bottom line for the stated goal.** The spine's ownership invariants are doing their job — nothing above lets a second unit *mutate* or *import* its way into a bug. The holes are all in the *byte contracts* the coin's two defining properties live on: "any node can recompute the winner" (F1, F4) and "any node can verify the proof" (F2, F3). Those two properties are load-bearing for an *equal* node network and for the *well-tested* goal (the harness is the unit most likely to hold a divergent second implementation, and the in-memory transport is structurally blind to F4). Close F1–F4 before any code is written against the spine; F5–F8 are tightenings that can land as the relevant unit is built.
