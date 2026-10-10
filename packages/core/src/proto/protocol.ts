import { decodeMessage, encodeMessage, MaxLengthError, message, streamMessage } from 'protons-runtime'
import { alloc as uint8ArrayAlloc } from 'uint8arrays/alloc'
import type { Codec, DecodeOptions } from 'protons-runtime'
import type { Uint8ArrayList } from 'uint8arraylist'

export interface succinctcoinInput {}

export interface succinctcoin {}

export namespace succinctcoin {
  export interface Block {
    slot: bigint
    parentHash: Uint8Array<ArrayBuffer>
    winnerIdentityId: string
    winnerTicket: Uint8Array<ArrayBuffer>
    nonce: Uint8Array<ArrayBuffer>
    hash: Uint8Array<ArrayBuffer>
    txCount: bigint
  }

  export interface BlockInput {
    slot?: bigint
    parentHash?: Uint8Array
    winnerIdentityId?: string
    winnerTicket?: Uint8Array
    nonce?: Uint8Array
    hash?: Uint8Array
    txCount?: bigint
  }

  export namespace Block {
    let _codec: Codec<Block, BlockInput>

    export const codec = (): Codec<Block, BlockInput> => {
      if (_codec == null) {
        _codec = message<Block, BlockInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if ((obj.slot != null && obj.slot !== 0n)) {
            w.uint32(8)
            w.int64(obj.slot)
          }

          if ((obj.parentHash != null && obj.parentHash.byteLength > 0)) {
            w.uint32(18)
            w.bytes(obj.parentHash)
          }

          if ((obj.winnerIdentityId != null && obj.winnerIdentityId !== '')) {
            w.uint32(26)
            w.string(obj.winnerIdentityId)
          }

          if ((obj.winnerTicket != null && obj.winnerTicket.byteLength > 0)) {
            w.uint32(34)
            w.bytes(obj.winnerTicket)
          }

          if ((obj.nonce != null && obj.nonce.byteLength > 0)) {
            w.uint32(42)
            w.bytes(obj.nonce)
          }

          if ((obj.hash != null && obj.hash.byteLength > 0)) {
            w.uint32(50)
            w.bytes(obj.hash)
          }

          if ((obj.txCount != null && obj.txCount !== 0n)) {
            w.uint32(56)
            w.int64(obj.txCount)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length) => {
          const obj: any = {
            slot: 0n,
            parentHash: uint8ArrayAlloc(0),
            winnerIdentityId: '',
            winnerTicket: uint8ArrayAlloc(0),
            nonce: uint8ArrayAlloc(0),
            hash: uint8ArrayAlloc(0),
            txCount: 0n
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.slot = r.int64()
                break
              }
              case 2: {
                obj.parentHash = r.bytes()
                break
              }
              case 3: {
                obj.winnerIdentityId = r.string()
                break
              }
              case 4: {
                obj.winnerTicket = r.bytes()
                break
              }
              case 5: {
                obj.nonce = r.bytes()
                break
              }
              case 6: {
                obj.hash = r.bytes()
                break
              }
              case 7: {
                obj.txCount = r.int64()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.Block'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield {
                  field: `${prefix}slot`,
                  value: r.int64()
                }
                break
              }
              case 2: {
                yield {
                  field: `${prefix}parentHash`,
                  value: r.bytes()
                }
                break
              }
              case 3: {
                yield {
                  field: `${prefix}winnerIdentityId`,
                  value: r.string()
                }
                break
              }
              case 4: {
                yield {
                  field: `${prefix}winnerTicket`,
                  value: r.bytes()
                }
                break
              }
              case 5: {
                yield {
                  field: `${prefix}nonce`,
                  value: r.bytes()
                }
                break
              }
              case 6: {
                yield {
                  field: `${prefix}hash`,
                  value: r.bytes()
                }
                break
              }
              case 7: {
                yield {
                  field: `${prefix}txCount`,
                  value: r.int64()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.Block'
            }
          }
        })
      }

