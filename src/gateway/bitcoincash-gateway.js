const BitcoinGateway = require('./bitcoin-gateway.js')
const BitcoinCashUtil = require('./bitcoincash-util.js')
const gatewayLib = require('asch-gateway')

class BitcoinCashGateway extends BitcoinGateway {
  constructor(options) {
    super(options)
    this._name = options.name || 'bitcoincash'
    this._currency = options.currency || 'BCH'
  }
  _getClient() {
    if (!this._client) {
      const rpc = this._rpc
      this._client = new gatewayLib.bitcoincash.Client(
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
      this._util = new BitcoinCashUtil(this._netType)
    }
    return this._util
  }
  async _signTransaction(outTransaction, account, inputAccountInfo) {
    console.log('signTransaction-----------', outTransaction, account, inputAccountInfo)
    const utxos = await this._getClient().getUTXOsByTransaction(outTransaction.txhex)
    return this._getUtil().signTransactionWithUTXO(
      outTransaction,
      account,
      inputAccountInfo,
      utxos,
    )
  }
}

module.exports = BitcoinCashGateway
