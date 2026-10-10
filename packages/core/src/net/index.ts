/**
 * `core/net` — re-exports the libp2p adapter (5.1 scaffold, AD-8/AD-10).
 * The package entry re-exports this surface so consumers import everything
 * from the package root.
 */
export { createNetAdapter } from './adapter.js'
export type { NetAdapterConfig } from './adapter.js'
