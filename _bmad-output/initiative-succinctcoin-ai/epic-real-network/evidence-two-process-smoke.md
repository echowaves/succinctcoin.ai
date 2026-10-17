# Evidence — two-process real-network smoke (pre-proof for 7.3)

**Date:** 2026-10-17 · **Host:** macOS 27.0.1, one machine, two separate Node processes · **Node:** v24.14.0
**Harness:** `mdns-smoke.mjs` (beside this file) — imports the REAL `defaultNetConfig` seam from `packages/app/src/main/net-config.ts` and the built core adapter (`packages/core/dist/index.js`). Config under test is byte-for-byte what the app boots with post-7.2: `{transport:'tcp', listenAddress:'/ip4/0.0.0.0/tcp/0', mdns:true, bootstrap:[], protocolIdentityId:'smoke-identity-<A|B>'}`.

## Result — PASS (twice, 2026-10-17)

Two independent processes with an EMPTY bootstrap list discovered each other via real `@libp2p/mdns` and exchanged a gossip block in BOTH directions:

```text
[A] peerId=12D3KooWRanY1AizyvKYxoc9ognzHYb9KCPpZYjr4dPfJZWjiazu listening on /ip4/0.0.0.0/tcp/0 (mdns:true, bootstrap:[])
[A] DISCOVERED 1 peer(s): 12D3KooWMuBgwFq9wVJzSXMpas6KvRTbzs64U2mA8uLb3K1p74DY
[A] published a block (slot 777)
[A] RECEIVED 1 block(s) via gossip from sourcePeerId=smoke-identity-B
[B] peerId=12D3KooWMuBgwFq9wVJzSXMpas6KvRTbzs64U2mA8uLb3K1p74DY listening on /ip4/0.0.0.0/tcp/0 (mdns:true, bootstrap:[])
[B] DISCOVERED 1 peer(s): 12D3KooWRanY1AizyvKYxoc9ognzHYb9KCPpZYjr4dPfJZWjiazu
[B] published a block (slot 777)
[B] RECEIVED 1 block(s) via gossip from sourcePeerId=smoke-identity-A
```

## What this proves / does not

- **Proves:** the user-reported failure ("peers on the LAN can't find each other") is fixed at the transport level — mDNS multicast discovery works with zero bootstrap entries, and block gossip flows both ways. Distinct libp2p transport peer IDs per process.
- **Answers one 7.2 unknown:** mDNS discovery between two instances on ONE machine (same interface) works for plain Node processes. Still open: the Electron-packaged path (macOS firewall/entitlements for multicast from a signed app).
- **Does NOT prove:** ticket interplay across instances — all installs share the pinned `IDENTITY_SEED` (deferred-work 6.2(3); OPEN 2026-10-17 entry), so the node-loop dedupes cross-instance tickets as same-identity duplicates. This is expected behavior for this smoke, not a discovery failure.
- **Not covered:** two PHYSICAL machines / real LAN + NAT (AP isolation would force the documented genesis-bootstrap fallback) — that remains ticket 7.3's remaining scope.

## Reproduce

```sh
corepack pnpm install && corepack pnpm build   # once
node _bmad-output/initiative-succinctcoin-ai/epic-real-network/mdns-smoke.mjs A > /tmp/smoke-A.log 2>&1 &
node _bmad-output/initiative-succinctcoin-ai/epic-real-network/mdns-smoke.mjs B > /tmp/smoke-B.log 2>&1 &
wait; cat /tmp/smoke-A.log /tmp/smoke-B.log    # both must show DISCOVERED + RECEIVED from the other label
```
