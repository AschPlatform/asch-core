const crypto = require('crypto')
const ByteBuffer = require('bytebuffer')
const ed = require('../utils/ed.js')
const constants = require('../utils/constants.js')
const slots = require('../utils/slots.js')
const addressHelper = require('../utils/address.js')
const feeCalculators = require('../utils/calculate-fee.js')
const transactionMode = require('../utils/transaction-mode.js')

let self
// Constructor
function Transaction(scope) {
  self = this
  this.scope = scope
}

// Private methods
const prv = {}
prv.types = {}

// function calc(height) {
//   return Math.floor(height / slots.delegates) + (height % slots.delegates > 0 ? 1 : 0)
// }

// Public methods
Transaction.prototype.create = (data) => {
  const trs = {
    type: data.type,
    senderId: data.senderId,
    senderPublicKey: data.keypair.publicKey.toString('hex'),
    timestamp: slots.getTime(),
    message: data.message,
    args: data.args,
    fee: data.fee,
    mode: data.mode,
  }
  const signerId = addressHelper.generateNormalAddress(trs.senderPublicKey)
  if (transactionMode.isDirectMode(trs.mode)) {
    trs.senderId = signerId
  } else if (transactionMode.isRequestMode(trs.mode)) {
    if (!trs.senderId) throw new Error('No senderId was provided in request mode')
    trs.requestorId = signerId
  } else {
    throw new Error('Unexpected transaction mode')
  }

  // if (trs.senderId) {
  //   trs.requestorId = signerId
  // } else {
  //   trs.senderId = signerId
  // }
  trs.signatures = [self.sign(data.keypair, trs)]

  if (data.secondKeypair) {
    trs.secondSignature = self.sign(data.secondKeypair, trs)
  }

  trs.id = self.getId(trs)

  return trs
}

Transaction.prototype.attachAssetType = (typeId, instance) => {
  if (instance && typeof instance.create === 'function' && typeof instance.getBytes === 'function'
    && typeof instance.calculateFee === 'function' && typeof instance.verify === 'function'
    && typeof instance.objectNormalize === 'function' && typeof instance.dbRead === 'function'
    && typeof instance.apply === 'function' && typeof instance.undo === 'function'
    && typeof instance.applyUnconfirmed === 'function' && typeof instance.undoUnconfirmed === 'function'
    && typeof instance.ready === 'function' && typeof instance.process === 'function'
  ) {
    prv.types[typeId] = instance
  } else {
    throw Error('Invalid instance interface')
  }
}

Transaction.prototype.sign = (keypair, trs) => {
  const hash = self.getHash(trs)
  return ed.Sign(hash, keypair).toString('hex')
}

Transaction.prototype.multisign = (keypair, trs) => {
  const bytes = self.getBytes(trs, true, true)
  const hash = crypto.createHash('sha256').update(bytes).digest()
  return ed.Sign(hash, keypair).toString('hex')
}

Transaction.prototype.getId = trs => self.getId2(trs)

Transaction.prototype.getId2 = trs => self.getHash(trs).toString('hex')

Transaction.prototype.getHash = trs => crypto.createHash('sha256').update(self.getBytes(trs)).digest()

Transaction.prototype.getBytes = (trs, skipSignature, skipSecondSignature) => {
  const bb = new ByteBuffer(1, true)
  bb.writeInt(trs.type)
  bb.writeInt(trs.timestamp)
  bb.writeLong(trs.fee)
  bb.writeString(trs.senderId)
  if (trs.requestorId) {
    bb.writeString(trs.requestorId)
  }
  if (trs.mode) {
    bb.writeInt(trs.mode)
  }

  if (trs.message) bb.writeString(trs.message)
  if (trs.args) {
    let args
    if (typeof trs.args === 'string') {
      args = trs.args
    } else if (Array.isArray(trs.args)) {
      args = JSON.stringify(trs.args)
    } else {
      throw new Error('Invalid transaction args')
    }
    bb.writeString(args)
  }

  // FIXME
  if (!skipSignature && trs.signatures) {
    for (const signature of trs.signatures) {
      const signatureBuffer = Buffer.from(signature, 'hex')
      for (let i = 0; i < signatureBuffer.length; i++) {
        bb.writeByte(signatureBuffer[i])
      }
    }
  }

  if (!skipSecondSignature && trs.signSignature) {
    const signSignatureBuffer = Buffer.from(trs.signSignature, 'hex')
    for (let i = 0; i < signSignatureBuffer.length; i++) {
      bb.writeByte(signSignatureBuffer[i])
    }
  }

  bb.flip()

  return bb.toBuffer()
}

