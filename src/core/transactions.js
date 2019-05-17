const crypto = require('crypto')
const isArray = require('util').isArray
const ed = require('../utils/ed.js')
const Router = require('../utils/router.js')
const sandboxHelper = require('../utils/sandbox.js')
const LimitCache = require('../utils/limit-cache.js')
const addressHelper = require('../utils/address.js')

// let genesisblock = null
// Private fields
let modules
let library
let self
const priv = {}
const shared = {}

priv.unconfirmedNumber = 0
priv.unconfirmedTransactions = []
priv.unconfirmedTransactionsIdIndex = {}

class TransactionPool {
  constructor() {
    this.index = new Map()
    this.unConfirmed = []
  }

  add(trs) {
    this.unConfirmed.push(trs)
    this.index.set(trs.id, this.unConfirmed.length - 1)
  }

  remove(id) {
    const pos = this.index.get(id)
    delete this.index[id]
    this.unConfirmed[pos] = null
  }

  has(id) {
    const pos = this.index.get(id)
    return pos !== undefined && !!this.unConfirmed[pos]
  }

  getUnconfirmed() {
    const a = []

    for (let i = 0; i < this.unConfirmed.length; i++) {
      if (this.unConfirmed[i]) {
        a.push(this.unConfirmed[i])
      }
    }
    return a
  }

  clear() {
    this.index = new Map()
    this.unConfirmed = []
  }

  get(id) {
    const pos = this.index.get(id)
    return this.unConfirmed[pos]
  }
}

// Constructor
function Transactions(cb, scope) {
  library = scope
  genesisblock = library.genesisblock
  self = this
  self.pool = new TransactionPool()
  self.failedTrsCache = new LimitCache()
  priv.attachApi()

  setImmediate(cb, null, self)
}

// Private methods
priv.attachApi = () => {
  const router = new Router()

  router.use((req, res, next) => {
    if (modules) return next()
    return res.status(500).send({ success: false, error: 'Blockchain is loading' })
  })

  router.map(shared, {
    'get /': 'getTransactions',
    'get /get': 'getTransaction',
    'get /unconfirmed/get': 'getUnconfirmedTransaction',
    'get /unconfirmed': 'getUnconfirmedTransactions',
    'put /': 'addTransactionUnsigned',
    'put /batch': 'addTransactions',
  })

  router.use((req, res) => {
    res.status(500).send({ success: false, error: 'API endpoint not found' })
  })

  library.network.app.use('/api/transactions', router)
  library.network.app.use((err, req, res, next) => {
    if (!err) return next()
    library.logger.error(req.url, err.toString())
    return res.status(500).send({ success: false, error: err.toString() })
  })

  priv.attachStorageApi()
}

priv.attachStorageApi = () => {
  const router = new Router()

  router.use((req, res, next) => {
    if (modules) return next()
    return res.status(500).send({ success: false, error: 'Blockchain is loading' })
  })

  router.map(shared, {
    'get /get': 'getStorage',
    'get /:id': 'getStorage',
    'put /': 'putStorage',
  })

  router.use((req, res) => {
    res.status(500).send({ success: false, error: 'API endpoint not found' })
  })

  library.network.app.use('/api/storages', router)
  library.network.app.use((err, req, res, next) => {
    if (!err) return next()
    library.logger.error(req.url, err.toString())
    return res.status(500).send({ success: false, error: err.toString() })
  })
}

Transactions.prototype.getUnconfirmedTransaction = id => self.pool.get(id)

Transactions.prototype.getUnconfirmedTransactionList = () => self.pool.getUnconfirmed()

Transactions.prototype.removeUnconfirmedTransaction = id => self.pool.remove(id)

Transactions.prototype.hasUnconfirmed = id => self.pool.has(id)

Transactions.prototype.clearUnconfirmed = () => self.pool.clear()

Transactions.prototype.getUnconfirmedTransactions = (_, cb) => setImmediate(
  cb, null,
  { transactions: self.getUnconfirmedTransactionList() },
)

