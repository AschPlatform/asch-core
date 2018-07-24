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
    return this._util || new BitcoinCashUtil(this._netType)
  }
}

module.exports = BitcoinCashGateway
