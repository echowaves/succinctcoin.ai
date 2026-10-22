---
id: 1
type: story
title: "LAN locality mode built as prototype (record + acceptance)"
parent: epic-lan-locality
covers: [R1, R2, R3, R4, E1]
after: []
hitl: false
---

# LAN locality mode built as prototype (record + acceptance)

## Description

BUILT OUT-OF-BAND before this epic existed — bmad-build run 2026-10-22, commit 15117a4, build record ../plan-lan-locality-prototype.md (design frozen, edit list, Review Triage Log F1-F5, gates). Implements epic R1-R4 + E1: SUCCINCTCOIN_LAN=1 v4 bind replacing the v6 wildcard (app + headless runner), mDNS implied, core lanMode loopback wire drop in announceFilter, isLanBootstrapMultiaddr bootstrap widening (private/127 v4 only; public never), honest [boot] LAN dial line, name/file/value-scoped lint exemption. This entry's remaining purpose: the acceptance decision over the field evidence.

## Acceptance Criteria

Verify: Done-when 1 of the epic holds: two machines on one segment showed each other as peers over /ip4 (field demo PASS 2026-10-22, two Macs + probe ../epic-real-network/mdns-lan.mjs PASS incl. cross-process). Done-when 2 held at build: root build/typecheck clean + vitest 556/70; app tsc clean + vitest 76/10; exact-config pins byte-identical with flag unset; lint real-repo scan green.

## References

- parent — _bmad-output/initiative-succinctcoin-ai/epic-lan-locality/epic-lan-locality.md
