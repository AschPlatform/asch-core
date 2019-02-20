const _ = require('lodash')
const LRU = require('lru-cache')
const Router = require('../utils/router.js')
const slots = require('../utils/slots.js')
const sandboxHelper = require('../utils/sandbox.js')

let modules
let library
let self
const priv = {}
const shared = {}

priv.headers = {}
priv.loaded = false

// Constructor
function Transport(cb, scope) {
  library = scope
  self = this
  priv.attachApi()
  priv.latestBlocksCache = new LRU(200)
  priv.blockHeaderMidCache = new LRU(1000)

  setImmediate(cb, null, self)
}

priv.attachApi = () => {
  const router = new Router()

  router.use((req, res, next) => {

    res.set(priv.headers)
    if (req.headers.magic !== library.config.magic) {
      modules.peer.setNodeIncompatible(req.ip, req.headers.magic)
      return res.status(500).send({
        success: false,
        error: 'Request is made on the wrong network',
        expected: library.config.magic,
        received: req.headers.magic,
      })
    }
    return next()
  })

  router.post('/newBlock', (req, res) => {
    const { body } = req
    if (!body.id) {
      return res.status(500).send({ error: 'Invalid params' })
    }
    const newBlock = priv.latestBlocksCache.get(body.id)
    if (!newBlock) {
      return res.status(500).send({ error: 'New block not found: '+ body.id })
    }
    return res.send({ success: true, block: newBlock.block, votes: newBlock.votes })
  })

  router.post('/commonBlock', (req, res) => {
    const { body } = req
    if (!Number.isInteger(body.max)) return res.send({ error: 'Field max must be integer' })
    if (!Number.isInteger(body.min)) return res.send({ error: 'Field min must be integer' })
    const max = body.max
    const min = body.min
    const ids = body.ids
    return (async () => {
      try {
        let blocks = await app.sdb.getBlocksByHeightRange(min, max)
        // app.logger.trace('find common blocks in database', blocks)
        if (!blocks || !blocks.length) {
          return res.status(500).send({ success: false, error: 'Blocks not found' })
        }
        blocks = blocks.reverse()
        let commonBlock = null
        for (const i in ids) {
          if (blocks[i].id === ids[i]) {
            commonBlock = blocks[i]
            break
          }
        }
        if (!commonBlock) {
          return res.status(500).send({ success: false, error: 'Common block not found' })
        }
        return res.send({ success: true, common: commonBlock })
      } catch (e) {
        app.logger.error(`Failed to find common block: ${e}`)
        return res.send({ success: false, error: 'Failed to find common block' })
      }
    })()
  })

  router.post('/blocks', (req, res) => {
    const { body } = req
    let blocksLimit = 200
    if (body.limit) {
      blocksLimit = Math.min(blocksLimit, Number(body.limit))
    }
    const lastBlockId = body.lastBlockId
    if (!lastBlockId) {
      return res.status(500).send({ error: 'Invalid params' })
    }
    return (async () => {
      try {
        const lastBlock = await app.sdb.getBlockById(lastBlockId)
        if (!lastBlock) throw new Error(`Last block not found: ${lastBlockId}`)

        const minHeight = lastBlock.height + 1
        const maxHeight = (minHeight + blocksLimit) - 1
        const blocks = await modules.blocks.getBlocks(minHeight, maxHeight, true)
        return res.send({ blocks })
      } catch (e) {
        app.logger.error('Failed to get blocks or transactions', e)
        return res.send({ blocks: [] })
      }
    })()
  })

  router.post('/transactions', (req, res) => {
    if (modules.loader.syncing()) {
      return res.status(500).send({
        success: false,
        error: 'Blockchain is syncing',
      })
    }
    const lastBlock = modules.blocks.getLastBlock()
    const lastSlot = slots.getSlotNumber(lastBlock.timestamp)
    if (slots.getNextSlot() - lastSlot >= 12) {
      library.logger.error('Blockchain is not ready', {
        getNextSlot: slots.getNextSlot(),
        lastSlot,
        lastBlockHeight: lastBlock.height,
      })
      return res.status(200).json({ success: false, error: 'Blockchain is not ready' })
    }
    let transaction
    try {
      transaction = library.base.transaction.objectNormalize(req.body.transaction)
    } catch (e) {
      library.logger.error('Received transaction parse error', {
        raw: req.body,
        trs: transaction,
        error: e.toString(),
      })
      return res.status(200).json({ success: false, error: 'Invalid transaction body' })
    }

    return library.sequence.add((cb) => {
      library.logger.info(`Received transaction ${transaction.id} from http client`)
      modules.transactions.processUnconfirmedTransaction(transaction, cb)
    }, (err, trans, ret) => {
      if (err) {
        library.logger.warn(`Receive invalid transaction ${transaction.id}`, err)
        const errMsg = err.message ? err.message : err.toString()
        res.status(200).json({ success: false, error: errMsg })
      } else {
        library.bus.message('unconfirmedTransaction', transaction)
        const result = (!ret) ? { success: true, transactionId: transaction.id } :
          Object.assign({ transactionId: transaction.id }, ret) 
        res.status(200).json(result)
      }
    })
  })

  router.post('/votes', (req, res) => {
    library.bus.message('receiveVotes', req.body.votes)
    res.send({})
  })

  router.post('/getUnconfirmedTransactions', (req, res) => {
    res.send({ transactions: modules.transactions.getUnconfirmedTransactionList() })
  })

  router.post('/getHeight', (req, res) => {
    res.send({
      height: modules.blocks.getLastBlock().height,
    })
  })

  router.post('/chainRequest', (req, res) => {
    const params = req.body
    const body = req.body.body
    try {
      if (!params.chain) {
        return res.send({ success: false, error: 'missed chain' })
      }
    } catch (e) {
      library.logger.error('receive invalid chain request', { error: e.toString(), params })
      return res.send({ success: false, error: e.toString() })
    }

    return modules.chains.request(
      params.chain,
      body.method,
      body.path,
      { query: body.query },
      (err, ret) => {
        if (!err && ret.error) {
          err = ret.error
        }

        if (err) {
          library.logger.error('failed to process chain request', err)
          return res.send({ success: false, error: err })
        }
        return res.send(_.assign({ success: true }, ret))
      },
    )
  })

  router.use((req, res) => {
    res.status(500).send({ success: false, error: 'API endpoint not found' })
  })

  library.network.app.use('/peer', router)
}

