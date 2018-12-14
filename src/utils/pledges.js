const constants = require('../utils/constants.js')

module.exports = {
  async getNetEnergyLimit(address) {
    const pledgeAccount = await app.sdb.findOne('AccountPledge', { condition: { address } })
    if (!pledgeAccount) throw new Error('No pledge was found')
    const totalPledges = await app.sdb.findAll('AccountTotalPledge', { })
    if (totalPledges.length === 0) throw new Error('No pledge was found')
    const totalPledge = totalPledges[0]
    const netLimit = parseInt(pledgeAccount.pledgeAmountForBP
                    / totalPledge.totalPledgeForBP
                    * totalPledge.totalNetLimit, 10)
    const energyLimit = parseInt(pledgeAccount.pledgeAmountForEnergy
                      / totalPledge.totalPledgeForEnergy
                      * totalPledge.totalEnergyLimit, 10)
    const netUsed = pledgeAccount.netUsed
    const energyUsed = pledgeAccount.energyUsed
    const bpLockHeight = pledgeAccount.bpLockHeight
    const energyLockHeight = pledgeAccount.energyLockHeight
    const totalNetLimit = totalPledge.totalNetLimit
    const totalEnergyLimit = totalPledge.totalEnergyLimit
    return {
      netLimit,
      energyLimit,
      netUsed,
      energyUsed,
      bpLockHeight,
      energyLockHeight,
      totalNetLimit,
      totalEnergyLimit,
    }
  },

  async isNetCovered(fee, address, blockHeight) {
    let netUsed = fee * constants.netPerXAS
    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if ((netEnergyLimit.lastBPUpdateHeight + constants.blocksPerDay) > blockHeight) {
      netUsed += netEnergyLimit.netUsed
    }
    if (netUsed < netEnergyLimit.netLimit) {
      return true
    }
    return false
  },

  async updateNet(fee, address, blockHeight) {
    const netUsed = fee * constants.netPerXAS
    const pledgeAccount = await app.sdb.findOne('AccountPledge', { condition: { address } })
    if (!pledgeAccount) throw new Error('Pledge account is not found')
    if ((pledgeAccount.lastBPUpdateHeight + constants.blocksPerDay) < blockHeight) {
      pledgeAccount.netUsed += netUsed
      pledgeAccount.lastBPUpdateHeight = blockHeight
      app.sdb.update('AccountPledge', pledgeAccount, { address })
    }
  },

}
