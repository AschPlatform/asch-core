const crypto = require('crypto')
const isArray = require('util').isArray
const jsonSql = require('json-sql')()

jsonSql.setDialect('sqlite')

const ed = require('../utils/ed.js')
const Router = require('../utils/router.js')
const sandboxHelper = require('../utils/sandbox.js')

const addressHelper = require('../utils/address.js')


// Private fields
let modules
let library
let self
const priv = {}
const shared = {}

// Constructor
function UIA(cb, scope) {
  library = scope
  self = this
  priv.attachApi()
  cb(null, self)
}

// Private methods
priv.attachApi = () => {
  const router = new Router()

  router.use((req, res, next) => {
    if (modules) return next()
    return res.status(500).send({ success: false, error: 'Blockchain is loading' })
  })

  router.map(shared, {
    'get /issuers': 'getIssuers',
    'get /issuers/:name': 'getIssuer',
    'get /issuers/:name/assets': 'getIssuerAssets',
    'get /assets': 'getAssets',
    'get /assets/:name': 'getAsset',
    'get /balances/:address': 'getBalances',
    'get /balances/:address/:currency': 'getBalance',
    'put /transfers': 'transferAsset',
    'get /transfers/:address/:currency': 'getTransfers',
    'get /transactions/my/:address/:currency': 'getTransfers',
  })

  router.use((req, res) => {
    res.status(500).send({ success: false, error: 'API endpoint not found' })
  })

  library.network.app.use('/api/uia', router)
  library.network.app.use((err, req, res, next) => {
    if (!err) return next()
    library.logger.error(req.url, err)
    return res.status(500).send({ success: false, error: err.toString() })
  })
}

// Public methods
UIA.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

function trimPrecision(amount, precision) {
  if (Number(amount) === 0) return '0'

  const s = amount.toString()
  const value = app.util.bignumber(s)
  if (precision <= 10) {
    return value.div(10 ** precision).toString()
  }

  return value.div(10 ** 10).div(10 ** (precision - 10)).toString()
}

UIA.prototype.toAPIV1UIABalances = (balances) => {
  if (!(balances && isArray(balances) && balances.length > 0)) return balances
  const assetMap = new Map()
  app.sdb.getAll('Asset').forEach(asset => assetMap.set(asset.name, self.toAPIV1Asset(asset)))

  return balances.map((b) => {
    b.balance = String(b.balance)
    const asset = assetMap.get(b.currency)
    if (asset) {
      b.balanceShow = trimPrecision(b.balance, asset.precision)
    }
    return assetMap.has(b.currency) ? Object.assign(b, asset) : b
  })
}

UIA.prototype.toAPIV1Assets = assets => ((assets && isArray(assets) && assets.length > 0)
  ? assets.map(a => self.toAPIV1Asset(a))
  : [])

UIA.prototype.toAPIV1Asset = (asset) => {
  if (!asset) return asset

  return {
    name: asset.name,
    desc: asset.desc,
    maximum: String(asset.maximum),
    precision: asset.precision,
    quantity: String(asset.quantity),
    issuerId: asset.issuerId,
    height: asset.height,
    writeoff: 0,
    maximumShow: trimPrecision(asset.maximum, asset.precision),
    quantityShow: trimPrecision(asset.quantity, asset.precision),

    // "strategy"  => missing
    // "acl" => missing
    // "allowWriteoff" => missing
    // "allowWhitelist" => missing
    // "allowBlacklist" => missing
  }
}

// Events
UIA.prototype.onBind = (scope) => {
  modules = scope
}

// Shared

shared.getIssuers = (req, cb) => {
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
    },
  }, (err) => {
    if (err) return cb(`Invalid parameters: ${err[0]}`)
    return (async () => {
      try {
        const limitAndOffset = { limit: query.limit || 100, offset: query.offset || 0 }
        const count = await app.sdb.count('Issuer', {})
        const issues = await app.sdb.find('Issuer', {}, limitAndOffset)
        return cb(null, { count, issues })
      } catch (dbErr) {
        return cb(`Failed to get issuers: ${dbErr}`)
      }
    })()
  })
}

