const assert = require('assert')
const crypto = require('crypto')
const async = require('async')
const PIFY = require('util').promisify
const isArray = require('util').isArray
const constants = require('../utils/constants.js')
const BlockStatus = require('../utils/block-status.js')
const FIFOCache = require('../utils/fifo-cache.js')
const Router = require('../utils/router.js')
const slots = require('../utils/slots.js')
const sandboxHelper = require('../utils/sandbox.js')
const addressHelper = require('../utils/address.js')
const featureSwitch = require('../utils/feature-switch.js')
const benefits = require('../utils/benefits.js')

const REGISTER_CONTRACT_TYPE = 600

let genesisblock = null
let modules
let library
let self
const priv = {}
const shared = {}

priv.lastBlock = {}
priv.blockStatus = new BlockStatus()
priv.loaded = false
priv.isActive = false
priv.blockCache = {}
priv.proposeCache = {}
priv.failedTransactionsCache = new FIFOCache()
priv.lastPropose = null
priv.isCollectingVotes = false
priv.isApplyingBlock = false

// Constructor
function Blocks(cb, scope) {
  library = scope
  genesisblock = library.genesisblock
  self = this
  priv.attachApi()
  setImmediate(cb, null, self)
}

// priv methods
priv.attachApi = () => {
  const router = new Router()

  router.use((req, res, next) => {
    if (modules) return next()
    return res.status(500).send({ success: false, error: 'Blockchain is loading' })
  })

  router.map(shared, {
    'get /get': 'getBlock',
    'get /full': 'getFullBlock',
    'get /': 'getBlocks',
    'get /getHeight': 'getHeight',
    'get /getMilestone': 'getMilestone',
    'get /getReward': 'getReward',
    'get /getSupply': 'getSupply',
    'get /getStatus': 'getStatus',
  })

  router.use((req, res) => {
    res.status(500).send({ success: false, error: 'API endpoint not found' })
  })

  library.network.app.use('/api/blocks', router)
  library.network.app.use((err, req, res, next) => {
    if (!err) return next()
    library.logger.error(req.url, err.toString())
    return res.status(500).send({ success: false, error: err.toString() })
  })
}

priv.getIdSequence2 = (height, cb) => {
  (async () => {
    try {
      const maxHeight = Math.max(height, priv.lastBlock.height)
      const minHeight = Math.max(0, maxHeight - 4)
      let blocks = await app.sdb.getBlocksByHeightRange(minHeight, maxHeight)
      blocks = blocks.reverse()
      const ids = blocks.map(b => b.id)
      return cb(null, { ids, firstHeight: minHeight })
    } catch (e) {
      return cb(e)
    }
  })()
}

Blocks.prototype.toAPIV1Blocks = (blocks) => {
  if (blocks && isArray(blocks) && blocks.length > 0) {
    return blocks.map(b => self.toAPIV1Block(b))
  }
  return []
}

Blocks.prototype.toAPIV1Block = (block) => {
  if (!block) return undefined
  const result = {
    id: block.id,
    version: block.version,
    timestamp: block.timestamp,
    height: Number(block.height),
    payloadHash: block.payloadHash,
    previousBlock: block.prevBlockId,
    numberOfTransactions: block.count,
    totalFee: block.fees,
    generatorPublicKey: block.delegate,
    blockSignature: block.signature,
    confirmations: self.getLastBlock().height - block.height,
    // "generatorId":  => missing
    // "totalAmount" => missing
    // "reward" => missing
    // "payloadLength" => missing
    // "totalForged" => missing
  }
  if (block.transactions) {
    result.transactions = modules.transactions.toAPIV1Transactions(block.transactions, block)
  }
  return result
}

Blocks.prototype.getCommonBlock = (peerId, height, cb) => {
  const lastBlockHeight = height

  priv.getIdSequence2(lastBlockHeight, (err, data) => {
    if (err) {
      return cb(`Failed to get last block id sequence${err}`)
    }
    library.logger.trace('getIdSequence=========', data)
    const params = {
      max: lastBlockHeight,
      min: data.firstHeight,
      ids: data.ids,
    }
    return modules.peer.request('commonBlock', params, peerId, (err2, ret) => {
      if (err2 || ret.error) {
        return cb(err2 || ret.error.toString())
      }

      if (!ret.common) {
        return cb('Common block not found')
      }
      return cb(null, ret.common)
    })
  })
}

Blocks.prototype.getBlock = (filter, cb) => {
  shared.getBlock({ body: filter }, cb)
}

