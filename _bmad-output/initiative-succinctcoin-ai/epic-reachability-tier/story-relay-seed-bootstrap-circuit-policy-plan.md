---
id: relay-seed-bootstrap-circuit-policy
status: built
epic: epic-reachability-tier (ticket 10.2)
title: Relay seed bootstrap + circuit addresses through every policy boundary
---

# 10.2 — Relay seeds + circuit policy — plan

## Build-time unknowns — RESOLVED before code (2026-10-19, verified against installed dists)

1. **Does `getMultiaddrs()` include the reservation address natively?** NO on
   our pinned stack for OUR reservation type. `address-manager/index.js:272`
   builds transport addrs from `transportManager.getListeners()` /
   `getAddrs()` — the circuit LISTEN path only; 5.7 deliberately uses the
   'configured' `addRelay` (no circuit listener — the listener's
   `addedRelay` crashes on `/memory` reservation addrs, pinned in
   circuit-relay-v2.test.ts). `appendAnnounce` is init-time static (private
   Set) — no dynamic announce. ⇒ **adapter-level announce**: the adapter
   computes its own circuit address per held seed and appends it to
   `listenAddresses()` (the ONE source announce/invite/book/crawl read
   since 8.5). Wire-level identify does NOT learn it — documented gap, same
   as 5.7; invite-over-gossip is the join path anyway.
2. **Reservation lifecycle / retry:** `transport/reservation-store.js`
   self-refreshes each reservation ~5 min before expiry (native `setTimeout`
   re-`addRelay`; refresh failure removes the entry). ⇒ our bounded retry is
   for INITIAL reserve + connection-loss re-hold; steady-state maintenance
   is native. Loss signal: node `connection:close` for a seed relay peer.
3. **Circuit address form:** memory-transport dial filter accepts ONLY the
   peer-id-prefixed `/p2p/<relayId>/p2p-circuit/p2p/<self>` (5.7 experiment);
   real-transport seeds are `/ip6/…/tcp/N/p2p/<relayId>` and their circuit
   form passes both the dial filter and the 9.1 policy. Seeds MUST carry
   `/p2p/<relayId>` (needed to dial + to build our address); a seed without
   it is skipped with an event, never a throw.
4. **Policy already implements R3** — `isGlobalIp6Multiaddr` accepts iff ≥1
   `/ip6`, EVERY `/ip6` global, no `/ip4`/`ip6zone` ANYWHERE: strictly
   stronger than "first hop global" and it covers circuit chains verbatim
   (the relay hop is an `/ip6` component). `ip6Slash64` keys on the FIRST
   global `/ip6` = the RELAY's /64 for circuit addrs — exactly the ticket's
   "honest single point of network". ⇒ NO policy code change; pin with rows
   + doc comments. Validator budget (announcements.ts: 1–8 addresses per
   record) is family-blind ⇒ SHARED by construction; pin with a row.

## Design

1. **Adapter** (`net/adapter.ts`): config gains
   `relaySeeds?: readonly string[]` (default `[]`) and
   `onRelaySeed?: (event: { seed: string; ok: boolean; error?: string }) => void`
   (boot-log seam; default no-op). Non-empty seeds imply client behavior —
   independent of the 5.7 `relayRole`/`relayAddress` operator shape, which
   keeps working unchanged.
2. **Hold loop** (fire-and-forget from `start()`, epoch-guarded so `stop()`
   cancels): per seed — parse; skip-with-event unless it parses AND carries
   `/p2p/<id>`; else `dial(seed)` (bounded by DIAL_TIMEOUT_MS) +
   `reserveCircuitOnRelay` (reuse the 5.7 seam); success ⇒ record circuit
   address `${seed}/p2p-circuit/p2p/${selfId}` in `heldCircuits`, emit ok;
   failure ⇒ retry up to `SEED_ATTEMPTS = 3` with `relaySeedRetryMs`
   (default 5000, injectable for tests), then give up WITH an event — boot
   NEVER unwinds. `connection:close` for a held relay peer drops the
   circuit address and re-runs one bounded hold episode (native store
   refresh covers everything else).
3. **Announce**: `listenAddresses()` = honest direct addrs ++ held circuit
   addrs (deduped, stable order). Honesty filter never drops circuit (10.1).
