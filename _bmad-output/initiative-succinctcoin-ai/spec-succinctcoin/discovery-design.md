# Discovery design — ticket-seeded bootstrap-free discovery (CAP-7)

Mechanism reference for CAP-7; owned by bmad-spec. The invariant everything below serves: **no channel is load-bearing** — the SPOF dies by plurality plus verification, not abstinence. Source of decisions: spec `.memlog.md` 2026-10-17 entries; brainstorm record in `../brainstorm-bootstrap-free-auto-discovery/`.

## Why tickets are the registry

The chain continuously receives **signed liveness proofs**: mining tickets (identity-signed responses to the per-window challenge, 4.2) and block winners recorded per slot. A ticket proves *that identity was alive and mining right now*, and forging presence costs mining work — sybil cost falls out of the protocol for free. Recording presence alongside chain data turns the network into a self-certifying, self-expiring address book with no operator.

## Announcement records (proto change — PROTO_OK gate)

`PeerAnnouncement { identityId, multiaddrs[], observedExternalAddr?, slotStart, slotEnd }`, signed by the identity key.

- Gossiped on the existing peers topic AND anchored in block metadata (block winners and ticket submitters publish theirs).
- **Address shapes (amended 2026-10-21 for CAP-8):** `multiaddrs` entries are direct global `/ip6` addresses, or circuit addresses whose HOP passes the relay-hop rule below — non-global hops and direct `/ip4` never enter an announcement (spec constraint); macOS-style rotating interface IDs are absorbed by chain-time re-announce.
- **Expiry is chain-time:** valid for `[slotStart, slotEnd]`; re-announce driven by block-applied events; expired records are dead weight nobody relays. No wall clocks (AD-3).
- **Reorg-safe:** announcements are block data — they roll back and re-confirm exactly like the chain (no off-chain address state to desync).
- **One identity, many addresses:** book dedupes by `identityId`, not address — DHCP/NAT rotation is natural; identities persist.
- **Network-scoped:** records carry the chain id; testnet presence can never contaminate mainnet books.

## Trust taxonomy (the address book)

Every record is tagged `(source class, first-seen slot)`. Connect-eligibility rules key on the class:

| Class | Examples | Cost to forge | Rule |
|---|---|---|---|
| block-grade | announcements in validated blocks; **verified invitations** (sig + chain-time-fresh + identity has recent tickets) | mining work | connect-eligible if fresh |
| log-grade | CT-style public logs (parked tier) | ~log fee | corroborate, then dial |
| dns-grade | `dnsaddr`/SRV conventions (parked tier) | a domain | hint until 3 introductions |
| hint-grade | gossiped records, books, embedded release hints | ~nothing | never dialed directly; never re-gossiped until verified |

**Three-introductions rule:** a hint becomes connect-eligible only after ≥3 independent signed introductions ("I saw X online at slot s" — Letter of Introduction from distinct known identities). Introductions carry reachability class (direct / via-relay / LAN) so NATed targets get usable addresses.

## Relay-hop addressing (CAP-8, dual-stack hop)

The one exception to IPv6-only addressing, kept small on purpose (full evidence + verdict: CGNAT research companion):

- **Rule:** a `/…/p2p-circuit/p2p/<id>` address is valid iff its leading HOP segment (`/ip4|/ip6/…/tcp/N[/p2p/<relayId>]`) is **global scope** — v4 or v6 — and the remainder carries no IP components. Global rejects RFC1918, CGNAT `100.64.0.0/10`, loopback, link-local, ULA, multicast, zones; direct addresses keep the strict global-`/ip6` law. One predicate module owns every boundary (dial/announce/ingest/book/crawl); consensus mechanics never see a new family — only a widened address-shape check.
- **Diversity/anti-abuse keys on the hop network:** relayed entries count one point of network per relay `/64` (v6) or per-IP/`/24` (v4).
- **Seeds are bootstrap, never trust root (amended 2026-10-22):** software ships an EMPTY built-in seed list — the project operates no relay and owns no domain or DNS. Seeds are IP-form multiaddrs (`/ip4|/ip6/<host>/tcp/N/p2p/<relayId>`) operators pin via `SUCCINCTCOIN_RELAY_SEEDS`, typically published by volunteers as text; domains name hosts for humans only (the seed law rejects `/dns`). Records reached through any relay still verify by signature + tickets like every other class. Seeds absent or dead degrades exactly to epic-10 behavior; volunteer relays dilute any seed.

