const _ = require('lodash')
const LRU = require('lru-cache')
const Router = require('../utils/router.js')
const slots = require('../utils/slots.js')
const sandboxHelper = require('../utils/sandbox.js')
const constants = require('../utils/constants.js')
const promisify = require('util').promisify

const MAX_BLOCKS_JSON_SIZE = 4 * 1024 * 1024 // 4M

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
  priv.attachRESTAPI()
  priv.latestBlocksCache = new LRU(200)
  priv.blockHeaderMidCache = new LRU(1000)

  setImmediate(cb, null, self)
}

priv.attachRESTAPI = () => {
  const router = new Router()

  router.use((req, res, next) => {
    res.set(priv.headers)
    if (req.headers.magic !== library.config.magic) {
      return res.status(500).send({
        success: false,
        error: 'Request is made on the wrong network',
        expected: library.config.magic,
        received: req.headers.magic,
      })
    }
    return next()
  })

  router.post('/transactions', (req, res) => {
    if (modules.transactions.getUnconfirmedTransactionCount() > constants.maxQueuedTransactions) {
      return res.status(500).send({
        success: false,
        error: 'Blockchain is busy',
      })
    }

    const verifyOnly = !!req.body.verifyOnly
    if (modules.loader.syncing() && !verifyOnly) {
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
      modules.transactions.processUnconfirmedTransaction(transaction, verifyOnly, cb)
    }, (err, ret) => {
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

priv.limitBlocksResultSize = (allBlocks, allFailedTransactions, maxSize = MAX_BLOCKS_JSON_SIZE) => {
  const blocks = []
  const failedTransactions = {}

  let resultSize = 0
  while (allBlocks.length > 0) {
    const block = allBlocks.shift()
    const failedOfHeight = allFailedTransactions[block.height]

    const size = JSON.stringify(block).length +
      (failedOfHeight ? JSON.stringify(failedOfHeight).length : 0)

    if (resultSize + size >= maxSize) break

    blocks.push(block)
    if (failedOfHeight) {
      failedTransactions[block.height] = failedOfHeight
    }
    resultSize += size
  }

  return { blocks, failedTransactions }
}

priv.attachP2PAPI = () => {
  const handleRPC = modules.peer.handleRPC

  handleRPC('newBlock', (req, cb) => {
    const { params } = req
    if (!params.id) {
      return cb('Invalid params')
    }
    const newBlock = priv.latestBlocksCache.get(params.id)
    if (!newBlock) {
      return cb(`New block not found: ${params.id}`)
    }
    return cb(null, newBlock)
  })

  handleRPC('commonBlock', (req, cb) => {
    const { params } = req
    if (!Number.isInteger(params.max)) return cb('Field max must be integer')
    if (!Number.isInteger(params.min)) return cb('Field min must be integer')
    const max = params.max
    const min = params.min
    const ids = params.ids
    return (async () => {
      try {
        let blocks = await app.sdb.getBlocksByHeightRange(min, max)
        // app.logger.trace('find common blocks in database', blocks)
        if (!blocks || !blocks.length) {
          return cb('Blocks not found')
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
          return cb('Common block not found')
        }
        return cb(null, { common: commonBlock })
      } catch (e) {
        app.logger.error(`Failed to find common block: ${e}`)
        return cb('Failed to find common block')
      }
    })()
  })

  handleRPC('blocks', (req, cb) => {
    const { params } = req
    let blocksLimit = 200
    if (params.limit) {
      blocksLimit = Math.min(blocksLimit, Number(params.limit))
    }
    const lastBlockId = params.lastBlockId
    if (!lastBlockId) {
      return cb('Invalid params')
    }
    return (async () => {
      try {
        const lastBlock = await app.sdb.getBlockById(lastBlockId)
        if (!lastBlock) throw new Error(`Last block not found: ${lastBlockId}`)

        const minHeight = lastBlock.height + 1
        const maxHeight = (minHeight + blocksLimit) - 1
        const blocks = await modules.blocks.getBlocks(minHeight, maxHeight, true)
        const failedTransactions = modules.blocks.getCachedFailedTransactions(minHeight, maxHeight)
        const blocksResult = priv.limitBlocksResultSize(blocks, failedTransactions)
        return cb(null, blocksResult)
      } catch (e) {
        app.logger.error('Failed to get blocks or transactions', e)
        return cb(null, { blocks: [], failedTransactions: {} })
      }
    })()
  })

  handleRPC('getUnconfirmedTransaction', (req, cb) => {
    if (!req.params || !req.params.id) {
      return cb('Invalid transaction id')
    }

    const id = req.params.id
    const transaction = modules.transactions.getUnconfirmedTransaction(id)
    const info = (transaction) ?
      `response transaction, id = ${id}` :
      `transaction not found, id = ${id}`

    library.logger.debug(info)
    return cb(null, { transaction })
  })

  handleRPC('votes', (req, cb) => {
    library.bus.message('receiveVotes', req.params.votes)
    return cb(null, {})
  })

  handleRPC('getUnconfirmedTransactions', (req, cb) => {
    const { ids = [] } = req.params
    const idSet = new Set()
    ids.forEach((id) => {
      if (!idSet.has(id)) idSet.add(id)
    })

    const transactions = modules.transactions.getUnconfirmedTransactionList()
      .filter(t => !idSet.has(t.id))
    return cb(null, { transactions })
  })

  handleRPC('getHeight', (req, cb) => cb(null, {
    height: modules.blocks.getLastBlock().height,
  }))
}

Transport.prototype.broadcast = (topic, data) => {
  library.logger.debug(`broadcast topic '${topic}'`, data)
  modules.peer.publish(topic, data)
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
  priv.attachP2PAPI()

  modules.peer.subscribe('newBlockHeader', (data, peerId, callbackForward) => {
    if (modules.loader.syncing()) {
      return
    }
    const lastBlock = modules.blocks.getLastBlock()
    if (!lastBlock) {
      library.logger.error('Last block not exists')
      return
    }

    if (!data || !data.id || !data.height || !data.prevBlockId) {
      library.logger.error('Invalid message data')
      return
    }

    const { id, height, prevBlockId } = data
    if (height === lastBlock.height && id === lastBlock.id) {
      library.logger.debug('Receive processed block', { height, id, prevBlockId })
      return
    }

    if (height < lastBlock.height) {
      const cachedBlock = priv.latestBlocksCache.get(id)
      if (cachedBlock && cachedBlock.block && cachedBlock.block.height === height) {
        library.logger.debug('Receive processed block', { height, id, prevBlockId })
        return
      }
    }

    if (height !== lastBlock.height + 1 || prevBlockId !== lastBlock.id) {
      library.logger.warn('New block donnot match with last block', data)
      if (height > lastBlock.height + 5) {
        library.logger.warn('Receive new block header from long fork')
      } else {
        modules.loader.syncBlocksFromPeer(peerId)
      }
      return
    }

    library.logger.info('Receive new block header', data)
    modules.peer.request('newBlock', { id }, peerId, (err, result) => {
      if (err) {
        library.logger.error('Failed to get latest block data', err)
        return
      }
      if (!result || !result.block || !result.votes) {
        library.logger.error('Invalid block data', result)
        return
      }
      library.logger.debug('Got new block', result)
      try {
        let block = result.block
        let votes = library.protobuf.decodeBlockVotes(Buffer.from(result.votes, 'base64'))
        block = library.base.block.objectNormalize(block)
        votes = library.base.consensus.normalizeVotes(votes)
        priv.latestBlocksCache.set(block.id, result)
        priv.blockHeaderMidCache.set(block.id, data)
        modules.blocks.onReceiveNewBlock(block, votes, result.failedTransactions, callbackForward)
      } catch (e) {
        library.logger.error(`normalize block or votes object error: ${e.toString()}`, result)
      }
    })
  })

  modules.peer.subscribe('propose', (data, peerId, callbackForward) => {
    try {
      const buffer = Buffer.from(data.propose, 'base64')
      const propose = library.protobuf.decodeBlockPropose(buffer)
      library.bus.message('receivePropose', propose)
      // forward propose message
      callbackForward(null, true)
    } catch (e) {
      library.logger.error('Receive invalid propose', e)
    }
  })

  modules.peer.subscribe('votes', (data, peerId, callbackForward) => {
    library.bus.message('receiveVotes', data.votes)
    // forward votes message
    return callbackForward(null, true)
  })

  modules.peer.subscribe('transaction', (data, peerId, callbackForward) => {
    const lastBlock = modules.blocks.getLastBlock()
    const lastSlot = slots.getSlotNumber(lastBlock.timestamp)
    if (slots.getNextSlot() - lastSlot >= 12) {
      library.logger.error('Blockchain is not ready', { getNextSlot: slots.getNextSlot(), lastSlot, lastBlockHeight: lastBlock.height })
      return
    }

    (async () => {
      const id = data.id
      library.logger.debug(`receive transaction ${id}`)

      let trans
      try {
        const exists = await modules.transactions.existsTransaction(id)
        if (exists) {
          library.logger.debug(`receive processed transaction ${id}`)
          return
        }

        library.logger.debug(`try to get transaction from remote peer ${peerId}`)
        const request = promisify(modules.peer.request)
        const getResult = await request('getUnconfirmedTransaction', { id }, peerId)

        if (!getResult || getResult.error) {
          library.logger.info(`fail to get transaction ${id} from peer ${peerId},`, getResult.error)
          return
        }

        trans = getResult.transaction
        if (!trans) {
          // transaction maybe in new block
          library.logger.debug(`transaction ${id} not found`)
          return
        }
      } catch (err) {
        library.logger.info(`fail to get transaction ${id} from peer ${peerId}`, err)
        return
      }

      const transaction = library.base.transaction.objectNormalize(trans)
      library.sequence.add((cb) => {
        // The 2rd argument is true to indicate 'verify only'
        modules.transactions.processUnconfirmedTransaction(transaction, true, (err, ret) => {
          cb(err, ret)
          // forward transaction message if process OK
          callbackForward(err, !err)
        })
      }, (err) => {
        if (!err) return

        // New blocks may be generated after queuing
        if (/Transaction already/.test(err)) {
          library.logger.debug(`Receive processed transaction ${transaction.id}`)
        } else {
          library.logger.warn(`Receive invalid transaction ${transaction.id}`, err)
        }
      })
    })()
  })
}

Transport.prototype.onUnconfirmedTransaction = (transaction) => {
  const data = {
    id: transaction.id,
  }
  self.broadcast('transaction', data)
}

Transport.prototype.onNewBlock = (block, votes, failedTransactions, broadcast = false) => {
  priv.latestBlocksCache.set(
    block.id,
    {
      block,
      votes: library.protobuf.encodeBlockVotes(votes).toString('base64'),
      failedTransactions,
    },
  )

  if (!broadcast) return

  const data = priv.blockHeaderMidCache.get(block.id) || {
    id: block.id,
    height: block.height,
    prevBlockId: block.prevBlockId,
  }
  self.broadcast('newBlockHeader', data)
}

Transport.prototype.onNewPropose = (propose) => {
  const data = {
    propose: library.protobuf.encodeBlockPropose(propose).toString('base64'),
  }
  self.broadcast('propose', data)
}

Transport.prototype.sendVotes = (votes, peerId) => {
  const data = { votes, peerId }
  if (!modules.peer.isConnected(peerId)) {
    self.broadcast('votes', data)
    return
  }

  modules.peer.request('votes', data, peerId, (err) => {
    if (err) {
      self.broadcast('votes', data)
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
  // TODO: check it !!!
  if (req.params.peer) {
    modules.peer.request('chainRequest', req, req.params.peer, (err, res) => {
      if (res) {
        res.peer = req.peer.peer
      }
      cb(err, res)
    })
  } else {
    modules.peer.randomRequest('chainRequest', req, cb)
  }
}

module.exports = Transport
