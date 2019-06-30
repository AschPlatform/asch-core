const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')
const { EventEmitter } = require('events')
const _ = require('lodash')
const validate = require('validate.js')
const { AschCore } = require('asch-smartdb')
const { AschContract } = require('asch-contract')
const gatewayLib = require('./gateway')
const slots = require('./utils/slots')
const amountHelper = require('./utils/amount')
const Router = require('./utils/router.js')
const BalanceManager = require('./smartdb/balance-manager')
const AutoIncrement = require('./smartdb/auto-increment')
const AccountRole = require('./utils/account-role')
const transactionMode = require('./utils/transaction-mode.js')

const PIFY = util.promisify

class RouteWrapper {
  constructor() {
    this.hands = []
    this.routePath = null
  }

  get(routePath, handler) {
    this.handlers.push({ path: routePath, method: 'get', handler })
  }

  put(routePath, handler) {
    this.handlers.push({ path: routePath, method: 'put', handler })
  }

  post(routePath, handler) {
    this.handlers.push({ path: routePath, method: 'post', handler })
  }

  set path(val) {
    this.routePath = val
  }

  get path() {
    return this.routePath
  }

  get handlers() {
    return this.hands
  }
}

async function loadModels(dir) {
  let modelFiles = []
  try {
    modelFiles = await PIFY(fs.readdir)(dir)
  } catch (e) {
    app.logger.error(`models load error: ${e}`)
    return
  }
  app.logger.debug('models', modelFiles)

  const schemas = []
  modelFiles.forEach((modelFile) => {
    app.logger.info('loading model', modelFile)
    const basename = path.basename(modelFile, '.js')
    const modelName = _.chain(basename).camelCase().upperFirst().value()
    const fullpath = path.resolve(dir, modelFile)
    const schema = require(fullpath)
    schemas.push(new AschCore.ModelSchema(schema, modelName))
  })

  await app.sdb.init(schemas)

  // HARDCODE HOTFIX upgrade group_members schema
  async function updateSchemaIfNoRecords(name) {
    const count = await app.sdb.count(name, {})
    if (count === 0) {
      const schema = schemas.find(s => s.modelName === name)
      await app.sdb.updateSchema(schema)
    }
  }
  await updateSchemaIfNoRecords('GroupMember')
  await updateSchemaIfNoRecords('GatewayAccount')
}

async function loadContracts(dir) {
  let contractFiles
  try {
    contractFiles = await PIFY(fs.readdir)(dir)
  } catch (e) {
    app.logger.error(`contracts load error: ${e}`)
    return
  }
  contractFiles.forEach((contractFile) => {
    app.logger.info('loading contract', contractFile)
    const basename = path.basename(contractFile, '.js')
    const contractName = _.snakeCase(basename)
    const fullpath = path.resolve(dir, contractFile)
    const contract = require(fullpath)
    if (contractFile !== 'index.js') {
      app.contract[contractName] = contract
    }
  })
}

async function loadInterfaces(dir, routes) {
  let interfaceFiles
  try {
    interfaceFiles = await PIFY(fs.readdir)(dir)
  } catch (e) {
    app.logger.error(`interfaces load error: ${e}`)
    return
  }
  for (const f of interfaceFiles) {
    app.logger.info('loading interface', f)
    const basename = path.basename(f, '.js')
    const rw = new RouteWrapper()
    require(path.resolve(dir, f))(rw)
    const router = new Router()
    for (const h of rw.handlers) {
      router[h.method](h.path, (req, res) => {
        (async () => {
          try {
            const result = await h.handler(req)
            let response = { success: true }
            if (util.isObject(result) && !Array.isArray(result)) {
              response = _.assign(response, result)
            } else if (!util.isNullOrUndefined(result)) {
              response.data = result
            }
            res.send(response)
          } catch (e) {
            res.status(500).send({ success: false, error: e.message })
          }
        })()
      })
    }
    if (!rw.path) {
      rw.path = `/api/v2/${basename}`
    }
    routes.use(rw.path, router)
  }
}