## Fallback ladder (boot sequence; MVP rungs)

0. **Trusted invitation** (human channel) — a fresh identity-signed announcement rendered as text/QR and shared out-of-band (email/SMS/copy-paste); verified by signature + chain-time freshness + recent-ticket liveness before the first dial. This is rung 0 since the 2026-10-18 course correction: middleboxes in real LANs drop multicast, so zero-config discovery cannot be load-bearing.
1. **mDNS** (LAN multicast) — OPTIONAL dev/LAN convenience behind an opt-in flag, default off (`@libp2p/mdns` is IPv4-multicast-only by construction); the `bootstrap.txt` file seam is its CLI/headless sibling for invites.
2. **LAN shared address-book file** — OS-level file the instances on a machine share; still useful in air-gapped dev.
3. **Sync the chain from ANY artifact** — peer, torrent, `.scsnap` snapshot file, USB stick, archive mirror: *read before dial*; membership bootstraps from data, not from a live peer.
4. **Read announcements from recent blocks** — the address book arrives with the chain.

No rung is required; there is no shipped file of defaults that can stale out. Release-embedded build-time hints are allowed only as explicitly stamp-expired hint-grade entries.

## Peer-book exchange & crawl (recursive fill from one invite)

Joining from a single invitation must reach the wider network without infrastructure:

- **Protocol:** `/succinctcoin/peerbook/1` request/response stream (proto, AD-8/AD-12, PROTO_OK gate): `PeerBookRequest { limit }` → `PeerBookResponse { records[] }` where each record is a signed announcement + the responder's corroboration witness. Responses serve the responder's top-scored fresh records.
- **Crawl policy (BFS from the invite):** depth ≤ 3, concurrency ≤ 8, per-address dial budget 2 s (existing rule), quarantine on failure (existing rule), and a hard book cap of **100 entries**. Records enter the book through the same IPv6-only + trust-class gate as every other ingest; the crawl never dials hint-grade records directly.
- **Diversity:** at-cap eviction keeps /64-prefix diversity (eclipse guard extended to v6 prefixes); Address Grafting is load-bearing for learning one's own global v6 face.

## Reliability scoring (local, selection-only)

Every book record carries a local score — Bitcoin addrman / Ethereum peer-scoring precedent. Inputs: dial-success EWMA, seen-across-slots stability, served-data validity (blocks/tickets it gossipped validated), corroboration count, observed latency. Uses are **selection only**: dial-order priority, which records to re-share (top-K), at-cap eviction. A score never grants connect-eligibility or validation trust — a poisoned record can only sink itself (verify-before-connect preserved).

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

- **Amnesiac Boot Proof** (CAP-7 success): wiped node + ONE block-grade record (a human-channel invitation qualifies) → ≥k healthy peers across distinct /64s in <30 s, book ≤100 — LAN and NATed-internet variants; runs headless over memory transport with a simulated book (AD-10); real-stack variant via the `dial-manual.mjs` invite-dial pattern (`mdns-smoke.mjs` retired to legacy).
- **Poison test:** injected forged/expired/hint-grade records never produce a dial or a re-gossip.
- **Discovery lint (CI):** repo-wide scan fails on hardwired multiaddrs outside test fixtures, and on `/ip4` multiaddrs in non-test sources except at relay-hop positions the CAP-8 predicate governs (seed config, hop fixtures) — the anti-seed / direct-IPv6-only immune system.

## Prerequisite (blocking build)

Per-install identity seed: while every install derives one shared `IDENTITY_SEED` (deferred-work 6.2(3); OPEN 2026-10-17), ticket-presence cannot distinguish installs and cross-instance tickets dedupe. Ratification is a human decision; CAP-7 mechanics are spec-complete without it but unverifiable end-to-end until it lands.

## Parked tiers (spec-adjacent, not v1)

Stateless UDP **Hello Packet** (signed identity + head digest → 5 introductions; anyone-can-be-a-door); CT-log/crt.sh registry; ownerless `dnsaddr` federation; mega-DHT rendezvous under genesis-hash namespace (interacts with the standing no-DHT non-goal — that bans a *protocol* DHT, this borrows foreign DHTs as hint sources); cross-chain memory-hole announcements; radio/LoRa/BLE physical tiers; `.scsnap` bundle format.