shared.getIssuerByAddress = (req, cb) => {
  if (!req.params || !addressHelper.isAddress(req.params.address)) {
    return cb('Invalid address')
  }
  return (async () => {
    try {
      const issuers = await app.sdb.find('Issuer', { address: req.params.address })
      if (!issuers || issuers.length === 0) return cb('Issuer not found')
      return cb(null, { issuer: issuers[0] })
    } catch (dbErr) {
      return cb(`Failed to get issuer: ${dbErr}`)
    }
  })()
}

shared.getIssuer = (req, cb) => {
  if (req.params && addressHelper.isAddress(req.params.name)) {
    req.params.address = req.params.name
    return shared.getIssuerByAddress(req, cb)
  }
  const query = req.params
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 16,
      },
    },
    required: ['name'],
  }, (err) => {
    if (err) return cb(`Invalid parameters: ${err[0]}`)

    return (async () => {
      try {
        const issuers = await app.sdb.find('Issuer', { name: req.params.name })
        if (!issuers || issuers.length === 0) return cb('Issuer not found')
        return cb(null, { issuer: issuers[0] })
      } catch (dbErr) {
        return cb(`Failed to get issuers: ${dbErr}`)
      }
    })()
  })
  return null
}

shared.getIssuerAssets = (req, cb) => {
  if (!req.params || !req.params.name || req.params.name.length > 32) {
    cb(' Invalid parameters')
    return
  }
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
    },
  }, (err) => {
    if (err) return cb(`Invalid parameters: ${err[0]}`)

    return (async () => {
      try {
        const limitAndOffset = { limit: query.limit || 100, offset: query.offset || 0 }
        const condition = { issuerName: req.params.name }
        const count = await app.sdb.count('Asset', condition)
        const assets = await app.sdb.find('Asset', condition, limitAndOffset)
        return cb(null, { count, assets: self.toAPIV1Assets(assets) })
      } catch (dbErr) {
        return cb(`Failed to get assets: ${dbErr}`)
      }
    })()
  })
}

shared.getAssets = (req, cb) => {
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
    },
  }, (err) => {
    if (err) return cb(`Invalid parameters: ${err[0]}`)
    return (async () => {
      try {
        const condition = {}
        const limitAndOffset = { limit: query.limit || 100, offset: query.offset || 0 }
        const count = await app.sdb.count('Asset', condition)
        const assets = await app.sdb.find('Asset', condition, limitAndOffset)
        return cb(null, { count, assets: self.toAPIV1Assets(assets) })
      } catch (dbErr) {
        return cb(`Failed to get assets: ${dbErr}`)
      }
    })()
  })
}

shared.getAsset = (req, cb) => {
  const query = req.params
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
      },
    },
    required: ['name'],
  }, (err) => {
    if (err) cb(`Invalid parameters: ${err[0]}`)

    return (async () => {
      try {
        const condition = { name: query.name }
        const assets = await app.sdb.find('Asset', condition)
        if (!assets || assets.length === 0) return cb('Asset not found')
        return cb(null, { asset: self.toAPIV1Asset(assets[0]) })
      } catch (dbErr) {
        return cb(`Failed to get asset: ${dbErr}`)
      }
    })()
  })
}


shared.getBalances = (req, cb) => {
  if (!req.params || !addressHelper.isAddress(req.params.address)) {
    return cb('Invalid address')
  }
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
    },
  }, (err) => {
    if (err) return cb(`Invalid parameters: ${err[0]}`)

    return (async () => {
      try {
        const condition = { address: req.params.address }
        const count = await app.sdb.count('Balance', condition)
        const resultRange = { limit: query.limit, offset: query.offset }
        const balances = await app.sdb.find('Balance', condition, resultRange)
        return cb(null, { count, balances: self.toAPIV1UIABalances(balances) })
      } catch (dbErr) {
        return cb(`Failed to get balances: ${dbErr}`)
      }
    })()
  })
  return null
}

