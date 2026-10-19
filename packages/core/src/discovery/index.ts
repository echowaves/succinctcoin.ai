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
  MAX_ENTRIES_PER_64,
  MAX_VOUCHES_PER_SUBJECT,
} from './address-book.js'

// 9.3 — the peer-book serve policy + bounded BFS crawler.
export { servePeerBook } from './peerbook-serve.js'
export type { ServePeerBookOptions } from './peerbook-serve.js'
export {
  CORROBORATION_CAP,
  emptyPeerHistory,
  ewmaUpdate,
  LATENCY_CAP_MS,
  scorePeer,
  SCORE_EWMA_ALPHA,
  STABILITY_WINDOW_SLOTS,
  VALIDITY_NEUTRAL,
  WEIGHT_CORROBORATION,
  WEIGHT_DIAL,
  WEIGHT_LATENCY,
  WEIGHT_STABILITY,
  WEIGHT_VALIDITY,
} from './peer-score.js'
export type { PeerHistory } from './peer-score.js'
export {
  CRAWL_CONCURRENCY,
  CRAWL_MAX_DEPTH,
  runCrawl,
} from './crawler.js'
export type { CrawlerDeps, CrawlReport } from './crawler.js'

export {
  applyInvites,
  defaultArtifactPath,
  defaultInvitePath,
  defaultLanBookPath,
  MAX_ARTIFACT_RECORDS,
  MAX_INVITE_LINES,
  readAnnouncementFile,
  readInviteFile,
  runBootLadder,
  writeAnnouncementFile,
  writeAnnouncementsFromMessages,
} from './boot-files.js'
export type {
  AnnouncementFileRead,
  ApplyInvitesOptions,
  BootLadderOptions,
  InviteApplyReport,
  InviteFileRead,
  LadderReport,
  LadderRungReport,
} from './boot-files.js'

export {
  DEFAULT_TICKET_LOOKBACK_SLOTS,
  encodeInvite,
  INVITE_PREFIX,
  parseInvite,
  verifyInvite,
} from './invitation.js'
export type { InviteContext, InviteRejectReason, InviteValidation } from './invitation.js'
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
