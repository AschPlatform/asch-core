const Bancor = require('../utils/bancor.js')
const constants = require('../utils/constants.js')
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
    const gatewayMembers = await this.getElectedGatewayMember(gatewayName)
    const member = await this.getGatewayMember(gatewayName, memberAddr)
    const count = gatewayMembers.length
    let ratio = 0
    let needSupply = 0
    let minimumBail = 0
    let currentBail = 0
    if (member) {
      currentBail = member.bail
    }
    if (currentBail < constants.initialDeposit) {
      needSupply = constants.initialDeposit - currentBail
    }
    if (!bancor) {
      return { ratio, currentBail, needSupply }
    }
    if (member && member.elected === 0) {
      minimumBail = constants.initialDeposit
    }
    const sourceAmount = app.util.bignumber(bancor.getBancorInfo().moneyBalance).div(1000)
    const result = await bancor.exchangeBySource(gwCurrency[0].symbol, 'XAS', sourceAmount.toString(), false)
    result.targetAmount = result.targetAmount.times(allBCH).div(sourceAmount)
    if (result.targetAmount.eq(0)) {
      return { ratio, currentBail, needSupply }
    }
    app.logger.debug(`====ratio: totalBail is ${totalBail}, targetAmount is ${result.targetAmount.toString()}`)
    ratioCalc = app.util.bignumber(totalBail).div(result.targetAmount)
    ratio = Number(ratioCalc.toFixed(2).toString())
    if (ratioCalc.lt(constants.supplyCriteria) && member && member.elected !== 0) {
      minimumBail = Math.ceil(totalBail / ratio
        * constants.supplyCriteria / (Math.floor(count / 2) + 1))
      if (minimumBail < constants.initialDeposit) {
        minimumBail = constants.initialDeposit
      }
    }
    if (minimumBail > currentBail) {
      needSupply = minimumBail - currentBail
    }
    return { ratio, currentBail, needSupply }
  },

  async getNeedsBail(gatewayName) {
    const gwCurrency = await app.sdb.findAll('GatewayCurrency', { condition: { gateway: gatewayName }, limit: 1 })
    const gatewayMembers = await this.getElectedGatewayMember(gatewayName)
    const count = gatewayMembers.length
    const bancor = await Bancor.create(gwCurrency[0].symbol, 'XAS')
    if (!bancor) throw new Error(`Bancor from ${gwCurrency[0].symbol} to XAS is not ready`)
    const sourceAmount = app.util.bignumber(bancor.getBancorInfo().moneyBalance).div(1000)
    const result = await bancor.exchangeBySource(gwCurrency[0].symbol, 'XAS', sourceAmount.toString(), false)
    result.targetAmount = result.targetAmount.times(gwCurrency[0].quantity).div(sourceAmount)
    const needsBail = result.targetAmount.times(1.5).div(Math.floor(count / 2) + 1).round()
    return needsBail
  },

  async getMaximumBailWithdrawl(gatewayName, memberAddr) {
    let canBeWithdrawl = 0
    const m = await this.getGatewayMember(gatewayName, memberAddr)
    if (!m) return 0
    const addr = addressHelper.generateLockedAddress(memberAddr)
    const lockAccount = await app.sdb.load('Account', addr)
    if (!lockAccount) return canBeWithdrawl
    if (m.elected === 0) {
      return lockAccount.xas
    }
    const threshold = await this.getThreshold(gatewayName, memberAddr)

    if (m.elected === 1 && lockAccount.xas > constants.initialDeposit) {
      if (threshold.ratio === 0) {
        canBeWithdrawl = lockAccount.xas - constants.initialDeposit
      } else {
        const needsBail = await this.getNeedsBail(gatewayName)
        const initialDeposit = constants.initialDeposit
        app.logger.debug(`====needsBail is ${needsBail}, locked bail is ${lockAccount.xas}`)
        if (needsBail.lt(initialDeposit)) {
          canBeWithdrawl = lockAccount.xas - initialDeposit
        } else if (needsBail.lt(lockAccount.xas)) {
          canBeWithdrawl = lockAccount.xas - needsBail.toNumber()
        }
      }
    }
    return canBeWithdrawl
  },
}
