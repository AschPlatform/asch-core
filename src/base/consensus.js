const assert = require('assert')
const crypto = require('crypto')
const ByteBuffer = require('bytebuffer')
const ip = require('ip')
const ed = require('../utils/ed.js')
const slots = require('../utils/slots.js')
const featureSwitch = require('../utils/feature-switch.js')

let self
function Consensus(scope) {
  self = this
  this.scope = scope
  this.pendingBlock = null
  this.pendingVotes = null
  this.votesKeySet = {}
}

Consensus.prototype.createVotes = (keypairs, block) => {
  const hash = self.getVoteHash(block.height, block.id)
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
    const hash = self.getVoteHash(height, id)
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
  if (featureSwitch.isEnabled('enableLongId')) {
    bytes.writeString(id)
  } else {
    const idBytes = app.util.bignumber(id).toBuffer({ size: 8 })
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

Consensus.prototype.getPendingBlock = () => self.pendingBlock

Consensus.prototype.hasPendingBlock = (timestamp) => {
  if (!self.pendingBlock) {
    return false
  }
  return slots.getSlotNumber(self.pendingBlock.timestamp) === slots.getSlotNumber(timestamp)
}

Consensus.prototype.setPendingBlock = (block) => {
  self.pendingVotes = null
  self.votesKeySet = {}
  self.pendingBlock = block
}

Consensus.prototype.clearState = () => {
  self.pendingVotes = null
  self.votesKeySet = {}
  self.pendingBlock = null
}

Consensus.prototype.addPendingVotes = (votes) => {
  if (!self.pendingBlock || self.pendingBlock.height !== votes.height
    || self.pendingBlock.id !== votes.id) {
    return self.pendingVotes
  }
  for (let i = 0; i < votes.signatures.length; ++i) {
    const item = votes.signatures[i]
    if (self.votesKeySet[item.key]) {
      continue
    }
    if (self.verifyVote(votes.height, votes.id, item)) {
      self.votesKeySet[item.key] = true
      if (!self.pendingVotes) {
        self.pendingVotes = {
          height: votes.height,
          id: votes.id,
          signatures: [],
        }
      }
      self.pendingVotes.signatures.push(item)
    }
  }
  return self.pendingVotes
}

Consensus.prototype.createPropose = (keypair, block, address) => {
  assert(keypair.publicKey.toString('hex') === block.delegate)
  const propose = {
    height: block.height,
    id: block.id,
    timestamp: block.timestamp,
    generatorPublicKey: block.delegate,
    address,
  }
  const hash = self.getProposeHash(propose)
  propose.hash = hash.toString('hex')
  propose.signature = ed.Sign(hash, keypair).toString('hex')
  return propose
}

Consensus.prototype.getProposeHash = (propose) => {
  const bytes = new ByteBuffer()
  bytes.writeLong(propose.height)

  if (featureSwitch.isEnabled('enableLongId')) {
    bytes.writeString(propose.id)
  } else {
    const idBytes = app.util.bignumber(propose.id).toBuffer({ size: 8 })
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
  const report = self.scope.scheme.validate(votes, {
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
    throw Error(self.scope.scheme.getLastError())
  }
  return votes
}

Consensus.prototype.acceptPropose = (propose, cb) => {
  const hash = self.getProposeHash(propose)
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
