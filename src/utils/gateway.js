const Bancor = require('../utils/bancor.js')
const constants = require('../utils/constants.js')
const addressHelper = require('../utils/address.js')

module.exports = {
  async getAllGatewayMember(gatewayName) {
    const members = await app.sdb.findAll('GatewayMember', { condition: { gateway: gatewayName } })
    if (!members) throw new Error('No gateway members found')
    // await Promise.all(members.map(async (member) => {
    //   const addr = addressHelper.generateLockedAddress(member.address)
    //   const newAccount = await app.sdb.findOne('Account', { condition: { address: addr } })
    //   if (newAccount) {
    //     member.bail = newAccount.xas
    //   } else {
    //     member.bail = 0
    //   }
    //   const srcAccount = await app.sdb.findOne('Account', { condition: { address: member.address } })
    //   if (srcAccount) {
    //     member.name = srcAccount.name
    //   }
    // }))
    for (let i = 0; i < members.length; i++) {
      const addr = addressHelper.generateLockedAddress(members[i].address)
      // const newAccount = await app.sdb.findOne('Account', { condition: { address: addr } })
      const newAccount = await app.sdb.load('Account', { address: addr })
      if (newAccount) {
        members[i].bail = newAccount.xas
      } else {
        members[i].bail = 0
      }
      // const srcAccount = await app.sdb.findOne('Account', { condition: { address: members[i].address } })
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
    // const account = await app.sdb.findOne('Account', { condition: { address: addr } })
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

  async getAllBailAmount(gatewayName) {
    const members = await this.getElectedGatewayMember(gatewayName)
    let amount = 0
    members.forEach((member) => {
      amount += member.bail
    })
    return amount
  },

  async getBailTotalAmount(gatewayName) {
    const members = await this.getElectedGatewayMember(gatewayName)
    const member = await this.getMinimumBailMember(gatewayName)
    if (!member) return null
    return member.bail * (Math.floor(members.length / 2) + 1)
  },

  async getAmountByCurrency(gateway, symbol) {
    // const gwCurrency = await app.sdb.findOne('GatewayCurrency', { condition: { gateway, symbol } })
    const gwCurrency = await app.sdb.load('GatewayCurrency', { gateway, symbol })
    if (gwCurrency) {
      return gwCurrency.quantity
    }
    return 0
  },

  async getThreshold(gatewayName, memberAddr) {
    // Calculate Ap / B
    const gwCurrency = await app.sdb.findAll('GatewayCurrency', { condition: { gateway: gatewayName }, limit: 1 })
    const bancor = await Bancor.create(gwCurrency[0].symbol, 'XAS')
    const allBCH = await this.getAmountByCurrency(gatewayName, gwCurrency[0].symbol)
    const totalBail = await this.getBailTotalAmount(gatewayName)
    let ratio = 0
    let needSupply = 0
    let minimumBail = 0
    let currentBail = 0
    if (!bancor) {
      return { ratio, needSupply }
    }
    const result = await bancor.exchangeBySource(gwCurrency[0].symbol, 'XAS', allBCH, false)
    if (result.targetAmount.eq(0)) return { ratio, currentBail, needSupply }
    app.logger.debug(`====ratio: totalBail is ${totalBail}, targetAmount is ${result.targetAmount.toString()}`)
    ratioCalc = app.util.bignumber(totalBail).div(result.targetAmount)
    if (ratioCalc.lt(constants.warningCriteria)) {
      const minimumMember = await this.getMinimumBailMember(gatewayName)
      minimumBail = constants.supplyCriteria * minimumMember.bail
    }

    if (memberAddr) {
      const member = await this.getGatewayMember(gatewayName, memberAddr)
      if (member && minimumBail > member.bail) {
        needSupply = minimumBail - member.bail
      }
      if (member) {
        currentBail = member.bail
      }
    }
    ratio = Number(ratioCalc.toFixed(2).toString())
    return { ratio, currentBail, needSupply }
  },

  async getMaximumBailWithdrawl(gatewayName, memberAddr) {
    const gwCurrency = await app.sdb.findAll('GatewayCurrency', { condition: { gateway: gatewayName }, limit: 1 })
    const gatewayMembers = await this.getElectedGatewayMember(gatewayName)
    const count = gatewayMembers.length
    let canBeWithdrawl = 0
    const m = await this.getGatewayMember(gatewayName, memberAddr)
    if (!m) return 0
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const lockAccount = await app.sdb.load('Account', addr)
    if (!lockAccount) return canBeWithdrawl
    if (m.elected === 0) {
      return lockAccount.xas
    }
    const threshold = await this.getThreshold(gatewayName)

    if (m.elected === 1 && threshold.ratio > constants.supplyCriteria) {
      const bancor = await Bancor.create(gwCurrency[0].symbol, 'XAS')
      const result = await bancor.exchangeBySource(gwCurrency[0].symbol, 'XAS', gwCurrency[0].quantity, false)
      const needsBail = result.targetAmount.times(1.5).div(count).round()
      const initialDeposit = constants.initialDeposit
      app.logger.debug(`====needsBail is ${needsBail}, locked bail is ${lockAccount.xas}`)
      if (needsBail.le(initialDeposit)) {
        canBeWithdrawl = lockAccount.xas - initialDeposit
      } else if (needsBail.lt(lockAccount.xas)) {
        canBeWithdrawl = lockAccount.xas - needsBail.toNumber()
      }
    }
    return canBeWithdrawl
  },
}