Transactions.prototype.getTransactions = (req, cb) => {
  const query = req.body
  const limit = query.limit ? Number(query.limit) : 100
  const offset = query.offset ? Number(query.offset) : 0
  const condition = {}
  if (query.senderId) {
    condition.senderId = query.senderId
  }
  if (query.type) {
    condition.type = Number(query.type)
  }
  if (query.recipientId) {
    condition.recipientId = query.recipientId
  }

  (async () => {
    try {
      const count = await app.sdb.count('Transaction', condition)
      let transactions = await app.sdb.find('Transaction', condition, { limit, offset })
      if (!transactions) transactions = []
      return cb(null, { transactions, count })
    } catch (e) {
      app.logger.error('Failed to get transactions', e)
      return cb(`System error: ${e}`)
    }
  })()
}

Transactions.prototype.getTransaction = (req, cb) => {
  (async () => {
    try {
      if (!req.params || !req.params.id) return cb('Invalid transaction id')
      const id = req.params.id
      const trs = await app.sdb.find('Transaction', { id })
      if (!trs || !trs.length) return cb('Transaction not found')
      return cb(null, { transaction: trs[0] })
    } catch (e) {
      return cb(`System error: ${e}`)
    }
  })()
}

Transactions.prototype.applyTransactionsAsync = async (transactions) => {
  for (let i = 0; i < transactions.length; ++i) {
    await self.applyUnconfirmedTransactionAsync(transactions[i])
  }
}

Transactions.prototype.processUnconfirmedTransactions = (transactions, cb) => {
  (async () => {
    try {
      for (const transaction of transactions) {
        await self.processUnconfirmedTransactionAsync(transaction)
      }
      cb(null, transactions)
    } catch (e) {
      cb(e.toString(), transactions)
    }
  })()
}

Transactions.prototype.processUnconfirmedTransactionsAsync = async (transactions) => {
  for (const transaction of transactions) {
    await self.processUnconfirmedTransactionAsync(transaction)
  }
}

Transactions.prototype.processUnconfirmedTransaction = (transaction, cb) => {
  (async () => {
    try {
      const ret = await self.processUnconfirmedTransactionAsync(transaction)
      cb(null, ret)
    } catch (e) {
      cb(e.toString())
    }
  })()
}

Transactions.prototype.existsTransaction = async (id) => {
  if (self.failedTrsCache.has(id)) return true
  if (self.pool.has(id)) return true
  if (app.sdb.get('Transaction', id)) return true

  const exists = await app.sdb.exists('Transaction', { id })
  return exists
}

Transactions.prototype.broadcastUnconfirmedTransaction = (transaction) => {
  const isLargeTransaction = transaction.type === 600

  const messageName = isLargeTransaction ?
    'unconfirmedLargeTransaction' :
    'unconfirmedNormalTransaction'
  library.bus.message(messageName, transaction)
}


Transactions.prototype.processUnconfirmedTransactionAsync = async (transaction) => {
  try {
    if (!transaction.id) {
      transaction.id = library.base.transaction.getId(transaction)
    } else {
      const id = library.base.transaction.getId(transaction)
      if (transaction.id !== id) {
        throw new Error('Invalid transaction id')
      }
    }

    if (modules.blocks.isCollectingVotes()) {
      throw new Error('Block consensus in processing')
    }

    if (self.failedTrsCache.has(transaction.id)) {
      throw new Error('Transaction already processed')
    }
    if (self.pool.has(transaction.id)) {
      throw new Error('Transaction already in the pool')
    }
    const exists = await app.sdb.exists('Transaction', { id: transaction.id })
    if (exists) {
      throw new Error('Transaction already confirmed')
    }
    const ret = await self.applyUnconfirmedTransactionAsync(transaction)
    self.pool.add(transaction)
    return ret
  } catch (e) {
    self.failedTrsCache.set(transaction.id, true)
    throw e
  }
}

