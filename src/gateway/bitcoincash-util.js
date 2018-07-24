const gatewayLib = require('asch-gateway')

class BitcoinCashUtil extends gatewayLib.bitcoincash.Utils {
  createMultiSigAccount(m, accounts) {
    const ma = this.createMultisigAddress(m, accounts)
    ma.accountExtrsInfo.redeemScript = ma.accountExtrsInfo.redeemScript.toString('hex')
    ma.accountExtrsInfo = JSON.stringify(ma.accountExtrsInfo)
    return ma
  }
}

module.exports = BitcoinCashUtil