      return _codec
    }

    export interface BlockSlotFieldEvent {
      field: '.slot'
      value: bigint
    }

    export interface BlockParentHashFieldEvent {
      field: '.parentHash'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockWinnerIdentityIdFieldEvent {
      field: '.winnerIdentityId'
      value: string
    }

    export interface BlockWinnerTicketFieldEvent {
      field: '.winnerTicket'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockNonceFieldEvent {
      field: '.nonce'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockHashFieldEvent {
      field: '.hash'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockTxCountFieldEvent {
      field: '.txCount'
      value: bigint
    }

    export function encode (obj: BlockInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, Block.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Block>): Block {
      return decodeMessage(buf, Block.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Block>): Generator<BlockSlotFieldEvent | BlockParentHashFieldEvent | BlockWinnerIdentityIdFieldEvent | BlockWinnerTicketFieldEvent | BlockNonceFieldEvent | BlockHashFieldEvent | BlockTxCountFieldEvent> {
      return streamMessage(buf, Block.codec(), opts)
    }
  }

  export interface Ticket {
    identityId: string
    windowIndex: bigint
    challenge: Uint8Array<ArrayBuffer>
    nonceCommitment: Uint8Array<ArrayBuffer>
    signature: Uint8Array<ArrayBuffer>
  }

  export interface TicketInput {
    identityId?: string
    windowIndex?: bigint
    challenge?: Uint8Array
    nonceCommitment?: Uint8Array
    signature?: Uint8Array
  }

  export namespace Ticket {
    let _codec: Codec<Ticket, TicketInput>

    export const codec = (): Codec<Ticket, TicketInput> => {
      if (_codec == null) {
        _codec = message<Ticket, TicketInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if ((obj.identityId != null && obj.identityId !== '')) {
            w.uint32(10)
            w.string(obj.identityId)
          }

          if ((obj.windowIndex != null && obj.windowIndex !== 0n)) {
            w.uint32(16)
            w.int64(obj.windowIndex)
          }

          if ((obj.challenge != null && obj.challenge.byteLength > 0)) {
            w.uint32(26)
            w.bytes(obj.challenge)
          }

          if ((obj.nonceCommitment != null && obj.nonceCommitment.byteLength > 0)) {
            w.uint32(34)
            w.bytes(obj.nonceCommitment)
          }

          if ((obj.signature != null && obj.signature.byteLength > 0)) {
            w.uint32(42)
            w.bytes(obj.signature)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length) => {
          const obj: any = {
            identityId: '',
            windowIndex: 0n,
            challenge: uint8ArrayAlloc(0),
            nonceCommitment: uint8ArrayAlloc(0),
            signature: uint8ArrayAlloc(0)
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.identityId = r.string()
                break
              }
              case 2: {
                obj.windowIndex = r.int64()
                break
              }
              case 3: {
                obj.challenge = r.bytes()
                break
              }
              case 4: {
                obj.nonceCommitment = r.bytes()
                break
              }
              case 5: {
                obj.signature = r.bytes()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.Ticket'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield {
                  field: `${prefix}identityId`,
                  value: r.string()
                }
                break
              }
              case 2: {
                yield {
                  field: `${prefix}windowIndex`,
                  value: r.int64()
                }
                break
              }
              case 3: {
                yield {
                  field: `${prefix}challenge`,
                  value: r.bytes()
                }
                break
              }
              case 4: {
                yield {
                  field: `${prefix}nonceCommitment`,
                  value: r.bytes()
                }
                break
              }
              case 5: {
                yield {
                  field: `${prefix}signature`,
                  value: r.bytes()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.Ticket'
            }
          }
        })
      }

      return _codec
    }

    export interface TicketIdentityIdFieldEvent {
      field: '.identityId'
      value: string
    }

    export interface TicketWindowIndexFieldEvent {
      field: '.windowIndex'
      value: bigint
    }

    export interface TicketChallengeFieldEvent {
      field: '.challenge'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TicketNonceCommitmentFieldEvent {
      field: '.nonceCommitment'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TicketSignatureFieldEvent {
      field: '.signature'
      value: Uint8Array<ArrayBuffer>
    }

    export function encode (obj: TicketInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, Ticket.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Ticket>): Ticket {
      return decodeMessage(buf, Ticket.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Ticket>): Generator<TicketIdentityIdFieldEvent | TicketWindowIndexFieldEvent | TicketChallengeFieldEvent | TicketNonceCommitmentFieldEvent | TicketSignatureFieldEvent> {
      return streamMessage(buf, Ticket.codec(), opts)
    }
  }

  export interface Tx {
    sender: Uint8Array<ArrayBuffer>
    recipient: Uint8Array<ArrayBuffer>
    amount: string
    fee: string
    slot: bigint
    signature: Uint8Array<ArrayBuffer>
  }

  export interface TxInput {
    sender?: Uint8Array
    recipient?: Uint8Array
    amount?: string
    fee?: string
    slot?: bigint
    signature?: Uint8Array
  }

  export namespace Tx {
    let _codec: Codec<Tx, TxInput>

    export const codec = (): Codec<Tx, TxInput> => {
      if (_codec == null) {
        _codec = message<Tx, TxInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if ((obj.sender != null && obj.sender.byteLength > 0)) {
            w.uint32(10)
            w.bytes(obj.sender)
          }

          if ((obj.recipient != null && obj.recipient.byteLength > 0)) {
            w.uint32(18)
            w.bytes(obj.recipient)
          }

          if ((obj.amount != null && obj.amount !== '')) {
            w.uint32(26)
            w.string(obj.amount)
          }

          if ((obj.fee != null && obj.fee !== '')) {
            w.uint32(34)
            w.string(obj.fee)
          }

          if ((obj.slot != null && obj.slot !== 0n)) {
            w.uint32(40)
            w.int64(obj.slot)
          }

          if ((obj.signature != null && obj.signature.byteLength > 0)) {
            w.uint32(50)
            w.bytes(obj.signature)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length) => {
          const obj: any = {
            sender: uint8ArrayAlloc(0),
            recipient: uint8ArrayAlloc(0),
            amount: '',
            fee: '',
            slot: 0n,
            signature: uint8ArrayAlloc(0)
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.sender = r.bytes()
                break
              }
              case 2: {
                obj.recipient = r.bytes()
                break
              }
              case 3: {
                obj.amount = r.string()
                break
              }
              case 4: {
                obj.fee = r.string()
                break
              }
              case 5: {
                obj.slot = r.int64()
                break
              }
              case 6: {
                obj.signature = r.bytes()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.Tx'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield {
                  field: `${prefix}sender`,
                  value: r.bytes()
                }
                break
              }
              case 2: {
                yield {
                  field: `${prefix}recipient`,
                  value: r.bytes()
                }
                break
              }
              case 3: {
                yield {
                  field: `${prefix}amount`,
                  value: r.string()
                }
                break
              }
              case 4: {
                yield {
                  field: `${prefix}fee`,
                  value: r.string()
                }
                break
              }
              case 5: {
                yield {
                  field: `${prefix}slot`,
                  value: r.int64()
                }
                break
              }
              case 6: {
                yield {
                  field: `${prefix}signature`,
                  value: r.bytes()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.Tx'
            }
          }
        })
      }

      return _codec
    }

    export interface TxSenderFieldEvent {
      field: '.sender'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TxRecipientFieldEvent {
      field: '.recipient'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TxAmountFieldEvent {
      field: '.amount'
      value: string
    }

    export interface TxFeeFieldEvent {
      field: '.fee'
      value: string
    }

    export interface TxSlotFieldEvent {
      field: '.slot'
      value: bigint
    }

    export interface TxSignatureFieldEvent {
      field: '.signature'
      value: Uint8Array<ArrayBuffer>
    }

    export function encode (obj: TxInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, Tx.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Tx>): Tx {
      return decodeMessage(buf, Tx.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<Tx>): Generator<TxSenderFieldEvent | TxRecipientFieldEvent | TxAmountFieldEvent | TxFeeFieldEvent | TxSlotFieldEvent | TxSignatureFieldEvent> {
      return streamMessage(buf, Tx.codec(), opts)
    }
  }

  export interface PeerInfo {
    peerId: string
    multiaddrs: string[]
    uptime: bigint
  }

  export interface PeerInfoInput {
    peerId?: string
    multiaddrs?: string[]
    uptime?: bigint
  }

  export namespace PeerInfo {
    let _codec: Codec<PeerInfo, PeerInfoInput>

    export const codec = (): Codec<PeerInfo, PeerInfoInput> => {
      if (_codec == null) {
        _codec = message<PeerInfo, PeerInfoInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if ((obj.peerId != null && obj.peerId !== '')) {
            w.uint32(10)
            w.string(obj.peerId)
          }

          if (obj.multiaddrs != null && obj.multiaddrs.length > 0) {
            for (const value of obj.multiaddrs) {
              w.uint32(18)
              w.string(value)
            }
          }

          if ((obj.uptime != null && obj.uptime !== 0n)) {
            w.uint32(24)
            w.int64(obj.uptime)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length, opts = {}) => {
          const obj: any = {
            peerId: '',
            multiaddrs: [],
            uptime: 0n
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.peerId = r.string()
                break
              }
              case 2: {
                if (opts.limits?.multiaddrs != null && obj.multiaddrs.length === opts.limits.multiaddrs) {
                  throw new MaxLengthError('Decode error - repeated field "multiaddrs" had too many elements')
                }

                obj.multiaddrs.push(r.string())
                break
              }
              case 3: {
                obj.uptime = r.int64()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix, opts = {}) {
          const obj = {
            multiaddrs: 0
          }

          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.PeerInfo'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield {
                  field: `${prefix}peerId`,
                  value: r.string()
                }
                break
              }
              case 2: {
                if (opts.limits?.multiaddrs != null && obj.multiaddrs === opts.limits.multiaddrs) {
                  throw new MaxLengthError('Streaming decode error - repeated field "multiaddrs" had too many elements')
                }

                yield {
                  field: `${prefix}multiaddrs[]`,
                  index: obj.multiaddrs,
                  value: r.string()
                }

                obj.multiaddrs++

                break
              }
              case 3: {
                yield {
                  field: `${prefix}uptime`,
                  value: r.int64()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.PeerInfo'
            }
          }
        })
      }

      return _codec
    }

    export interface PeerInfoPeerIdFieldEvent {
      field: '.peerId'
      value: string
    }

    export interface PeerInfoMultiaddrsFieldEvent {
      field: '.multiaddrs[]'
      index: number
      value: string
    }

    export interface PeerInfoUptimeFieldEvent {
      field: '.uptime'
      value: bigint
    }

    export function encode (obj: PeerInfoInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, PeerInfo.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfo>): PeerInfo {
      return decodeMessage(buf, PeerInfo.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfo>): Generator<PeerInfoPeerIdFieldEvent | PeerInfoMultiaddrsFieldEvent | PeerInfoUptimeFieldEvent> {
      return streamMessage(buf, PeerInfo.codec(), opts)
    }
  }

  export interface BlockEnvelope {
    block?: succinctcoin.Block
    sourcePeerId: string
  }

  export interface BlockEnvelopeInput {
    block?: succinctcoin.BlockInput
    sourcePeerId?: string
  }

  export namespace BlockEnvelope {
    let _codec: Codec<BlockEnvelope, BlockEnvelopeInput>

    export const codec = (): Codec<BlockEnvelope, BlockEnvelopeInput> => {
      if (_codec == null) {
        _codec = message<BlockEnvelope, BlockEnvelopeInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if (obj.block != null) {
            w.uint32(10)
            succinctcoin.Block.codec().encode(obj.block, w)
          }

          if ((obj.sourcePeerId != null && obj.sourcePeerId !== '')) {
            w.uint32(18)
            w.string(obj.sourcePeerId)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length, opts = {}) => {
          const obj: any = {
            sourcePeerId: ''
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.block = succinctcoin.Block.codec().decode(r, r.uint32(), {
                  limits: opts.limits?.block
                })
                break
              }
              case 2: {
                obj.sourcePeerId = r.string()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix, opts = {}) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.BlockEnvelope'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield * succinctcoin.Block.codec().stream(r, r.uint32(), `${prefix}block.`, {
                  limits: opts.limits?.block
                })

                break
              }
              case 2: {
                yield {
                  field: `${prefix}sourcePeerId`,
                  value: r.string()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.BlockEnvelope'
            }
          }
        })
      }

      return _codec
    }

    export interface BlockEnvelopeBlockMessageStart {
      field: '.block'
      type: 'start'
    }

    export interface BlockEnvelopeBlockMessageEnd {
      field: '.block'
      type: 'end'
    }

    export interface BlockEnvelopeBlockSlotFieldEvent {
      field: '.block.slot'
      value: bigint
    }

    export interface BlockEnvelopeBlockParentHashFieldEvent {
      field: '.block.parentHash'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockEnvelopeBlockWinnerIdentityIdFieldEvent {
      field: '.block.winnerIdentityId'
      value: string
    }

    export interface BlockEnvelopeBlockWinnerTicketFieldEvent {
      field: '.block.winnerTicket'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockEnvelopeBlockNonceFieldEvent {
      field: '.block.nonce'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockEnvelopeBlockHashFieldEvent {
      field: '.block.hash'
      value: Uint8Array<ArrayBuffer>
    }

    export interface BlockEnvelopeBlockTxCountFieldEvent {
      field: '.block.txCount'
      value: bigint
    }

    export interface BlockEnvelopeSourcePeerIdFieldEvent {
      field: '.sourcePeerId'
      value: string
    }

    export function encode (obj: BlockEnvelopeInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, BlockEnvelope.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<BlockEnvelope>): BlockEnvelope {
      return decodeMessage(buf, BlockEnvelope.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<BlockEnvelope>): Generator<BlockEnvelopeBlockMessageStart | BlockEnvelopeBlockMessageEnd | BlockEnvelopeBlockSlotFieldEvent | BlockEnvelopeBlockParentHashFieldEvent | BlockEnvelopeBlockWinnerIdentityIdFieldEvent | BlockEnvelopeBlockWinnerTicketFieldEvent | BlockEnvelopeBlockNonceFieldEvent | BlockEnvelopeBlockHashFieldEvent | BlockEnvelopeBlockTxCountFieldEvent | BlockEnvelopeSourcePeerIdFieldEvent> {
      return streamMessage(buf, BlockEnvelope.codec(), opts)
    }
  }

  export interface TicketEnvelope {
    ticket?: succinctcoin.Ticket
    sourcePeerId: string
  }

  export interface TicketEnvelopeInput {
    ticket?: succinctcoin.TicketInput
    sourcePeerId?: string
  }

  export namespace TicketEnvelope {
    let _codec: Codec<TicketEnvelope, TicketEnvelopeInput>

    export const codec = (): Codec<TicketEnvelope, TicketEnvelopeInput> => {
      if (_codec == null) {
        _codec = message<TicketEnvelope, TicketEnvelopeInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if (obj.ticket != null) {
            w.uint32(10)
            succinctcoin.Ticket.codec().encode(obj.ticket, w)
          }

          if ((obj.sourcePeerId != null && obj.sourcePeerId !== '')) {
            w.uint32(18)
            w.string(obj.sourcePeerId)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length, opts = {}) => {
          const obj: any = {
            sourcePeerId: ''
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.ticket = succinctcoin.Ticket.codec().decode(r, r.uint32(), {
                  limits: opts.limits?.ticket
                })
                break
              }
              case 2: {
                obj.sourcePeerId = r.string()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix, opts = {}) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.TicketEnvelope'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield * succinctcoin.Ticket.codec().stream(r, r.uint32(), `${prefix}ticket.`, {
                  limits: opts.limits?.ticket
                })

                break
              }
              case 2: {
                yield {
                  field: `${prefix}sourcePeerId`,
                  value: r.string()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.TicketEnvelope'
            }
          }
        })
      }

      return _codec
    }

    export interface TicketEnvelopeTicketMessageStart {
      field: '.ticket'
      type: 'start'
    }

    export interface TicketEnvelopeTicketMessageEnd {
      field: '.ticket'
      type: 'end'
    }

    export interface TicketEnvelopeTicketIdentityIdFieldEvent {
      field: '.ticket.identityId'
      value: string
    }

    export interface TicketEnvelopeTicketWindowIndexFieldEvent {
      field: '.ticket.windowIndex'
      value: bigint
    }

    export interface TicketEnvelopeTicketChallengeFieldEvent {
      field: '.ticket.challenge'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TicketEnvelopeTicketNonceCommitmentFieldEvent {
      field: '.ticket.nonceCommitment'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TicketEnvelopeTicketSignatureFieldEvent {
      field: '.ticket.signature'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TicketEnvelopeSourcePeerIdFieldEvent {
      field: '.sourcePeerId'
      value: string
    }

    export function encode (obj: TicketEnvelopeInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, TicketEnvelope.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<TicketEnvelope>): TicketEnvelope {
      return decodeMessage(buf, TicketEnvelope.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<TicketEnvelope>): Generator<TicketEnvelopeTicketMessageStart | TicketEnvelopeTicketMessageEnd | TicketEnvelopeTicketIdentityIdFieldEvent | TicketEnvelopeTicketWindowIndexFieldEvent | TicketEnvelopeTicketChallengeFieldEvent | TicketEnvelopeTicketNonceCommitmentFieldEvent | TicketEnvelopeTicketSignatureFieldEvent | TicketEnvelopeSourcePeerIdFieldEvent> {
      return streamMessage(buf, TicketEnvelope.codec(), opts)
    }
  }

  export interface TxEnvelope {
    tx?: succinctcoin.Tx
    sourcePeerId: string
  }

  export interface TxEnvelopeInput {
    tx?: succinctcoin.TxInput
    sourcePeerId?: string
  }

  export namespace TxEnvelope {
    let _codec: Codec<TxEnvelope, TxEnvelopeInput>

    export const codec = (): Codec<TxEnvelope, TxEnvelopeInput> => {
      if (_codec == null) {
        _codec = message<TxEnvelope, TxEnvelopeInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if (obj.tx != null) {
            w.uint32(10)
            succinctcoin.Tx.codec().encode(obj.tx, w)
          }

          if ((obj.sourcePeerId != null && obj.sourcePeerId !== '')) {
            w.uint32(18)
            w.string(obj.sourcePeerId)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length, opts = {}) => {
          const obj: any = {
            sourcePeerId: ''
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.tx = succinctcoin.Tx.codec().decode(r, r.uint32(), {
                  limits: opts.limits?.tx
                })
                break
              }
              case 2: {
                obj.sourcePeerId = r.string()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix, opts = {}) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.TxEnvelope'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield * succinctcoin.Tx.codec().stream(r, r.uint32(), `${prefix}tx.`, {
                  limits: opts.limits?.tx
                })

                break
              }
              case 2: {
                yield {
                  field: `${prefix}sourcePeerId`,
                  value: r.string()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.TxEnvelope'
            }
          }
        })
      }

      return _codec
    }

    export interface TxEnvelopeTxMessageStart {
      field: '.tx'
      type: 'start'
    }

    export interface TxEnvelopeTxMessageEnd {
      field: '.tx'
      type: 'end'
    }

    export interface TxEnvelopeTxSenderFieldEvent {
      field: '.tx.sender'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TxEnvelopeTxRecipientFieldEvent {
      field: '.tx.recipient'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TxEnvelopeTxAmountFieldEvent {
      field: '.tx.amount'
      value: string
    }

    export interface TxEnvelopeTxFeeFieldEvent {
      field: '.tx.fee'
      value: string
    }

    export interface TxEnvelopeTxSlotFieldEvent {
      field: '.tx.slot'
      value: bigint
    }

    export interface TxEnvelopeTxSignatureFieldEvent {
      field: '.tx.signature'
      value: Uint8Array<ArrayBuffer>
    }

    export interface TxEnvelopeSourcePeerIdFieldEvent {
      field: '.sourcePeerId'
      value: string
    }

    export function encode (obj: TxEnvelopeInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, TxEnvelope.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<TxEnvelope>): TxEnvelope {
      return decodeMessage(buf, TxEnvelope.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<TxEnvelope>): Generator<TxEnvelopeTxMessageStart | TxEnvelopeTxMessageEnd | TxEnvelopeTxSenderFieldEvent | TxEnvelopeTxRecipientFieldEvent | TxEnvelopeTxAmountFieldEvent | TxEnvelopeTxFeeFieldEvent | TxEnvelopeTxSlotFieldEvent | TxEnvelopeTxSignatureFieldEvent | TxEnvelopeSourcePeerIdFieldEvent> {
      return streamMessage(buf, TxEnvelope.codec(), opts)
    }
  }

  export interface PeerInfoEnvelope {
    peerInfo?: succinctcoin.PeerInfo
    sourcePeerId: string
  }

  export interface PeerInfoEnvelopeInput {
    peerInfo?: succinctcoin.PeerInfoInput
    sourcePeerId?: string
  }

  export namespace PeerInfoEnvelope {
    let _codec: Codec<PeerInfoEnvelope, PeerInfoEnvelopeInput>

    export const codec = (): Codec<PeerInfoEnvelope, PeerInfoEnvelopeInput> => {
      if (_codec == null) {
        _codec = message<PeerInfoEnvelope, PeerInfoEnvelopeInput>((obj, w, opts = {}) => {
          if (opts.lengthDelimited !== false) {
            w.fork()
          }

          if (obj.peerInfo != null) {
            w.uint32(10)
            succinctcoin.PeerInfo.codec().encode(obj.peerInfo, w)
          }

          if ((obj.sourcePeerId != null && obj.sourcePeerId !== '')) {
            w.uint32(18)
            w.string(obj.sourcePeerId)
          }

          if (opts.lengthDelimited !== false) {
            w.ldelim()
          }
        }, (r, length, opts = {}) => {
          const obj: any = {
            sourcePeerId: ''
          }

          const end = length == null ? r.len : r.pos + length

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                obj.peerInfo = succinctcoin.PeerInfo.codec().decode(r, r.uint32(), {
                  limits: opts.limits?.peerInfo
                })
                break
              }
              case 2: {
                obj.sourcePeerId = r.string()
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          return obj
        }, function * (r, length, prefix, opts = {}) {
          const end = length == null ? r.len : r.pos + length

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'start',
              message: 'succinctcoin.PeerInfoEnvelope'
            }
          }

          while (r.pos < end) {
            const tag = r.uint32()

            switch (tag >>> 3) {
              case 1: {
                yield * succinctcoin.PeerInfo.codec().stream(r, r.uint32(), `${prefix}peerInfo.`, {
                  limits: opts.limits?.peerInfo
                })

                break
              }
              case 2: {
                yield {
                  field: `${prefix}sourcePeerId`,
                  value: r.string()
                }
                break
              }
              default: {
                r.skipType(tag & 7)
                break
              }
            }
          }

          if (prefix !== '.') {
            yield {
              field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
              type: 'end',
              message: 'succinctcoin.PeerInfoEnvelope'
            }
          }
        })
      }

      return _codec
    }

    export interface PeerInfoEnvelopePeerInfoMessageStart {
      field: '.peerInfo'
      type: 'start'
    }

    export interface PeerInfoEnvelopePeerInfoMessageEnd {
      field: '.peerInfo'
      type: 'end'
    }

    export interface PeerInfoEnvelopePeerInfoPeerIdFieldEvent {
      field: '.peerInfo.peerId'
      value: string
    }

    export interface PeerInfoEnvelopePeerInfoMultiaddrsFieldEvent {
      field: '.peerInfo.multiaddrs[]'
      index: number
      value: string
    }

    export interface PeerInfoEnvelopePeerInfoUptimeFieldEvent {
      field: '.peerInfo.uptime'
      value: bigint
    }

    export interface PeerInfoEnvelopeSourcePeerIdFieldEvent {
      field: '.sourcePeerId'
      value: string
    }

    export function encode (obj: PeerInfoEnvelopeInput): Uint8Array<ArrayBuffer> {
      return encodeMessage(obj, PeerInfoEnvelope.codec())
    }

    export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfoEnvelope>): PeerInfoEnvelope {
      return decodeMessage(buf, PeerInfoEnvelope.codec(), opts)
    }

    export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<PeerInfoEnvelope>): Generator<PeerInfoEnvelopePeerInfoMessageStart | PeerInfoEnvelopePeerInfoMessageEnd | PeerInfoEnvelopePeerInfoPeerIdFieldEvent | PeerInfoEnvelopePeerInfoMultiaddrsFieldEvent | PeerInfoEnvelopePeerInfoUptimeFieldEvent | PeerInfoEnvelopeSourcePeerIdFieldEvent> {
      return streamMessage(buf, PeerInfoEnvelope.codec(), opts)
    }
  }

  let _codec: Codec<succinctcoin, succinctcoinInput>

  export const codec = (): Codec<succinctcoin, succinctcoinInput> => {
    if (_codec == null) {
      _codec = message<succinctcoin, succinctcoinInput>((obj, w, opts = {}) => {
        if (opts.lengthDelimited !== false) {
          w.fork()
        }

        if (opts.lengthDelimited !== false) {
          w.ldelim()
        }
      }, (r, length) => {
        const obj: any = {}

        const end = length == null ? r.len : r.pos + length

        while (r.pos < end) {
          const tag = r.uint32()

          switch (tag >>> 3) {
            default: {
              r.skipType(tag & 7)
              break
            }
          }
        }

        return obj
      }, function * (r, length, prefix) {
        const end = length == null ? r.len : r.pos + length

        if (prefix !== '.') {
          yield {
            field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
            type: 'start',
            message: 'succinctcoin'
          }
        }

        while (r.pos < end) {
          const tag = r.uint32()

          switch (tag >>> 3) {
            default: {
              r.skipType(tag & 7)
              break
            }
          }
        }

        if (prefix !== '.') {
          yield {
            field: prefix.endsWith('.') ? prefix.substring(0, prefix.length - 1) : prefix,
            type: 'end',
            message: 'succinctcoin'
          }
        }
      })
    }

    return _codec
  }

  export function encode (obj: succinctcoinInput): Uint8Array<ArrayBuffer> {
    return encodeMessage(obj, succinctcoin.codec())
  }

  export function decode (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<succinctcoin>): succinctcoin {
    return decodeMessage(buf, succinctcoin.codec(), opts)
  }

  export function stream (buf: Uint8Array | Uint8ArrayList, opts?: DecodeOptions<succinctcoin>): Generator<{}> {
    return streamMessage(buf, succinctcoin.codec(), opts)
  }
}
