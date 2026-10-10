/**
 * `core/net` — re-exports the libp2p adapter (5.1 scaffold + 5.2 topics /
 * proto envelopes, AD-8/AD-10/AD-12). The package entry re-exports this
 * surface so consumers import everything from the package root.
 */
export { createNetAdapter } from './adapter.js'
export type { NetAdapterConfig, NetAdapter, ReceivedEnvelope } from './adapter.js'
export { TOPICS } from './topics.js'
export type { TopicClass } from './topics.js'
