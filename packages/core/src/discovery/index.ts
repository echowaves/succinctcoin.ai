/**
 * `core/discovery` — CAP-7 ticket-seeded discovery (epic 8). Ticket 8.2
 * owns the contract slice: signed peer announcements (digest, sign/verify,
 * pure validator). 8.3 adds block-carriage; 8.4 the address book; 8.5 the
 * fallback-ladder boot — all consume THIS module's pinned bytes.
 */
export {
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
