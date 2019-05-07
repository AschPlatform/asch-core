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

async function allocateToDelegatesByVotes(delegates, rewards) {
  let votes = 0
  let count = 0
  let allocatedReward = 0
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
      const remainReward = rewards - allocatedReward
      await updateDelegate(address, 0, remainReward)
      await updateAccount(address, remainReward)
    } else {
      const ratioReward = Math.floor((rewards * delegate.votes) / votes)
      await updateDelegate(address, 0, ratioReward)
      await updateAccount(address, ratioReward)
      allocatedReward += ratioReward
    }
  }
}

module.exports = {
  async assignIncentive(groupName, forgedDelegates, fees, rewards) {
    const BASIC_BLOCK_REWARD_RATIO = 0.2
    const VOTING_REWARD_RATIO = 0.2
    const blockRewards = rewards * BASIC_BLOCK_REWARD_RATIO
    const votingRewards = rewards * VOTING_REWARD_RATIO
    const councilFound = rewards - blockRewards - votingRewards
    await allocateToGroup(groupName, councilFound)
    await allocateToDelegatesEqually(forgedDelegates, fees, blockRewards)
    await allocateToDelegatesByVotes(forgedDelegates, votingRewards)
  },
}
