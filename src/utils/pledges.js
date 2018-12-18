const constants = require('../utils/constants.js')

module.exports = {
  async getNetEnergyLimit(address) {
    const pledgeAccount = await app.sdb.findOne('AccountPledge', { condition: { address } })
    if (!pledgeAccount) return null
    const totalPledges = await app.sdb.findAll('AccountTotalPledge', { })
    if (totalPledges.length === 0) return null
    const totalPledge = totalPledges[0]
    const netLimit = parseInt(pledgeAccount.pledgeAmountForBP
                    / totalPledge.totalPledgeForBP
                    * totalPledge.totalNetLimit, 10)
    const energyLimit = parseInt(pledgeAccount.pledgeAmountForEnergy
                      / totalPledge.totalPledgeForEnergy
                      * totalPledge.totalEnergyLimit, 10)
    const freeNetLimit = pledgeAccount.freeNetLimit
    const freeNetUsed = pledgeAccount.freeNetUsed
    const netUsed = pledgeAccount.netUsed
    const energyUsed = pledgeAccount.energyUsed
    const pledgeAmountForBP = pledgeAccount.pledgeAmountForBP
    const pledgeAmountForEnergy = pledgeAccount.pledgeAmountForEnergy
    const bpLockHeight = pledgeAccount.bpLockHeight
    const energyLockHeight = pledgeAccount.energyLockHeight
    const lastFreeNetUpdateHeight = pledgeAccount.lastFreeNetUpdateHeight
    const lastBPUpdateHeight = pledgeAccount.lastBPUpdateHeight
    const lastEnergyUpdateHeight = pledgeAccount.lastEnergyUpdateHeight
    const totalPledgeForBP = totalPledge.totalPledgeForBP
    const totalPledgeForEnergy = totalPledge.totalPledgeForEnergy
    const totalNetLimit = totalPledge.totalNetLimit
    const totalEnergyLimit = totalPledge.totalEnergyLimit
    return {
      netLimit,
      energyLimit,
      freeNetLimit,
      freeNetUsed,
      netUsed,
      energyUsed,
      pledgeAmountForBP,
      pledgeAmountForEnergy,
      bpLockHeight,
      energyLockHeight,
      lastFreeNetUpdateHeight,
      lastBPUpdateHeight,
      lastEnergyUpdateHeight,
      totalPledgeForBP,
      totalPledgeForEnergy,
      totalNetLimit,
      totalEnergyLimit,
    }
  },

  async isNetCovered(fee, address, blockHeight) {
    const netUsed = fee * constants.netPerXAS
    let totalUsed = netUsed

    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      return false
    }
    if ((netEnergyLimit.lastBPUpdateHeight + constants.blocksPerDay) > blockHeight) {
      totalUsed += netEnergyLimit.netUsed
    }
    if (totalUsed < netEnergyLimit.netLimit) {
      return true
    }
    totalUsed = netUsed
    if ((netEnergyLimit.lastFreeNetUpdateHeight + constants.blocksPerDay) > blockHeight) {
      totalUsed += netEnergyLimit.freeNetUsed
    }
    if (totalUsed < netEnergyLimit.freeNetLimit) {
      return true
    }
    return false
  },

  async updateNet(fee, address, blockHeight) {
    const pledgeAccount = await app.sdb.findOne('AccountPledge', { condition: { address } })
    if (!pledgeAccount) throw new Error('Pledge account is not found')
    const netUsed = fee * constants.netPerXAS
    let totalUsed = netUsed
    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      throw new Error('No pledge was found')
    }
    if ((netEnergyLimit.lastBPUpdateHeight + constants.blocksPerDay) > blockHeight) {
      totalUsed += netEnergyLimit.netUsed
    }
    if (totalUsed < netEnergyLimit.netLimit) {
      pledgeAccount.netUsed = totalUsed
      pledgeAccount.lastBPUpdateHeight = blockHeight
      app.sdb.update('AccountPledge', pledgeAccount, { address })
      return null
    }

    totalUsed = netUsed
    if ((netEnergyLimit.lastFreeNetUpdateHeight + constants.blocksPerDay) > blockHeight) {
      totalUsed += netEnergyLimit.freeNetUsed
    }
    if (totalUsed < netEnergyLimit.freeNetLimit) {
      pledgeAccount.freeNetUsed = totalUsed
      pledgeAccount.lastFreeNetUpdateHeight = blockHeight
      app.sdb.update('AccountPledge', pledgeAccount, { address })
    }

    return null
  },

}
