const crypto = require('crypto')
const ByteBuffer = require('bytebuffer')
const ed = require('../utils/ed.js')
const BlockStatus = require('../utils/block-status.js')
const constants = require('../utils/constants.js')
const featureSwitch = require('../utils/feature-switch.js')

// Private methods
const prv = {}
prv.getAddressByPublicKey = (publicKey) => {
  const publicKeyHash = crypto.createHash('sha256').update(publicKey, 'hex').digest()
  const temp = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    temp[i] = publicKeyHash[7 - i]
  }

  const address = app.util.bignumber.fromBuffer(temp).toString()
  return address
}

prv.writeHexBytes = (buffer, hexString) => {
  if (!hexString) return

  const hexBuffer = Buffer.from(hexString, 'hex')
  for (let i = 0; i < hexBuffer.length; i++) {
    buffer.writeByte(hexBuffer[i])
  }
}

let self
// Constructor
function Block(scope) {
  self = this
  this.scope = scope
  prv.blockStatus = new BlockStatus()
}

// Public methods

Block.prototype.sortTransactions = data => data.transactions.sort((a, b) => {
  if (a.type === b.type) {
    // if (a.type === 1) {
    //   return 1
    // }
    // if (b.type === 1) {
    //   return -1
    // }
    return a.type - b.type
  }
  // if (a.amount !== b.amount) {
  //   return a.amount - b.amount
  // }
  return a.id.localeCompare(b.id)
})

Block.prototype.create = (data) => {
  const transactions = self.sortTransactions(data)

  const nextHeight = (data.previousBlock) ? data.previousBlock.height + 1 : 1

  const reward = prv.blockStatus.calcReward(nextHeight)
  let totalFee = 0
  let totalAmount = 0
  let size = 0

  const blockTransactions = []
  const payloadHash = crypto.createHash('sha256')

  for (let i = 0; i < transactions.length; i++) {
    const transaction = transactions[i]
    const bytes = self.scope.transaction.getBytes(transaction)

    if (size + bytes.length > constants.maxPayloadLength) {
      break
    }

    size += bytes.length

    totalFee += transaction.fee
    totalAmount += transaction.amount

    blockTransactions.push(transaction)
    payloadHash.update(bytes)
  }

  let block = {
    version: 0,
    totalAmount,
    totalFee,
    reward,
    payloadHash: payloadHash.digest().toString('hex'),
    timestamp: data.timestamp,
    numberOfTransactions: blockTransactions.length,
    payloadLength: size,
    previousBlock: data.previousBlock.id,
    generatorPublicKey: data.keypair.publicKey.toString('hex'),
    transactions: blockTransactions,
  }

  try {
    block.blockSignature = self.sign(block, data.keypair)

    block = self.objectNormalize(block)
  } catch (e) {
    throw Error(e.toString())
  }

  return block
}

Block.prototype.sign = (block, keypair) => {
  const hash = self.getHash(block)

  return ed.Sign(hash, keypair).toString('hex')
}

Block.prototype.getBytes = (block, skipSignature) => {
  const size = 4 + 4 + 8 + 4 + 8 + 8 + 64 + 64 + 32 +
    block.version > 0 ? (32 /* stateHash */ + 32 /* contractStateHash */) : 0 +
    64

  const bb = new ByteBuffer(size, true)
  bb.writeInt(block.version)
  bb.writeInt(block.timestamp)
  bb.writeLong(block.height)
  bb.writeInt(block.count)
  bb.writeLong(block.fees)
  bb.writeLong(block.reward)
  bb.writeString(block.delegate)

  // HARDCODE HOTFIX
  if (block.height > 6167000 && block.prevBlockId) {
    bb.writeString(block.prevBlockId)
  } else {
    bb.writeString('0')
  }

  prv.writeHexBytes(bb, block.payloadHash)

  if (block.version > 0) {
    prv.writeHexBytes(bb, block.stateHash)
    prv.writeHexBytes(bb, block.contractStateHash)
  }

  if (!skipSignature && block.signature) {
    prv.writeHexBytes(bb, block.signature)
  }

  bb.flip()
  const b = bb.toBuffer()

  return b
}

