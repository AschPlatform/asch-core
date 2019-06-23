const Router = require('../utils/router.js')
const sandboxHelper = require('../utils/sandbox.js')
const slots = require('../utils/slots.js')
require('colors')


let modules
let library
let self
const priv = {}
const shared = {}

priv.loaded = false
priv.syncing = false
priv.loadingLastBlock = null
priv.genesisBlock = null
priv.total = 0
priv.blocksToSync = 0
priv.syncIntervalId = null
priv.lastCheckUnconfirmedAt = 0

function Loader(cb, scope) {
  library = scope
  priv.genesisBlock = library.genesisblock
  priv.loadingLastBlock = library.genesisblock
  self = this
  priv.attachApi()

  setImmediate(cb, null, self)
}

priv.attachApi = () => {
  const router = new Router()

  router.map(shared, {
    'get /status': 'status',
    'get /status/sync': 'sync',
  })

  library.network.app.use('/api/loader', router)
  library.network.app.use((err, req, res, next) => {
    if (!err) return next()
    library.logger.error(req.url, err.toString())
    return res.status(500).send({ success: false, error: err.toString() })
  })
}

priv.syncTrigger = (turnOn) => {
  if (turnOn === false && priv.syncIntervalId) {
    clearTimeout(priv.syncIntervalId)
    priv.syncIntervalId = null
  }
  if (turnOn === true && !priv.syncIntervalId) {
    setImmediate(function nextSyncTrigger() {
      library.network.io.sockets.emit('loader/sync', {
        blocks: priv.blocksToSync,
        height: modules.blocks.getLastBlock().height,
      })
      priv.syncIntervalId = setTimeout(nextSyncTrigger, 1000)
    })
  }
}

priv.loadFullDb = (peerId, cb) => {
  const commonBlockId = priv.genesisBlock.block.id

  library.logger.debug(`Loading blocks from genesis from ${peerId}`)

  modules.blocks.loadBlocksFromPeer(peerId, commonBlockId, cb)
}

priv.findUpdate = (lastBlock, peerId, cb) => {
  library.logger.info(`Looking for common block with ${[peerId]}`)

  modules.blocks.getCommonBlock(peerId, lastBlock.height, (err, commonBlock) => {
    if (err || !commonBlock) {
      library.logger.error('Failed to get common block:', err)
      return cb()
    }

    library.logger.info(`Found common block ${commonBlock.id} (at ${commonBlock.height})
      with peer ${peerId}, last block height is ${lastBlock.height}`)
    const toRemove = lastBlock.height - commonBlock.height

    if (toRemove >= 5) {
      library.logger.error(`long fork with peer ${peerId}`)
      return cb()
    }

    return (async () => {
      try {
        if (toRemove > 0) {
          modules.transactions.clearUnconfirmed()
          modules.transactions.clearFailedTrsCache()

          await app.sdb.rollbackBlock(commonBlock.height)
          const maxHeight = commonBlock.height + toRemove
          modules.blocks.evitCachedFailedTransactions(commonBlock.height + 1, maxHeight)
          modules.blocks.setLastBlock(app.sdb.lastBlock)

          library.logger.debug('set new last block', app.sdb.lastBlock)
        } else {
          await app.sdb.rollbackBlock()
        }
      } catch (e) {
        library.logger.error('Failed to rollback block', e)
        return cb()
      }
      library.logger.debug(`Loading blocks from peer ${peerId}`)
      return modules.blocks.loadBlocksFromPeer(peerId, commonBlock.id, (err2) => {
        if (err) {
          library.logger.error(`Failed to load blocks, ban 60 min: ${peerId}`, err2)
        }
        cb()
      })
    })()
  })
}

priv.loadBlocks = (lastBlock, cb) => {
  modules.peer.randomRequest('getHeight', {}, (err, ret, peerId) => {
    if (err) {
      library.logger.warn('Failed to request from random peer,', err)
      return cb()
    }

    library.logger.info(`Check blockchain on ${peerId}`)

    ret.height = Number.parseInt(ret.height, 10)

    const report = library.scheme.validate(ret, {
      type: 'object',
      properties: {
        height: {
          type: 'integer',
          minimum: 0,
        },
      },
      required: ['height'],
    })

    if (!report) {
      library.logger.info(`Failed to parse blockchain height: ${peerId}\n${library.scheme.getLastError()}`)
      return cb()
    }

    if (app.util.bignumber(lastBlock.height).lt(ret.height)) {
      priv.blocksToSync = ret.height

      if (lastBlock.id !== priv.genesisBlock.block.id) {
        return priv.findUpdate(lastBlock, peerId, cb)
      }
      return priv.loadFullDb(peerId, cb)
    }
    return cb()
  })
}

