# Discovery design — ticket-seeded bootstrap-free discovery (CAP-7)

Mechanism reference for CAP-7; owned by bmad-spec. The invariant everything below serves: **no channel is load-bearing** — the SPOF dies by plurality plus verification, not abstinence. Source of decisions: spec `.memlog.md` 2026-10-17 entries; brainstorm record in `../brainstorm-bootstrap-free-auto-discovery/`.

## Why tickets are the registry

The chain continuously receives **signed liveness proofs**: mining tickets (identity-signed responses to the per-window challenge, 4.2) and block winners recorded per slot. A ticket proves *that identity was alive and mining right now*, and forging presence costs mining work — sybil cost falls out of the protocol for free. Recording presence alongside chain data turns the network into a self-certifying, self-expiring address book with no operator.

## Announcement records (proto change — PROTO_OK gate)

`PeerAnnouncement { identityId, multiaddrs[], observedExternalAddr?, slotStart, slotEnd }`, signed by the identity key.

- Gossiped on the existing peers topic AND anchored in block metadata (block winners and ticket submitters publish theirs).
- **Expiry is chain-time:** valid for `[slotStart, slotEnd]`; re-announce driven by block-applied events; expired records are dead weight nobody relays. No wall clocks (AD-3).
- **Reorg-safe:** announcements are block data — they roll back and re-confirm exactly like the chain (no off-chain address state to desync).
- **One identity, many addresses:** book dedupes by `identityId`, not address — DHCP/NAT rotation is natural; identities persist.
- **Network-scoped:** records carry the chain id; testnet presence can never contaminate mainnet books.

## Trust taxonomy (the address book)

Every record is tagged `(source class, first-seen slot)`. Connect-eligibility rules key on the class:

| Class | Examples | Cost to forge | Rule |
|---|---|---|---|
| block-grade | announcements in validated blocks | mining work | connect-eligible if fresh |
| log-grade | CT-style public logs (parked tier) | ~log fee | corroborate, then dial |
| dns-grade | `dnsaddr`/SRV conventions (parked tier) | a domain | hint until 3 introductions |
| hint-grade | gossiped records, books, embedded release hints | ~nothing | never dialed directly; never re-gossiped until verified |

**Three-introductions rule:** a hint becomes connect-eligible only after ≥3 independent signed introductions ("I saw X online at slot s" — Letter of Introduction from distinct known identities). Introductions carry reachability class (direct / via-relay / LAN) so NATed targets get usable addresses.

## Fallback ladder (boot sequence; MVP rungs)

1. **mDNS** (LAN multicast) — shipped 7.2.
2. **LAN shared address-book file** — OS-level file the instances on a machine/subnet share; also the answer when Electron sandbox/firewall blocks multicast (open 7.2 unknown).
3. **Sync the chain from ANY artifact** — peer, torrent, `.scsnap` snapshot file, USB stick, archive mirror: *read before dial*; membership bootstraps from data, not from a live peer.
4. **Read announcements from recent blocks** — the address book arrives with the chain.

No rung is required; there is no shipped file of defaults that can stale out. Release-embedded build-time hints are allowed only as explicitly stamp-expired hint-grade entries.

## Swarm rules (dumb, local, emergent)

- **Handshake Swap:** on contact each side offers up to ~8 random book records; receiver keeps its best ~20 by freshness + identity-distance diversity.
- **Address Grafting:** A tells B the address it sees for B — everyone learns their own external face (autonat-lite); confidence grows when a third peer confirms.
- **k-bucket recency:** remember last ~20 peers seen <1 min; on disconnect, hand over 5 random records.
- **Eclipse guard:** cap share of connections per /24/ASN; keep ≥1 contact per identity-distance bucket (space-filling).
- **Blizzard mode:** chain head older than M slots → widen fanout, lower freshness bar; isolation makes discovery more aggressive.
- **Dial budget:** try each new address once, 2 s budget; 3 failures quarantine for a slot window.
- **Farewell Gift / Echo Chamber:** graceful shutdown pushes the book to 3 contacts; periodically ask 2 random peers whether they see *you* — silence triggers transport switch (self-diagnosis).
- Rate-limit announcement re-gossip per publisher; verify signatures before relay so forgeries self-clean.

## Verification testbeds

- **Amnesiac Boot Proof** (CAP-7 success): wiped node + ONE block-grade record → ≥k healthy peers across distinct /24s in <30 s — LAN and NATed-internet variants; runs headless over memory transport with a simulated book (AD-10), real-stack variant via the `mdns-smoke.mjs` pattern.
- **Poison test:** injected forged/expired/hint-grade records never produce a dial or a re-gossip.
- **Discovery lint (CI):** repo-wide scan fails on hardwired multiaddrs outside test fixtures — the anti-seed immune system.

## Prerequisite (blocking build)

Per-install identity seed: while every install derives one shared `IDENTITY_SEED` (deferred-work 6.2(3); OPEN 2026-10-17), ticket-presence cannot distinguish installs and cross-instance tickets dedupe. Ratification is a human decision; CAP-7 mechanics are spec-complete without it but unverifiable end-to-end until it lands.

## Parked tiers (spec-adjacent, not v1)

Stateless UDP **Hello Packet** (signed identity + head digest → 5 introductions; anyone-can-be-a-door); CT-log/crt.sh registry; ownerless `dnsaddr` federation; mega-DHT rendezvous under genesis-hash namespace (interacts with the standing no-DHT non-goal — that bans a *protocol* DHT, this borrows foreign DHTs as hint sources); cross-chain memory-hole announcements; radio/LoRa/BLE physical tiers; `.scsnap` bundle format.