Transactions.prototype.applyUnconfirmedTransactionAsync = async (transaction) => {
  library.logger.debug('apply unconfirmed trs', transaction)

  const height = modules.blocks.getLastBlock().height
  const block = {
    height: height + 1,
  }

  const senderId = transaction.senderId
  const requestorId = transaction.requestorId
  if (!senderId) {
    throw new Error('Missing sender address')
  }

  if (!transaction.signatures || transaction.signatures.length === 0) {
    throw new Error('Signatures are not provided')
  }

  if (requestorId) throw new Error('RequestId should not be provided')
  // HARDCODE_HOT_FIX_BLOCK_6119128
  if (height > 6119128
    && app.util.address.isNormalAddress(senderId)
    && !transaction.senderPublicKey) {
    throw new Error('Sender public key not provided')
  }

  let sender = await app.sdb.load('Account', senderId)
  const contractCallOrPay = transaction.type === 601 || transaction.type === 602
  if (!sender) {
    if (height > 0 && !contractCallOrPay) {
      throw new Error('Sender account not found')
    } else if (height > 0 && contractCallOrPay) {
      // call contract or pay contract

    } else { // height <= 0
      sender = app.sdb.create('Account', {
        address: senderId,
        name: null,
        xas: 0,
      })
    }
  }

  if (transaction.senderPublicKey) {
    const signerId = transaction.senderId
    if (addressHelper.generateNormalAddress(transaction.senderPublicKey) !== signerId) {
      throw new Error('Invalid senderPublicKey')
    }
  }

  const context = {
    trs: transaction,
    block,
    sender,
  }
  if (height > 0) {
    const error = await library.base.transaction.verify(context)
    if (error) throw new Error(error)
  }

  app.sdb.beginContract()
  try {
    const ret = await library.base.transaction.apply(context)
    await app.sdb.commitContract()
    return ret
  } catch (e) {
    await app.sdb.rollbackContract()
    library.logger.error(e)
    throw e
  }
}

Transactions.prototype.toAPIV1Transactions = (transArray, block) => {
  if (transArray && isArray(transArray) && transArray.length > 0) {
    return transArray.map(t => self.toAPIV1Transaction(t, block))
  }
  return []
}

Transactions.prototype.tranfersToAPIV1Transactions = async (transfers, block, heightAsString) => {
  if (transfers && isArray(transfers) && transfers.length > 0) {
    const transMap = new Map()
    const transIds = transfers.map(t => t.tid)
    const transArray = await app.sdb.find('Transaction', { id: { $in: transIds } })
    transArray.forEach(t => transMap.set(t.id, t))

    transfers.forEach((transfer) => {
      const trans = transMap.get(transfer.tid)
      if (trans !== undefined) {
        transfer.senderPublicKey = trans.senderPublicKey
        transfer.signSignature = trans.secondSignature || trans.signSignature
        transfer.message = trans.message
        transfer.fee = trans.fee
        transfer.type = trans.type
        transfer.args = trans.args
        transfer.signatures = trans.signatures
      }
    })

    return transfers.map(t => self.toAPIV1Transaction(t, block, heightAsString))
  }
  return []
}


function toV1TypeAndArgs(type, args, transactionId) {
  let v1Type

  const v1Args = {}
  let result = {}
  switch (type) {
    case 1: // transfer
      v1Type = 0
      result = { amount: Number(args[0]), recipientId: args[1] }
      break
    case 3: // setPassword
      v1Type = 1
      result = { senderPublicKey: args[0] }
      break
    case 10: // registerDelegate
      v1Type = 2
      break
    case 11: // vote
      v1Type = 3
      reulst = { votes: args.map(v => `+${v}`).join(',') }
      break
    case 12: // unvote
      v1Type = 3
      reulst = { votes: args.map(v => `-${v}`).join(',') }
      break
    case 200: // register dapp
      v1Type = 5
      // args = [ dapp.name, dapp.description, dapp.link,
      // dapp.icon, dapp.delegates, dapp.unlockDelegates ]
      break
    case 204: // deposit
      v1Type = 6
      // args = [ it.name, it.currency, it.amount ];
      break
    case 205: // withdrawal
      v1Type = 7
      // args = [ ot.name, tx.senderId, ot.currency, ot.amount, ot.outtransactionId, 1 ]
      break
    case 100: // registerIssuer
      v1Type = 9
      // args = [ issuers.name, issuers.desc ];
      break
    case 101: // registerAsset
      v1Type = 10
      // args = [ asset.name, asset.desc, asset.maximum, asset.precision ]
      break
    case 102: // issue
      v1Type = 13
      // args = [ issue.currency, issue.amount ];
      break
    case 103: // UIA transfer
      v1Type = 14
      result = {
        asset: { uiaTransfer: { transactionId, currency: args[0], amount: String(args[1]) } },
        recipientId: args[2],
      }
      break
    case 4:
      v1Type = 100 // lock
      // args = [ tx.args[0], balance ];
      break
  }

  result.recipientId = result.recipientId || ''
  return Object.assign(result, { type: v1Type, args: v1Args, argsNew: args })
}

