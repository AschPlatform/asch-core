const Bancor = require('../utils/bancor.js')
const constants = require('../utils/constants.js')
const addressHelper = require('../utils/address.js')

module.exports = {
  getAllGatewayMember(gatewayName) {
    const members = app.sdb.findAll('GatewayMember', { condition: { gateway: gatewayName } })
    members.forEach((element, index, array) => {
      const addr = addressHelper.generateLockedAddress(element.address)
      const account = app.sdb.findOne('Account', { condition: { address: addr } })
      if (account) {
        array[index].bail = account.xas
      } else {
        array[index].bail = 0
      }
    })
    return members
  },

  getGatewayMember(gatewayName, memberAddr) {
    const m = app.sdb.findOne('GatewayMember', { condition: { gateway: gatewayName, address: memberAddr } })
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const account = app.sdb.findOne('Account', { condition: { address: addr } })
    if (account) {
      m.bail = account.xas
    } else {
      m.bail = 0
    }
    return m
  },

  getElectedGatewayMember(gatewayName) {
    const members = this.getAllGatewayMember(gatewayName)
    return members.filter(m => m.elected === 1)
  },

  getMinimumBailMember(gatewayName) {
    const members = this.getElectedGatewayMember(gatewayName)
    members.sort((m1, m2) => {
      if (m1.bail < m2.bail) {
        return -1
      }
      if (m1.bail > m2.bail) {
        return 1
      }
      return 0
    })
    return members[0]
  },

  getBailTotalAmount(gatewayName) {
    const member = this.getMinimumBailMember(gatewayName)
    return member.bail * (Math.floor(members.length / 2) + 1)
  },

  getAmountByCurrency(currency) {
    const gwCurrency = app.sdb.findOne('GatewayCurrency', { condition: { symbol: currency } })
    if (gwCurrency) {
      return gwCurrency.quantity
    }
    return 0
  },

  getThreshold(gatewayName, memberAddr) {
    // Calculate Ap / B
    const gwCurrency = app.sdb.findOne('GatewayCurrency', { condition: { gateway: gatewayName } })
    const bancor = new Bancor(gwCurrency.symbol, 'XAS')
    const allBCH = this.getAmountByCurrency(gwCurrency.symbol)
    const totalBail = this.getBailTotalAmount(gatewayName)
    let ratio = -1
    let needSupply = 0
    let minimumBail = 0
    if (!bancor) {
      return { ratio, needSupply }
    }
    const result = bancor.exchangeBySource(gwCurrency.symbol, 'XAS', allBCH, false)
    ratio = totalBail / result.targetAmount
    if (ratio < constants.warningCriteria) {
      const minimumMember = this.getMinimumBailMember(gatewayName)
      minimumBail = constants.supplyCriteria * minimumMember.bail
    }

    if (memberAddr) {
      const member = getGatewayMember(gatewayName, memberAddr)
      if (member && minimumBail > member.bail) {
        needSupply = minimumBail - member.bail
      }
    }

    return { ratio, needSupply }
  },

  getMaximumBailWithdrawl(gatewayName, memberAddr) {
    const m = this.getGatewayMember(gatewayName, memberAddr)
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const lockAccount = app.sdb.load('Account', addr)
    if (m.elected === 0) {
      return lockAccount.xas
    }
    const threshold = this.getThreshold(gatewayName)
    if (m.elected === 1 && threshold.ratio > constants.supplyCriteria) {
      const minimumMember = this.getMinimumBailMember(gatewayName)
      const canBeWithdrawl = lockAccount.xas - minimumMember.bail
                            + minimumMember.bail * (threshold.ratio - constants.supplyCriteria)
      return canBeWithdrawl
    }
    return 0
  },
}
