---
id: 3
type: story
title: "Two-instance LAN proof on a real network (closing, hitl)"
parent: epic-real-network
covers: [R2, R4]
after: [1, 2]
hitl: true
risk: low
---

# Two-instance LAN proof on a real network (closing, hitl)

## Description

Closing story, run by the user. Start two instances of the built app on one LAN and observe: each node's peers read-API/UI shows the other instance's peer id with no manual multiaddrs (mDNS discovery), and gossip flows both ways (block/ticket events observed on both sides — chain heads advance). Record the evidence in THIS ticket file (both peer ids, slots observed, date), mark deferred-work.md item (4) RESOLVED, and move this file to done/. If discovery fails, fix and re-run until the observation holds. PARTLY PRE-PROVEN: transport-level discovery + two-way block gossip already passed between two processes on one machine with zero bootstrap entries (mdns-smoke.mjs beside this epic's tickets; log in evidence-two-process-smoke.md) — the remaining scope is the packaged/Electron path across real devices. NOTE 2026-10-17: epic-bootstrap-free-discovery ticket 8.6 will partially supersede this proof (its artifact-only internet join subsumes part of the observation); 7.3 stays open for its own evidence value, and building 8.1 first would additionally unlock cross-instance ticket interplay here. SUPERSEDED 2026-10-18 (change-ipv6-invitation-join, approved): mDNS is demoted to an opt-in flag under the IPv6-only + invitation pivot — this multicast-based proof no longer gates anything; keep as OPTIONAL regression evidence only if the mdns flag is ever re-enabled on a friendly network. The live two-device proof now rides re-scoped 8.6.

## Acceptance Criteria

Verify: On a real LAN: two app instances discover each other with zero manual configuration; blocks/tickets gossip both ways; evidence recorded in this ticket file AND deferred-work.md item (4) marked RESOLVED. Root suite still green headless.

## References

- parent — _bmad-output/initiative-succinctcoin-ai/epic-real-network/epic-real-network.md

## Notes

- Unknown: The user's LAN/NAT environment (AP isolation or mDNS-blocking networks would force the documented genesis-bootstrap fallback instead of multicast discovery). KNOWN CAVEAT (7.2 review): all installs share the pinned IDENTITY_SEED (deferred-work 6.2(3)), so the node-loop dedupes cross-instance tickets as same-identity duplicates — expect peer discovery + block gossip to work while ticket interplay does not; record it in the evidence rather than treating it as a discovery failure (see the OPEN 2026-10-17 deferred-work entry).

## Evidence (2026-10-22 — accepted by user)

Run on two Macs, one Wi-Fi segment, under the LAN-locality mode (`SUCCINCTCOIN_LAN=1`, spec CAP-9, build `15117a4`) — the mDNS flag re-enabled on a friendly network, exactly the condition this ticket's 2026-10-18 note reserved for regression evidence:

- Machine A boot line: `[boot] LAN dial: /ip4/192.168.1.17/tcp/50759/p2p/12D3KooWGGh3v9zbCCjBetcRbhM4txbGPwAijbdS4Xy6UoT8rogH (local testnet — not an invite)` — a REAL announced address (the pre-fix default bind announced `/ip6/::1` junk, tcpdump-proved).
- The app's Network peers showed the OTHER machine's instance `12D3KooWM3apt8Q1Pfp5WAyxrUrd2ckiSi6WVPKnETjPGhnYST1R` with ZERO manual multiaddrs — mDNS discovery + automatic dial + identify (the panel lists identified connections only).
- Corroborating probe (`../epic-real-network/mdns-lan.mjs`, one machine, two LAN-mode adapters): PASS — both nodes connected AND independently discovered the same cross-machine peer over LAN multicast.

Observed: peer discovery with zero manual configuration (core of the Verify). NOT separately recorded this run: both-ways block-gossip advance in the UI (peers() proves identified connections; gossip topics are subscribed at adapter level). Caveat honored: the ticket's own superseding note makes this optional regression evidence — accepted on that basis, with the real bug it caught (junk announcement) fixed as CAP-9. deferred-work item (4) marked RESOLVED.