Blocks.prototype.setLastBlock = (block) => {
  priv.lastBlock = block
  if (global.Config.netVersion === 'mainnet') {
    if (priv.lastBlock.height >= 1700000) {
      featureSwitch.enable('enableLongId')
    }
    if (priv.lastBlock.height >= 2920000) {
      featureSwitch.enable('enable1_3_0')
    }
    if (priv.lastBlock.height >= 3320000) {
      featureSwitch.enable('enableClubBonus')
    }
    if (featureSwitch.isEnabled('enableClubBonus')) {
      featureSwitch.enable('enableMoreLockTypes')
    }
    if (priv.lastBlock.height >= 4290000) {
      featureSwitch.enable('enableLockReset')
    }
    // TODO: check height to enable feature
    if (priv.lastBlock.height >= 8474506) {
      featureSwitch.enable('enableUpdateProduceRatio')
    }
    if (priv.lastBlock.height >= 8474506) {
      featureSwitch.enable('enableBlock_v1')
    }
  } else {
    featureSwitch.enable('enableLongId')
    featureSwitch.enable('enable1_3_0')
    if (global.state.clubInfo) {
      featureSwitch.enable('enableClubBonus')
    } else {
      featureSwitch.disable('enableClubBonus')
    }

    featureSwitch.enable('enableMoreLockTypes')
    featureSwitch.enable('enableLockReset')
    featureSwitch.enable('enableUpdateProduceRatio')
    featureSwitch.enable('enableBlock_v1')
  }
  featureSwitch.enable('fixVoteNewAddressIssue')
  if (global.Config.netVersion === 'mainnet' && priv.lastBlock.height < 1854000) {
    featureSwitch.disable('fixVoteNewAddressIssue')
  }
  featureSwitch.copyFeature('enableLongId', 'enableUIA')
}

Blocks.prototype.getLastBlock = () => priv.lastBlock

Blocks.prototype.verifyBlock = async (block, options) => {
  try {
    block.id = library.base.block.getId(block)
  } catch (e) {
    throw new Error(`Failed to get block id: ${e.toString()}`)
  }

  library.logger.debug(`verifyBlock, id: ${block.id}, h: ${block.height}`)

  if (!block.prevBlockId && block.height !== 0) {
    throw new Error('Previous block should not be null')
  }

  try {
    if (!library.base.block.verifySignature(block)) {
      throw new Error('Failed to verify block signature')
    }
  } catch (e) {
    library.logger.error({ e, block })
    throw new Error(`Got exception while verify block signature: ${e.toString()}`)
  }

  if (block.prevBlockId !== priv.lastBlock.id) {
    throw new Error('Incorrect previous block hash')
  }

  if (block.height !== 0) {
    const blockSlotNumber = slots.getSlotNumber(block.timestamp)
    const lastBlockSlotNumber = slots.getSlotNumber(priv.lastBlock.timestamp)

    if (blockSlotNumber > slots.getSlotNumber() + 1 || blockSlotNumber <= lastBlockSlotNumber) {
      throw new Error(`Can't verify block timestamp: ${block.id}`)
    }
  }

  if (block.transactions.length > constants.maxTxsPerBlock) {
    throw new Error(`Invalid amount of block assets: ${block.id}`)
  }
  if (block.transactions.length !== block.count) {
    throw new Error('Invalid transaction count')
  }

  const payloadHash = crypto.createHash('sha256')
  const appliedTransactions = {}

  let totalFee = 0
  for (const transaction of block.transactions) {
    totalFee += transaction.fee

    let bytes
    try {
      bytes = library.base.transaction.getBytes(transaction)
    } catch (e) {
      throw new Error(`Failed to get transaction bytes: ${e.toString()}`)
    }

    if (appliedTransactions[transaction.id]) {
      throw new Error(`Duplicate transaction id in block ${block.id}`)
    }

    appliedTransactions[transaction.id] = transaction
    payloadHash.update(bytes)
  }

  if (totalFee !== block.fees) {
    throw new Error('Invalid total fees')
  }

  const expectedReward = priv.blockStatus.calcReward(block.height)
  if (expectedReward !== block.reward) {
    throw new Error('Invalid block reward')
  }

  // HARDCODE_HOT_FIX_BLOCK_6119128
  if (block.height > 6119128) {
    if (payloadHash.digest().toString('hex') !== block.payloadHash) {
      throw new Error(`Invalid payload hash: ${block.id}`)
    }
  }

  if (options.votes) {
    const votes = options.votes
    if (block.height !== votes.height) {
      throw new Error('Votes height is not correct')
    }
    if (block.id !== votes.id) {
      throw new Error('Votes id is not correct')
    }
    if (!votes.signatures || !library.base.consensus.hasEnoughVotesRemote(votes)) {
      throw new Error('Votes signature is not correct')
    }
    await self.verifyBlockVotes(block, votes)
  }
}