Transport.prototype.broadcast = (topic, message, recursive) => {
  modules.peer.publish(topic, message, recursive)
}

Transport.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

// Events
Transport.prototype.onBind = (scope) => {
  modules = scope
  priv.headers = {
    os: modules.system.getOS(),
    version: modules.system.getVersion(),
    port: modules.system.getPort(),
    magic: modules.system.getMagic(),
  }
}

Transport.prototype.onBlockchainReady = () => {
  priv.loaded = true
}

Transport.prototype.onPeerReady = () => {
  modules.peer.subscribe('newBlockHeader', (message, peer) => {
    if (modules.loader.syncing()) {
      return
    }
    const lastBlock = modules.blocks.getLastBlock()
    if (!lastBlock) {
      library.logger.error('Last block not exists')
      return
    }

    const body = message.body
    if (!body || !body.id || !body.height || !body.prevBlockId) {
      library.logger.error('Invalid message body')
      return
    }
    const height = body.height
    const id = body.id.toString('hex')
    const prevBlockId = body.prevBlockId.toString('hex')
    if (height !== lastBlock.height + 1 || prevBlockId !== lastBlock.id) {
      library.logger.warn('New block donnot match with last block', message)
      if (height > lastBlock.height + 5) {
        library.logger.warn('Receive new block header from long fork')
      } else {
        modules.loader.syncBlocksFromPeer(peer)
      }
      return
    }
    library.logger.info('Receive new block header', { height, id })
    modules.peer.request('newBlock', { id }, peer, (err, result) => {
      if (err) {
        library.logger.error('Failed to get latest block data', err)
        return
      }
      if (!result || !result.block || !result.votes) {
        library.logger.error('Invalid block data', result)
        return
      }
      try {
        let block = result.block
        let votes = library.protobuf.decodeBlockVotes(Buffer.from(result.votes, 'base64'))
        block = library.base.block.objectNormalize(block)
        votes = library.base.consensus.normalizeVotes(votes)
        priv.latestBlocksCache.set(block.id, result)
        priv.blockHeaderMidCache.set(block.id, message)
        library.bus.message('receiveBlock', block, votes)
      } catch (e) {
        library.logger.error(`normalize block or votes object error: ${e.toString()}`, result)
      }
    })
  })

  modules.peer.subscribe('propose', (message) => {
    try {
      const propose = library.protobuf.decodeBlockPropose(message.body.propose)
      library.bus.message('receivePropose', propose)
    } catch (e) {
      library.logger.error('Receive invalid propose', e)
    }
  })

  modules.peer.subscribe('transaction', (message) => {
    if (modules.loader.syncing()) {
      return
    }
    const lastBlock = modules.blocks.getLastBlock()
    const lastSlot = slots.getSlotNumber(lastBlock.timestamp)
    if (slots.getNextSlot() - lastSlot >= 12) {
      library.logger.error('Blockchain is not ready', { getNextSlot: slots.getNextSlot(), lastSlot, lastBlockHeight: lastBlock.height })
      return
    }
    let transaction
    try {
      transaction = message.body.transaction
      if (Buffer.isBuffer(transaction)) transaction = transaction.toString()
      transaction = JSON.parse(transaction)
      transaction = library.base.transaction.objectNormalize(transaction)
    } catch (e) {
      library.logger.error('Received transaction parse error', {
        message,
        error: e.toString(),
      })
      return
    }

    library.sequence.add((cb) => {
      library.logger.info(`Received transaction ${transaction.id} from remote peer`)
      modules.transactions.processUnconfirmedTransaction(transaction, cb)
    }, (err) => {
      if (err) {
        library.logger.warn(`Receive invalid transaction ${transaction.id}`, err)
      } else {
        // library.bus.message('unconfirmedTransaction', transaction, true)
      }
    })
  })
}

