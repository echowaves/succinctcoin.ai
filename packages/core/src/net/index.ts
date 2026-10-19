/**
 * `core/net` — re-exports the libp2p adapter (5.1 scaffold + 5.2 topics /
 * proto envelopes, AD-8/AD-10/AD-12). The package entry re-exports this
 * surface so consumers import everything from the package root.
 */
export { createNetAdapter } from './adapter.js'
export type { NetAdapterConfig, NetAdapter, ReceivedEnvelope } from './adapter.js'
export { TOPICS } from './topics.js'
export type { TopicClass } from './topics.js'
export { assertDialable, filterPolicyAddresses, isGlobalIp6Multiaddr } from './address-policy.js'
// 5.4 — chain sync (AD-8/AD-10/AD-12): the stable `SYNC_PROTOCOL` (a
// dedicated request/response STREAM protocol, distinct from the four gossip
// topics) + the sync source/client surface (`SyncSource` is structural — the
// consensus module's `buildSyncSource` satisfies it without a net import, D7).
export { SYNC_PROTOCOL } from './sync.js'
export type { SyncSource } from './sync.js'
