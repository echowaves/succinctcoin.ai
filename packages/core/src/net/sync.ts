/**
 * `core/net` — chain-sync transport (5.4, D1/AC-4, AD-8/AD-10/AD-12).
 *
 * Sync is a **PULL** (a directed request/response over a dedicated libp2p
 * STREAM — NOT a gossip topic, D1): the client sends ONE
 * `SyncRequest { fromSlot }`, half-closes, and reads the server's stream of
 * `SyncBlock`s (one per window, `fromSlot` up to the peer's head) until the
 * server half-closes. Both messages are PROTO-ENCODED (AD-12 — the schema is
 * the proto's; `SyncRequest`/`SyncBlock` are generated codecs, never
 * re-serialized by hand) and **u32be length-prefix framed** on the stream —
 * framing is the transport's job (the stream is a byte pipe; the proto codec
 * is a message encoder), kept out of the schema (AD-12).
 *
 * Verified libp2p 3.3.11 stream API (D1):
 *   - server: `node.handle(SYNC_PROTOCOL, (stream, conn) => …)`;
 *   - client: `node.dialProtocol(peer, SYNC_PROTOCOL)` → a `Stream`;
 *   - `Stream.send(data)` writes (returns a drain flag — ignored here, the
 *     frames are small and the memory transport never backpressures in CI);
 *   - the `Stream` is `AsyncIterable<Uint8Array | Uint8ArrayList>` for reads
 *     (the async iterable ends when the remote half-closes its writable end);
 *   - `Stream.close()` half-closes the local writable end (signals
 *     "no more data").
 *
 * This module is PURE NETWORKING — it decodes the request, invokes the
 * registered source, and encodes the responses. It contains NO consensus
 * logic (no accept/apply): the catch-up ORCHESTRATION lives in
 * `src/consensus/sync.ts` (D7 — the two modules never import each other;
 * both import the shared proto layer, AD-12). The source the server handler
 * invokes is STRUCTURAL (`SyncSource` below — a plain generator of decoded
 * `SyncBlock`s), and the client's dialer is STRUCTURAL (`dialProtocol`) — so
 * this module never sees the consensus module at all.
 *
 * Hygiene: no `big.js` (AD-5), no `.secret` reads (AD-11), no RNG, no
 * wall-clock (AD-3) — a timeout, if one were needed, would be an
 * `AbortSignal.timeout`, never a clock read.
 */
import type { DialTarget, Stream } from '@libp2p/interface'
import { isUint8ArrayList } from 'uint8arraylist'
import type { Uint8ArrayList } from 'uint8arraylist'

import { SyncBlock, SyncRequest } from '../proto/index.js'

/**
 * The stable sync protocol identifier (AC-4/D4): a dedicated libp2p STREAM
 * protocol — a stable constant, DISTINCT from the four gossipsub topics
 * (`src/net/topics.ts`, byte-identical — a sync message never travels on a
 * gossip topic, and a block never on the sync stream's gossip path). The
 * trailing `/1` is the protocol version (the same versioning convention the
 * topics carry — a bump is a protocol change).
 */
export const SYNC_PROTOCOL = '/succinctcoin/sync/1'

/**
 * The sync SOURCE (server side, D7): given the slot the client is missing
 * starting from, yield that window's `{ block, acceptedTickets, weights }`
 * (one `SyncBlock` per window) from `fromSlot` up to the source's last slot
 * (inclusive). The server handler encodes + frames each yielded `SyncBlock`;
 * when the generator is EXHAUSTED the handler half-closes the stream (the
 * client's read loop ends). The factory that builds one from a peer's
 * per-window records lives in `src/consensus/sync.ts` (`buildSyncSource`) —
 * this module only consumes the structural shape (no consensus import, D7).
 */
export interface SyncSource {
  (fromSlot: bigint): AsyncGenerator<SyncBlock>
}

/** The u32be length-prefix size (the frame header). */
const FRAME_HEADER_BYTES = 4

/**
 * Encode one proto message as a u32be length-prefix frame (the AD-12
 * message + the transport's framing — the frame is the stream's job).
 */
function encodeFrame(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + message.length)
  new DataView(frame.buffer).setUint32(0, message.length, false) // u32be
  frame.set(message, FRAME_HEADER_BYTES)
  return frame
}

/**
 * The framed-bytes accumulator: it absorbs read chunks (one
 * `Uint8Array | Uint8ArrayList` per stream chunk) and yields the COMPLETE
 * frames it holds as soon as a full frame is available (never before — a
 * partial frame is held until more bytes arrive). The accumulator is a
 * plain `Uint8Array` (an `ArrayBuffer`-backed `Uint8Array<ArrayBuffer>`
 * under TS 5.9) — read chunks are copied into it, so the decoded message
 * bytes are always the fresh ArrayBuffer-backed form the protons codecs
 * want.
 */
class FrameAccumulator {
  private buf = new Uint8Array(0)

