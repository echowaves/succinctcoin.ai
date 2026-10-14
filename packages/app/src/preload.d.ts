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
  ReadBalances,
  ReadBlock,
  ReadChainHead,
  ReadPeer,
} from '@succinctcoin/core'

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
      /** Subscribe to the core event stream; returns an unsubscribe. */
      on<E extends keyof CoreEvents>(event: E, cb: (payload: CoreEvents[E]) => void): () => void
    }
  }
}

export {}