Blocks.prototype.verifyBlockVotes = async (block, votes) => {
  const delegateList = await PIFY(modules.delegates.generateDelegateList)(block.height)
  const publicKeySet = new Set(delegateList)
  for (const item of votes.signatures) {
    if (!publicKeySet.has(item.key.toString('hex'))) {
      throw new Error(`Votes key is not in the top list: ${item.key}`)
    }
    if (!library.base.consensus.verifyVote(votes.height, votes.id, item)) {
      throw new Error('Failed to verify vote signature')
    }
  }
}

Blocks.prototype.applyBlock = async (block) => {
  app.logger.trace('enter applyblock')
  const appliedTransactions = {}
  let contractStateChanged = false
  const hash = crypto.createHash('sha256')
  let error
  library.bus.message('preApplyBlock', block)
  priv.isApplyingBlock = true
  try {
    for (const tx of block.transactions) {
      if (appliedTransactions[tx.id]) {
        throw new Error(`Duplicate transaction in block: ${tx.id}`)
      }
      const applyResult = await modules.transactions.applyUnconfirmedTransactionAsync(tx, block)
      if (self.withContractStateChanges(tx, applyResult)) {
        contractStateChanged = true
        hash.update(applyResult.stateChangesHash, 'hex')
      }
      appliedTransactions[tx.id] = tx
    }

    const contractStateHash = contractStateChanged ? hash.digest().toString('hex') : ''
    // block.stateChangesHash is undefined in history blocks
    if (contractStateHash !== (block.contractStateHash || '')) {
      throw new Error(`Invalid contract state hash, expect '${block.contractStateHash}' but '${contractStateHash}'`)
    }
  } catch (e) {
    app.logger.error(e)
    await app.sdb.rollbackBlock()
    error = e
    throw new Error(`Failed to apply block: ${e}`)
  } finally {
    priv.isApplyingBlock = false
    library.bus.message('postApplyBlock', error, block)
  }
}

Blocks.prototype.isApplyingBlock = () => priv.isApplyingBlock

Blocks.prototype.commitGeneratedBlock = async (block, failedTransactions, votes) => {
  try {
    await app.sdb.commitBlock()
    const trsCount = block.transactions.length

    self.setLastBlock(block)
    const size = modules.transactions.removeUnconfirmedTransactions([
      ...(failedTransactions || []),
      ...block.transactions.map(t => t.id),
    ])

    app.logger.info(`Commit generated block correctly with ${trsCount} transactions, ${size} in pool`)

    votes.signatures = votes.signatures.slice(0, 6)
    library.bus.message('newBlock', block, votes, failedTransactions, true /* broadcast */)
    library.bus.message('processBlock', block)

    priv.blockCache = {}
    priv.proposeCache = {}
    priv.lastVoteTime = null
    priv.isCollectingVotes = false
    library.base.consensus.clearState()
  } catch (e) {
    await app.sdb.rollbackBlock()
    app.logger.error(block)
    app.logger.error('failed to commit block', e)
  }
}

Blocks.prototype.processBlock = async (b, failedTransactions, options) => {
  if (!priv.loaded) throw new Error('Blockchain is loading')

  let block = b
  await app.sdb.beginBlock(block)

  if (!block.transactions) block.transactions = []

  try {
    block = library.base.block.objectNormalize(block)
  } catch (e) {
    library.logger.error(`Failed to normalize block: ${e}`, block)
    throw e
  }

  await self.verifyBlock(block, options)

  library.logger.debug('verify block ok')
  if (block.height !== 0) {
    const dbBlock = await app.sdb.getBlockById(block.id)
    if (dbBlock) throw new Error(`Block already exists: ${block.id}`)
  }

  if (block.height !== 0) {
    try {
      await PIFY(modules.delegates.validateBlockSlot)(block)
    } catch (e) {
      library.logger.error(e)
      throw new Error(`Can't verify slot: ${e}`)
    }
    library.logger.debug('verify block slot ok')
  }

  // TODO use bloomfilter
  for (const transaction of block.transactions) {
    library.base.transaction.objectNormalize(transaction)
  }
  const idList = block.transactions.map(t => t.id)
  if (await app.sdb.exists('Transaction', { id: { $in: idList } })) {
    throw new Error('Block contain already confirmed transaction')
  }

  app.logger.trace('before applyBlock')
  try {
    await self.applyBlock(block, options)
  } catch (e) {
    app.logger.error(`Failed to apply block: ${e}`)
    throw e
  }

  try {
    self.saveBlockTransactions(block)
    await self.applyRound(block)
    if (failedTransactions && failedTransactions.length > 0) {
      self.cacheFailedTransactions(block.height, failedTransactions)
    }
  } catch (e) {
    app.logger.error(block, failedTransactions)
    app.logger.error('save block transactions error: ', e)
    await app.sdb.rollbackBlock()
    self.evitCachedFailedTransactions(block.height)
    throw new Error(`Failed to save block transactions: ${e}`)
  }

  if (block.version > 0) {
    const stateHash = app.sdb.getChangesHash()
    if (stateHash !== block.stateHash) {
      await app.sdb.rollbackBlock()
      self.evitCachedFailedTransactions(block.height)
      throw new Error(`Invalid transaction state hash, expected '${block.stateHash}' but was '${stateHash}'`)
    }
  }

  try {
    await app.sdb.commitBlock()
    const trsCount = block.transactions.length

    self.setLastBlock(block)
    const size = modules.transactions.removeUnconfirmedTransactions([
      ...(failedTransactions || []),
      ...block.transactions.map(t => t.id),
    ])

    app.logger.info(`Block applied correctly with ${trsCount} transactions, ${size} in pool`)

    options.votes.signatures = options.votes.signatures.slice(0, 6)
    library.bus.message('newBlock', block, options.votes, failedTransactions)
    library.bus.message('processBlock', block)

    priv.blockCache = {}
    priv.proposeCache = {}
    priv.lastVoteTime = null
    priv.isCollectingVotes = false
    library.base.consensus.clearState()
  } catch (e) {
    app.logger.error(block)
    app.logger.error('failed to commit block', e)
  }
}

