/**
 * `core/discovery/peerbook-serve` — the peer-book SERVE POLICY (ticket 9.3).
 *
 * Which records leave this node's book when a peer asks, and what witnesses
 * travel with them. The transport (`net/peerbook.ts`) only moves bytes; every
 * decision lives here, in the open, pinned by tests:
 *
 *  - ELIGIBILITY exactly `dialEligible` (8.4's verify-before-connect surface —
 *    fresh, unexpired, un-quarantined, class-promoted). Score never enters
 *    (that is 9.4's ORDER hook, the same seam).
 *  - CLASS EXCLUSION: hint-grade records are NEVER served — an
 *    uncorroborated observation must not propagate across the network
 *    (amplification guard; the receiver would only store it as hint anyway).
 *  - ORDER (9.4): reliability — local `scorePeer(history)` desc, ties by
 *    slotEnd desc then identityId asc (deterministic; with empty histories
 *    this is exactly the 9.3 freshness order). Score ORDERS the response;
 *    it never gates it — eligibility stays `dialEligible` alone.
 *  - BYTE-TRUE records: the book stores each verified record's ORIGINAL
 *    signature; a served record must verify against its fields before it
 *    leaves (defensive re-check — nothing unverified egresses, and we can
 *    never re-sign another peer's record).
 *  - WITNESSES: one SELF-SIGNED `Introduction` per served record ("I verified
 *    this identity at slotObserved = now"), signed by THIS node's identity —
 *    full 8.4 reuse, no new witness type. No identity keypair ⇒ zero
 *    witnesses (the crawl's introducer-corroboration rule then holds nothing
 *    dialable from our responses — honest, not fatal).
 */
import type { IdentityKeypair } from '../identity/index.js'
import type { PeerBookServed } from '../net/peerbook.js'
import type { Introduction, PeerAnnouncement } from '../proto/index.js'

import type { AddressBook } from './address-book.js'
import { verifyPeerAnnouncementSignature } from './announcements.js'
import type { PeerAnnouncementFields } from './announcements.js'
import { scorePeer } from './peer-score.js'
import { signIntroduction } from './introductions.js'

export interface ServePeerBookOptions {
  book: AddressBook
  /** Chain-time slot the serve happens at (AD-3 — caller-supplied). */
  currentSlot: number | bigint
  expectedChainId: string
  /** The client's requested limit (< 1 serves nothing). */
  limit: number
  /** This node's identity keypair — signs the per-record witnesses. Absent
   * ⇒ records serve WITHOUT witnesses (receivers cannot crawl through us). */
  witnessSigner?: IdentityKeypair | undefined
}

/** Apply the serve policy (module header). Pure over the book snapshot. */
export function servePeerBook(opts: ServePeerBookOptions): PeerBookServed {
  const records: PeerAnnouncement[] = []
  const witnesses: Introduction[] = []
  if (opts.limit < 1) return { records, witnesses }

  // Eligibility set (identity ids) from the ONE canonical surface…
  const eligible = new Set(opts.book.dialEligible(opts.currentSlot).map((t) => t.identityId))
  // …then the full entries for fields + signature + class.
  const served = opts.book
    .entries()
    .filter(
      (e) =>
        eligible.has(e.identityId) &&
        e.sourceClass !== 'hint' &&
        verifyPeerAnnouncementSignature(
          {
            identityId: e.identityId,
            multiaddrs: [...e.multiaddrs],
            observedExternalAddr: e.observedExternalAddr,
            slotStart: e.slotStart,
            slotEnd: e.slotEnd,
            chainId: opts.expectedChainId,
          },
          e.signature,
        ),
    )
    // 9.4 reliability order: score desc, tie → slotEnd desc (the 9.3 fresh-
    // ness order), tie → identityId asc. Empty histories score equally, so
    // a fresh book serves exactly as in 9.3.
    .sort((a, b) => {
      const sa = scorePeer(a.history)
      const sb = scorePeer(b.history)
      if (sa !== sb) return sa < sb ? 1 : -1
      if (a.slotEnd !== b.slotEnd) return a.slotEnd < b.slotEnd ? 1 : -1
      return a.identityId < b.identityId ? -1 : a.identityId === b.identityId ? 0 : 1
    })
    .slice(0, opts.limit)

  for (const e of served) {
    const fields: PeerAnnouncementFields = {
      identityId: e.identityId,
      multiaddrs: [...e.multiaddrs],
      observedExternalAddr: e.observedExternalAddr,
      slotStart: e.slotStart,
      slotEnd: e.slotEnd,
      chainId: opts.expectedChainId,
    }
    records.push({
      identityId: fields.identityId,
      multiaddrs: fields.multiaddrs,
      observedExternalAddr: fields.observedExternalAddr ?? undefined,
      slotStart: BigInt(fields.slotStart),
      slotEnd: BigInt(fields.slotEnd),
      chainId: fields.chainId,
      signature: new Uint8Array(e.signature),
    })
    if (opts.witnessSigner !== undefined) {
      const subject = {
        signerIdentityId: opts.witnessSigner.identityId,
        subjectIdentityId: e.identityId,
        slotObserved: BigInt(opts.currentSlot),
        reachability: 'direct' as const,
        chainId: opts.expectedChainId,
      }
      witnesses.push({
        ...subject,
        signature: new Uint8Array(signIntroduction(opts.witnessSigner, subject)),
      })
    }
  }
  return { records, witnesses }
}
