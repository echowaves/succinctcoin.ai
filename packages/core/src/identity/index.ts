/**
 * `core/identity` barrel (epic 4, CAP-2).
 *
 * 4.1 stands up the module with the OFFLINE gate-credential surface:
 * the deterministic `GateVerifier` implementation (the port itself lives
 * in `src/ports.ts` — epic 1, AD-4) + the offline gate-standin issuer.
 * Later entries (4.2 keypair/signature, 4.4 acceptance cap, 4.5 uptime,
 * 4.6 re-attestation) extend this barrel additively.
 */
export {
  GateError,
  createOfflineGateVerifier,
  issueGateCredential,
} from './gate-verifier.js'
export type { IssueGateCredentialParams } from './gate-verifier.js'

// 4.2 — the identity keypair (the AD-11 key material that lives in the
// core) + the ticket signature sign/verify over the EXACT AD-12 digest.
// `deriveIdentityKeypair` derives a deterministic Ed25519 keypair from a
// 32-byte seed (no RNG — the golden vector is reproducible);
// `signTicket` signs, `verifyTicketSignature` verifies from PUBLIC data
// alone (a reject is a normal `false`, never a throw).
export {
  IdentityError,
  deriveIdentityKeypair,
  signTicket,
  verifyTicketSignature,
} from './identity.js'
export type { IdentityKeypair, TicketFields } from './identity.js'

// The credential / verification port types (AD-4) — re-exported so the
// identity surface is import-complete from this module. The declarations
// stay in `src/ports.ts` (4.1 adds the implementation, not the seam).
export type {
  GateCredential,
  GateVerification,
  GateVerifier,
} from '../ports.js'