Blocks.prototype.cacheFailedTransactions = (height, failedTransactions) => {
  library.logger.debug(`cache failed transactions of height ${height}`, failedTransactions)

  priv.failedTransactionsCache.put(height, failedTransactions)
}

Blocks.prototype.getCachedFailedTransactions = (minHeight, maxHeight) => {
  const result = {}
  for (let height = minHeight; height <= maxHeight; height++) {
    const failedItems = priv.failedTransactionsCache.get(height)
    if (failedItems) {
      result[height] = failedItems
    }
  }
  return result
}

Blocks.prototype.evitCachedFailedTransactions = (minHeight, maxHeight) => {
  library.logger.debug('evit cached failed transactions ', minHeight, maxHeight)

  let height = (maxHeight === undefined) ? minHeight : maxHeight
  while (height >= minHeight) {
    priv.failedTransactionsCache.evit(height--)
  }
}

Blocks.prototype.saveBlockTransactions = (block) => {
  app.logger.trace('Blocks#saveBlockTransactions height', block.height)
  for (const trs of block.transactions) {
    trs.height = block.height
    app.sdb.create('Transaction', trs)
  }
  app.logger.trace('Blocks#save transactions')
}

// Blocks.prototype.processFee = function (block) {
//   if (!block || !block.transactions) return
//   for (let t of block.transactions) {
//     let feeInfo = app.getFee(t.type) || app.defaultFee
//     app.feePool.add(feeInfo.currency, t.fee)
//   }
// }

Blocks.prototype.increaseRoundData = (modifier, roundNumber) => {
  app.sdb.createOrLoad('Round', { fees: 0, rewards: 0, round: roundNumber })
  return app.sdb.increase('Round', modifier, { round: roundNumber })
}

Blocks.prototype.applyRound = async (block) => {
  if (block.height === 0) {
    modules.delegates.updateBookkeeper()
    return
  }

  let address = addressHelper.generateNormalAddress(block.delegate)
  app.sdb.increase('Delegate', { producedBlocks: 1 }, { address })

  let blockFees = 0
  // const records = await app.sdb.load('Netenergyconsumption', { height: block.height })
  for (const t of block.transactions) {
    const record = await app.sdb.load('Netenergyconsumption', { tid: t.id })
    if (!record) {
      blockFees += t.fee
    } else if (record.isFeeDeduct === 1) {
      blockFees += record.fee
    } else {
      assert(record.netUsed || record.energyUsed, 'net or energy must be consumed instead of fee')
    }
  }

  const roundNumber = modules.round.calc(block.height)
  const modifier = { fees: blockFees, rewards: block.reward }
  const { fees, rewards } = self.increaseRoundData(modifier, roundNumber)

  if (block.height % slots.delegates !== 0) return

  app.logger.debug(`----------------------on round ${roundNumber} end-----------------------`)

  const delegates = await PIFY(modules.delegates.generateDelegateList)(block.height)
  app.logger.debug('delegate length', delegates.length)

  const forgedBlocks = await app.sdb.getBlocksByHeightRange(
    block.height - slots.delegates + 1,
    block.height - 1,
  )
  const forgedDelegates = [...forgedBlocks.map(b => b.delegate), block.delegate]

  // const missedDelegates = forgedDelegates.filter(fd => !delegates.includes(fd))
  let missedDelegates
  if (featureSwitch.isEnabled('enableUpdateProduceRatio')) {
    missedDelegates = delegates.filter(fd => !forgedDelegates.includes(fd))
  } else {
    missedDelegates = forgedDelegates.filter(fd => !delegates.includes(fd))
  }

  missedDelegates.forEach((md) => {
    address = addressHelper.generateNormalAddress(md)
    app.sdb.increase('Delegate', { missedBlocks: 1 }, { address })
  })

  await benefits.assignIncentive(forgedDelegates, fees, rewards)

  if (block.height % slots.delegates === 0) {
    modules.delegates.updateBookkeeper()
  }
}