Transaction.prototype.verifyNormalSignature = (trs, requestor, bytes) => {
  if (!self.verifyBytes(bytes, trs.senderPublicKey, trs.signatures[0])) {
    return 'Invalid signature'
  }
  if (requestor.secondPublicKey) {
    if (!self.verifyBytes(bytes, requestor.secondPublicKey, trs.secondSignature)) {
      return 'Invalid second signature'
    }
  }
  return undefined
}

Transaction.prototype.verifyGroupSignature = async (trs, sender, bytes) => {
  const group = await app.sdb.findOne('Group', { condition: { name: sender.name } })
  if (!group) return 'Group not found'
  const groupMembers = await app.sdb.findAll('GroupMember', { condition: { name: sender.name } })
  if (!groupMembers) return 'Group members not found'
  const memberMap = new Map()
  for (const item of groupMembers) {
    memberMap.set(item.member, item)
  }
  let totalWeight = 0
  for (const ks of trs.signatures) {
    const k = ks.substr(0, 64)
    const address = addressHelper.generateNormalAddress(k)
    if (!memberMap.has(address)) return 'Invalid member address'
    totalWeight += memberMap.get(address).weight
  }
  if (totalWeight < group.m) return 'Signature weight not enough'

  for (const ks of trs.signatures) {
    if (ks.length !== 192) return 'Invalid key-signature format'
    const key = ks.substr(0, 64)
    const signature = ks.substr(64, 192)
    if (!self.verifyBytes(bytes, key, signature)) {
      return 'Invalid multi signatures'
    }
  }
  return undefined
}

Transaction.prototype.verifyChainSignature = async (trs, sender, bytes) => {
  const chain = await app.sdb.findOne('Chain', { condition: { address: sender.senderId } })
  if (!chain) return 'Chain not found'
  const validators = await app.sdb.findAll('ChainDelegate', { condition: { address: sender.senderId } })
  if (!validators || !validators.length) return 'Chain delegates not found'

  const validatorPublicKeySet = new Set()
  for (const v of validators) {
    validatorPublicKeySet.add(v.delegate)
  }
  let validSignatureNumber = 0
  for (const s of trs.signatures) {
    const k = s.substr(0, 64)
    if (validatorPublicKeySet.has(k)) {
      validSignatureNumber++
    }
  }
  if (validSignatureNumber < chain.unlockNumber) return 'Signature not enough'

  for (const ks of trs.signatures) {
    if (ks.length !== 192) return 'Invalid key-signature format'
    const key = ks.substr(0, 64)
    const signature = ks.substr(64, 192)
    if (!self.verifyBytes(bytes, key, signature)) {
      return 'Invalid multi signatures'
    }
  }
  return undefined
}

Transaction.prototype.verify = async (context) => {
  const { trs, sender, requestor } = context
  if (slots.getSlotNumber(trs.timestamp) > slots.getSlotNumber()) {
    return 'Invalid transaction timestamp'
  }

  if (!trs.type) {
    return 'Invalid function'
  }

  if (sender === requestor || !requestor) {
    const feeCalculator = feeCalculators[trs.type]
    if (!feeCalculator) return 'Fee calculator not found'
    const minFee = 100000000 * feeCalculator(trs)
    if (trs.fee < minFee) return 'Fee not enough'
  }

  const id = self.getId(trs)
  if (trs.id !== id) {
    return 'Invalid transaction id'
  }

  try {
    const bytes = self.getBytes(trs, true, true)
    if (trs.senderPublicKey) {
      const error = self.verifyNormalSignature(trs, requestor, bytes)
      if (error) return error
    }
    if (!trs.senderPublicKey && trs.signatures && trs.signatures.length > 1) {
      const ADDRESS_TYPE = app.util.address.TYPE
      const addrType = app.util.address.getType(trs.senderId)
      if (addrType === ADDRESS_TYPE.CHAIN) {
        const error = await self.verifyChainSignature(trs, sender, bytes)
        if (error) return error
      } else if (addrType === ADDRESS_TYPE.GROUP) {
        const error = await self.verifyGroupSignature(trs, sender, bytes)
        if (error) return error
      } else {
        return 'Invalid account type'
      }
    }
  } catch (e) {
    library.logger.error('verify signature excpetion', e)
    return 'Faied to verify signature'
  }
  return undefined
}

