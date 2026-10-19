/**
 * peerbook-transport.test.ts — ticket 9.3: ONE real round trip of
 * `/succinctcoin/peerbook/1` over two REAL net adapters on the memory
 * transport (zero sockets). This pins what the fake-stream and crawler tests
 * cannot: the handler is REGISTERED by `start()`, the lazy source seam works
 * across the wire, and served records/witnesses survive encode → frame →
 * decode byte-true (signatures verify at the client). Deep policy lives in
 * `peerbook-serve.test.ts` / `net-peerbook.test.ts`; this is the seam.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  createAddressBook,
  createNetAdapter,
  deriveIdentityKeypair,
  servePeerBook,
  signPeerAnnouncement,
  verifyIntroductionSignature,
  verifyPeerAnnouncementSignature,
} from '../src/index.js'
import type { NetAdapter } from '../src/index.js'

const TEST_CHAIN = 'succinctcoin-test'
const KEYPAIRS = [0x31, 0x32, 0x33].map((b) => deriveIdentityKeypair(new Uint8Array(32).fill(b)))

function annFor(kp: (typeof KEYPAIRS)[number], slotEnd: number, hextet: string) {
  const fields = {
    identityId: kp.identityId,
    multiaddrs: [`/ip6/2001:db8:7:${hextet}::/tcp/4001`],
    slotStart: 0,
    slotEnd,
    chainId: TEST_CHAIN,
  }
  return { ...fields, signature: signPeerAnnouncement(kp, fields) }
}

const started: NetAdapter[] = []
async function adapter(name: string, idChar: string): Promise<NetAdapter> {
  const a = createNetAdapter({ transport: 'memory', listenAddress: `/memory/${name}`, protocolIdentityId: idChar.repeat(64) })
  await a.start()
  started.push(a)
  return a
}

afterEach(async () => {
  while (started.length > 0) await started.pop()!.stop()
})

describe('9.3 — /succinctcoin/peerbook/1 over the memory transport', () => {
  it('ROUND_TRIP: served records + witnesses cross the wire byte-true; limit honored', async () => {
    const server = await adapter('pbk-server', 'a')
    const client = await adapter('pbk-client', 'b')

    const book = createAddressBook()
    for (const [i, kp] of KEYPAIRS.entries())
      expect(book.ingestAnnouncement(annFor(kp, 90 - i * 10, `${i + 1}`), { currentSlot: 5, expectedChainId: TEST_CHAIN, sourceClass: 'block', blockRef: { blockHashHex: `0${i}`.repeat(32), slot: 5n } })).toEqual({ ok: true })

    server.setPeerBookSource((limit) => Promise.resolve(servePeerBook({ book, currentSlot: 5n, expectedChainId: TEST_CHAIN, limit, witnessSigner: KEYPAIRS[0] })))

    const served = await client.requestPeerBook('/memory/pbk-server', 2)
    expect(served.records.map((r) => r.identityId)).toEqual([KEYPAIRS[0]!.identityId, KEYPAIRS[1]!.identityId]) // end 90, 80 — freshest first
    // Signatures verify AT THE CLIENT — byte-true across the wire.
    for (const r of served.records) expect(verifyPeerAnnouncementSignature(r, r.signature)).toBe(true)
    expect(served.witnesses).toHaveLength(2)
    for (const w of served.witnesses)
      expect(verifyIntroductionSignature({ ...w, reachability: w.reachability as 'direct' }, w.signature)).toBe(true)

    // The limit travels: 1 in ⇒ 1 out.
    expect((await client.requestPeerBook('/memory/pbk-server', 1)).records).toHaveLength(1)
  })

  it('NO_SOURCE + LIMIT_ZERO: honest empty serves over the wire', async () => {
    const server = await adapter('pbk-s2', 'c')
    const client = await adapter('pbk-c2', 'd')

    // No source registered at all ⇒ empty.
    expect(await client.requestPeerBook('/memory/pbk-s2', 5)).toEqual({ records: [], witnesses: [] })

    // limit 0 ⇒ empty even WITH a source (the handler floors before calling).
    let called = 0
    server.setPeerBookSource(() => {
      called += 1
      return Promise.resolve({ records: [], witnesses: [] })
    })
    expect(await client.requestPeerBook('/memory/pbk-s2', 0)).toEqual({ records: [], witnesses: [] })
    expect(called).toBe(0)
  })
})
