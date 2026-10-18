/**
 * `core/discovery` — CAP-7 ticket-seeded discovery (epic 8). Ticket 8.2
 * owns the announcement contract slice (digest, sign/verify, pure
 * validator); 8.4 adds the Introduction vouch contract and the address
 * book; 8.3 added block-carriage; 8.5 wires the fallback-ladder boot —
 * all consume these pinned bytes.
 */
export {
  MAX_MULTIADDRS,
  PEER_ANNOUNCEMENT_DOMAIN,
  peerAnnouncementDigest,
  signPeerAnnouncement,
  validatePeerAnnouncement,
  verifyPeerAnnouncementSignature,
} from './announcements.js'
export type {
  AnnouncementContext,
  AnnouncementRejectReason,
  AnnouncementValidation,
  PeerAnnouncementFields,
  SignedPeerAnnouncement,
} from './announcements.js'

export {
  INTRODUCTION_DOMAIN,
  REACHABILITY_CLASSES,
  introductionDigest,
  signIntroduction,
  validateIntroduction,
  verifyIntroductionSignature,
} from './introductions.js'
export type {
  IntroductionContext,
  IntroductionFields,
  IntroductionReachability,
  IntroductionRejectReason,
  IntroductionValidation,
  SignedIntroduction,
} from './introductions.js'

export {
  ADDRESS_SOURCE_CLASSES,
  createAddressBook,
  DEFAULT_QUARANTINE_SLOTS,
  DIAL_FAILURES_TO_QUARANTINE,
  MAX_BOOK_ENTRIES,
  MAX_VOUCHES_PER_SUBJECT,
} from './address-book.js'
export type {
  AddressBook,
  AddressBookEntry,
  AddressBookOptions,
  AddressSourceClass,
  BlockRef,
  BookIngestContext,
  BookIngestResult,
  BookIntroResult,
  DialTarget,
} from './address-book.js'
