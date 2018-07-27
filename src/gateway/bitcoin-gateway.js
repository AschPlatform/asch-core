const BitcoinUtil = require('./bitcoin-util.js')
const utils = require('../utils')
const gatewayLib = require('asch-gateway')
const PIFY = require('util').promisify

const GatewayLogType = {
  IMPORT_ADDRESS: 1,
  DEPOSIT: 2,
  WITHDRAWAL: 3,
  SEND_WITHDRAWAL: 4,
}

class BitcoinGateway {
  constructor(options) {
    this._name = options.name || 'bitcoin'
    this._client = null
    this._util = null
    this._netType = options.netType || 'testnet'
    this._rpc = options.rpc
    this._sdb = options.sdb
    this._spentTids = []
    this._currency = options.currency || 'BTC'
    this._outSecret = options.outSecret
    this._secret = options.secret
    this._stopped = true
  }
  get name() {
    return this._name
  }
  get currency() {
    return this._currency
  }
  get stopped() {
    return this._stopped
  }
  start() {
    this._stopped = false
    this._loopAsyncFunction(this._importAccounts.bind(this), 10 * 1000)
    this._loopAsyncFunction(this._processDeposits.bind(this), 60 * 1000)
    this._loopAsyncFunction(this._processWithdrawals.bind(this), 10 * 1000)
    this._loopAsyncFunction(this._sendWithdrawals.bind(this), 30 * 1000)
    library.logger.info('gateway service started')
  }
  stop() {
    this._stopped = true
    library.logger.info('gateway service stopped')
  }
  _loopAsyncFunction(asyncFunc, interval) {
    const self = this
    setImmediate(function next() {
      (async () => {
        try {
          if (modules.blocks.isHealthy()) {
            await asyncFunc()
          } else {
            library.logger.warn('blockchain is not healthy, stop process gateway business')
          }
        } catch (e) {
          library.logger.error(`Failed to run ${asyncFunc.name}`, e)
        }
        if (!self.stopped) {
          setTimeout(next, interval)
        }
      })()
    })
  }
  _getClient() {
    if (!this._client) {
      const rpc = this._rpc
      this._client = new gatewayLib.bitcoin.Client(
        rpc.username,
        rpc.password,
        this._netType,
        rpc.port,
        rpc.host,
      )
    }
    return this._client
  }
  _getUtil() {
    if (!this._util) {
      this._util = new BitcoinUtil(this._netType)
    }
    return this._util
  }
  async _importAccounts() {
    const GATEWAY = this.name
    const key = { gateway: GATEWAY, type: GatewayLogType.IMPORT_ADDRESS }
    let lastImportAddressLog = this._sdb.get('GatewayLog', key)

    library.logger.debug('find last import address log', lastImportAddressLog)
    let lastSeq = 0
    if (lastImportAddressLog) {
      lastSeq = lastImportAddressLog.seq
    } else {
      const value = { gateway: GATEWAY, type: GatewayLogType.IMPORT_ADDRESS, seq: 0 }
      lastImportAddressLog = this._sdb.create('GatewayLog', value)
    }
    // query( model, condition, fields, limit, offset, sort, join )
    const gatewayAccounts = await this._sdb.find(
      'GatewayAccount',
      { gateway: GATEWAY, seq: { $gt: lastSeq } },
      100,
      { seq: 1 },
    )
    library.logger.debug('find gateway account', gatewayAccounts)
    const len = gatewayAccounts.length
    if (len > 0) {
      for (const a of gatewayAccounts) {
        await this._importAddress(a.outAddress)
      }
      app.sdb.update('GatewayLog', { seq: gatewayAccounts[len - 1].seq }, key)
      this._sdb.saveLocalChanges()
    }
  }
  async _processDeposits() {
    const GATEWAY = this.name

    const validators = await this._sdb.findAll(
      'GatewayMember',
      {
        condition: {
          gateway: GATEWAY,
          elected: 1,
        },
      },
    )
    if (!validators || !validators.length) {
      library.logger.error('Validators not found')
      return
    }

    const exists = await this._sdb.exists('GatewayAccount', { gateway: GATEWAY })
    if (!exists) {
      library.logger.error('No gateway accounts')
      return
    }

    const gatewayLogKey = { gateway: GATEWAY, type: GatewayLogType.DEPOSIT }
    let lastDepositLog = this._sdb.get('GatewayLog', gatewayLogKey)
    library.logger.debug('==========find DEPOSIT log============', lastDepositLog)

    lastDepositLog = lastDepositLog
      || this._sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.DEPOSIT, seq: 0 })

    const lastSeq = lastDepositLog.seq
    const ret = await this._getTransactionsFromBlockHeight(lastSeq)
    if (!ret || !ret.transactions) {
      library.logger.error('Failed to get gateway transactions')
      return
    }

    const outTransactions = ret.transactions.filter(ot => ot.category === 'receive' && ot.confirmations >= 1)
      .sort((l, r) => l.height - r.height)

    library.logger.debug('get gateway transactions', outTransactions)

    const onError = (err) => {
      library.logger.error('process gateway deposit error, will retry...', err)
    }
    const len = outTransactions.length
    if (len > 0) {
      for (const ot of outTransactions) {
        const isAccountOpened = await this._sdb.exists('GatewayAccount', { outAddress: ot.address })
        if (!isAccountOpened) {
          library.logger.warn('unknow address', { address: ot.address, gateway: GATEWAY, t: ot })
          continue
        }
        const deposit = await this._sdb.findOne(
          'GatewayDeposit',
          {
            condition: {
              gateway: GATEWAY,
              oid: ot.txid,
            },
          },
        )
        if (deposit && deposit.processed) {
          library.logger.info('already processed deposit', { gateway: GATEWAY, oid: ot.txid })
          continue
        }

        try {
          await utils.retryAsync(this._processDeposit.bind(this, ot), 3, 10 * 1000, onError)
          library.logger.info('gateway deposit processed', { address: ot.address, amount: ot.amount, gateway: GATEWAY })
        } catch (e) {
          library.logger.warn('Failed to process gateway deposit', { error: e, outTransaction: ot })
        }
      }
      app.sdb.update('GatewayLog', { seq: outTransactions[len - 1].height }, gatewayLogKey)
      this._sdb.saveLocalChanges()
    }
  }
  async _processDeposit(outTransaction) {
    const ot = outTransaction
    const params = {
      type: 402,
      secret: this._secret,
      fee: 10000000,
      args: [
        this.name,
        ot.address,
        this.currency,
        String(ot.amount * 100000000),
        ot.txid,
      ],
    }
    await PIFY(modules.transactions.addTransactionUnsigned)(params)
  }
  async _processWithdrawals() {
    const GATEWAY = this.name
    const PAGE_SIZE = 25
    const validators = await this._sdb.findAll(
      'GatewayMember',
      {
        condition: {
          gateway: GATEWAY,
          elected: 1,
        },
      },
    )
    if (!validators || !validators.length) {
      library.logger.error('Validators not found')
      return
    }
    library.logger.debug('find gateway validators', validators)

    const withdrawalLogKey = { gateway: GATEWAY, type: GatewayLogType.WITHDRAWAL }
    let lastWithdrawalLog = await this._sdb.load('GatewayLog', withdrawalLogKey)
    library.logger.debug('find ==========WITHDRAWAL============ log', lastWithdrawalLog)

    lastWithdrawalLog = lastWithdrawalLog
      || this._sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.WITHDRAWAL, seq: 0 })

    const lastSeq = lastWithdrawalLog.seq

    const withdrawals = await this._sdb.find('GatewayWithdrawal', { gateway: GATEWAY, seq: { $gt: lastSeq } }, PAGE_SIZE)
    library.logger.debug('get gateway withdrawals', withdrawals)
    if (!withdrawals || !withdrawals.length) {
      return
    }

    const outPublicKeys = validators.map(v => v.outPublicKey).sort((l, r) => l - r)
    const unlockNumber = Math.floor(outPublicKeys.length / 2) + 1
    const multiAccount = this._getUtil().createMultisigAccount(unlockNumber, outPublicKeys)
    library.logger.debug('gateway validators cold account', multiAccount)

    const onError = (err) => {
      library.logger.error('Process gateway withdrawal error, will retry', err)
    }

    this._spentTids = await this._getSpentTids()
    for (const w of withdrawals) {
      if (w.ready) continue
      try {
        const fn = this._processWithdrawal.bind(this, w.tid, multiAccount)
        await utils.retryAsync(fn, 3, 10 * 1000, onError)
        library.logger.info('Gateway withdrawal processed', w.tid)
      } catch (e) {
        library.logger.warn('Failed to process gateway withdrawal', { error: e, transaction: w })
      }
    }
    app.sdb.update('GatewayLog', { seq: withdrawals[withdrawals.length - 1].seq }, withdrawalLogKey)
    this._sdb.saveLocalChanges()
  }
  async _processWithdrawal(wid, multiAccount) {
    let contractParams = null
    const w = await this._sdb.load('GatewayWithdrawal', wid)
    const account = {
      privateKey: this._outSecret,
    }
    if (!w.outTransaction) {
      const output = [{ address: w.recipientId, value: Number(w.amount) }]
      library.logger.debug('gateway spent tids', this._spentTids)
      const ot = await this._createNewTransaction(
        multiAccount,
        output,
        this._spentTids,
        Number(w.fee),
      )
      this._spentTids =
        this._spentTids.concat(this._getUtil().getSpentTidsFromRawTransaction(ot.txhex))
      library.logger.debug('create withdrawl out transaction', ot)

      const inputAccountInfo = await this._getGatewayAccountByOutAddress(ot.input, multiAccount)
      library.logger.debug('input account info', inputAccountInfo)

      const ots = await this._signTransaction(ot, account, inputAccountInfo)
      library.logger.debug('sign withdrawl out transaction', ots)

      contractParams = {
        type: 404,
        secret: this._secret,
        fee: 10000000,
        args: [w.tid, JSON.stringify(ot), JSON.stringify(ots)],
      }
    } else {
      const ot = JSON.parse(w.outTransaction)
      const inputAccountInfo = await this._getGatewayAccountByOutAddress(ot.input, multiAccount)
      const ots = await this._signTransaction(ot, account, inputAccountInfo)
      contractParams = {
        type: 405,
        secret: global.Config.gateway.secret,
        fee: 10000000,
        args: [w.tid, JSON.stringify(ots)],
      }
    }
    await PIFY(modules.transactions.addTransactionUnsigned)(contractParams)
  }
  async _signTransaction(outTransaction, account, inputAccountInfo) {
    return this._getUtil().signTransaction(outTransaction, account, inputAccountInfo)
  }
  async _sendWithdrawals() {
    const GATEWAY = this.name
    const PAGE_SIZE = 25
    let lastSeq = 0
    const logKey = {
      gateway: GATEWAY,
      type: GatewayLogType.SEND_WITHDRAWAL,
    }
    let lastLog = this._sdb.get('GatewayLog', logKey)
    library.logger.debug('find ======SEND_WITHDRAWAL====== log', lastLog)
    if (lastLog) {
      lastSeq = lastLog.seq
    } else {
      lastLog = this._sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.SEND_WITHDRAWAL, seq: 0 })
    }
    const withdrawals = await this._sdb.findAll('GatewayWithdrawal', {
      condition: {
        gateway: GATEWAY,
        seq: { $gt: lastSeq },
      },
      limit: PAGE_SIZE,
      sort: {
        seq: 1,
      },
    })
    library.logger.debug('get gateway withdrawals', withdrawals)
    if (!withdrawals || !withdrawals.length) {
      return
    }
    const validators = await this._sdb.findAll('GatewayMember', {
      condition: {
        gateway: GATEWAY,
        elected: 1,
      },
    })
    if (!validators) {
      library.logger.error('Validators not found')
      return
    }
    library.logger.debug('find gateway validators', validators)

    const outPublicKeys = validators.map(v => v.outPublicKey).sort((l, r) => l - r)
    const unlockNumber = Math.floor(outPublicKeys.length / 2) + 1
    const multiAccount = this._getUtil().createMultisigAddress(unlockNumber, outPublicKeys)
    library.logger.debug('gateway validators cold account', multiAccount)

    const onError = (err) => {
      library.logger.error('Send withdrawal error, will retry...', err)
    }
    for (const w of withdrawals) {
      if (!w.outTransaction) {
        library.logger.debug('out transaction not created')
        return
      }
      const preps = await this._sdb.findAll('GatewayWithdrawalPrep', { condition: { wid: w.tid } })
      if (preps.length < unlockNumber) {
        library.logger.debug('not enough signature')
        return
      }
      const ot = JSON.parse(w.outTransaction)
      const ots = []
      for (let i = 0; i < unlockNumber; i++) {
        ots.push(JSON.parse(preps[i].signature))
      }
      try {
        const fn = this._sendWithdrawal.bind(this, ot, ots, multiAccount)
        const tid = await utils.retryAsync(fn, 3, 10 * 1000, onError)
        library.logger.info('Send withdrawal transaction to out chain success', tid)
        const submitOidParams = {
          type: 406,
          secret: global.Config.gateway.secret,
          fee: 1000000,
          args: [w.tid, tid],
        }
        await PIFY(modules.transactions.addTransactionUnsigned)(submitOidParams)
      } catch (e) {
        library.logger.error('Failed to send gateway withdrawal', { error: e, transaction: w })
      }
      app.sdb.update('GatewayLog', { seq: w.seq }, logKey)
      this._sdb.saveLocalChanges()
    }
  }
  async _sendWithdrawal(outTransaction, outTransactionSignatures, multiAccount) {
    const ot = outTransaction
    const ots = outTransactionSignatures
    const inputAccountInfo = await this._getGatewayAccountByOutAddress(ot.input, multiAccount)
    library.logger.debug('before build transaction')
    const finalTransaction = this._getUtil().buildTransaction(ot, ots, inputAccountInfo)
    library.logger.debug('before send raw tarnsaction', finalTransaction)
    const tid = await this._sendRawTransaction(finalTransaction)
    return tid
  }
  _importAddress(address) {
    return new Promise((resolve, reject) => {
      this._getClient().importAddress(address, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  }
  _getTransactionsFromBlockHeight(height) {
    return new Promise((resolve, reject) => {
      this._getClient().getTransactionsFromBlockHeight(height, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  }
  _createNewTransaction(multiAccount, output, spentTids, fee) {
    return new Promise((resolve, reject) => {
      const client = this._getClient()
      client.createNewTransaction(multiAccount, output, spentTids, fee, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  }
  _sendRawTransaction(t) {
    return new Promise((resolve, reject) => {
      this._getClient().sendRawTransaction(t, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  }
  async _getSpentTids() {
    let spentTids = []
    const latestWithdrawals = await this._sdb.find(
      'GatewayWithdrawal',
      { gateway: this.name },
      10,
      { seq: -1 },
    )
    for (const w of latestWithdrawals) {
      if (w.outTransaction) {
        const ot = JSON.parse(w.outTransaction)
        const rawTransaction = ot.txhex
        const tids = this._getUtil().getSpentTidsFromRawTransaction(rawTransaction)
        spentTids = spentTids.concat(tids)
      }
    }
    return spentTids
  }
  async _getGatewayAccountByOutAddress(addresses, coldAccount) {
    const accountMap = {}
    for (const i of addresses) {
      let account
      if (coldAccount.address === i) {
        account = coldAccount.accountExtrsInfo.redeemScript
      } else {
        const gatewayAccount = await this._sdb.findOne('GatewayAccount', { condition: { outAddress: i } })
        if (!gatewayAccount) throw new Error('Input address have no gateway account')
        account = JSON.parse(gatewayAccount.attachment).redeemScript
      }
      accountMap[i] = account
    }
    return accountMap
  }
}

module.exports = BitcoinGateway