Blocks.prototype.getBlocks = async (minHeight, maxHeight, withTransaction) => {
  const blocks = await app.sdb.getBlocksByHeightRange(minHeight, maxHeight)

  if (!blocks || !blocks.length) {
    return []
  }

  maxHeight = blocks[blocks.length - 1].height
  if (withTransaction) {
    const transactions = await app.sdb.findAll('Transaction', {
      condition: {
        height: { $gte: minHeight, $lte: maxHeight },
      },
    })
    const firstHeight = blocks[0].height
    for (const t of transactions) {
      const h = t.height
      const b = blocks[h - firstHeight]
      if (b) {
        if (!b.transactions) {
          b.transactions = []
        }
        b.transactions.push(t)
      }
    }
  }

  return blocks
}

Blocks.prototype.loadBlocksFromPeer = (peerId, id, cb) => {
  let loaded = false
  let count = 0
  let lastValidBlock = null
  let lastCommonBlockId = id
  async.whilst(
    () => !loaded && count < 30,
    (next) => {
      count++
      const limit = 200
      const params = {
        limit,
        lastBlockId: lastCommonBlockId,
      }
      modules.peer.request('blocks', params, peerId, (err, ret) => {
        if (err) {
          return next(`Failed to request remote peer: ${err}`)
        }
        if (!ret) {
          return next('Invalid response for blocks request')
        }
        const { blocks, failedTransactions = {} } = ret
        if (!isArray(blocks) || blocks.length === 0) {
          loaded = true
          return next()
        }
        const num = isArray(blocks) ? blocks.length : 0
        library.logger.info(`Loading ${num} blocks from ${peerId}`)
        return (async () => {
          try {
            for (const block of blocks) {
              const blockFailedTransactions = failedTransactions[block.height] || []
              await self.processBlock(block, blockFailedTransactions, { syncing: true })
              lastCommonBlockId = block.id
              lastValidBlock = block
              library.logger.info(`Block ${block.id} loaded from ${peerId} at`, block.height)
            }
            return next()
          } catch (e) {
            library.logger.error('Failed to process synced block', e)
            return cb(e)
          }
        })()
      })
    },
    (err) => {
      if (err) {
        library.logger.error('load blocks from remote peer error:', err)
      }
      setImmediate(cb, err, lastValidBlock)
    },
  )
}

Blocks.prototype.packTransactions = async (block) => {
  const transactions = []
  const failedTransactions = []
  const payload = crypto.createHash('sha256')
  const stateChanges = crypto.createHash('sha256')
  const startTime = process.uptime()
  let contractStateChanged = false
  let payloadLength = 0
  let fees = 0
  let registerCount = 0
  for (const trans of modules.transactions.getUnconfirmedTransactionList()) {
    if (trans.type === REGISTER_CONTRACT_TYPE) {
      if (registerCount < constants.maxContractRegisterationPerBlock) {
        registerCount++
      } else {
        continue
      }
    }
    const bytes = library.base.transaction.getBytes(trans)
    // TODO check payload length when process remote block
    if ((payloadLength + bytes.length) > constants.maxPayloadLength) {
      app.logger.info(`finish packing transactions due to payload size exceed ${constants.maxPayloadLength}`)
      break
    }

    try {
      const applyResult = await modules.transactions.applyUnconfirmedTransactionAsync(trans, block)
      if (self.withContractStateChanges(trans, applyResult)) {
        contractStateChanged = true
        stateChanges.update(applyResult.stateChangesHash, 'hex')
      }
      payload.update(bytes)
      payloadLength += bytes.length

      transactions.push(trans)
      fees += trans.fee
    } catch (err) {
      const error = err.message || String(err)
      failedTransactions.push(trans.id)
      app.logger.info(`fail to pack transaction ${trans.id} to block ${block.height},`, error)
      continue
    }

    if (process.uptime() - startTime >= constants.buildBlockTimeoutSeconds) {
      app.logger.info('finish packing transactions due to timeout')
      break
    }
  }

  Object.assign(block, {
    fees,
    transactions,
    count: transactions.length,
    payloadLength,
    payloadHash: payload.digest().toString('hex'),
    contractStateHash: (block.version > 0 && contractStateChanged) ? stateChanges.digest().toString('hex') : '',
  })

  return failedTransactions
}

