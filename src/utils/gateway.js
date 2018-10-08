const Bancor = require('../utils/bancor.js')
const constants = require('../utils/constants.js')
const addressHelper = require('../utils/address.js')

module.exports = {
  async getAllGatewayMember(gatewayName) {
    const members = await app.sdb.findAll('GatewayMember', { condition: { gateway: gatewayName } })
    await members.forEach(async (element, index, array) => {
      const addr = addressHelper.generateLockedAddress(element.address)
      const account = await app.sdb.findOne('Account', { condition: { address: addr } })
      if (account) {
        array[index].bail = account.xas
      } else {
        array[index].bail = 0
      }
    })
    return members
  },

  async getGatewayMember(gatewayName, memberAddr) {
    const m = await app.sdb.findOne('GatewayMember', { condition: { gateway: gatewayName, address: memberAddr } })
    if (!m) return null
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const account = await app.sdb.findOne('Account', { condition: { address: addr } })
    if (account) {
      m.bail = account.xas
    } else {
      m.bail = 0
    }
    return m
  },

  async getElectedGatewayMember(gatewayName) {
    const members = await this.getAllGatewayMember(gatewayName)
    if (!members) return null
    return members.filter(m => m.elected === 1)
  },

  async getMinimumBailMember(gatewayName) {
    const members = await this.getElectedGatewayMember(gatewayName)
    if (!members) return null
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

  async getBailTotalAmount(gatewayName) {
    const members = await this.getElectedGatewayMember(gatewayName)
    const member = await this.getMinimumBailMember(gatewayName)
    if (!member) return null
    return member.bail * (Math.floor(members.length / 2) + 1)
  },

  async getAmountByCurrency(currency) {
    const gwCurrency = await app.sdb.findOne('GatewayCurrency', { condition: { symbol: currency } })
    if (gwCurrency) {
      return gwCurrency.quantity
    }
    return 0
  },

  async getThreshold(gatewayName, memberAddr) {
    // Calculate Ap / B
    const gwCurrency = await app.sdb.findOne('GatewayCurrency', { condition: { gateway: gatewayName } })
    const bancor = await Bancor.create(gwCurrency.symbol, 'XAS')
    const allBCH = await this.getAmountByCurrency(gwCurrency.symbol)
    const totalBail = await this.getBailTotalAmount(gatewayName)
    let ratio = -1
    let needSupply = 0
    let minimumBail = 0
    let currentBail = 0
    if (!bancor) {
      return { ratio, needSupply }
    }
    const result = await bancor.exchangeBySource(gwCurrency.symbol, 'XAS', allBCH, false)
    ratio = totalBail / result.targetAmount
    if (ratio < constants.warningCriteria) {
      const minimumMember = await this.getMinimumBailMember(gatewayName)
      minimumBail = constants.supplyCriteria * minimumMember.bail
    }

    if (memberAddr) {
      const member = await this.getGatewayMember(gatewayName, memberAddr)
      if (member && minimumBail > member.bail) {
        needSupply = minimumBail - member.bail
      }
      currentBail = member.bail
    }

    return { ratio, currentBail, needSupply }
  },

  async getMaximumBailWithdrawl(gatewayName, memberAddr) {
    const m = await this.getGatewayMember(gatewayName, memberAddr)
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const lockAccount = await app.sdb.load('Account', addr)
    if (m.elected === 0) {
      return lockAccount.xas
    }
    const threshold = await this.getThreshold(gatewayName)
    if (m.elected === 1 && threshold.ratio > constants.supplyCriteria) {
      const minimumMember = await this.getMinimumBailMember(gatewayName)
      const canBeWithdrawl = lockAccount.xas - minimumMember.bail
                            + minimumMember.bail * (threshold.ratio - constants.supplyCriteria)
      return canBeWithdrawl
    }
    return 0
  },
}
