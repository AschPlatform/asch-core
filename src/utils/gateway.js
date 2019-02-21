const addressHelper = require('../utils/address.js')

module.exports = {
  async getAllGatewayMember(gatewayName) {
    const members = await app.sdb.findAll('GatewayMember', { condition: { gateway: gatewayName } })
    if (!members) throw new Error('No gateway members found')
    for (let i = 0; i < members.length; i++) {
      const addr = addressHelper.generateLockedAddress(members[i].address)
      const newAccount = await app.sdb.load('Account', { address: addr })
      if (newAccount) {
        members[i].bail = newAccount.xas
      } else {
        members[i].bail = 0
      }
      const srcAccount = await app.sdb.load('Account', { address: members[i].address })
      if (srcAccount) {
        members[i].name = srcAccount.name
      }
    }
    return members
  },

  async getGatewayMember(gatewayName, memberAddr) {
    const m = await app.sdb.findOne('GatewayMember', { condition: { gateway: gatewayName, address: memberAddr } })
    if (!m) return null
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const account = await app.sdb.load('Account', { address: addr })
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

  async getAllBailAmount(gatewayName) {
    const members = await this.getElectedGatewayMember(gatewayName)
    let amount = 0
    members.forEach((member) => {
      amount += member.bail
    })
    return amount
  },

  async getAmountByCurrency(gateway, symbol) {
    const gwCurrency = await app.sdb.load('GatewayCurrency', { gateway, symbol })
    if (gwCurrency) {
      return gwCurrency.quantity
    }
    return 0
  },
}
