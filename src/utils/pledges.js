const constants = require('../utils/constants.js')

module.exports = {
  async getNetEnergyLimit(address) {
    const pledgeAccount = await app.sdb.load('AccountPledge', address)
    if (!pledgeAccount) return null
    const totalPledges = await app.sdb.loadMany('AccountTotalPledge', { })
    if (totalPledges.length === 0) return null
    const totalPledge = totalPledges[0]
    const netLimit = parseInt(pledgeAccount.pledgeAmountForNet
                              * totalPledge.netPerPledgedXAS / constants.fixedPoint, 10)
    const energyLimit = parseInt(pledgeAccount.pledgeAmountForEnergy
                              * totalPledge.energyPerPledgedXAS / constants.fixedPoint, 10)
    const freeNetLimit = totalPledge.freeNetLimit
    const freeNetUsed = pledgeAccount.freeNetUsed
    const netUsed = pledgeAccount.netUsed
    const energyUsed = pledgeAccount.energyUsed
    const pledgeAmountForNet = pledgeAccount.pledgeAmountForNet
    const pledgeAmountForEnergy = pledgeAccount.pledgeAmountForEnergy
    const netLockHeight = pledgeAccount.netLockHeight
    const energyLockHeight = pledgeAccount.energyLockHeight
    const lastFreeNetUpdateDay = pledgeAccount.lastFreeNetUpdateDay
    const lastNetUpdateDay = pledgeAccount.lastNetUpdateDay
    const lastEnergyUpdateDay = pledgeAccount.lastEnergyUpdateDay
    const heightOffset = pledgeAccount.heightOffset
    const totalPledgeForNet = totalPledge.totalPledgeForNet
    const totalPledgeForEnergy = totalPledge.totalPledgeForEnergy
    const netPerXAS = totalPledge.netPerXAS
    const energyPerXAS = totalPledge.energyPerXAS
    const netPerPledgedXAS = totalPledge.netPerPledgedXAS
    const energyPerPledgedXAS = totalPledge.energyPerPledgedXAS
    const gasprice = totalPledge.gasprice
    return {
      netLimit,
      energyLimit,
      freeNetLimit,
      freeNetUsed,
      netUsed,
      energyUsed,
      pledgeAmountForNet,
      pledgeAmountForEnergy,
      netLockHeight,
      energyLockHeight,
      lastFreeNetUpdateDay,
      lastNetUpdateDay,
      lastEnergyUpdateDay,
      heightOffset,
      totalPledgeForNet,
      totalPledgeForEnergy,
      netPerXAS,
      energyPerXAS,
      netPerPledgedXAS,
      energyPerPledgedXAS,
      gasprice,
    }
  },

  async getPledgeConfig() {
    const totalPledges = await app.sdb.loadMany('AccountTotalPledge', { })
    if (totalPledges.length === 0) return null
    const totalPledge = totalPledges[0]
    const freeNetLimit = totalPledge.freeNetLimit
    const totalPledgeForNet = totalPledge.totalPledgeForNet
    const totalPledgeForEnergy = totalPledge.totalPledgeForEnergy
    const netPerXAS = totalPledge.netPerXAS
    const energyPerXAS = totalPledge.energyPerXAS
    const netPerPledgedXAS = totalPledge.netPerPledgedXAS
    const energyPerPledgedXAS = totalPledge.energyPerPledgedXAS
    const gasprice = totalPledge.gasprice
    return {
      freeNetLimit,
      totalPledgeForNet,
      totalPledgeForEnergy,
      netPerXAS,
      energyPerXAS,
      netPerPledgedXAS,
      energyPerPledgedXAS,
      gasprice,
    }
  },

  async getEnergyByGas(gas) {
    const totalPledges = await app.sdb.loadMany('AccountTotalPledge', { })
    if (totalPledges.length === 0) return null

    const totalPledge = totalPledges[0]
    const energy = parseInt(gas * totalPledge.gasprice, 10)

    return energy
  },

  async getXASByGas(gas) {
    const totalPledges = await app.sdb.loadMany('AccountTotalPledge', { })
    if (totalPledges.length === 0) return null

    const totalPledge = totalPledges[0]
    const energy = gas * totalPledge.gasprice
    const xas = parseInt(energy * (constants.fixedPoint / totalPledge.energyPerXAS), 10)

    return xas
  },

  async isNetCovered(fee, address, blockHeight) {
    if (fee <= 0) {
      return true
    }

    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      return false
    }

    const netUsed = fee * netEnergyLimit.netPerXAS / constants.fixedPoint
    let totalUsed = netUsed

    const actualHeight = blockHeight - netEnergyLimit.heightOffset
    const now = Number.parseInt(actualHeight / constants.blocksPerDay, 10)
    if (now <= netEnergyLimit.lastNetUpdateDay) {
      totalUsed += netEnergyLimit.netUsed
    }
    return totalUsed <= netEnergyLimit.netLimit

    // totalUsed = netUsed
    // if (now <= netEnergyLimit.lastFreeNetUpdateDay) {
    //   totalUsed += netEnergyLimit.freeNetUsed
    // }
    // if (totalUsed <= netEnergyLimit.freeNetLimit) {
    //   return true
    // }
    // return false
  },

  async isEnergyCovered(gasLimit, address, blockHeight) {
    if (gasLimit <= 0) {
      return true
    }

    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      return false
    }

    const energyUsed = gasLimit * netEnergyLimit.gasprice
    let totalUsed = energyUsed

    const actualHeight = blockHeight - netEnergyLimit.heightOffset
    const now = Number.parseInt(actualHeight / constants.blocksPerDay, 10)
    if (now <= netEnergyLimit.lastEnergyUpdateDay) {
      totalUsed += netEnergyLimit.energyUsed
    }
    return totalUsed <= netEnergyLimit.energyLimit
  },

  async consumeGasFee(fee, address, height, tid) {
    if (fee <= 0) return null
    const account = await app.sdb.load('Account', address)
    if (!account) throw new Error('Account is not found')
    if (fee > account.xas) throw new Error('Insufficient balance')
    app.sdb.increase('Account', { xas: -fee }, { address })
    app.sdb.create('Netenergyconsumption', {
      tid,
      height,
      fee,
      isFeeDeduct: 1,
      address,
    })

    return null
  },

  async consumeEnergy(energy, address, blockHeight, tid) {
    if (energy <= 0) return null

    const pledgeAccount = await app.sdb.load('AccountPledge', address)
    if (!pledgeAccount) throw new Error('Pledge account is not found')
    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      throw new Error('No pledge was found')
    }

    const energyUsed = energy
    let totalUsed = energyUsed
    const actualHeight = blockHeight - netEnergyLimit.heightOffset
    const now = Number.parseInt(actualHeight / constants.blocksPerDay, 10)

    if (now <= netEnergyLimit.lastEnergyUpdateDay) {
      totalUsed += netEnergyLimit.energyUsed
    } else {
      pledgeAccount.lastEnergyUpdateDay = now
    }
    if (totalUsed <= netEnergyLimit.energyLimit) {
      pledgeAccount.energyUsed = totalUsed
      app.sdb.update('AccountPledge', pledgeAccount, { address })
      app.sdb.create('Netenergyconsumption', {
        tid,
        height: blockHeight,
        energyUsed,
        isFeeDeduct: 0,
        address,
      })
    }
    return null
  },

  async consumeNet(fee, address, blockHeight, tid) {
    const pledgeAccount = await app.sdb.load('AccountPledge', address)
    if (!pledgeAccount) throw new Error('Pledge account is not found')
    const netEnergyLimit = await this.getNetEnergyLimit(address)
    if (!netEnergyLimit) {
      throw new Error('No pledge was found')
    }
    const netUsed = fee * netEnergyLimit.netPerXAS / constants.fixedPoint
    if (netUsed <= 0) return null

    let totalUsed = netUsed
    const actualHeight = blockHeight - netEnergyLimit.heightOffset
    const now = Number.parseInt(actualHeight / constants.blocksPerDay, 10)
    if (now <= netEnergyLimit.lastNetUpdateDay) {
      totalUsed += netEnergyLimit.netUsed
    } else {
      pledgeAccount.lastNetUpdateDay = now
    }

    if (totalUsed <= netEnergyLimit.netLimit) {
      pledgeAccount.netUsed = totalUsed
      app.sdb.update('AccountPledge', pledgeAccount, { address })
      app.sdb.create('Netenergyconsumption', {
        tid,
        height: blockHeight,
        netUsed,
        isFeeDeduct: 0,
        address,
      })
      return null
    }

    // totalUsed = netUsed
    // if (now <= netEnergyLimit.lastFreeNetUpdateDay) {
    //   totalUsed += netEnergyLimit.freeNetUsed
    // } else {
    //   pledgeAccount.lastFreeNetUpdateDay = now
    // }
    // if (totalUsed <= netEnergyLimit.freeNetLimit) {
    //   pledgeAccount.freeNetUsed = totalUsed
    //   app.sdb.update('AccountPledge', pledgeAccount, { address })
    //   app.sdb.create('Netenergyconsumption', {
    //     tid,
    //     height: blockHeight,
    //     netUsed,
    //     isFeeDeduct: 0,
    //     address,
    //   })
    // }

    return null
  },

}