function adaptSmartDBLogger(config) {
  const { LogLevel } = AschCore
  const levelMap = {
    log: LogLevel.log,
    trace: LogLevel.trace,
    debug: LogLevel.debug,
    info: LogLevel.info,
    warn: LogLevel.warn,
    error: LogLevel.error,
    fatal: LogLevel.fatal,
  }

  AschCore.LogManager.logFactory = {
    createLog: () => app.logger,
    format: false,
    getLevel: () => {
      const appLogLevel = String(config.logLevel).toLocaleLowerCase()
      return levelMap[appLogLevel] || LogLevel.info
    },
  }
}

async function loadSmartContracts() {
  const contracts = await app.sdb.find('Contract', { state: 0 }, undefined, undefined, ['name'])
  app.logger.info(`Loading ${contracts.length} contracts`)
  await app.contract.loadContracts(contracts.map(c => c.name))
  app.logger.info('Smart contracts loaded')
}

async function checkAndRecover() {
  const sdb = app.sdb
  const contractSandbox = app.contract

  const dbHeight = sdb.lastBlockHeight
  const contractHeight = await contractSandbox.getLastCommittedHeight()

  if (dbHeight === contractHeight || contractHeight < 0) return

  app.logger.warn('Inconsistent SmartDB and contract DB detected, try to recover')
  if (Math.abs(dbHeight - contractHeight) > 1) {
    const error = 'Cannot recover contract DB automatically, please check it manually'
    app.logger.error(error, { dbHeight, contractHeight })
    throw new Error(error)
  }

  if (dbHeight > contractHeight) {
    try {
      await app.sdb.rollbackBlock(contractHeight)
    } catch (err) {
      const error = `Fail to rollback SmartDB, ${err}`
      app.logger.error(error)
      throw new Error(error)
    }
  } else {
    try {
      const ret = await contractSandbox.rollback(dbHeight)
      if (!ret.success) throw new Error(ret.error)
      await contractSandbox.getLastCommittedHeight()
    } catch (err) {
      const error = `Fail to rollback contract DB, ${err}`
      app.logger.error(error)
      throw new Error(error)
    }
  }
  app.logger.info('Recovery successful')
}