shared.getBalance = (req, cb) => {
  if (!req.params) return cb('Invalid parameters')
  if (!addressHelper.isAddress(req.params.address)) return cb('Invalid address')
  if (!req.params.currency || req.params.currency.length > 22) return cb('Invalid currency')

  return (async () => {
    try {
      const condition = { address: req.params.address, currency: req.params.currency }
      let balances = await app.sdb.find('Balance', condition)
      if (!balances || balances.length === 0) return cb('Balance info not found')
      balances = self.toAPIV1UIABalances(balances)
      return cb(null, { balance: balances[0] })
    } catch (dbErr) {
      return cb(`Failed to get issuers: ${dbErr}`)
    }
  })()
}

function formatUiaTransfers(transactions) {
  if (!transactions || transactions.length === 0) return []
  const assetMap = new Map()
  app.sdb.getAll('Asset').forEach(asset => assetMap.set(asset.name, self.toAPIV1Asset(asset)))

  transactions.forEach((t) => {
    t.height = String(t.height)
    t.amount = Number(t.amount)
    t.confirmations = String(t.confirmations)
    const uiaTransfer = t.asset.uiaTransfer
    const asset = assetMap.get(uiaTransfer.currency)
    t.asset.uiaTransfer = {
      transactionId: t.id,
      currency: uiaTransfer.currency,
      amount: String(uiaTransfer.amount),
      amountShow: trimPrecision(uiaTransfer.amount, asset.precision),
      precision: asset.precision,
    }
  })
  return transactions
}

shared.getTransfers = (req, cb) => {
  const query = req.params
  let validateResult = library.scheme.validate(query, {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
      currency: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
    },
    required: ['address', 'currency'],
  })
  if (!validateResult) return cb(library.scheme.getLastError().details[0].message)

  validateResult = library.scheme.validate(req.body, {
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
    },
  })
  if (!validateResult) return cb(library.scheme.getLastError().details[0].message)

  const limit = req.body.limit || 100
  const offset = req.body.offset || 0

  let orderBy
  if (req.body.orderBy) {
    let [orderField, sortOrder] = req.body.orderBy.split(':')
    if (orderField && sortOrder !== undefined) {
      orderField = orderField === 't_timestamp' ? 'timestamp' : orderField
      sortOrder = sortOrder.toUpperCase()
      orderBy = {}
      orderBy[orderField] = sortOrder
    }
  }

  const condition = [
    {
      $or: {
        senderId: query.address,
        recipientId: query.address,
      },
    },
    { currency: query.currency }]

  return (async () => {
    try {
      const transfers = await app.sdb.find('Transfer', condition, { limit, offset }, orderBy)

      const transactions = formatUiaTransfers(await modules.transactions.tranfersToAPIV1Transactions(transfers))
      return cb(null, { transactions, count: transactions.length })
    } catch (err) {
      return cb(err.message)
    }
  })()
}

shared.transferAsset = (req, cb) => {
  const query = req.body
  const valid = library.scheme.validate(query, {
    type: 'object',
    properties: {
      secret: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
      currency: {
        type: 'string',
        maxLength: 22,
      },
      amount: {
        type: 'string',
        maxLength: 50,
      },
      recipientId: {
        type: 'string',
        minLength: 1,
      },
      publicKey: {
        type: 'string',
        format: 'publicKey',
      },
      secondSecret: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
      },
      multisigAccountPublicKey: {
        type: 'string',
        format: 'publicKey',
      },
      message: {
        type: 'string',
        maxLength: 256,
      },
      fee: {
        type: 'integer',
        minimum: 10000000,
      },
    },
    required: ['secret', 'amount', 'recipientId', 'currency'],
  })

  if (!valid) {
    library.logger.warn('Failed to validate query params', library.scheme.getLastError())
    return setImmediate(cb, library.scheme.getLastError().details[0].message)
  }

  return library.sequence.add((callback) => {
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
          fee: query.fee || 10000000,
          type: 103,
          senderId: query.senderId || null,
          args: [query.currency, query.amount, query.recipientId],
          message: query.message || null,
          secondKeypair,
          keypair,
        })
        await modules.transactions.processUnconfirmedTransactionAsync(trs)
        library.bus.message('unconfirmedTransaction', trs)
        callback(null, { transactionId: trs.id })
      } catch (e) {
        library.logger.warn('Failed to process unsigned transaction', e)
        callback(e.toString())
      }
    })()
  }, cb)
}

module.exports = UIA