4. **Policy** (`address-policy.ts`): header + `assertDialable` message
   updated (relay tier is NO LONGER "parked" — epic 10 ships it); circuit
   rule documented as already-implied. No behavior change.
5. **App glue**: `parseRelaySeeds(value: string | undefined): string[]`
   (comma-separated, trimmed, empties dropped — pure, net-config.ts);
   `NetConfigOptions.relaySeeds` passthrough; `index.ts` reads
   `SUCCINCTCOIN_RELAY_SEEDS` and wires `onRelaySeed` to boot log lines.

## Tests

- `test/relay-seeds.test.ts` (memory, headless; extends the 5.7 driver):
  - SEED_HOLD: relay + seeded client → poll until client
    `listenAddresses()` contains `/p2p/<relayId>/p2p-circuit/p2p/<self>`;
    third node dials THAT address verbatim → peers() both ways.
  - EMPTY_DEFAULT: no seeds ⇒ zero circuit addrs, boot byte-quiet (no events).
  - BAD_SEED_JUNK / BAD_SEED_NO_PEERID: skipped with `ok:false` event, never
    thrown, other seeds still hold.
  - DEAD_SEED_BOUNDED: relay absent ⇒ exactly SEED_ATTEMPTS failures
    (retryMs=10), no throw; stop() during retries cancels (no post-stop events).
  - LOSS_REHOLD: held seed's relay stops ⇒ circuit addr leaves
    listenAddresses(); relay restarts ⇒ re-hold episode restores it.
- `address-policy.test.ts`: CIRCUIT_ROWS — global-v6 hop accepts; /ip4,
  fe80::, fd00::, zone-bearing relay hops reject; second-hop junk rejects.
  SLASH64: circuit addr keys on the RELAY /64.
- announcements validator row: one direct + one circuit address verify OK;
  nine addresses rejected (budget SHARED, not doubled).
- crawler row: book entry whose address is a circuit multiaddr is dialed
  VERBATIM (mock dial captures target).
- app `net-config.test.ts`: parseRelaySeeds rows (`'a,b'`→2, junk spaces,
  `''`/undefined→[]); defaultNetConfig passthrough + DEFAULT EMPTY pin;
  env row (unset ⇒ []).

## Gates / review / commit

Standard loop: build → typecheck → root suite → quick-lens review subagent
→ finalize plan + memlog + README counts → tmp-commit-msg commit.

## Explicitly NOT in scope

- No DCUtR (10.3), no gossip-based relay advertisement (deferred-work), no
  wire-level identify of circuit addrs (documented gap above).
- No relay-server hardening (5.7 server stays config-only).

## Build log

- 2026-10-19: implemented per plan — adapter hold loop + announce, app env
  glue (`parseRelaySeeds`, `SUCCINCTCOIN_RELAY_SEEDS`, `[boot] relay HOLD/
  FAIL` lines), policy docs (relay tier no longer "parked"), test rows as
  planned. Deviation from plan D2: the loss watcher re-holds on ANY
  `connection:close` for the relay peer (delete-before-re-hold keeps at most
  one episode per seed live).
- Quick-lens review → F1–F6. Fixed: **F1** epoch counter replaced with a RUN
  OBJECT (stop→start inside one retry sleep could revive a stale loop under
  an integer ABA; object identity cannot); **F2** LOSS_DETECT now pins that
  the re-hold episode RUNS (exactly SEED_ATTEMPTS failures), not just that
  it bounds; **F4** EMPTY_DEFAULT gained a quiet window; **F5**
  `reserveCircuitOnRelay` resolves a BOOLEAN — a refused RESERVE is an
  attempt failure, so `ok:true`/`[boot] relay HOLD` never announces an
  address the relay would answer NO_RESERVATION for; **F6** shape + policy
  pre-flight (deterministic rejects get ONE skip event, never three
  retries). F3 accepted: memory dials to absent listeners reject
  synchronously (file ran <1 s headless); test-side dial attempts are
  additionally raced at 600 ms so no loop can eat the suite budget.
- Suite-stability note: three full-suite runs mid-story failed ~5–8 heavy
  gossip rows at ~900 s each while isolated groups passed in seconds; a
  clean-HEAD control run confirmed EXTERNAL machine load (Spotlight/
  `mdworker` churn). Post-fix quiet-machine gate: root 478/66 in 118 s,
  app 49/9, build + typecheck clean.

