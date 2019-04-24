const addressHelper = require('./address.js')

async function updateAccount(address, amount) {
  app.sdb.createOrLoad('Account', { xas: 0, address, name: null })
  app.sdb.increase('Account', { xas: amount }, { address })
}

async function updateDelegate(address, fee, reward) {
  app.sdb.increase('Delegate', { fees: fee, rewards: reward }, { address })
}

async function allocateToGroup(groupName, amount) {
  const address = addressHelper.generateGroupAddress(groupName)
  await updateAccount(address, amount)
}

async function allocateToDelegatesEqually(delegates, fees, rewards) {
  const averageFee = Math.floor(fees / delegates.length)
  const averageReward = Math.floor(rewards / delegates.length)
  let count = 0
  let usedFee = 0
  let usedReward = 0
  for (const pk of delegates) {
    const address = addressHelper.generateNormalAddress(pk)
    count++
    if (count === delegates.length) {
      const remainFee = fees - usedFee
      const remainReward = rewards - usedReward
      await updateDelegate(address, remainFee, remainReward)
      await updateAccount(address, remainFee + remainReward)
    } else {
      await updateDelegate(address, averageFee, averageReward)
      await updateAccount(address, averageFee + averageReward)
      usedFee += averageFee
      usedReward += averageReward
    }
  }
}

async function allocateToDelegatesByVotes(delegates, fees, rewards) {
  let votes = 0
  let count = 0
  let usedFee = 0
  let usedReward = 0
  for (const pk of delegates) {
    const address = addressHelper.generateNormalAddress(pk)
    const delegate = await app.sdb.findOne('Delegate', { condition: { address } })
    votes += delegate.votes
  }
  for (const pk of delegates) {
    count++
    const address = addressHelper.generateNormalAddress(pk)
    const delegate = await app.sdb.findOne('Delegate', { condition: { address } })
    if (count === delegates.length) {
      const remainFee = fees - usedFee
      const remainReward = rewards - usedReward
      await updateDelegate(address, remainFee, remainReward)
      await updateAccount(address, remainFee + remainReward)
    } else {
      const ratioFee = Math.floor(fees * delegate.votes / votes)
      const ratioReward = Math.floor(rewards * delegate.votes / votes)
      await updateDelegate(address, ratioFee, ratioReward)
      await updateAccount(address, ratioFee + ratioReward)
      usedFee += ratioFee
      usedReward += ratioReward
    }
  }
}

module.exports = {
  async assignIncentive(groupName, forgedDelegates, fees, rewards) {
    const fee = Math.floor(fees / 100)
    const reward = Math.floor(rewards / 100)
    await allocateToGroup(groupName, fees + rewards - fee * 40 - reward * 40)
    await allocateToDelegatesEqually(forgedDelegates, fee * 20, reward * 20)
    await allocateToDelegatesByVotes(forgedDelegates, fee * 20, reward * 20)
  },
}