module.exports = async function runtime(options) {
  global.app = {
    sdb: null,
    balances: null,
    model: {},
    contract: {},
    contractTypeMapping: {},
    feeMapping: {},
    defaultFee: {
      currency: 'XAS',
      min: '10000000',
    },
    hooks: {},
    custom: {},
    logger: options.logger,
  }
  app.validators = {
    amount: value => amountHelper.validate(value),
    name: (value) => {
      const regname = /^[a-z0-9_]{2,20}$/
      if (!regname.test(value)) return 'Invalid name'
      return null
    },
    publickey: (value) => {
      const reghex = /^[0-9a-fA-F]{64}$/
      if (!reghex.test(value)) return 'Invalid public key'
      return null
    },
    string: (value, constraints) => {
      if (constraints.length) {
        return JSON.stringify(validate({ data: value }, { data: { length: constraints.length } }))
      } if (constraints.isEmail) {
        return JSON.stringify(validate({ email: value }, { email: { email: true } }))
      } if (constraints.url) {
        return JSON.stringify(validate({ url: value }, { url: { url: constraints.url } }))
      } if (constraints.number) {
        return JSON.stringify(validate(
          { number: value },
          { number: { numericality: constraints.number } },
        ))
      }
      return null
    },
  }
  app.validate = (type, value, constraints) => {
    if (!app.validators[type]) throw new Error(`Validator not found: ${type}`)
    const error = app.validators[type](value, constraints)
    if (error) throw new Error(error)
  }
  app.registerContract = (type, name) => {
    // if (type < 1000) throw new Error('Contract types that small than 1000 are reserved')
    app.contractTypeMapping[type] = name
  }
  app.getContractName = type => app.contractTypeMapping[type]

  // app.registerFee = (type, min, currency) => {
  //   app.feeMapping[type] = {
  //     currency: currency || app.defaultFee.currency,
  //     min,
  //   }
  // }
  // app.getFee = type => app.feeMapping[type]

  // app.setDefaultFee = (min, currency) => {
  //   app.defaultFee.currency = currency
  //   app.defaultFee.min = min
  // }

  app.addRoundFee = (fee, roundNumber) => {
    modules.blocks.increaseRoundData({ fees: fee }, roundNumber)
  }

  app.getRealTime = epochTime => slots.getRealTime(epochTime)

  app.registerHook = (name, func) => {
    app.hooks[name] = func
  }

  app.verifyBytes = (bytes, pk, signature) => app.api.crypto.verify(pk, signature, bytes)

  app.checkMultiSignature = (bytes, allowedKeys, signatures, m) => {
    const keysigs = signatures.split(',')
    const publicKeys = []
    const sigs = []
    for (const ks of keysigs) {
      if (ks.length !== 192) throw new Error('Invalid public key or signature')
      publicKeys.push(ks.substr(0, 64))
      sigs.push(ks.substr(64, 192))
    }
    const uniqPublicKeySet = new Set()
    for (const pk of publicKeys) {
      uniqPublicKeySet.add(pk)
    }
    if (uniqPublicKeySet.size !== publicKeys.length) throw new Error('Duplicated public key')

    let sigCount = 0
    for (let i = 0; i < publicKeys.length; ++i) {
      const pk = publicKeys[i]
      const sig = sigs[i]
      if (allowedKeys.indexOf(pk) !== -1 && app.verifyBytes(bytes, pk, sig)) {
        sigCount++
      }
    }
    if (sigCount < m) throw new Error('Signatures not enough')
  }

  app.gateway = {
    createMultisigAddress: (gateway, m, accounts) => gatewayLib
      .getGatewayUtil(gateway)
      .createMultisigAccount(m, accounts),

    isValidAddress: (gateway, address) => gatewayLib
      .getGatewayUtil(gateway)
      .isValidAddress(address),
  }

  app.isCurrentBookkeeper = addr => modules.delegates.getBookkeeperAddresses().has(addr)

  app.executeContract = async (context) => {
    context.activating = 1
    const ret = await library.base.transaction.apply(context)
    const error = (typeof ret === 'object' && ret.success === false) ? ret.error || 'failed' : ret
    if (!error) {
      const trs = await app.sdb.get('Transaction', { id: context.trs.id })
      if (!transactionMode.isRequestMode(context.trs.mode)) throw new Error('Transaction mode is not request mode')

      app.sdb.update('TransactionStatu', { executed: 1 }, { tid: context.trs.id })
      app.addRoundFee(trs.fee, modules.round.calc(context.block.height))
    }
    return error
  }

  app.AccountRole = AccountRole

  const { appDir, dataDir } = options.appConfig

  const BLOCK_DB_DIR = path.resolve(dataDir)
  const BLOCK_HEADER_DIR = path.join(BLOCK_DB_DIR, 'blocks')

  adaptSmartDBLogger(options.appConfig)
  app.sdb = new AschCore.SmartDB(BLOCK_DB_DIR, BLOCK_HEADER_DIR, { blockTimeout: 10000 })
  app.balances = new BalanceManager(app.sdb)
  app.autoID = new AutoIncrement(app.sdb)
  app.events = new EventEmitter()

  app.util = {
    address: require('./utils/address.js'),
    bignumber: require('./utils/bignumber'),
    bigdecimal: require('./utils/bigdecimal'),
    transactionMode: require('./utils/transaction-mode.js'),
    lodash: require('lodash'),
    slots: require('./utils/slots.js'),
    constants: require('./utils/constants.js'),
    gateway: require('./utils/gateway.js'),
    pledges: require('./utils/pledges.js'),
  }

  const memoryConfig = {}
  if (options.appConfig.netVersion === 'mainnet') {
    const totalMemory = Math.round(os.totalmem() / (1024 * 1024))
    if (totalMemory > 4096) {
      memoryConfig.maxOldSpace = totalMemory - 2048
    }
  }
  const contractSandbox = new AschContract.SandboxConnector({
    entry: require.resolve('asch-contract/sandbox-launcher.js'),
    dataDir: path.join(dataDir, '/contracts'),
    logDir: path.join(appDir, '../logs/contracts/'),
    logLevelConfig: { defaultLogLevel: AschContract.LogLevel[options.appConfig.logLevel] },
    memoryConfig,
  })

  await contractSandbox.connect()
  app.contract = contractSandbox

  app.sdb.on(AschCore.SmartDB.events.commitBlock, async (height) => {
    const result = await contractSandbox.commit(height)
    if (!result.success) throw new Error(result.error)
  })

  app.sdb.on(AschCore.SmartDB.events.rollbackBlock, async (info) => {
    const lastHeight = await contractSandbox.getLastCommittedHeight()
    if (lastHeight >= 0) {
      const result = await contractSandbox.rollback(info.to)
      if (!result.success) throw new Error(result.error)
    }
  })

  app.sdb.on(AschCore.SmartDB.events.beforeCommitContract, async () => {
    const result = await contractSandbox.confirmChanges()
    if (!result.success) throw new Error(result.error)
  })

  app.sdb.on(AschCore.SmartDB.events.beforeRollbackContract, async () => {
    const result = await contractSandbox.cancelChanges()
    if (!result.success) throw new Error(result.error)
  })

  app.sdb.on(AschCore.SmartDB.events.commitBlockTimeout, async (args) => {
    // exit process
    library.logger.error(`process exit unexpectedly due to commit block ${args.height} timeout`)
    process.emit('cleanup')
  })

  app.sdb.on(AschCore.SmartDB.events.rollbackBlockTimeout, async (args) => {
    // exit process
    library.logger.error(`process exit unexpectedly due to rollback block to ${args.height} timeout`)
    process.emit('cleanup')
  })

  await loadModels(path.join(appDir, 'model'))
  await loadContracts(path.join(appDir, 'contract'))
  await loadInterfaces(path.join(appDir, 'interface'), options.library.network.app)
  await loadSmartContracts()
  await checkAndRecover()

  app.contractTypeMapping[1] = 'basic.transfer'
  app.contractTypeMapping[2] = 'basic.setName'
  app.contractTypeMapping[3] = 'basic.setPassword'
  app.contractTypeMapping[4] = 'basic.lock'
  app.contractTypeMapping[5] = 'basic.unlock'
  app.contractTypeMapping[6] = 'basic.registerGroup'
  app.contractTypeMapping[7] = 'basic.registerAgent'
  app.contractTypeMapping[8] = 'basic.setAgent'
  app.contractTypeMapping[9] = 'basic.cancelAgent'
  app.contractTypeMapping[10] = 'basic.registerDelegate'
  app.contractTypeMapping[11] = 'basic.vote'
  app.contractTypeMapping[12] = 'basic.unvote'
  app.contractTypeMapping[13] = 'basic.pledge'
  app.contractTypeMapping[14] = 'basic.unpledge'

  app.contractTypeMapping[100] = 'uia.registerIssuer'
  app.contractTypeMapping[101] = 'uia.registerAsset'
  app.contractTypeMapping[102] = 'uia.issue'
  app.contractTypeMapping[103] = 'uia.transfer'

  app.contractTypeMapping[200] = 'chain.register'
  app.contractTypeMapping[201] = 'chain.replaceDelegate'
  app.contractTypeMapping[202] = 'chain.addDelegate'
  app.contractTypeMapping[203] = 'chain.removeDelegate'
  app.contractTypeMapping[204] = 'chain.deposit'
  app.contractTypeMapping[205] = 'chain.withdrawal'

  app.contractTypeMapping[300] = 'proposal.propose'
  app.contractTypeMapping[301] = 'proposal.vote'
  app.contractTypeMapping[302] = 'proposal.activate'

  app.contractTypeMapping[400] = 'gateway.openAccount'
  app.contractTypeMapping[401] = 'gateway.registerMember'
  app.contractTypeMapping[402] = 'gateway.deposit'
  app.contractTypeMapping[403] = 'gateway.withdrawal'
  app.contractTypeMapping[404] = 'gateway.submitWithdrawalTransaction'
  app.contractTypeMapping[405] = 'gateway.submitWithdrawalSignature'
  app.contractTypeMapping[406] = 'gateway.submitOutTransactionId'
  app.contractTypeMapping[407] = 'gateway.depositBail'
  app.contractTypeMapping[408] = 'gateway.withdrawalBail'

  app.contractTypeMapping[500] = 'group.vote'
  app.contractTypeMapping[501] = 'group.activate'
  app.contractTypeMapping[502] = 'group.addMember'
  app.contractTypeMapping[503] = 'group.removeMember'

  app.contractTypeMapping[600] = 'contract.register'
  app.contractTypeMapping[601] = 'contract.call'
  app.contractTypeMapping[602] = 'contract.pay'
}
