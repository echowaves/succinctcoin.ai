# D3 — js-libp2p integration reality (code-verified)

Date: 2026-10-21 · Dimension: D3 · Method: direct read of our code + libp2p spec primary

## Protocol-layer facts (primary sources)

- **Circuit Relay v2 spec** (github.com/libp2p/specs relay/circuit-v2.md, Active r3 2023): addressing is **peer-ID based**, not IP based. Dialer learns `<relay>/p2p-circuit/p2p/<target>` out-of-band, "connects to R" by whatever address family works. `Reservation.addrs` = "all the public relay addrs" — no family restriction anywhere in the spec. → **A `/ip4` relay hop is normal wire reality** (IPFS relays are overwhelmingly v4). Confidence: HIGH.
- Reservation mechanics match exactly what ticket 7 built on: RESERVE → voucher + Limit{duration,data}; relay drops connection when reservation lapses; implementations must not accept relayed connections over already-relayed (no relay chaining through us unless we want it).
- **@libp2p/autonat** v3.0.32 published 2 days ago (ACTIVE); `@libp2p/autonat-v2` exists and is recommended. Reachability classification is available in JS if we want AutoNAT-style "am I dialable?" detection to drive auto-relay triggering.
- **No maintained JS autorelay package found**: npm search for autorelay+libp2p returns only core packages; `@chainsafe/libp2p-auto-relay` → 404 on registry and GitHub. Our ticket-7 `auto-relay.ts` policy module IS the JS implementation; nothing to replace it. Confidence: HIGH (negative result, two channels).
- Kubo parity evidence (d1-r2): RelayClient/RelayService/hole-punching all default-on in Go — the JS gap is our problem to fill, not upstream's.

## Our codebase blast radius (read 2026-10-21)

`packages/core/src/net/address-policy.ts` — ONE predicate `isGlobalIp6Multiaddr`: any `/ip4` anywhere → false; every `/ip6` must be 2000::/3. Circuit chains get circuit acceptance "for free" from the same rule (ticket 10.2 design note — the general rule was deliberately made stronger than per-hop rules).
- `assertDialable` = dial-side gate (+dev `::1` flag via `SUCCINCTCOIN_ALLOW_LOOPBACK`)
- `filterDialableAddresses` = announce construction + bootstrap filtering
- Ingest: announcement/invitation validation consumes the same family of predicates; loopback exception is context-gated (`AnnouncementContext.allowLoopbackAddresses`) with strict-in-consensus-paths discipline ALREADY established — precedent for a context-scoped relaxation.

`packages/core/src/net/adapter.ts`:
- `holdSeed(seed)` → `assertDialable(seed)` (~L903) before dialing relay seeds ← **today this rejects `/ip4` seeds; the user's machine cannot even reach a dual-stack relay we operated.** This is the single blocking line.
- TCP dial path guard `assertDialable(address)` (~L1195) — target dials; must stay strict for direct (non-circuit) addresses.
- Held circuits announced as `<seed>/p2p-circuit/p2p/<self>` via announce/invite/book (ticket 7 machinery, works unchanged once seeds may be v4).
- Auto-relay rounds (ticket 7): candidates come from already-connected peers supporting circuit v2 hop — unaffected; they only ADD relays reachable by definition.

## The minimal change shape (for the report's build-cost cell)

1. New pure predicate in `address-policy.ts`: `isRelayHopDialable(addr)` — global `/ip6` OR **global** `/ip4` (reject RFC1918, CGNAT 100.64/10, loopback, link-local, LSZ, multicast); no zones; used ONLY for seed/hop dials.
2. Circuit-aware predicate for announce/ingest of `<hop>/p2p-circuit/p2p/<target>`: hop segment per (1), remainder must contain NO ip components (pure `/p2p`/`/p2p-circuit` tail — already the shape). Direct addresses keep today's strict rule.
3. `holdSeed` + dial path use the new predicates at exactly the two call sites above; consensus-path validators switch to (2) — a spec-constraint amendment (9.5/9.1 decision text), not a fork-choice change: signatures, slots, block rules untouched.
4. Default dual-stack seed shipped in app config (domain with A+AAAA) = the zero-config bootstrap (Tailscale ships DERP maps; kubo ships bootstrapers — same pattern).
5. Anti-abuse keying: relayed entries currently keyed on RELAY's /64 (`ip6Slash64`); v4 hops need the equivalent (relay /24 or per-IP cap) — small follow-on in whatever consumes that key.

## Failure modes to design for

- A v4 hop makes the announced address lie about the target's network only in the same way a v6 relay already does (target rides relay's address space) — invariant "one honest point of network per record" survives if keyed on the HOP, which is what we do.
- v4 hop exposure: relay operators get inbound dials from arbitrary v4 internet → kubo-style caps (per-IP/ASN reservations, duration/data limits) come with `circuitRelayServer()` defaults; keep them.
- No relay chaining (spec note) — our relays serve direct hops only; fine.
