const gatewayClassMap = new Map()

gatewayClassMap.set('bitcoin', require('./bitcoin-gateway'))
// gatewayClassMap.set('bitcoincash', require('./bitcoincash-gateway'))

const gatewayInstanceMap = new Map()

const utilClassMap = new Map()
utilClassMap.set('bitcoin', require('./bitcoin-util'))
// utilClassMap.set('bitcoincash', require('./bitcoincash-util'))

const utilMap = new Map()

module.exports = {
  createGatewayService(name, options) {
    if (gatewayInstanceMap.has(name)) {
      return gatewayInstanceMap.get(name)
    }
    const Klass = gatewayClassMap.get(name)
    if (!Klass) throw new Error('Unsupported gateway')
    const instance = new Klass(options)
    gatewayInstanceMap.set(name, instance)
    return instance
  },
  getGatewayService(name) {
    if (!gatewayInstanceMap.has(name)) throw new Error('Gateway service not found')
    return gatewayInstanceMap.get(name)
  },
  getGatewayUtil(name) {
    if (utilMap.has(name)) {
      return utilMap.get(name)
    }
    if (!utilClassMap.has(name)) throw new Error('Unsupported gateway')
    const Klass = utilClassMap.get(name)
    const netType = global.Config.netVersion === 'mainnet' ? 'mainnet' : 'testnet'
    const instance = new Klass(netType)
    utilMap.set(name, instance)
    return instance
  },
}
