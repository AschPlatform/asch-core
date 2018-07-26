const gatewayLib = require('asch-gateway')

class BitcoinUtil extends gatewayLib.bitcoin.Utils {
  createMultisigAccount(m, accounts) {
    const ma = this.createMultisigAddress(m, accounts)
    ma.accountExtrsInfo.redeemScript = ma.accountExtrsInfo.redeemScript.toString('hex')
    ma.accountExtrsInfo = JSON.stringify(ma.accountExtrsInfo)
    return ma
  }
}

module.exports = BitcoinUtil
