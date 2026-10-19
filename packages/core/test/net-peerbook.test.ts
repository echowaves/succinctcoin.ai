/**
 * net-peerbook.test.ts — ticket 9.3: the peer-book exchange PROTOCOL over
 * paired fake streams (the sync-test pattern). Pins the wire contract:
 * one framed request in, one framed response out, half-close semantics,
 * honest-empty on no-request/no-source/limit<=0, and ABORT (never a hang)
 * on corrupt frames or a throwing source. Real-transport reality rides in
 * `peerbook-transport.test.ts`.
 */
import { describe, expect, it } from 'vitest'

import type { DialTarget, Stream } from '@libp2p/interface'

const PEER = '/ip6/::1/tcp/1' as unknown as DialTarget

import { makePeerBookHandler, PEERBOOK_PROTOCOL, PEERBOOK_TIMEOUT_MS, requestPeerBook } from '../src/index.js'
import type { PeerBookServed } from '../src/index.js'
import { decodeFramed, encodeFrame } from '../src/net/sync.js'
import { PeerBookRequest, PeerBookResponse } from '../src/proto/index.js'

// ---------------------------------------------------------------------------
// Paired in-memory streams: client.send → server inbox; iteration reads the
// peer's writes; close() ends the peer's read; abort(err) fails it.
// ---------------------------------------------------------------------------

interface Inbox {
  push(chunk: Uint8Array): void
  end(): void
  fail(err: Error): void
  iterate(): AsyncGenerator<Uint8Array>
}

function makeInbox(): Inbox {
  const chunks: Uint8Array[] = []
  let state: 'open' | 'ended' | 'failed' = 'open'
  let error: Error | undefined
  let notify: (() => void) | undefined
  const wake = () => {
    const n = notify
    notify = undefined
    n?.()
  }
  return {
    push: (c) => {
      chunks.push(c)
      wake()
    },
    end: () => {
      state = 'ended'
      wake()
    },
    fail: (e) => {
      state = 'failed'
      error = e
      wake()
    },
    async *iterate() {
      for (;;) {
        while (chunks.length > 0) yield chunks.shift()!
        if (state === 'failed') throw error
        if (state === 'ended') return
        await new Promise<void>((r) => {
          notify = r
        })
      }
    },
  }
}

interface FakeStream extends AsyncIterable<Uint8Array> {
  send(bytes: Uint8Array): void
  close(): Promise<void>
  abort(err: Error): void
}

function makeStreamPair(): { client: FakeStream; server: FakeStream } {
  const c2s = makeInbox()
  const s2c = makeInbox()
  // Half-close is PER DIRECTION: the client closing its write side must not
  // block the server's response.
  const closed = { c2s: false, s2c: false }

  const mk = (dir: 'c2s' | 's2c'): FakeStream => {
    const out = dir === 'c2s' ? c2s : s2c
    const inn = dir === 'c2s' ? s2c : c2s
    return {
      send: (bytes) => {
        if (closed[dir]) throw new Error('stream closed')
        out.push(bytes)
      },
      close: async () => {
        closed[dir] = true
        out.end()
      },
      abort: (err) => {
        out.fail(err)
        inn.fail(err)
      },
      [Symbol.asyncIterator]: () => inn.iterate()[Symbol.asyncIterator](),
    }
  }
  return { client: mk('c2s'), server: mk('s2c') }
}

const REC = (id: string) => ({
  identityId: id,
  multiaddrs: [`/ip6/2001:db8:9:${id.slice(-2)}::/tcp/4001`],
  slotStart: 0n,
  slotEnd: 50n,
  chainId: 'succinctcoin-test',
  signature: new Uint8Array([1, 2, 3]),
})

const WIT = (subject: string) => ({
  signerIdentityId: 'aa'.repeat(32),
  subjectIdentityId: subject,
  slotObserved: 3n,
  reachability: 'direct' as const,
  chainId: 'succinctcoin-test',
  signature: new Uint8Array([4, 5, 6]),
})

/** Drive one client/server exchange; `clientScript` writes to the server. */
async function exchange(
  source: ((limit: number) => Promise<PeerBookServed>) | null,
  clientScript: (client: FakeStream) => Promise<void>,
): Promise<{ client: FakeStream; handlerError?: unknown }> {
  const { client, server } = makeStreamPair()
  const handler = makePeerBookHandler(() => source)
  const handlerDone = handler(server as unknown as Stream)
  await clientScript(client)
  const r = await handlerDone.then(() => null, (err: unknown) => ({ err }))
  return { client, handlerError: r?.err }
}