  /** Absorb one read chunk; return the frames it completed (possibly none). */
  push(chunk: Uint8Array | Uint8ArrayList): Uint8Array[] {
    // Copy the chunk into a fresh ArrayBuffer-backed buffer (a
    // `Uint8ArrayList` is NOT `ArrayLike<number>` for `.set` — it iterates
    // its parts, so branch on the value type).
    const bytes = new Uint8Array(chunk.byteLength)
    if (isUint8ArrayList(chunk)) {
      let off = 0
      for (const part of chunk) {
        bytes.set(part, off)
        off += part.byteLength
      }
    } else {
      bytes.set(chunk)
    }
    const grown = new Uint8Array(this.buf.length + bytes.length)
    grown.set(this.buf, 0)
    grown.set(bytes, this.buf.length)
    this.buf = grown

    const out: Uint8Array[] = []
    // Consume every COMPLETE frame; hold the trailing partial one.
    for (;;) {
      const len = this.buf.length
      if (len < FRAME_HEADER_BYTES) break
      const payloadLen = new DataView(this.buf.buffer, this.buf.byteOffset, len).getUint32(
        0,
        false,
      )
      const frameLen = FRAME_HEADER_BYTES + payloadLen
      if (len < frameLen) break // partial frame — wait for more bytes
      const payload = this.buf.slice(FRAME_HEADER_BYTES, frameLen)
      this.buf = this.buf.slice(frameLen)
      out.push(payload)
    }
    return out
  }
}

/**
 * Decode framed proto messages off a `Stream` until it ends (the remote
 * half-closes → the read iterable ends), YIELDING each decoded message as
 * its full frame becomes available (never before). `decode` maps one
 * decoded payload to a value — `SyncRequest.decode` for the server's read
 * of the ONE request, `SyncBlock.decode` for the client's read of the
 * response stream.
 */
async function* decodeFramed<T>(
  stream: Stream,
  decode: (buf: Uint8Array) => T,
): AsyncGenerator<T> {
  const acc = new FrameAccumulator()
  for await (const chunk of stream) {
    for (const payload of acc.push(chunk)) {
      yield decode(payload)
    }
  }
}

/**
 * The SERVER handler factory (D1): reads the client's ONE framed
 * `SyncRequest`, invokes `getSource()(fromSlot)` for each yielded
 * `SyncBlock` (encodes + u32be-frames each), then half-closes the stream —
 * the client's read loop ends.
 *
 * `getSource` is a GETTER (not a captured `SyncSource`) because the source
 * is registered on the adapter AFTER the handler (the adapter's `start()`
 * registers the handler once, before the operator may call `setSyncSource`)
 * — the handler reads the CURRENT source at stream-open time. A request
 * that arrives before a source is registered (or with no request) half-
 * closes with no response (the client's sync yields zero blocks — a normal
 * empty catch-up, not a throw).
 *
 * The handler is async (libp2p accepts `void | Promise<void>`); it runs the
 * whole request/response exchange so the stream is only released once the
 * response is fully written. A request that fails to decode, or a source
 * that throws, ABORTS the stream (a corrupt frame is a transport error, not
 * a normal reject — the normal reject path is the 4.3 acceptance path in
 * `src/consensus/sync.ts`, which this module never touches).
 */
export function makeSyncHandler(
  getSource: () => SyncSource | null,
): (stream: Stream) => Promise<void> {
  return async (stream: Stream) => {
    try {
      // Read the ONE framed `SyncRequest` (the client half-closes after it).
      let fromSlot: bigint | null = null
      for await (const req of decodeFramed(stream, SyncRequest.decode)) {
        fromSlot = req.fromSlot
        break // exactly ONE request; the rest (if any) is protocol noise
      }
      const source = getSource()
      if (fromSlot === null || source === null) {
        // No request (protocol violation) or no registered source —
        // half-close with no response (the client's sync yields zero
        // blocks, a normal stop).
        await stream.close()
        return
      }
      // Stream the source's `SyncBlock`s, framing each, until exhausted.
      for await (const block of source(fromSlot)) {
        stream.send(encodeFrame(SyncBlock.encode(block)))
      }
      // Half-close: "no more data" — the client's read loop ends.
      await stream.close()
    } catch (err) {
      // A decode failure or a throwing source is a transport-level fault —
      // abort the stream so the client's read loop ends with an error
      // (never a silent hang). The normal reject path is the consensus
      // acceptance seam, not here (D7).
      stream.abort(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

/**
 * The CLIENT (D1): dial the peer's sync protocol, write the ONE framed
 * `SyncRequest`, half-close the writable end, and RETURN an `AsyncIterable`
 * of the server's decoded `SyncBlock`s (read lazily — the server's
 * `for await` over the source streams each block as the client pulls it,
 * and the iterable ends when the server half-closes).
 *
 * `dialer` is structural — the node's `dialProtocol` (the adapter passes
 * its libp2p node's own; a test may pass a double). `peer` is a
 * `DialTarget` (PeerId / Multiaddr — `dialProtocol`'s own parameter type;
 * the adapter parses its multiaddr-string surface to a `Multiaddr` before
 * calling).
 *
 * The returned `AsyncIterable<SyncBlock>` is the shape the consensus
 * orchestration's STRUCTURAL client consumes (D7 — `syncChain` takes a
 * `{ syncFrom(peer, request): AsyncIterable<SyncBlock> }`, never a net
 * import).
 */
export function syncFrom(
  dialer: { dialProtocol(peer: DialTarget, protocol: string): Promise<Stream> },
  peer: DialTarget,
  request: SyncRequest,
): AsyncIterable<SyncBlock> {
  return (async function* (): AsyncGenerator<SyncBlock> {
    const stream = await dialer.dialProtocol(peer, SYNC_PROTOCOL)
    // ONE request, framed, then half-close (the server reads exactly one).
    stream.send(encodeFrame(SyncRequest.encode(request)))
    await stream.close()
    // Read the framed `SyncBlock`s until the server half-closes.
    yield* decodeFramed(stream, SyncBlock.decode)
  })()
}