Blocks.prototype.withContractStateChanges = (trans, applyResult) =>
  constants.smartContractType.includes(trans.type) &&
  applyResult &&
  applyResult.stateChangesHash

Blocks.prototype.predictNextBlock = async () => {
  const lastBlock = self.getLastBlock()
  const height = lastBlock.height + 1
  const nextBlock = priv.nextBlock || {}
  if (height === nextBlock.height) {
    return nextBlock
  }

  const nextSlot = slots.getNextSlot()
  const timestamp = slots.getSlotTime(nextSlot)
  const delegates = await PIFY(modules.delegates.generateDelegateList)(height)
  const delegate = delegates[nextSlot % slots.delegates]

  priv.nextBlock = {
    delegate, height, timestamp, prevBlockId: lastBlock.id,
  }
  return priv.nextBlock
}

Blocks.prototype.buildBlock = async (keypair, timestamp) => {
  const delegate = keypair.publicKey.toString('hex')
  const prevBlockId = priv.lastBlock.id
  const height = priv.lastBlock.height + 1
  const reward = priv.blockStatus.calcReward(height)
  const version = featureSwitch.isEnabled('enableBlock_v1') ? 1 : 0

  const block = {
    version, delegate, height, prevBlockId, timestamp, reward,
  }

  await app.sdb.beginBlock(block)

  // TODO sort transactions
  // block.transactions = library.base.block.sortTransactions(block)
  const failedTransactions = await self.packTransactions(block)
  try {
    self.saveBlockTransactions(block)
    await self.applyRound(block)
  } catch (e) {
    app.logger.error(block, failedTransactions)
    app.logger.error('save block transactions error: ', e)
    await app.sdb.rollbackBlock()
    throw new Error(`Failed to save block transactions: ${e}`)
  }

  block.stateHash = version > 0 ? app.sdb.getChangesHash() : ''
  block.signature = library.base.block.sign(block, keypair)
  block.id = library.base.block.getId(block)

  return { block, failedTransactions }
}

Blocks.prototype.generateBlock = async (keypair, timestamp) => {
  if (library.base.consensus.hasPendingBlock(timestamp)) {
    return null
  }

  await app.sdb.rollbackBlock()
  const { block, failedTransactions } = await self.buildBlock(keypair, timestamp)
  let activeKeypairs
  try {
    activeKeypairs = await PIFY(modules.delegates.getActiveDelegateKeypairs)(block.height)
  } catch (e) {
    throw new Error(`Failed to get active delegate keypairs: ${e}`)
  }

  assert(activeKeypairs && activeKeypairs.length > 0, 'Active keypairs should not be empty')
  library.logger.info(`get active delegate keypairs len: ${activeKeypairs.length}`)
  const localVotes = library.base.consensus.createVotes(activeKeypairs, block)
  if (library.base.consensus.hasEnoughVotes(localVotes)) {
    // modules.transactions.clearUnconfirmed()
    await self.commitGeneratedBlock(block, failedTransactions, localVotes)
    library.logger.info(`Forged new block id: ${block.id}, height: ${block.height}, round: ${modules.round.calc(block.height)}, slot: ${slots.getSlotNumber(block.timestamp)}, reward: ${block.reward}`)
    return null
  }
  let propose
  try {
    const peerId = modules.peer.getPeerId()
    propose = library.base.consensus.createPropose(keypair, block, peerId)
  } catch (e) {
    await app.sdb.rollbackBlock()
    library.logger.error('Failed to create propose', e)
    return null
  }
  library.base.consensus.setPendingBlock(block, failedTransactions)
  library.base.consensus.addPendingVotes(localVotes)
  priv.proposeCache[propose.hash] = true
  priv.isCollectingVotes = true
  library.bus.message('newPropose', propose, true)
  return null
}

Blocks.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

// Events
Blocks.prototype.onReceiveNewBlock = (block, votes, failedTransactions, callback) => {
  if (modules.loader.syncing() || !priv.loaded) {
    return
  }

  if (priv.blockCache[block.id]) {
    return
  }
  priv.blockCache[block.id] = true

  library.sequence.add((cb) => {
    if (block.prevBlockId === priv.lastBlock.id && priv.lastBlock.height + 1 === block.height) {
      library.logger.info(`Received new block id: ${block.id}`
        + ` height: ${block.height}`
        + ` round: ${modules.round.calc(modules.blocks.getLastBlock().height)}`
        + ` slot: ${slots.getSlotNumber(block.timestamp)}`)
      return (async () => {
        try {
          await app.sdb.rollbackBlock()
          await self.processBlock(block, failedTransactions, { votes })
          cb(null, true)
        } catch (e) {
          library.logger.error('Failed to process received block', e)
          cb(e)
        }
      })()
    } if (block.prevBlockId !== priv.lastBlock.id
      && priv.lastBlock.height + 1 === block.height) {
      modules.delegates.fork(block, 1)
      return cb('Fork')
    } if (block.prevBlockId === priv.lastBlock.prevBlockId
      && block.height === priv.lastBlock.height
      && block.id !== priv.lastBlock.id) {
      modules.delegates.fork(block, 5)
      return cb('Fork')
    } if (block.height > priv.lastBlock.height + 1) {
      library.logger.info(`receive discontinuous block height ${block.height}`)
      modules.loader.startSyncBlocks()
      return cb()
    }
    return cb()
  }, callback)
}

