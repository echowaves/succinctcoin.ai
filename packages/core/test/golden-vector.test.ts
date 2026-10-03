/**
 * GOLDEN VECTOR — the canonical-encoding pin (AD-12).
 *
 * A fixed `Block` + `Ticket` are encoded once with the generated protons
 * codecs and the resulting bytes committed as hex below. The test decodes the
 * hex, re-encodes the objects, and asserts byte-identity. This is what makes
 * "encoder, decoder, and (later) the verifier + draw all agree on the bytes"
 * checkable NOW, before those consumers (epics 3-4) exist: any schema,
 * field-number, or codec drift fails the suite.
 *
 * Field values (deterministic; see the constants below):
 *   Ticket { identityId = "0011…deeff" (32-byte hex), windowIndex = 7,
 *            challenge = 0x00..0x1f, nonceCommitment = 0x5a×32,
 *            signature = 0x7e×64 }
 *   Block  { slot = 42, parentHash = 0x01..0x20, winnerIdentityId = <id>,
 *            winnerTicket = <the Ticket's canonical bytes (AD-7: the block
 *            carries the winner's ticket)>, nonce = 0x00..0x1f,
 *            hash = 0x99×32, txCount = 3 }
 */
import { describe, expect, it } from 'vitest'

import { Block, Ticket } from '../src/index.js'
import type { Uint8ArrayList } from 'uint8arraylist'

const IDENTITY_ID =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

// Canonical bytes, pinned. Regenerate ONLY by changing protocol.proto (a
// protocol change) — never hand-edit.
const TICKET_HEX =
  '0a403030313132323333343435353636373738383939616162626363646465656666303031313232333334343535363637373838393961616262636364646565666610071a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f22205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a2a407e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e'
const BLOCK_HEX =
  '082a12200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f201a403030313132323333343435353636373738383939616162626363646465656666303031313232333334343535363637373838393961616262636364646565666622ca010a403030313132323333343435353636373738383939616162626363646465656666303031313232333334343535363637373838393961616262636364646565666610071a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f22205a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a2a407e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e2a20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f322099999999999999999999999999999999999999999999999999999999999999993803'

const hex = (buf: Uint8Array | Uint8ArrayList): string =>
  Buffer.from(buf.subarray()).toString('hex')
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength &&
  Array.from(a).every((v, i) => v === b[i])

describe('GOLDEN VECTOR — canonical encoding pin (AD-12)', () => {
  it('ROUND_TRIP: decode(pinned hex) then re-encode reproduces identical bytes', () => {
    const ticket = Ticket.decode(fromHex(TICKET_HEX))
    expect(hex(Ticket.encode(ticket))).toBe(TICKET_HEX)

    const block = Block.decode(fromHex(BLOCK_HEX))
    expect(hex(Block.encode(block))).toBe(BLOCK_HEX)
  })

  it('DETERMINISM: encoding the same decoded object twice is byte-identical', () => {
    const ticket = Ticket.decode(fromHex(TICKET_HEX))
    expect(eqBytes(Ticket.encode(ticket), Ticket.encode(ticket))).toBe(true)

    const block = Block.decode(fromHex(BLOCK_HEX))
    expect(eqBytes(Block.encode(block), Block.encode(block))).toBe(true)
  })

  it('PIN: the decoded objects carry the documented deterministic field values', () => {
    const ticket = Ticket.decode(fromHex(TICKET_HEX))
    expect(ticket.identityId).toBe(IDENTITY_ID)
    expect(ticket.windowIndex).toBe(7n)
    expect(ticket.challenge.byteLength).toBe(32)
    expect(ticket.nonceCommitment.byteLength).toBe(32)
    expect(ticket.signature.byteLength).toBe(64)

    const block = Block.decode(fromHex(BLOCK_HEX))
    expect(block.slot).toBe(42n)
    expect(block.txCount).toBe(3n)
    expect(block.parentHash.byteLength).toBe(32)
    expect(block.hash.byteLength).toBe(32)
    expect(block.nonce.byteLength).toBe(32)
    expect(block.winnerIdentityId).toBe(IDENTITY_ID)
    // AD-7: the block carries the winner's ticket (its canonical bytes).
    expect(eqBytes(block.winnerTicket, Ticket.encode(ticket))).toBe(true)
  })
})
