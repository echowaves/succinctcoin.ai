---
title: 'LAN locality prototype: SUCCINCTCOIN_LAN=1 (v4 bind + mDNS, opt-in)'
status: built
baseline_revision: 9b939d4
review: quick
review_source: pinned
lenses_ran: [quick]
context:
  - packages/core/src/net/address-policy.ts
  - packages/core/src/net/adapter.ts
  - packages/app/src/main/net-config.ts
  - packages/app/src/main/index.ts
  - packages/app/src/main/run-node.ts
  - packages/core/test/discovery-lint.test.ts
---

# Plan — LAN Locality Prototype (`SUCCINCTCOIN_LAN=1`)

## Intent (user-verified field facts, 2026-10-22)

Two real machines on one LAN (no global IPv6) cannot see each other. tcpdump
PROVED: mDNS itself works (our `_p2p._udp` service answers), but the announced
`dnsaddr=/ip6/::1/tcp/<port>/p2p/<id>` is self-referential junk — because the
`/ip6/::` wildcard bind expands via `getThinWaistAddresses`, which SKIPS
link-local, leaving only loopback `::1`. The discovery-dial path (adapter
`peer:discovery` listener) dials through libp2p internals, NOT our policy
guard — so a REAL announced address would already be dialed and connected.
The single missing link is: announce a real LAN address.

