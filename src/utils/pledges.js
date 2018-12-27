const constants = require('../utils/constants.js')

module.exports = {
  async getNetEnergyLimit(address) {
    const pledgeAccount = await app.sdb.load('AccountPledge', address)
    if (!pledgeAccount) return null
    const totalPledges = await app.sdb.loadMany('AccountTotalPledge', { })
    if (totalPledges.length === 0) return null
    const totalPledge = totalPledges[0]
    const netLimit = parseInt(pledgeAccount.pledgeAmountForBP
                    / totalPledge.totalPledgeForBP
                    * totalPledge.totalNetLimit, 10)
    const energyLimit = parseInt(pledgeAccount.pledgeAmountForEnergy
                      / totalPledge.totalPledgeForEnergy
                      * totalPledge.totalEnergyLimit, 10)
    const freeNetLimit = totalPledge.freeNetLimit
    const freeNetUsed = pledgeAccount.freeNetUsed
    const netUsed = pledgeAccount.netUsed
    const energyUsed = pledgeAccount.energyUsed
    const pledgeAmountForBP = pledgeAccount.pledgeAmountForBP
    const pledgeAmountForEnergy = pledgeAccount.pledgeAmountForEnergy
    const bpLockHeight = pledgeAccount.bpLockHeight
    const energyLockHeight = pledgeAccount.energyLockHeight
    const lastFreeNetUpdateDay = pledgeAccount.lastFreeNetUpdateDay
    const lastBPUpdateDay = pledgeAccount.lastBPUpdateDay
    const lastEnergyUpdateDay = pledgeAccount.lastEnergyUpdateDay
    const heightOffset = pledgeAccount.heightOffset
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
      lastFreeNetUpdateDay,
      lastBPUpdateDay,
      lastEnergyUpdateDay,
      heightOffset,
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
    const currentDay = (blockHeight - netEnergyLimit.heightOffset) % constants.blocksPerDay
    // if ((netEnergyLimit.lastBPUpdateHeight + constants.blocksPerDay) > blockHeight) {
    if (currentDay <= netEnergyLimit.lastBPUpdateDay) {
      totalUsed += netEnergyLimit.netUsed
    }
    if (totalUsed < netEnergyLimit.netLimit) {
      return true
    }
    totalUsed = netUsed
    // if ((netEnergyLimit.lastFreeNetUpdateHeight + constants.blocksPerDay) > blockHeight) {
    if (currentDay <= netEnergyLimit.lastFreeNetUpdateDay) {
      totalUsed += netEnergyLimit.freeNetUsed
    }
    if (totalUsed < netEnergyLimit.freeNetLimit) {
      return true
    }
    return false
  },

  async isEnergyCovered(gasLimit, address, blockHeight) {
    const energyUsed = gasLimit * constants.energyPerGas
    let totalUsed = energyUsed
    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      return false
    }

    const currentDay = (blockHeight - netEnergyLimit.heightOffset) % constants.blocksPerDay
    // if ((netEnergyLimit.lastEnergyUpdateHeight + constants.blocksPerDay) > blockHeight) {
    if (currentDay <= netEnergyLimit.lastEnergyUpdateDay) {
      totalUsed += netEnergyLimit.energyUsed
    }
    if (totalUsed < netEnergyLimit.energyLimit) {
      return true
    }

    return false
  },

  async updateNet(fee, address, blockHeight, tid) {
    const pledgeAccount = await app.sdb.load('AccountPledge', address)
    if (!pledgeAccount) throw new Error('Pledge account is not found')
    const netUsed = fee * constants.netPerXAS
    let totalUsed = netUsed
    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      throw new Error('No pledge was found')
    }
    const actualHeight = blockHeight - netEnergyLimit.heightOffset
    const currentDay = actualHeight % constants.blocksPerDay
    // if ((netEnergyLimit.lastBPUpdateHeight + constants.blocksPerDay) > blockHeight) {
    if (currentDay <= netEnergyLimit.lastBPUpdateDay) {
      totalUsed += netEnergyLimit.netUsed
    } else {
      pledgeAccount.lastBPUpdateDay = currentDay
    }
    if (totalUsed < netEnergyLimit.netLimit) {
      pledgeAccount.netUsed = totalUsed
      // pledgeAccount.lastBPUpdateHeight = blockHeight
      app.sdb.update('AccountPledge', pledgeAccount, { address })
      return null
    }

    totalUsed = netUsed
    // if ((netEnergyLimit.lastFreeNetUpdateHeight + constants.blocksPerDay) > blockHeight) {
    if (currentDay <= netEnergyLimit.lastFreeNetUpdateDay) {
      totalUsed += netEnergyLimit.freeNetUsed
    } else {
      pledgeAccount.lastFreeNetUpdateDay = currentDay
    }
    if (totalUsed < netEnergyLimit.freeNetLimit) {
      pledgeAccount.freeNetUsed = totalUsed
      // pledgeAccount.lastFreeNetUpdateHeight = blockHeight
      app.sdb.update('AccountPledge', pledgeAccount, { address })
    }

    app.sdb.create('Netenergyconsumption', {
      tid,
      height: blockHeight,
      netUsed,
      isFeeDeduct: 0,
    })

    return null
  },

}