describe('9.3 — /succinctcoin/peerbook/1 over fake streams', () => {
  it('ROUND_TRIP: framed request → framed response with records + witnesses', async () => {
    const served: PeerBookServed = { records: [REC('a1'.repeat(32)), REC('b2'.repeat(32))], witnesses: [WIT('a1'.repeat(32))] }
    let seenLimit = -1
    const { client } = await exchange(
      async (limit) => {
        seenLimit = limit
        return served
      },
      async (c) => {
        c.send(encodeFrame(PeerBookRequest.encode({ limit: 42 })))
        await c.close()
      },
    )
    expect(seenLimit).toBe(42)

    const responses: PeerBookResponse[] = []
    for await (const res of decodeFramed(client as unknown as Stream, PeerBookResponse.decode)) responses.push(res)
    expect(responses).toHaveLength(1)
    expect(responses[0]!.records.map((r) => r.identityId)).toEqual(served.records.map((r) => r.identityId))
    expect(responses[0]!.records[0]!.slotEnd).toBe(50n) // int64 survives as bigint
    expect(responses[0]!.witnesses).toHaveLength(1)
  })

  it('LIMIT_FLOOR: limit <= 0 (or fractional-truncated to 0) serves empty without calling the source', async () => {
    let called = false
    const { client } = await exchange(
      async () => {
        called = true
        return { records: [], witnesses: [] }
      },
      async (c) => {
        c.send(encodeFrame(PeerBookRequest.encode({ limit: 0 })))
        await c.close()
      },
    )
    expect(called).toBe(false)
    const responses: PeerBookResponse[] = []
    for await (const res of decodeFramed(client as unknown as Stream, PeerBookResponse.decode)) responses.push(res)
    expect(responses).toEqual([]) // half-closed empty — a normal empty serve
  })

  it('NO_SOURCE: registered source null ⇒ empty serve, never a throw', async () => {
    const { client, handlerError } = await exchange(null, async (c) => {
      c.send(encodeFrame(PeerBookRequest.encode({ limit: 5 })))
      await c.close()
    })
    expect(handlerError).toBeUndefined()
    const responses: PeerBookResponse[] = []
    for await (const res of decodeFramed(client as unknown as Stream, PeerBookResponse.decode)) responses.push(res)
    expect(responses).toEqual([])
  })

  it('NO_REQUEST: client closes without writing ⇒ empty serve', async () => {
    const { handlerError } = await exchange(async () => ({ records: [], witnesses: [] }), async (c) => {
      await c.close()
    })
    expect(handlerError).toBeUndefined()
  })

  it('CORRUPT_REQUEST: undecodable frame ABORTS the stream (client read rejects, no hang)', async () => {
    const { client } = await exchange(async () => ({ records: [], witnesses: [] }), async (c) => {
      // An invalid protobuf payload behind a valid length prefix (truncated
      // varint tag): the decode throws → the handler must ABORT, not hang.
      c.send(encodeFrame(new Uint8Array([0xff, 0xff, 0xff])))
      await c.close()
    })
    await expect(
      (async () => {
        for await (const _res of decodeFramed(client as unknown as Stream, PeerBookResponse.decode)) void _res
      })(),
    ).rejects.toThrow() // the abort error surfaces on the client read
  })

  it('THROWING_SOURCE: source failure ABORTS with its error (never a silent empty serve)', async () => {
    const { client, handlerError } = await exchange(
      async () => {
        throw new Error('source boom')
      },
      async (c) => {
        c.send(encodeFrame(PeerBookRequest.encode({ limit: 3 })))
        await c.close()
      },
    )
    expect(handlerError).toBeUndefined() // the handler swallows → abort, never rethrows
    await expect(
      (async () => {
        for await (const _res of decodeFramed(client as unknown as Stream, PeerBookResponse.decode)) void _res
      })(),
    ).rejects.toThrow('source boom')
  })

  it('requestPeerBook CLIENT: full exchange through a fake dialer; empty close ⇒ empty serve', async () => {
    const served: PeerBookServed = { records: [REC('c3'.repeat(32))], witnesses: [] }
    const { client, server } = makeStreamPair()
    const handler = makePeerBookHandler(() => async (limit) => (limit === 9 ? served : { records: [], witnesses: [] }))
    const done = handler(server as unknown as Stream)
    const got = await requestPeerBook({ dialProtocol: async () => client as unknown as Stream }, PEER, 9)
    expect(got.records.map((r) => r.identityId)).toEqual(served.records.map((r) => r.identityId))
    await done

    // limit is floored client-side: -5 → 0 → server serves empty.
    const pair2 = makeStreamPair()
    const done2 = makePeerBookHandler(() => async () => served)(pair2.server as unknown as Stream)
    const got2 = await requestPeerBook({ dialProtocol: async () => pair2.client as unknown as Stream }, PEER, -5)
    expect(got2).toEqual({ records: [], witnesses: [] })
    await done2

    // A transport failure REJECTS (the crawler owns failure accounting).
    await expect(requestPeerBook({ dialProtocol: async () => { throw new Error('no route') } }, PEER, 5)).rejects.toThrow('no route')
    expect(PEERBOOK_PROTOCOL).toBe('/succinctcoin/peerbook/1')
  })

  it('TIMEOUT: a silent peer never pins the exchange — client rejects, handler aborts (9.3 review)', async () => {
    // CLIENT SIDE: no server at all behind the stream — the read would hang
    // forever without the bound.
    const stalled = makeStreamPair()
    await expect(
      requestPeerBook({ dialProtocol: async () => stalled.client as unknown as Stream }, PEER, 5, 40),
    ).rejects.toThrow('peerbook-timeout')

    // SERVER SIDE: a source that never resolves must not leak a stuck stream
    // handler — the budget aborts and the handler promise settles.
    const pair = makeStreamPair()
    const handlerDone = makePeerBookHandler(
      () => () => new Promise<PeerBookServed>(() => undefined),
      40,
    )(pair.server as unknown as Stream)
    pair.client.send(encodeFrame(PeerBookRequest.encode({ limit: 5 })))
    await pair.client.close()
    await handlerDone // resolves via the abort path — no hang

    expect(PEERBOOK_TIMEOUT_MS).toBe(10_000) // the production bound is a constant
  })
})