priv.loadUnconfirmedTransactions = (cb) => {
  modules.peer.randomRequest('getUnconfirmedTransactions', { }, (err, ret, peerId) => {
    if (err) {
      return cb(err)
    }

    const report = library.scheme.validate(ret, {
      type: 'object',
      properties: {
        transactions: {
          type: 'array',
          uniqueItems: true,
        },
      },
      required: ['transactions'],
    })

    if (!report) {
      return cb(err)
    }

    const transactions = ret.transactions
    for (let i = 0; i < transactions.length; i++) {
      try {
        transactions[i] = library.base.transaction.objectNormalize(transactions[i])
      } catch (e) {
        library.logger.info(`Transaction ${transactions[i] ? transactions[i].id : 'null'} is invalid, ban 60 min`, peerId)
        // TODO: ban peer...
        return cb(e)
      }
    }

    library.logger.info(`Loading ${transactions.length} unconfirmed transactions from peer ${peerId}`)
    const asyncProcessTransactions = (async () => {
      const transArray = []
      try {
        for (const trans of transactions) {
          const exists = await modules.transactions.existsTransaction(trans.id)
          if (!exists) transArray.push(trans)
        }
      } catch (e) {
        return cb(e)
      }

      return library.sequence.add((done) => {
        modules.transactions.processUnconfirmedTransactions(transArray, true/* verify only */, done)
      }, cb)
    })
    return asyncProcessTransactions()
  })
}

// Public methods
Loader.prototype.syncing = () => priv.syncing

Loader.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

Loader.prototype.startSyncBlocks = () => {
  library.logger.debug('startSyncBlocks enter')
  if (!priv.loaded || self.syncing()) {
    library.logger.debug('blockchain is already syncing')
    return
  }
  library.sequence.add((cb) => {
    library.logger.debug('startSyncBlocks enter sequence')

    if (!self.needSync()) {
      library.logger.debug('no need to synchronize blocks now')
      return cb()
    }

    priv.syncing = true
    const lastBlock = modules.blocks.getLastBlock()
    return priv.loadBlocks(lastBlock, (err) => {
      if (err) {
        library.logger.error('loadBlocks error:', err)
      }
      priv.syncing = false
      priv.blocksToSync = 0
      library.logger.debug('startSyncBlocks end')
      cb()
    })
  })
}

Loader.prototype.syncBlocksFromPeer = (peerId) => {
  library.logger.debug('syncBlocksFromPeer enter')
  if (!priv.loaded || self.syncing()) {
    library.logger.debug('blockchain is already syncing')
    return
  }
  library.sequence.add((cb) => {
    library.logger.debug('syncBlocksFromPeer enter sequence')
    if (!self.needSync()) {
      library.logger.debug('no need to synchronize blocks now')
      return cb()
    }

    priv.syncing = true
    const lastBlock = modules.blocks.getLastBlock()
    // modules.transactions.clearUnconfirmed()
    return app.sdb.rollbackBlock().then(() => {
      modules.blocks.loadBlocksFromPeer(peerId, lastBlock.id, (err) => {
        if (err) {
          library.logger.error('syncBlocksFromPeer error:', err)
        }
        priv.syncing = false
        library.logger.debug('syncBlocksFromPeer end')
        cb()
      })
    })
  })
}

Loader.prototype.needSync = () => {
  const lastBlock = modules.blocks.getLastBlock()
  const lastSlot = slots.getSlotNumber(lastBlock.timestamp)
  return slots.getNextSlot() - lastSlot >= 3
}

// Events
Loader.prototype.onPeerReady = () => {
  setImmediate(function nextSync() {
    if (self.needSync()) {
      self.startSyncBlocks()
    }
    setTimeout(nextSync, slots.interval * 1000)
  })

  setTimeout(function syncTrans() {
    priv.loadUnconfirmedTransactions((err) => {
      if (err) {
        library.logger.warn('fail to load unconfirmed transactions,', err)
        setTimeout(syncTrans, slots.interval * 1000)
      }
    })
  }, 3000)
}

Loader.prototype.onBind = (scope) => {
  modules = scope
}

Loader.prototype.onBlockchainReady = () => {
  priv.loaded = true
}

Loader.prototype.cleanup = (cb) => {
  priv.loaded = false
  cb()
  // if (!priv.isActive) {
  //   cb();
  // } else {
  //   setImmediate(function nextWatch() {
  //     if (priv.isActive) {
  //       setTimeout(nextWatch, 1 * 1000)
  //     } else {
  //       cb();
  //     }
  //   });
  // }
}

// Shared
shared.status = (req, cb) => {
  cb(null, {
    loaded: priv.loaded,
    now: priv.loadingLastBlock.height,
    blocksCount: priv.total,
  })
}

shared.sync = (req, cb) => {
  cb(null, {
    syncing: self.syncing(),
    blocks: priv.blocksToSync,
    height: modules.blocks.getLastBlock().height,
  })
}

// Export
module.exports = Loader
