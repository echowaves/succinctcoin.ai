# Intent — Bootstrap-free auto-discovery (kill the bootstrap-list SPOF)

**Source:** brainstorm session 2026-10-17 (`brainstorm-bootstrap-free-auto-discovery/.memlog.md`, 120 entries; keepsake `brainstorm.html`). Input to: `bmad-spec` → future epic ("Ticket-Seeded Discovery").
**Goal (user's words):** the bootstrap list is a single point of failure that exists today — eliminate it so nodes always discover each other automagically, on LAN and internet. Make this the project's differentiator.

## The core insight (breakthrough)

**Tickets are already a registry.** This chain continuously receives signed liveness proofs — mining tickets (4.2 `signTicket`, gossiped on the tickets topic, winner recorded per block). A ticket proves an identity was alive *right now*; sybil cost = mining cost. If peer announcements (signed multiaddr + identity + slot range) ride alongside ticket/block data, the network carries a self-certifying, self-expiring address book. The bootstrap list is not replaced — it is revealed unnecessary.

## Design principles (from synthesis)

1. **Plurality, not abstinence.** Don't delete channels — multiply them and rank by cost-to-forge: block-grade > log-grade (CT-style) > DNS-grade > hint-grade. Every learned address is a *hint until verified* (signature + freshness). Poisoned hints fail soft; no channel is load-bearing → the SPOF dies by verification, not by policy.
2. **Read before dial.** A fresh node needs ONE block-grade artifact, obtainable off-network (torrent/USB/archive mirror/any website serving blocks). Network membership bootstraps from *data*, not from a live peer.
3. **Slot-native timing (AD-3).** Announcements carry slot ranges; expiry measured in slots; re-announce driven by block-applied events. No wall clocks anywhere in discovery.
4. **LAN is an amplifier, not a special case.** mDNS first; file-based same-machine/subnet address book as fallback (also answers the open 7.2 Electron-multicast/firewall unknown).
5. **Dumb local rules, emergent order** (swarm logic): handshake book-swap (~8 records each way), three-introductions before trusting a hint, TTL-in-slots, try-every-address-once, eclipse guard (cap per /24-ASN), blizzard mode when chain head goes stale.

## MVP shape (chosen direction)

- **Announcement records:** `{identityId, multiaddrs[], observedExternalAddr?, slotStart, slotEnd}` signed by the identity key; gossiped on a peers topic AND anchored in block metadata (ticket submitters publish theirs).
- **Source-classed address book** in the app/core: every record tagged with source class + first-seen slot; rules prefer higher classes for introductions.
- **Three-introductions rule:** hint-grade addresses become connect-eligible only after 3 independent signed introductions (Letter of Introduction: "I saw X online at slot s").
- **Fallback ladder on boot:** mDNS → LAN shared address-book file → sync chain from ANY artifact source (peer, torrent, USB `.scsnap`, archive mirror) → read announcements from recent blocks. No file of defaults ships; nothing hardwired exists to stale out.
- **Anyone-can-be-a-door tier (later):** stateless UDP Hello Packet (signed identity + head digest → replies with 5 introductions); `X-SC-Peers` HTTP header convention; existing libp2p `/rendezvous` armed with namespace = genesis hash.

## Done-when invariant (make it a test)

**Amnesiac Boot Proof:** a wiped node — no config, no history, no env vars — re-enters from ONE block-grade record and rebuilds full acquaintance via book-swap within 30 s. If this passes on a real LAN *and* across NAT, bootstrap-free is true by construction.

## Constraints & risks to carry into the spec

- AD-10: all of this must stay testable headless (memory transport doubles for announcement/ticket mechanics; real multicast stays in smoke harnesses like `mdns-smoke.mjs`).
- Privacy trade-off: on-chain/announced addresses are linkable — spec needs a rotation policy (one identity, many addresses is already the dedupe rule).
- Do NOT reopen the per-install identity-seed decision here (OPEN deferred-work 2026-10-17) but note: ticket-as-presence only differentiates instances once seeds differ per install — flag as prerequisite.
- Proto change required (announcement record + block metadata field) → PROTO_OK gate applies.
- Reorg-safety: announcements as block data roll back consistently with the chain — keep it that way (no off-chain address state that can desync).

## Notable parked ideas (deeper future tiers)

CT-log / crt.sh registry; DNS `dnsaddr` ownerless federation; mega-DHT rendezvous under genesis-hash namespace; cross-chain memory-hole announcements; radio/LoRa/BLE/ultrasonic physical tiers; `.scsnap` snapshot files (chain + book in one shareable artifact); discovery-lint CI bot banning accidental hardwired addresses repo-wide.
