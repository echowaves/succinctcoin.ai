/**
 * `core/net` — the stable gossipsub topics (5.2, AD-8; 8.3/8.4 extended).
 *
 * One topic per message class (AD-8 "one stable topic per message class"):
 * blocks, tickets, tx, peer info. Each class travels on its OWN topic — a
 * block never on the tickets topic — so the topic alone tells the receiver
 * which envelope to decode (no class discriminator on the wire). The
 * trailing `/1` is the protocol version: a version bump is a protocol
 * change (genesis version bump, AD-8/AD-12), which is why the topics are
 * "stable" — they are named constants here, not derived at runtime.
 *
 * The 5.1 scratch topic (`/succinctcoin/scratch`) is REMOVED (D3): the
 * scratch topic's JSON round-trip is superseded by the per-class proto
 * envelopes (5.2 D1/D5).
 *
 * Hygiene: no `big.js` (AD-5), no RNG, no wall-clock (AD-3) — plain
 * constants.
 */

/**
 * The stable gossipsub topics, one per message class (AD-8): the original
 * four (5.2) plus the CAP-7 discovery classes — announcements (8.3) and
 * introductions (8.4). `as const` keeps the literals and makes `TopicClass`
 * the keys.
 */
export const TOPICS = {
  /** Blocks: `BlockEnvelope { block, sourcePeerId }` (proto, AD-12). */
  blocks: '/succinctcoin/blocks/1',
  /** Tickets: `TicketEnvelope { ticket, sourcePeerId }` (proto, AD-12). */
  tickets: '/succinctcoin/tickets/1',
  /** Tx: `TxEnvelope { tx, sourcePeerId }` (proto, AD-12; amounts decimal strings, AD-5). */
  tx: '/succinctcoin/tx/1',
  /** Peer info: `PeerInfoEnvelope { peerInfo, sourcePeerId }` (proto, AD-12). */
  peers: '/succinctcoin/peers/1',
  /** Announcements (CAP-7, ticket 8.3): `AnnouncementEnvelope { announcement, sourcePeerId }`. */
  announcements: '/succinctcoin/announcements/1',
  /** Introductions (CAP-7, ticket 8.4): `IntroductionEnvelope { introduction, sourcePeerId }`. */
  introductions: '/succinctcoin/introductions/1',
} as const

/** The six message classes: `keyof TOPICS` (blocks/tickets/tx/peers/announcements/introductions). */
export type TopicClass = keyof typeof TOPICS
