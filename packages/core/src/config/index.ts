/**
 * `core/config` — re-exports the genesis config seam (the single owner of the
 * genesis shape). `createCore` is re-exported from the package entry.
 */
export {
  GenesisConfigError,
  loadGenesis,
  validateGenesis,
} from './genesis.js'
export type { GenesisConfig, GenesisEmission } from './genesis.js'