Transport.prototype.onUnconfirmedTransaction = (transaction) => {
  const message = {
    body: {
      transaction: JSON.stringify(transaction),
    },
  }
  self.broadcast('transaction', message)
}

Transport.prototype.onNewBlock = (block, votes) => {
  priv.latestBlocksCache.set(block.id,
    {
      block,
      votes: library.protobuf.encodeBlockVotes(votes).toString('base64'),
    }
  )
  const message = priv.blockHeaderMidCache.get(block.id) || {
    body: {
      id: Buffer.from(block.id, 'hex'),
      height: block.height,
      prevBlockId: Buffer.from(block.prevBlockId, 'hex'),
    },
  }
  self.broadcast('newBlockHeader', message, 0)
}

Transport.prototype.onNewPropose = (propose) => {
  const message = {
    body: {
      propose: library.protobuf.encodeBlockPropose(propose),
    },
  }
  self.broadcast('propose', message)
}

Transport.prototype.sendVotes = (votes, address) => {
  const parts = address.split(':')
  const contact = {
    host: parts[0],
    port: parts[1],
  }
  modules.peer.request('votes', { votes }, contact, (err) => {
    if (err) {
      library.logger.error('send votes error', err)
    }
  })
}

Transport.prototype.cleanup = (cb) => {
  priv.loaded = false
  cb()
}

shared.message = (msg, cb) => {
  msg.timestamp = (new Date()).getTime()

  // self.broadcast('chainMessage', msg)

  cb(null, {})
}

shared.request = (req, cb) => {
  if (req.body.peer) {
    modules.peer.request('chainRequest', req, req.body.peer, (err, res) => {
      if (res) {
        res.peer = req.body.peer
      }
      cb(err, res)
    })
  } else {
    modules.peer.randomRequest('chainRequest', req, cb)
  }
}

module.exports = Transport
