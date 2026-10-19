---
type: plan
ticket: "9.1"
title: "IPv6-only addressing policy: v6 listen, boundary rejects, mDNS default off"
status: built
created: '2026-10-18'
---

# 9.1 Plan — IPv6-only addressing policy

## Intent resolution (overrides board verify wording where noted)

- Mixed-record handling **simplified**: the announcement validator rejects a record
  containing ANY non-policy multiaddr (new reason `unsupported-address`) rather than
  filtering mixed records — announcements are self-authored and nodes only ever
  announce policy-valid addresses, so mixed records cannot occur legitimately; whole-
  record rejection is deterministic for consensus validation. Board line "mixed keeps
  only v6" reinterpreted: the *dial list* a consumer derives never contains v4 because
  such records never enter the book at all.
- `dial()` guard lives inside `adapter.dial` **only when transport === 'tcp'** (memory
  transport stays policy-free, AD-10 fixtures unaffected). Bootstrap service gets the
  same tcp-only filter at wiring.
- Policy = global unicast `2000::/3` only (docs prefix `2001:db8::/32` accepted — it
  is inside 2000::/3); rejected: any `/ip4`, `::1`, `fe80::/10` (incl. zones), `::`,
  ULA `fc00::/7`, multicast `ff00::/8`. `/p2p-circuit` paths allowed iff every ip6
  component passes and no ip4 appears.

## Changes

1. **NEW** `packages/core/src/net/address-policy.ts` (pure, zero deps beyond
   `@multiformats/multiaddr`): `isGlobalIp6Multiaddr`, `filterPolicyAddresses`,
   `assertDialable` (throws `{code:'SC-NET-1', message}` naming the parked relay tier).
   Exported from core index.
2. `discovery/announcements.ts`: validator — every `multiaddrs[]` entry must pass
   `isGlobalIp6Multiaddr` else `unsupported-address`; self-announcement builder filters
   caller-supplied addresses through the policy (empty ⇒ builder throws clear error).
3. `net/adapter.ts`: `dial()` asserts when tcp; `buildPeerDiscovery` filters
   `config.bootstrap` when tcp.
4. App `net-config.ts`: listen `/ip6/::/tcp/0` (`/ip6/::/tcp/<port>` pinned form);
   `mdns: opts.mdns === true` (default OFF). `index.ts` boot: `SUCCINCTCOIN_MDNS=1`
   opt-in; dial-me filter via `isGlobalIp6Multiaddr`.
5. Tests: migrate `/ip4` fixtures → `2001:db8:<n>::` across core/app suites; Amnesiac
   diversity /24→/64; lint gains no-`/ip4`-in-src rule; new `address-policy.test.ts`;
   net-config mdns/listen rows updated.

## Gates

build PROTO_OK → typecheck → root suite → app suite; quick-lens review; commit.

## Build log (2026-10-18)

- Gates green: build PROTO_OK, typecheck clean, root 387/55 files, app 36/7.
- Quick-lens review found and FIXED in-story: (1) leading-`::` IPv4-compat
  text (`::32.1.13.184`) judged by the tail's first group — now `dd === 0`
  rejects outright, pinned with `::1.2.3.4` / `::ffff:1.2.3.4` reject rows;
  (2) vacuous 160/161-char length pins after fixture migration — recomputed
  against the 20-char prefix and a real unparseable-but-in-shape row added;
  (3) observed-addr parse failure now keeps its dedicated `malformed-observed-addr`
  reason; (4) dial()/bootstrap comments no longer overclaim completeness.
- Review findings DEFERRED (recorded for 9.5 deferred-work list): a libp2p
  connectionGater to close identify-pushed / opt-in-mDNS dials (our `dial()`
  guard covers only our own dial calls); operator-visible diagnostics when
  bootstrap entries are policy-dropped.
- Pinned decisions surfaced by review: embedded IPv4 inside a global address
  (`2001:db8::1.2.3.4`) ACCEPTS (it is a legitimate global v6); the deprecated
  v4-mapped/compat forms reject because their first hextet is zero. Boundary
  rows `3fff::1` accept / `4000::1` reject pin the /3 mask. Canonical
  `/ip6zone/en0/ip6/fe80::1` row exercises the CODE_IP6ZONE branch.
- Wire goldens (`chain-sync`, `net-adapter`) reverted untouched — byte-pinned
  vectors do not pass the announcement validator. `GOLDEN_DIGEST_SIG` in the
  announcement suite re-pinned for the v6 test fixtures (documented inline).