Block.prototype.verifySignature = (block) => {
  const remove = 64

  try {
    const data = self.getBytes(block)
    const data2 = Buffer.alloc(data.length - remove)

    for (let i = 0; i < data2.length; i++) {
      data2[i] = data[i]
    }
    const hash = crypto.createHash('sha256').update(data2).digest()
    const blockSignatureBuffer = Buffer.from(block.signature, 'hex')
    const generatorPublicKeyBuffer = Buffer.from(block.delegate, 'hex')

    return ed.Verify(hash, blockSignatureBuffer || ' ', generatorPublicKeyBuffer || ' ')
  } catch (e) {
    throw Error(e.toString())
  }
}

Block.prototype.objectNormalize = (block) => {
  // eslint-disable-next-line guard-for-in
  for (const i in block) {
    if (block[i] == null || typeof block[i] === 'undefined') {
      delete block[i]
    }
    if (Buffer.isBuffer(block[i])) {
      block[i] = block[i].toString()
    }
  }

  const report = self.scope.scheme.validate(block, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
      },
      height: {
        type: 'integer',
      },
      signature: {
        type: 'string',
        format: 'signature',
      },
      delegate: {
        type: 'string',
        format: 'publicKey',
      },
      payloadHash: {
        type: 'string',
        format: 'hex',
      },
      payloadLength: {
        type: 'integer',
      },
      stateHash: {
        type: 'string',
        format: 'hex_or_empty',
      },
      contractStateHash: {
        type: 'string',
        format: 'hex_or_empty',
      },
      prevBlockId: {
        type: 'string',
      },
      timestamp: {
        type: 'integer',
      },
      transactions: {
        type: 'array',
        uniqueItems: true,
      },
      version: {
        type: 'integer',
        minimum: 0,
      },
      reward: {
        type: 'integer',
        minimum: 0,
      },
    },
    required: ['signature', 'delegate', 'payloadHash', 'timestamp', 'transactions', 'version', 'reward'],
  })

  if (!report) {
    throw Error(self.scope.scheme.getLastError())
  }

  try {
    for (let i = 0; i < block.transactions.length; i++) {
      block.transactions[i] = self.scope.transaction.objectNormalize(block.transactions[i])
    }
  } catch (e) {
    throw Error(e.toString())
  }

  return block
}

Block.prototype.getId = block => self.getId2(block)

Block.prototype.getId_old = (block) => {
  if (featureSwitch.isEnabled('enableLongId')) {
    return self.getId2(block)
  }
  const hash = crypto.createHash('sha256').update(self.getBytes(block)).digest()
  const temp = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    temp[i] = hash[7 - i]
  }

  const id = app.util.bignumber.fromBuffer(temp).toString()
  return id
}

Block.prototype.getId2 = (block) => {
  const hash = crypto.createHash('sha256').update(self.getBytes(block)).digest()
  return hash.toString('hex')
}

Block.prototype.getHash = block => crypto.createHash('sha256').update(self.getBytes(block)).digest()

Block.prototype.calculateFee = () => 10000000

Block.prototype.dbRead = (raw) => {
  if (!raw.b_id) {
    return null
  }

  const block = {
    id: raw.b_id,
    version: parseInt(raw.b_version, 10),
    timestamp: parseInt(raw.b_timestamp, 10),
    height: parseInt(raw.b_height, 10),
    previousBlock: raw.b_previousBlock,
    numberOfTransactions: parseInt(raw.b_numberOfTransactions, 10),
    totalAmount: parseInt(raw.b_totalAmount, 10),
    totalFee: parseInt(raw.b_totalFee, 10),
    reward: parseInt(raw.b_reward, 10),
    payloadLength: parseInt(raw.b_payloadLength, 10),
    payloadHash: raw.b_payloadHash,
    generatorPublicKey: raw.b_generatorPublicKey,
    generatorId: prv.getAddressByPublicKey(raw.b_generatorPublicKey),
    blockSignature: raw.b_blockSignature,
    confirmations: raw.b_confirmations,
  }
  block.totalForged = (block.totalFee + block.reward)
  return block
}

// Export
module.exports = Block
