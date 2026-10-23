/**
 * The `window.succinctcoin` global — the renderer-side typing of the 6.2
 * preload bridge (`./preload.ts`'s `contextBridge` exposure).
 *
 * AD-11: commands + the event stream + the read-API ONLY. No
 * `privateKey`/`secret`/`keypair` — the identity keypair lives in the main
 * process and never crosses the bridge (the payloads are the core's
 * key-free `CoreEvents` + read-models).
 */
import type {
  CoreEvents,
  InviteRejectReason,
  ReadBalances,
  ReadBlock,
  ReadChainHead,
  ReadPeer,
} from '@succinctcoin/core'

import type { InviteDiagnostics } from './main/invite-diagnostics.js'

declare global {
  interface Window {
    /** The preload IPC bridge (the AD-11 key-free surface). */
    succinctcoin: {
      /** Boot the node (open the store, load the genesis, mine the genesis block). */
      start(): Promise<void>
      /** Halt the node (stop the loop, close the store). */
      stop(): Promise<void>
      /** Start the integrated slot loop (mining). */
      startMining(): Promise<void>
      getChainHead(): Promise<ReadChainHead>
      getBalances(): Promise<ReadBalances>
      getPeers(): Promise<ReadPeer[]>
      getBlock(slot: number): Promise<ReadBlock>
      /** 9.2: this node's renderable self-invitation (public signed text;
       * null until the node has announced a policy-valid address). */
      getInvite(): Promise<string | null>
      /** Post-9.5: WHY there is no invite yet — this machine's IPv6 interface
       * classes (counts only, AD-11-safe; `main/invite-diagnostics.ts`). */
      getInviteDiagnostics(): Promise<InviteDiagnostics>
      /** Invite-share UX: LAN-mode /ip4 dial addresses (display-only,
       * CAP-9); empty whenever the node is not running in LAN mode. */
      getLanDial(): Promise<string[]>
      /** 9.2 join seam: verify a pasted invitation, ingest it invite-grade,
       * and dial through it. Rejects SC-CORE-1 before the node has started. */
      applyInvite(
        text: string,
      ): Promise<{ ok: true; identityId: string } | { ok: false; reason: InviteRejectReason }>
      /** Subscribe to the core event stream; returns an unsubscribe. */
      on<E extends keyof CoreEvents>(event: E, cb: (payload: CoreEvents[E]) => void): () => void
    }
  }
}

export {}
