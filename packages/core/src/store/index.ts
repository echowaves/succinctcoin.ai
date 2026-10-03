/**
 * `core/store` — re-exports the file-backed `ChainStore` adapter (AD-9).
 * The package entry re-exports this surface so consumers import everything
 * from the package root.
 */
export { FileChainStore, StoreError } from './file-chain-store.js'
