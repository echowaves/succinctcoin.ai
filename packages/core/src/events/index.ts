/**
 * `core/events/` — the single owner of the core public surface (AD-1/AD-9).
 * Re-exports the typed event map, commands, read-API, and read-models.
 * (`createCore` is re-exported from the package entry, `src/index.ts`.)
 */
export type {
  CoreCommands,
  CoreEvents,
  CoreEventsEmitter,
  CoreInstance,
  CoreReadApi,
  ReadBlock,
  ReadPeer,
} from './types.js'