Transaction.prototype.verifySignature = (trs, publicKey, signature) => {
  if (!signature) return false

  try {
    const bytes = self.getBytes(trs, true, true)
    return self.verifyBytes(bytes, publicKey, signature)
  } catch (e) {
    throw Error(e.toString())
  }
}

Transaction.prototype.verifyBytes = (bytes, publicKey, signature) => {
  try {
    const data2 = Buffer.alloc(bytes.length)

    for (let i = 0; i < data2.length; i++) {
      data2[i] = bytes[i]
    }

    const hash = crypto.createHash('sha256').update(data2).digest()
    const signatureBuffer = Buffer.from(signature, 'hex')
    const publicKeyBuffer = Buffer.from(publicKey, 'hex')
    return ed.Verify(hash, signatureBuffer || ' ', publicKeyBuffer || ' ')
  } catch (e) {
    throw Error(e.toString())
  }
}

Transaction.prototype.apply = async (context) => {
  const {
    block, trs, sender, requestor,
  } = context
  const name = app.getContractName(trs.type)
  if (!name) {
    throw new Error(`Unsupported transaction type: ${trs.type}`)
  }
  const [mod, func] = name.split('.')
  if (!mod || !func) {
    throw new Error('Invalid transaction function')
  }
  const fn = app.contract[mod][func]
  if (!fn) {
    throw new Error('Contract not found')
  }

  if (block.height !== 0) {
    if (transactionMode.isRequestMode(trs.mode) && !context.activating) {
      const requestorFee = 20000000
      if (requestor.xas < requestorFee) throw new Error('Insufficient requestor balance')
      requestor.xas -= requestorFee
      app.addRoundFee(requestorFee)
      // trs.executed = 0
      app.sdb.create('TransactionStatu', { tid: trs.id, executed: 0 })
      app.sdb.update('Account', { xas: requestor.xas }, { address: requestor.address })
      return null
    }
    if (sender.xas < trs.fee) throw new Error('Insufficient sender balance')
    sender.xas -= trs.fee
    app.sdb.update('Account', { xas: sender.xas }, { address: sender.address })
  }

  const error = await fn.apply(context, trs.args)
  if (error) {
    throw new Error(error)
  }
  // trs.executed = 1
}

Transaction.prototype.objectNormalize = (trs) => {
  for (const i in trs) {
    if (trs[i] === null || typeof trs[i] === 'undefined') {
      delete trs[i]
    }
  }

  if (trs.args && typeof trs.args === 'string') {
    try {
      trs.args = JSON.parse(trs.args)
      if (!Array.isArray(trs.args)) throw new Error('Transaction args must be json array')
    } catch (e) {
      throw new Error(`Failed to parse args: ${e}`)
    }
  }

  if (trs.signatures && typeof trs.signatures === 'string') {
    try {
      trs.signatures = JSON.parse(trs.signatures)
    } catch (e) {
      throw new Error(`Failed to parse signatures: ${e}`)
    }
  }

  // FIXME
  const report = self.scope.scheme.validate(trs, {
    type: 'object',
    properties: {
      id: { type: 'string' },
      height: { type: 'integer' },
      type: { type: 'integer' },
      timestamp: { type: 'integer' },
      senderId: { type: 'string' },
      fee: { type: 'integer', minimum: 0, maximum: constants.totalAmount },
      secondSignature: { type: 'string', format: 'signature' },
      signatures: { type: 'array' },
      // args: { type: "array" },
      message: { type: 'string', maxLength: 256 },
    },
    required: ['type', 'timestamp', 'senderId', 'signatures'],
  })

  if (!report) {
    library.logger.error(`Failed to normalize transaction body: ${self.scope.scheme.getLastError().details[0].message}`, trs)
    throw Error(self.scope.scheme.getLastError())
  }

  return trs
}

module.exports = Transaction
