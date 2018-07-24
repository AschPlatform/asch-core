const gateway = require('../gateway')

let library
let self
const priv = {
  gatewayService: null,
}

function Gateway(cb, scope) {
  library = scope
  self = this

  setImmediate(cb, null, self)
}

Gateway.prototype.onBlockchainReady = () => {
  if (global.Config.gateway && global.Config.gateway.name) {
    const rpc = global.Config.gateway.rpc
    if (!rpc) {
      library.logger.info('no gateway rpc config')
      return
    }
    if (!rpc.username || !rpc.password || !rpc.port || !rpc.host) {
      library.logger.error('invalid gateway rpc config:', rpc)
      return
    }

    const netType = global.Config.netVersion === 'mainnet' ? 'mainnet' : 'testnet'
    try {
      const name = global.Config.gateway.name
      const currency = global.Config.gateway.currency
      const outSecret = global.Config.gateway.outSecret
      const secret = global.Config.gateway.secret
      priv.gatewayService = gateway.createGatewayService(name, {
        name,
        rpc,
        netType,
        currency,
        secret,
        outSecret,
        sdb: app.sdb,
      })
      priv.gatewayService.start()
    } catch (e) {
      library.logger.error('failed to start gateway service', e)
    }
  }
}

Gateway.prototype.onBind = (scope) => {
  modules = scope
}

Gateway.prototype.cleanup = (cb) => {
  if (priv.gatewayService) priv.gatewayService.stop()
  cb()
}

module.exports = Gateway
