import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { multiaddr } from '@multiformats/multiaddr'
import { memory } from '@libp2p/memory'
import { createLibp2p } from 'libp2p'
import { describe, expect, it } from 'vitest'

// libp2p 3.x has no defaults: encryption, muxer, and transport must all be set
// explicitly (spine Stack: noise 17.0.3 + yamux 8.0.3 + memory 2.0.28).
// Option names verified against libp2p 3.3.11 Libp2pOptions:
// connectionEncrypters, streamMuxers.
const nodeOptions = {
  transports: [memory()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
}

// AD-10 template for every libp2p test in this repo: in-process memory
// transport only, no tcp, no mdns, no real sockets (testing.md "Network" row).
// API shape verified against @libp2p/memory 2.0.28 docs.
describe('@libp2p/memory smoke test (headless, no real sockets)', () => {
  it('two nodes dial and connect in-process', async () => {
    const nodeA = await createLibp2p({
      addresses: { listen: ['/memory/address-a'] },
      ...nodeOptions,
    })
    const nodeB = await createLibp2p({
      addresses: { listen: ['/memory/address-b'] },
      ...nodeOptions,
    })

    const ma = multiaddr('/memory/address-a')

    const connection = await nodeB.dial(ma, {
      signal: AbortSignal.timeout(10_000),
    })
    expect(connection).toBeDefined()
    expect(await nodeB.peerStore.has(nodeA.peerId)).toBe(true)
    expect(nodeB.getConnections(nodeA.peerId).length).toBeGreaterThanOrEqual(1)

    // AC: every node address is a /memory/* multiaddr. The memory transport
    // does not advertise multiaddrs via peer records, so each node's own
    // listen set is the no-real-sockets proof.
    for (const node of [nodeA, nodeB]) {
      expect(node.getMultiaddrs().length).toBeGreaterThanOrEqual(1)
      expect(
        node.getMultiaddrs().every((a) => a.toString().startsWith('/memory/')),
      ).toBe(true)
    }

    await nodeB.stop()
    await nodeA.stop()
  })
})
