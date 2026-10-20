---
id: story-autonat-reachability-truth-know-it-expose-it
status: built
epic: epic-reachability-tier (ticket 10.1)
title: AutoNAT reachability truth — know it, expose it, announce honestly
---

# 10.1 — AutoNAT reachability truth — plan

## Build-time unknowns — RESOLVED before code (2026-10-19)

1. **Which package?** `@libp2p/autonat` v1 3.0.32 is legacy and USELESS for
   this topology: it only confirms/removes OBSERVED addrs (NAT case); our
   nodes advertise bound LISTEN addrs, which v1 never touches, and it emits
   nothing observable. Swapped to `@libp2p/autonat-v2` **2.1.4** (exact pin,
   devDependencies per core's bundling convention — ALL libp2p runtime deps
   live there; app bundles them). 2.1.4 is the LAST release built on
   `@libp2p/interface-internal@^3.1.13` (what libp2p 3.3.11 locks); 2.1.6+
   require 3.2.x, whose new `registrar.use(middleware)` overload breaks
   Registrar type identity → build failure. `pnpm-workspace.yaml` now pins
   ONE copy of every shared interface package via `overrides:` (the pnpm-12
   location; package.json's `pnpm` field is ignored) +
   `minimumReleaseAgeExclude` for the two fresh transitives
   (peer-collections@7.0.32, utils@7.4.5).
2. **Native filtering?** NO: libp2p 3.3.11 `getAddresses()` filters only by
   the `verified` flag; transport listen addrs are verified-by-construction
   and AutoNAT-v2's `unconfirmAddress` removes only from the OBSERVED list.
   ⇒ **adapter-level suppression** is the path (the ticket's anticipated
   fallback). The pinned evidence: autonat-v2 `client.js` emits typed
   `address:reachable` / `address:unreachable` events ({addr,type,success,
   failure}) — that IS the truth surface; libp2p just doesn't act on it for
   listen addrs.

## Design (pinned)

1. **NEW pure module** `packages/core/src/net/reachability.ts`:
   - `type Reachability = 'unknown' | 'reachable' | 'unreachable'`.
   - `createReachabilityTracker()` — `observe(addrText, reachable)`,
     `state(addrText)`, `aggregate()`, `view()` (read-only map). Aggregate:
     no evidence ⇒ 'unknown'; ANY observed-reachable ⇒ 'reachable'; all
     observed-unreachable ⇒ 'unreachable'.
   - `isCircuitAddressText(text)` — contains a `/p2p-circuit` component
     (string-level here; the 10.2 policy module owns the real rule).
   - `filterHonestAddresses(addresses, seen)` — drop only KNOWN-unreachable
     non-circuit addresses; unknown/reachable/circuit always pass (unknown =
     today's behavior pinned: fresh boot announces everything).
   - `autoNatEnabledFor(transport, override)` — pure config resolution:
     tcp ⇒ on unless explicitly false; memory ⇒ ALWAYS off (AD-10).
2. **Adapter** (`net/adapter.ts`):
   - Config gains `autoNat?: boolean | undefined` and a test seam
     `reachabilitySource?: (report) => () => void` (subscribe to addr→
     reachable reports; returns unsubscribe). Default: none.
   - services: `...(autoNatEnabledFor(...) ? { autoNatV2: autoNATv2() } : {})`.
   - start(): tracker subscribes to the injected `reachabilitySource` when
     present, else to `node.services.autoNatV2` events; stop() unsubscribes.
   - `addresses.announceFilter` (review F1 root fix): libp2p's address-
     manager applies it inside `getAddresses()` AFTER encapsulating
     `/p2p/<self>`, and BOTH `libp2p.getMultiaddrs()` and identify /
     identify-push broadcast exactly that list — so proven-dead direct addrs
     stop reaching peers ON THE WIRE. `normalizeAddressKey` strips the
     trailing `/p2p/<x>` so AutoNAT's raw-event keys and the filter's
     suffixed keys agree; `isHonestAddressText` is the shared predicate.
   - `listenAddresses()` returns `filterHonestAddresses(raw, tracker.view())`
     — belt-and-braces over the same predicate (defense in depth), and
     announce/invite/ladder all inherit honesty for free (no node-loop
     change, no policy change).
   - New `reachability(): Reachability` on NetAdapter (+ doc: 'unknown' is
     the honest default before any probe evidence exists).
3. **Barrel**: export `Reachability`, `createReachabilityTracker`,
   `filterHonestAddresses`, `isCircuitAddressText` (app diagnostics later).

## Tests (`test/net-reachability.test.ts` + adapter rows)

- Tracker vectors: default unknown; observe flips; aggregate rules incl.
  mixed-evidence → reachable; re-observe overwrites.
- Filter rows: unknown kept (= today), known-unreachable dropped, circuit
  NEVER dropped even when reported unreachable (relay path is the point),
  empty input.
- `autoNatEnabledFor`: tcp on / tcp off / memory off-even-if-requested.
- Adapter (memory transport): `reachability() === 'unknown'`; listenAddresses
  unchanged vs raw (inert pin); WITH injected reachabilitySource: report a
  real bound memory address unreachable ⇒ it vanishes from listenAddresses(),
  report reachable ⇒ returns; unsubscribe on stop (no leak — report after
  stop changes nothing).

## Gates / review / commit

Standard loop: build → typecheck → root suite → quick-lens review subagent
→ finalize plan + memlog + README counts → tmp-commit-msg commit.

## Explicitly NOT in scope

- No relay seeds / circuit announce (10.2), no DCUtR (10.3).
- No app UI surface for reachability yet (diagnostics panel is a candidate
  later; the adapter method is the seam).
- No probe scheduling tuning (startupDelay/refreshInterval stay default).

## Build log

- 2026-10-19: implemented per plan; dependency resolution as recorded above
  (v1→v2 swap, 2.1.4 pin, workspace overrides + dedupe to purge a stale
  interface-internal@3.2.2 lock resolution).
- Quick-lens review → F1–F8. Fixed: **F1** announceFilter wired (root fix,
  verified delegation `getMultiaddrs→addressManager.getAddresses→announceFilter`
  and identify.js:114 / identify-push.js:50 read the same list) +
  `normalizeAddressKey`; **F2** overrides extended to interface/peer-id/
  utils/peer-collections → lockfile now ONE version each; **F3** aggregate
  semantics documented + pinned (AGGREGATE_SEMANTICS row); **F4** INERT pins
  the exact multiaddr set, SEAM asserts unsubbed 1→2 across stop/start/stop
  and restart clears evidence; **F5** this log + 2.1.8→2.1.4; **F6** typed
  `send` alias (casts gone); **F8** wireReachability moved LAST in start()
  (no subscription leak on mid-start throw) + barrel block reordered below
  the 9.1 comment. F7 (release-age exclusions are version-brittle): ACCEPTED
  — pnpm auto-maintains the list, noted here.
- Gates post-fix: build ✓ typecheck ✓ · root suite 468/65 ✓ (reachability
  file 8 rows) · app tsc ✓ + 48 tests ✓.
