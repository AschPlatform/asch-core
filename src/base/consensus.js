const assert = require('assert')
const crypto = require('crypto')
const ByteBuffer = require('bytebuffer')
const ip = require('ip')
const bignum = require('bignumber')
const ed = require('../utils/ed.js')
const slots = require('../utils/slots.js')

function Consensus(scope, cb) {
  this.scope = scope
  this.pendingBlock = null
  this.pendingVotes = null
  this.votesKeySet = {}
  if (cb) setImmediate(cb, null, this)
}

Consensus.prototype.createVotes = (keypairs, block) => {
  const hash = this.getVoteHash(block.height, block.id)
  const votes = {
    height: block.height,
    id: block.id,
    signatures: [],
  }
  keypairs.forEach((el) => {
    votes.signatures.push({
      key: el.publicKey.toString('hex'),
      sig: ed.Sign(hash, el).toString('hex'),
    })
  })
  return votes
}

Consensus.prototype.verifyVote = (height, id, voteItem) => {
  try {
    const hash = this.getVoteHash(height, id)
    const signature = Buffer.from(voteItem.sig, 'hex')
    const publicKey = Buffer.from(voteItem.key, 'hex')
    return ed.Verify(hash, signature, publicKey)
  } catch (e) {
    return false
  }
}

Consensus.prototype.getVoteHash = (height, id) => {
  const bytes = new ByteBuffer()
  bytes.writeLong(height)
  if (global.featureSwitch.enableLongId) {
    bytes.writeString(id)
  } else {
    const idBytes = bignum(id).toBuffer({ size: 8 })
    for (let i = 0; i < 8; i++) {
      bytes.writeByte(idBytes[i])
    }
  }
  bytes.flip()
  return crypto.createHash('sha256').update(bytes.toBuffer()).digest()
}

Consensus.prototype.hasEnoughVotes = votes => votes && votes.signatures
  && votes.signatures.length > slots.delegates * 2 / 3

Consensus.prototype.hasEnoughVotesRemote = votes => votes && votes.signatures
  && votes.signatures.length >= 6

Consensus.prototype.getPendingBlock = () => this.pendingBlock

Consensus.prototype.hasPendingBlock = (timestamp) => {
  if (!this.pendingBlock) {
    return false
  }
  return slots.getSlotNumber(this.pendingBlock.timestamp) === slots.getSlotNumber(timestamp)
}

Consensus.prototype.setPendingBlock = (block) => {
  this.pendingVotes = null
  this.votesKeySet = {}
  this.pendingBlock = block
}

Consensus.prototype.clearState = () => {
  this.pendingVotes = null
  this.votesKeySet = {}
  this.pendingBlock = null
}

Consensus.prototype.addPendingVotes = (votes) => {
  if (!this.pendingBlock || this.pendingBlock.height !== votes.height
    || this.pendingBlock.id !== votes.id) {
    return this.pendingVotes
  }
  for (let i = 0; i < votes.signatures.length; ++i) {
    const item = votes.signatures[i]
    if (this.votesKeySet[item.key]) {
      continue
    }
    if (this.verifyVote(votes.height, votes.id, item)) {
      this.votesKeySet[item.key] = true
      if (!this.pendingVotes) {
        this.pendingVotes = {
          height: votes.height,
          id: votes.id,
          signatures: [],
        }
      }
      this.pendingVotes.signatures.push(item)
    }
  }
  return this.pendingVotes
}

Consensus.prototype.createPropose = (keypair, block, address) => {
  assert(keypair.publicKey.toString('hex') === block.generatorPublicKey)
  const propose = {
    height: block.height,
    id: block.id,
    timestamp: block.timestamp,
    generatorPublicKey: block.generatorPublicKey,
    address,
  }
  const hash = this.getProposeHash(propose)
  propose.hash = hash.toString('hex')
  propose.signature = ed.Sign(hash, keypair).toString('hex')
  return propose
}

Consensus.prototype.getProposeHash = (propose) => {
  const bytes = new ByteBuffer()
  bytes.writeLong(propose.height)

  if (global.featureSwitch.enableLongId) {
    bytes.writeString(propose.id)
  } else {
    const idBytes = bignum(propose.id).toBuffer({ size: 8 })
    for (let i = 0; i < 8; i++) {
      bytes.writeByte(idBytes[i])
    }
  }

  const generatorPublicKeyBuffer = Buffer.from(propose.generatorPublicKey, 'hex')
  for (let i = 0; i < generatorPublicKeyBuffer.length; i++) {
    bytes.writeByte(generatorPublicKeyBuffer[i])
  }

  bytes.writeInt(propose.timestamp)

  const parts = propose.address.split(':')
  assert(parts.length === 2)
  bytes.writeInt(ip.toLong(parts[0]))
  bytes.writeInt(Number(parts[1]))

  bytes.flip()
  return crypto.createHash('sha256').update(bytes.toBuffer()).digest()
}

Consensus.prototype.normalizeVotes = (votes) => {
  const report = this.scope.scheme.validate(votes, {
    type: 'object',
    properties: {
      height: {
        type: 'integer',
      },
      id: {
        type: 'string',
      },
      signatures: {
        type: 'array',
        minLength: 1,
        maxLength: 101,
      },
    },
    required: ['height', 'id', 'signatures'],
  })
  if (!report) {
    throw Error(this.scope.scheme.getLastError())
  }
  return votes
}

Consensus.prototype.acceptPropose = (propose, cb) => {
  const hash = this.getProposeHash(propose)
  if (propose.hash !== hash.toString('hex')) {
    return setImmediate(cb, 'Propose hash is not correct')
  }
  try {
    const signature = Buffer.from(propose.signature, 'hex')
    const publicKey = Buffer.from(propose.generatorPublicKey, 'hex')
    if (ed.Verify(hash, signature, publicKey)) {
      return setImmediate(cb)
    }
    return setImmediate(cb, 'Vefify signature failed')
  } catch (e) {
    return setImmediate(cb, `Verify signature exception: ${e.toString()}`)
  }
}

module.exports = Consensus