Transactions.prototype.toAPIV1Transaction = (trans, block, heightAsString) => {
  if (!trans) return trans

  const signArray = trans.signatures
  const confirmations = modules.blocks.getLastBlock().height - trans.height
  const resultTrans = {
    id: trans.tid,
    height: heightAsString ? String(trans.height) : trans.height,
    timestamp: trans.timestamp,
    senderPublicKey: trans.senderPublicKey,
    senderId: trans.senderId,
    signSignature: trans.signSignature,
    message: trans.message,
    fee: trans.fee,
    blockId: block ? block.id : undefined,
    recipientId: '',
    amount: 0,
    asset: {},
    confirmations: heightAsString ? String(confirmations) : confirmations,

    type: -1,
    signature: signArray.length === 1 ? signArray[0] : null,
    signatures: signArray.length === 1 ? null : signArray,
    args: {},
  }
  return Object.assign(resultTrans, toV1TypeAndArgs(trans.type, trans.args, trans.tid))
}


Transactions.prototype.addTransactionUnsigned = (transaction, cb) => {
  shared.addTransactionUnsigned({ body: transaction }, cb)
}

Transactions.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

Transactions.prototype.list = (query, cb) => priv.list(query, cb)

Transactions.prototype.getById = (id, cb) => priv.getById(id, cb)

// Events
Transactions.prototype.onBind = (scope) => {
  modules = scope
}

Transactions.prototype.getBlockTransactionsForV1 = (v1Block, cb) => {
  if (!v1Block) return cb('Block not found')

  return (async () => {
    try {
      let transfer = await app.sdb.find('Transfer', { height: v1Block.height }, {}, { timestamp: 'ASC' })
      if (!transfer) transfer = []
      const transactions = await self.tranfersToAPIV1Transactions(transfer, v1Block)
      return cb(null, transactions)
    } catch (e) {
      app.logger.error('Failed to get transactions', e)
      return cb(`System error: ${e.message}`)
    }
  })()
}

// Shared
/**
 * for exchanges only
 * get transfers by given conditions
 *
 */
shared.getTransactions = (req, cb) => {
  const query = req.body
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
      },
      offset: {
        type: 'integer',
        minimum: 0,
      },
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
      blockId: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
    },
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    const limit = query.limit || 100
    const offset = query.offset || 0

    const condition = {}
    if (query.senderId) {
      condition.senderId = query.senderId
    }
    if (query.recipientId) {
      condition.recipientId = query.recipientId
    }
    if (query.id) {
      condition.tid = query.id
    }

    if (query.type !== undefined) {
      const type = Number(query.type)
      if (type !== 0 && type !== 14) return cb('invalid transaction type')
      condition.currency = type === 0 ? 'XAS' : { $ne: 'XAS' }
    }

    if (query.orderBy) {
      let [orderField, sortOrder] = query.orderBy.split(':')
      if (orderField && sortOrder !== undefined) {
        orderField = orderField === 't_timestamp' ? 'timestamp' : orderField
        sortOrder = sortOrder.toUpperCase()
        query.orderBy = {}
        query.orderBy[orderField] = sortOrder
      } else {
        query.orderBy = undefined
      }
    }

    (async () => {
      try {
        let block
        if (query.blockId) {
          block = await app.sdb.getBlockById(query.blockId)
          if (block === undefined) {
            return cb(null, { transactions: [], count: 0 })
          }
          condition.height = block.height
        }
        const count = await app.sdb.count('Transfer', condition)
        let transfer = await app.sdb.find('Transfer', condition, query.unlimited ? {} : { limit, offset }, query.orderBy)
        if (!transfer) transfer = []
        block = modules.blocks.toAPIV1Block(block)
        const transactions = await self.tranfersToAPIV1Transactions(transfer, block, true)
        return cb(null, { transactions, count })
      } catch (e) {
        app.logger.error('Failed to get transactions', e)
        return cb(`System error: ${e}`)
      }
    })()
    return null
  })
}

