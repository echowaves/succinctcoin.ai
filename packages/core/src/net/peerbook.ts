/**
 * `core/net/peerbook.ts` — the peer-book exchange PROTOCOL layer (epic 9,
 * ticket 9.3): a dedicated request/response libp2p STREAM, exactly the sync
 * pattern (D1 for sync applies verbatim here — never a gossip topic).
 *
 * The client sends ONE `PeerBookRequest` (`limit`), half-closes, and reads
 * ONE `PeerBookResponse` (signed records + self-signed witnesses) before the
 * server half-closes. u32be length-prefix framing is SHARED with sync (one
 * framing implementation on the wire — `encodeFrame`/`decodeFramed` are
 * imported, never re-implemented).
 *
 * NOTHING here trusts what it reads: the response carries RECORDS, and the
 * receiver verifies each one through the 8.2 validator at ingest (verify-
 * before-connect; the crawl trust rule lives in `discovery/crawler.ts`).
 * The serve policy (which records leave the book) lives in
 * `discovery/peerbook-serve.ts` — this module only moves bytes.
 */
import type { DialTarget, Stream } from '@libp2p/interface'

import { PeerBookRequest, PeerBookResponse } from '../proto/index.js'
import { decodeFramed, encodeFrame } from './sync.js'

/** The stable peer-book protocol identifier (9.3): a dedicated libp2p STREAM
 * protocol, `/1` versioned like the topics and sync. */
export const PEERBOOK_PROTOCOL = '/succinctcoin/peerbook/1'

/**
 * THE EXCHANGE BUDGET (9.3 review): a peer that opens the stream and STALLS
 * must never pin a crawler worker forever — both sides race the exchange
 * against this bound and ABORT on expiry (the dial's 10 s adapter bound is
 * the precedent). Injected smaller in tests; zero disables the timer.
 */
export const PEERBOOK_TIMEOUT_MS = 10_000

/** Race `work` against a timeout that aborts `stream` on expiry. */
async function withStreamTimeout<T>(stream: Stream, work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return await work
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('peerbook-timeout')
      try {
        stream.abort(err)
      } catch {
        /* already closed */
      }
      reject(err)
    }, ms)
  })
  try {
    return await Promise.race([work, guard])
  } finally {
    clearTimeout(timer)
  }
}

/** The decoded exchange — exactly the proto shape (records + witnesses). */
export type PeerBookServed = Pick<PeerBookResponse, 'records' | 'witnesses'>

/**
 * The peer-book SOURCE (server side): given the client's requested limit,
 * return the records to serve (+ their witnesses). The ADAPTER registers this
 * lazily like `setSyncSource` — the handler reads the CURRENT source at
 * stream-open time. The implementation (`servePeerBook`) owns every policy:
 * eligibility, class exclusion, ordering, cap, witnessing.
 */
export type PeerBookSource = (limit: number) => Promise<PeerBookServed>

/**
 * The SERVER handler factory (sync's shape): read the ONE framed request →
 * respond with ONE framed response → half-close. No request / no registered
 * source ⇒ half-close EMPTY (a normal empty serve, never a throw). A decode
 * failure or a throwing source ABORTS the stream so the client's read ends
 * with an error, never a silent hang.
 */
export function makePeerBookHandler(
  getSource: () => PeerBookSource | null,
  timeoutMs: number = PEERBOOK_TIMEOUT_MS,
): (stream: Stream) => Promise<void> {
  return async (stream: Stream) => {
    try {
      await withStreamTimeout(stream, serve(stream), timeoutMs)
    } catch (err) {
      stream.abort(err instanceof Error ? err : new Error(String(err)))
    }

    async function serve(inner: Stream): Promise<void> {
      let limit = 0
      for await (const req of decodeFramed(inner, PeerBookRequest.decode)) {
        limit = Number(req.limit)
        break // exactly ONE request; anything after is protocol noise
      }
      const source = getSource()
      if (limit <= 0 || source === null) {
        await inner.close() // empty serve — the client sees zero records
        return
      }
      const served = await source(limit)
      inner.send(
        encodeFrame(
          PeerBookResponse.encode({ records: served.records, witnesses: served.witnesses }),
        ),
      )
      await inner.close()
    }
  }
}

/**
 * The CLIENT: dial the peer's peerbook protocol, write the ONE framed
 * request, half-close, and resolve with the server's single framed
 * response (proto-decoded). A transport failure REJECTS — the crawler owns
 * failure accounting (book quarantine), never this call site.
 *
 * `dialer` is structural (the adapter passes its node's `dialProtocol`; a
 * test may pass a double) — the sync precedent, D7.
 */
export async function requestPeerBook(
  dialer: { dialProtocol(peer: DialTarget, protocol: string): Promise<Stream> },
  peer: DialTarget,
  limit: number,
  timeoutMs: number = PEERBOOK_TIMEOUT_MS,
): Promise<PeerBookServed> {
  // The abort target binds once the dial resolves (a stalled DIAL itself is
  // raced too — nothing settles until either side finishes or the budget
  // expires, so a silent peer can never pin a crawler worker).
  let stream: Stream | undefined
  const abortShim = {
    abort: (err: Error) => {
      try {
        stream?.abort(err)
      } catch {
        /* already closed */
      }
    },
  } as unknown as Stream
  return withStreamTimeout(
    abortShim,
    (async () => {
      const opened = await dialer.dialProtocol(peer, PEERBOOK_PROTOCOL)
      stream = opened
      return await exchange(opened)
    })(),
    timeoutMs,
  )

  async function exchange(stream: Stream): Promise<PeerBookServed> {
    stream.send(encodeFrame(PeerBookRequest.encode({ limit: Math.max(0, Math.trunc(limit)) })))
    await stream.close()
    for await (const res of decodeFramed(stream, PeerBookResponse.decode)) {
      return { records: res.records, witnesses: res.witnesses } // ONE response
    }
    return { records: [], witnesses: [] } // server half-closed empty — an empty serve
  }
}
