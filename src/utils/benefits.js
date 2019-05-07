const addressHelper = require('./address.js')

async function updateAccount(address, amount) {
  app.sdb.createOrLoad('Account', { xas: 0, address, name: null })
  app.sdb.increase('Account', { xas: amount }, { address })
}

async function updateDelegate(address, fee, reward) {
  app.sdb.increase('Delegate', { fees: fee, rewards: reward }, { address })
}

async function updateDelegateReward(address, reward) {
  app.sdb.increase('Delegate', { rewards: reward }, { address })
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

async function allocateToDelegatesByVotes(delegatesMap, totalVotes, delegates, rewards) {
  let allocatedRewards = 0
  for (let i = 0; i < delegates.length; i++) {
    const pk = delegates[i]
    const address = addressHelper.generateNormalAddress(pk)
    const delegate = delegatesMap.get(address)
    if (i < delegates.length) {
      const ratioRewards = rewards * (delegate.votes / totalVotes)
      await updateDelegateReward(address, ratioRewards)
      await updateAccount(address, ratioRewards)
      allocatedRewards += ratioRewards
    } else {
      const remainedRewards = rewards - allocatedRewards
      await updateDelegateReward(address, remainedRewards)
      await updateAccount(address, remainedRewards)
    }
  }
}

module.exports = {
  async assignIncentive(forgedDelegates, fees, rewards) {
    const COUNCIL_NAME = 'asch_council'
    const BASIC_BLOCK_REWARD_RATIO = 0.2
    const VOTING_REWARD_RATIO = 0.2
    const blockRewards = rewards * BASIC_BLOCK_REWARD_RATIO
    const votingRewards = rewards * VOTING_REWARD_RATIO
    const councilFound = rewards - blockRewards - votingRewards
    await allocateToGroup(COUNCIL_NAME, councilFound)

    const allDelegates = app.sdb.getAll('Delegate')
    const delegatesMap = new Map()
    let totalVotes = 0
    for (const d of allDelegates) {
      delegatesMap.set(d.address, d)
    }
    for (const pk of forgedDelegates) {
      const address = addressHelper.generateNormalAddress(pk)
      totalVotes += delegatesMap.get(address).votes
    }
    if (totalVotes > 0) {
      await allocateToDelegatesEqually(forgedDelegates, fees, blockRewards)
      await allocateToDelegatesByVotes(delegatesMap, totalVotes, forgedDelegates, votingRewards)
    } else {
      await allocateToDelegatesEqually(forgedDelegates, fees, blockRewards + votingRewards)
    }
  },
}