Blocks.prototype.onReceivePropose = (propose) => {
  if (modules.loader.syncing() || !priv.loaded) {
    return
  }
  if (priv.proposeCache[propose.hash]) {
    return
  }
  priv.proposeCache[propose.hash] = true

  library.sequence.add((cb) => {
    if (priv.lastPropose && priv.lastPropose.height === propose.height
      && priv.lastPropose.generatorPublicKey === propose.generatorPublicKey
      && priv.lastPropose.id !== propose.id) {
      library.logger.warn(`generate different block with the same height, generator: ${propose.generatorPublicKey}`)
      return setImmediate(cb)
    }
    if (propose.height !== priv.lastBlock.height + 1) {
      library.logger.debug('invalid propose height', propose)
      if (propose.height > priv.lastBlock.height + 1) {
        library.logger.info(`receive discontinuous propose height ${propose.height}`)
        modules.loader.startSyncBlocks()
      }
      return setImmediate(cb)
    }
    if (priv.lastVoteTime && Date.now() - priv.lastVoteTime < 5 * 1000) {
      library.logger.debug('ignore the frequently propose')
      return setImmediate(cb)
    }
    library.logger.info(`receive propose height ${propose.height} bid ${propose.id}`)
    return async.waterfall([
      (next) => {
        modules.delegates.validateProposeSlot(propose, (err) => {
          if (err) {
            next(`Failed to validate propose slot: ${err}`)
          } else {
            next()
          }
        })
      },
      (next) => {
        library.base.consensus.acceptPropose(propose, (err) => {
          if (err) {
            next(`Failed to accept propose: ${err}`)
          } else {
            next()
          }
        })
      },
      (next) => {
        modules.delegates.getActiveDelegateKeypairs(propose.height, (err, activeKeypairs) => {
          if (err) {
            next(`Failed to get active keypairs: ${err}`)
          } else {
            next(null, activeKeypairs)
          }
        })
      },
      (activeKeypairs, next) => {
        if (activeKeypairs && activeKeypairs.length > 0) {
          const votes = library.base.consensus.createVotes(activeKeypairs, propose)
          library.logger.debug(`send votes height ${votes.height} id ${votes.id} sigatures ${votes.signatures.length}`)
          modules.transport.sendVotes(votes, propose.peerId)
          priv.lastVoteTime = Date.now()
          priv.lastPropose = propose
        }
        setImmediate(next)
      },
    ], (err) => {
      if (err) {
        library.logger.error(`onReceivePropose error: ${err}`)
      }
      library.logger.debug('onReceivePropose finished')
      cb()
    })
  })
}

Blocks.prototype.onReceiveVotes = (votes) => {
  if (modules.loader.syncing() || !priv.loaded) {
    return
  }
  library.sequence.add((cb) => {
    const totalVotes = library.base.consensus.addPendingVotes(votes)
    if (totalVotes && totalVotes.signatures) {
      library.logger.debug(`Receive new votes, total votes ${totalVotes.signatures.length}`)
    }
    if (library.base.consensus.hasEnoughVotes(totalVotes)) {
      const { block, failedTransactions } = library.base.consensus.getPendingBlock()
      const height = block.height
      const id = block.id
      return (async () => {
        try {
          // modules.transactions.clearUnconfirmed()
          await self.commitGeneratedBlock(block, failedTransactions, totalVotes)
          library.logger.info(`Forged new block id: ${id}, height: ${height}, round: ${modules.round.calc(height)}, slot: ${slots.getSlotNumber(block.timestamp)}, reward: ${block.reward}`)
        } catch (err) {
          library.logger.error(`Failed to process confirmed block height: ${height} id: ${id} error: ${err}`)
        }
        cb()
      })()
    }
    return setImmediate(cb)
  })
}

Blocks.prototype.getSupply = () => {
  const height = priv.lastBlock.height
  return priv.blockStatus.calcSupply(height)
}

Blocks.prototype.getCirculatingSupply = () => {
  const height = priv.lastBlock.height
  return priv.blockStatus.calcSupply(height)
}

Blocks.prototype.isCollectingVotes = () => priv.isCollectingVotes

