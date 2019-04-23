const addressHelper = require('./address.js')

module.exports = {
  async allocateToGroup(groupName, amount) {
    // const group = await app.sdb.findOne('Group', { condition: { name: groupName } })
    // await this.updateAccount(group.address, amount)
    const address = addressHelper.generateGroupAddress(groupName)
    await this.updateAccount(address, amount)
  },

  async allocateToGroupMembersEqually(groupName, amount) {
    const groupMembers = await app.sdb.findAll('GroupMember', { condition: { name: groupName } })
    for (const groupMember of groupMembers) {
      await this.updateAccount(groupMember.member, Math.floor(amount / groupMembers.length))
    }
  },

  async allocateToDelegatesEqually(delegates, fees, rewards) {
    for (const pk of delegates) {
      const address = addressHelper.generateNormalAddress(pk)
      await this.updateDelegate(address, Math.floor(fees / delegates.length),
        Math.floor(rewards / delegates.length))
      await this.updateAccount(address,
        Math.floor(fees / delegates.length) + Math.floor(rewards / delegates.length))
    }
  },

  async allocateToDelegatesByVotes(delegates, fees, rewards) {
    let votes = 0
    for (const pk of delegates) {
      const address = addressHelper.generateNormalAddress(pk)
      const delegate = await app.sdb.findOne('Delegate', { condition: { address } })
      votes += delegate.votes
    }
    for (const pk of delegates) {
      const address = addressHelper.generateNormalAddress(pk)
      const delegate = await app.sdb.findOne('Delegate', { condition: { address } })
      await this.updateDelegate(address, Math.floor(fees * delegate.votes / votes),
        Math.floor(rewards * delegate.votes / votes))
      await this.updateAccount(address,
        Math.floor(fees * delegate.votes / votes) + Math.floor(rewards * delegate.votes / votes))
    }
  },

  async updateAccount(address, amount) {
    app.sdb.createOrLoad('Account', { xas: 0, address, name: null })
    app.sdb.increase('Account', { xas: amount }, { address })
  },

  async updateDelegate(address, fee, reward) {
    app.sdb.increase('Delegate', { fees: fee, rewards: reward }, { address })
  },
}