User decision: creative direct-connect for LAN ("discover/set the self address
which can be shared … dial directly"). Spec amendment waits until this
prototype proves itself in the field; this is an opt-in dev/operator mode,
default OFF, byte-identical when unset (the 9.6 loopback-flag pattern).

## Design (frozen)

`SUCCINCTCOIN_LAN=1` (app + headless runner) ⇒ LAN mode:

1. **Bind**: `listenAddress` becomes `/ip4/0.0.0.0/tcp/<port|0>` INSTEAD of
   the v6 wildcard (single listener — no dual-bind port collisions; on a
   machine with global IPv6 LAN mode deliberately trades WAN-v6 for LAN-v4,
   documented "local-first testnet" honesty). The v4 wildcard expands to
   `127.0.0.1` + real LAN IPs (verified in `@libp2p/utils/get-thin-waist-addresses`).
2. **mDNS on**: LAN mode implies `mdns: true` (multicast is the discovery
   mechanism; without it LAN mode has no peer source).
3. **Loopback honesty at the wire level** (core): with config `lanMode: true`
   the adapter's `announceFilter` additionally DROPS loopback-family direct
   addresses (`::1`, `/ip4/127.*`) — so the mDNS TXT / identify carry ONLY
   the real LAN address. This fixes the `multiaddrs[0]`-dial reliability
   problem without touching the 5.3 dial listener.
4. **Boot line** (both paths): LAN mode prints `[boot] LAN dial: <addr>` for
   non-loopback listen addresses (the copy-paste value for `bootstrap.txt`).

**What does NOT change (pinned invariants):** every address law (announce,
dial, hop, seed, record validation) — LAN `/ip4` can NEVER enter a block,
announcement, invite, or our own policy-guarded `dial()`. Default config
byte-identical with the flag unset (net-config exact pins stay green).

## Edit list

1. `packages/core/src/net/address-policy.ts` — `isLoopbackV4Multiaddr`
   (component-walk, first IPv4 octet 127; NO `/ip4/<digit>` literal in source)
   + `dropsForLanMode(addr)` = loopback-family v6 OR v4 (composes the existing
   `isLoopbackIp6Multiaddr`). Pure.
2. `packages/core/src/net/adapter.ts` — config `lanMode?: boolean`; when set,
   `announceFilter` = honest AND NOT dropsForLanMode. Absent ⇒ byte-identical.
3. `packages/app/src/main/net-config.ts` — exported
   `LAN_V4_LISTEN_ADDRESS` (the ONE exempted v4 literal position); option
   `lan?: boolean` ⇒ listenAddress = `/ip4/0.0.0.0/tcp/<port>`, mdns true,
   lanMode true. Absent ⇒ existing output EXACTLY (pins).
4. `packages/app/src/main/index.ts` + `run-node.ts` — read
   `SUCCINCTCOIN_LAN`; LAN-mode `[boot] LAN dial:` line; runner usage line.
5. `packages/core/test/discovery-lint.test.ts` — second position-scoped
   exemption (the `LAN_V4_LISTEN_ADDRESS` declaration in net-config.ts,
   hardwired-ip4 only) + fixture rows: exempt region reads clean, a `/ip4`
   ANYWHERE ELSE still fires (non-vacuity).
6. Tests: net-config exact pins for `lan:true` shape + default unchanged;
   address-policy loopback-v4/lan-drop rows; run-node env→config row; lint
   real-repo scan stays green with the new constant.
7. README — LAN mode paragraph (local-first testnet; NOT a WAN identity).

## Matrix Test Audit notes

- No CI row can bind tcp (AD-10): the end-to-end "two Macs connect" proof is
  THE field test (user, HITL) — disclosed, not faked with memory transport.
- Existing discovery-dial rows unchanged (listener untouched).
- Lint header comment updated: two exempt positions (seed region + LAN bind).

## Field verification (after build)

`SUCCINCTCOIN_LAN=1 corepack pnpm start` on both machines → Network peers
lists each other over `/ip4/192.168.x.y`; heights climb in step; control: kill
+ relaunch without the flag ⇒ peers vanish. On success: spec amendment via
bmad-spec + epic slice via bmad-ticket (LAN locality capability).

## Review Triage Log (quick lens, 2026-10-22)

| # | Finding | Verdict | Action |
|---|---------|---------|--------|
| F1 | Bootstrap filter (`filterDialableAddresses`) silently drops `/ip4` pins in LAN mode — the `[boot] LAN dial:` address, once pasted into `bootstrap.txt`, would be discarded before dialing; fallback path broken exactly when multicast is blocked. | Real | Fixed: new `isLanBootstrapMultiaddr` (dial law OR private-RFC1918/127 v4, direct or circuit-hop, never `/ip6`); adapter bootstrap filter branches on `lanMode`. Public `/ip4` still never survives (pinned). |
| F2 | Docstring contradictions: address-policy doc implied LAN mode drops circuit addresses; adapter 10.1 commentclaimed honesty-only filtering while lanMode is a real second filter. | Real | Fixed: both comments rewritten — circuits are KEPT (no IP at all); adapter says "never drop BY HONESTY … only LAN mode's loopback filter can touch them". |
| F3 | Lint exemption value-blind (`'[^']*'`): a concrete endpoint could hide behind the exempt constant name in the exempt file. | Partially real (name+file already scoped; value was not) | Fixed: `LAN_BIND_RE` now matches ONLY the wildcard value `'\/ip4\/0\.0\.0\.0…'`; new fixture row — `/ip4/203.0.113.7/...` behind the exempt name IN the exempt position still fires. |
| F4 | `[boot] LAN dial:` line had no test (both paths). | Real | Fixed: run-node.test row via the `listenAs` seam — real LAN addr printed, `127.0.0.1` excluded, "local testnet — not an invite" label present. |
| F5 | index.ts LAN boot line dropped the `(bootstrap hints: N from …)` suffix the v6 line carries. | Real | Fixed: shared `hints` suffix on both lines. |

## Implementation Notes

- Helper names as shipped: `isLoopbackV4Multiaddr`, `lanModeDropsAddress`
  (was `dropsForLanMode` in the plan), plus review-driven
  `isLanBootstrapMultiaddr` — all exported from `@succinctcoin/core`.
- LAN bind REPLACES the v6 bind (single listener); port flag/env ride the
  same `.replace(/\/tcp\/0$/, …)` rewrite as before.
- Gates at built: root build/typecheck clean; root vitest 556/70 files;
  app tsc clean; app vitest 76/10 files. Default path byte-identical
  (all pre-existing exact pins green, lint real-repo scan green).