Blocks.prototype.isHealthy = () => {
  const lastBlock = priv.lastBlock
  const lastSlot = slots.getSlotNumber(lastBlock.timestamp)
  return slots.getNextSlot() - lastSlot < 3 && !modules.loader.syncing()
}

Blocks.prototype.onBind = (scope) => {
  modules = scope

  priv.loaded = true
  return (async () => {
    try {
      const count = app.sdb.blocksCount
      app.logger.info('Blocks found:', count)
      if (!count) {
        self.setLastBlock({ height: -1 })
        await self.processBlock(genesisblock.block, []/* failedTransactions */, {})
      } else {
        const block = await app.sdb.getBlockByHeight(count - 1)
        self.setLastBlock(block)
      }
      library.bus.message('blockchainReady')
    } catch (e) {
      app.logger.error('Failed to prepare local blockchain', e)
      process.exit(0)
    }
  })()
}

Blocks.prototype.cleanup = (cb) => {
  priv.loaded = false
  cb()
}

// Shared
shared.getBlock = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const query = req.body
  return library.scheme.validate(query, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
      },
      height: {
        type: 'integer',
        minimum: 0,
      },
    },
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    return (async () => {
      try {
        let block
        if (query.id) {
          block = await app.sdb.getBlockById(query.id)
        } else if (query.height !== undefined) {
          block = await app.sdb.getBlockByHeight(query.height)
        }

        if (!block) {
          return cb('Block not found')
        }
        return cb(null, { block: self.toAPIV1Block(block) })
      } catch (e) {
        library.logger.error(e)
        return cb('Server error')
      }
    })()
  })
}

shared.getFullBlock = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const query = req.body
  return library.scheme.validate(query, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
      },
      height: {
        type: 'integer',
        minimum: 0,
      },
    },
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    return (async () => {
      try {
        let block
        if (query.id) {
          block = await app.sdb.getBlockById(query.id)
        } else if (query.height !== undefined) {
          block = await app.sdb.getBlockByHeight(query.height)
        }
        if (!block) return cb('Block not found')

        const v1Block = self.toAPIV1Block(block)
        return modules.transactions.getBlockTransactionsForV1(v1Block, (error, transactions) => {
          if (error) return cb(error)
          v1Block.transactions = transactions
          v1Block.numberOfTransactions = isArray(transactions) ? transactions.length : 0
          return cb(null, { block: v1Block })
        })
      } catch (e) {
        library.logger.error('Failed to find block', e)
        return cb(`Server error : ${e.message}`)
      }
    })()
  })
}

shared.getBlocks = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const query = req.body
  return library.scheme.validate(query, {
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
      generatorPublicKey: {
        type: 'string',
        format: 'publicKey',
      },
    },
  }, (err) => {
    if (err) {
      return cb(err[0].message)
    }

    return (async () => {
      try {
        const offset = query.offset ? Number(query.offset) : 0
        const limit = query.limit ? Number(query.limit) : 20
        let minHeight
        let maxHeight
        if (query.orderBy === 'height:desc') {
          maxHeight = priv.lastBlock.height - offset
          minHeight = (maxHeight - limit) + 1
        } else {
          minHeight = offset
          maxHeight = (offset + limit) - 1
        }

        // TODO: get by delegate ??
        // if (query.generatorPublicKey) {
        //   condition.delegate = query.generatorPublicKey
        // }
        const count = app.sdb.blocksCount
        if (!count) throw new Error('Failed to get blocks count')

        const blocks = await app.sdb.getBlocksByHeightRange(minHeight, maxHeight)
        if (!blocks || !blocks.length) return cb('No blocks')
        return cb(null, { count, blocks: self.toAPIV1Blocks(blocks) })
      } catch (e) {
        library.logger.error('Failed to find blocks', e)
        return cb('Server error')
      }
    })()
  })
}

shared.getHeight = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  return cb(null, { height: priv.lastBlock.height })
}

shared.getMilestone = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const height = priv.lastBlock.height
  return cb(null, { milestone: priv.blockStatus.calcMilestone(height) })
}

shared.getReward = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const height = priv.lastBlock.height
  return cb(null, { reward: priv.blockStatus.calcReward(height) })
}

shared.getSupply = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const height = priv.lastBlock.height
  return cb(null, { supply: priv.blockStatus.calcSupply(height) })
}

shared.getStatus = (req, cb) => {
  if (!priv.loaded) {
    return cb('Blockchain is loading')
  }
  const height = priv.lastBlock.height
  return cb(null, {
    height,
    fee: library.base.block.calculateFee(),
    milestone: priv.blockStatus.calcMilestone(height),
    reward: priv.blockStatus.calcReward(height),
    supply: priv.blockStatus.calcSupply(height),
  })
}

module.exports = Blocks