shared.getTransaction = (req, cb) => {
  const query = req.body
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
    },
    required: ['id'],
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    const convertResult = async (getTransError, ret) => {
      if (getTransError) {
        cb(getTransError)
        return
      }

      if (!ret || !ret.transactions || ret.transactions.length < 1) {
        cb('transaction not found', ret)
      } else {
        // for exchanges ....
        const transaction = ret.transactions[0]
        transaction.height = String(transaction.height)
        transaction.confirmations = String(transaction.confirmations)

        cb(null, { transaction })
      }
    }
    const callback = (err2, ret) => convertResult(err2, ret)
    return shared.getTransactions(req, callback)
  })
}

shared.getUnconfirmedTransaction = (req, cb) => {
  const query = req.body
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
      },
    },
    required: ['id'],
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    const unconfirmedTransaction = self.getUnconfirmedTransaction(query.id)

    return !unconfirmedTransaction
      ? cb('Transaction not found')
      : cb(null, { transaction: unconfirmedTransaction })
  })
}

shared.getUnconfirmedTransactions = (req, cb) => {
  const query = req.body
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      senderPublicKey: {
        type: 'string',
        format: 'publicKey',
      },
      address: {
        type: 'string',
      },
    },
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    const transactions = self.getUnconfirmedTransactionList(true)
    const toSend = []

    if (query.senderPublicKey || query.address) {
      for (let i = 0; i < transactions.length; i++) {
        if (transactions[i].senderPublicKey === query.senderPublicKey
          || transactions[i].recipientId === query.address) {
          toSend.push(transactions[i])
        }
      }
    } else {
      transactions.forEach(t => toSend.push(t))
    }

    return cb(null, { transactions: toSend })
  })
}

function convertV1Transfer(trans) {
  if (trans.type === 0 && trans.amount !== undefined && trans.recipientId !== undefined) {
    trans.type = 1
    trans.fee = trans.fee || 10000000
    trans.args = [trans.amount, trans.recipientId]
    Reflect.deleteProperty(trans, 'amount')
    Reflect.deleteProperty(trans, 'recipientId')
  }
}


shared.addTransactionUnsigned = (req, cb) => {
  const query = req.body

  query.type = Number(query.type || 0)
  convertV1Transfer(query)

  const valid = library.scheme.validate(query, {
    type: 'object',
    properties: {
      secret: { type: 'string', maxLength: 100 },
      fee: { type: 'integer', min: 1 },
      type: { type: 'integer', min: 1 },
      args: { type: 'array' },
      message: { type: 'string', maxLength: 50 },
      senderId: { type: 'string', maxLength: 50 },
      mode: { type: 'integer', min: 0, max: 1 },
    },
    required: ['secret', 'fee', 'type'],
  })
  if (!valid) {
    library.logger.warn('Failed to validate query params', library.scheme.getLastError())
    return setImmediate(cb, library.scheme.getLastError().details[0].message)
  }

  library.sequence.add((callback) => {
    (async () => {
      try {
        const hash = crypto.createHash('sha256').update(query.secret, 'utf8').digest()
        const keypair = ed.MakeKeypair(hash)
        let secondKeypair = null
        if (query.secondSecret) {
          secondKeypair = ed.MakeKeypair(crypto.createHash('sha256').update(query.secondSecret, 'utf8').digest())
        }
        const trs = library.base.transaction.create({
          secret: query.secret,
          fee: query.fee,
          type: query.type,
          senderId: query.senderId || null,
          args: query.args || null,
          message: query.message || null,
          secondKeypair,
          keypair,
          mode: query.mode,
        })
        const result = await self.processUnconfirmedTransactionAsync(trs)
        self.broadcastUnconfirmedTransaction(trs)
        callback(null, Object.assign({ transactionId: trs.id }, result))
      } catch (e) {
        library.logger.warn('Failed to process unsigned transaction', e)
        callback(e.toString())
      }
    })()
  }, cb)
  return null
}

shared.addTransactions = (req, cb) => {
  if (!req.body || !req.body.transactions) {
    return cb('Invalid params')
  }
  const trs = req.body.transactions
  try {
    for (const t of trs) {
      library.base.transaction.objectNormalize(t)
    }
  } catch (e) {
    return cb(`Invalid transaction body: ${e.toString()}`)
  }
  return library.sequence.add((callback) => {
    self.processUnconfirmedTransactions(trs, callback)
  }, cb)
}

// Export
module.exports = Transactions
