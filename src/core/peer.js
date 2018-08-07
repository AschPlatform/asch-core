const path = require('path')
const ip = require('ip')
const crypto = require('crypto')
const _ = require('lodash')
const DHT = require('bittorrent-dht')
const request = require('request')
const Router = require('../utils/router.js')
const sandboxHelper = require('../utils/sandbox.js')
const utils = require('../utils')

let modules
let library
let self
const priv = {
  handlers: {},
  dht: null,
}
const shared = {}

// Constructor
function Peer(cb, scope) {
  library = scope
  self = this

  priv.attachApi()
  setImmediate(cb, null, self)
}

// priv methods
priv.attachApi = () => {
  const router = new Router()

  router.use((req, res, next) => {
    if (modules) return next()
    return es.status(500).send({ success: false, error: 'Blockchain is loading' })
  })

  router.map(shared, {
    'get /': 'getPeers',
    'get /version': 'version',
    'get /get': 'getPeer',
  })

  router.use((req, res) => {
    res.status(500).send({ success: false, error: 'API endpoint not found' })
  })

  library.network.app.use('/api/peers', router)
  library.network.app.use((err, req, res, next) => {
    if (!err) return next()
    library.logger.error(req.url, err.toString())
    return res.status(500).send({ success: false, error: err.toString() })
  })
}

Peer.prototype.list = (options, cb) => {
  // FIXME
  options.limit = options.limit || 100
  return cb(null, [])
}

Peer.prototype.remove = (pip, port, cb) => {
  const peers = library.config.peers.list
  const isFrozenList = peers.find(peer => peer.ip === ip.fromLong(pip) && peer.port === port)
  if (isFrozenList !== undefined) return cb && cb('Peer in white list')
  // FIXME
  return cb()
}

Peer.prototype.addChain = (config, cb) => {
  // FIXME
  cb()
}

Peer.prototype.getVersion = () => ({
  version: library.config.version,
  build: library.config.buildVersion,
  net: library.config.netVersion,
})

Peer.prototype.isCompatible = (version) => {
  const nums = version.split('.').map(Number)
  if (nums.length !== 3) {
    return true
  }
  let compatibleVersion = '0.0.0'
  if (library.config.netVersion === 'testnet') {
    compatibleVersion = '1.2.3'
  } else if (library.config.netVersion === 'mainnet') {
    compatibleVersion = '1.3.1'
  }
  const numsCompatible = compatibleVersion.split('.').map(Number)
  for (let i = 0; i < nums.length; ++i) {
    if (nums[i] < numsCompatible[i]) {
      return false
    } if (nums[i] > numsCompatible[i]) {
      return true
    }
  }
  return true
}

Peer.prototype.getIdentity = (contact) => {
  const address = `${contact.host}:${contact.port}`
  return crypto.createHash('ripemd160').update(address).digest().toString('hex')
}

Peer.prototype.subscribe = (topic, handler) => {
  priv.handlers[topic] = handler
}

Peer.prototype.onpublish = (msg, peer) => {
  if (!msg || !msg.topic || !priv.handlers[msg.topic.toString()]) {
    library.logger.debug('Receive invalid publish message topic', msg)
    return
  }
  priv.handlers[msg.topic](msg, peer)
}

Peer.prototype.publish = (topic, message, recursive = 1) => {
  if (!priv.dht) {
    library.logger.warning('dht network is not ready')
    return
  }
  message.topic = topic
  message.recursive = recursive
  priv.dht.broadcast(message)
}

Peer.prototype.request = (method, params, contact, cb) => {
  const address = `${contact.host}:${contact.port - 1}`
  const uri = `http://${address}/peer/${method}`
  library.logger.debug(`start to request ${uri}`)
  const reqOptions = {
    uri,
    method: 'POST',
    body: params,
    headers: {
      magic: global.Config.magic,
      version: global.Config.version,
    },
    json: true,
  }
  request(reqOptions, (err, response, result) => {
    if (err) {
      return cb(`Failed to request remote peer: ${err}`)
    } else if (response.statusCode !== 200) {
      library.logger.debug('remote service error', result)
      return cb(`Invalid status code: ${response.statusCode}`)
    }
    return cb(null, result)
  })
}

Peer.prototype.randomRequest = (method, params, cb) => {
  const randomNode = priv.dht.getRandomNode()
  if (!randomNode) return cb('No contact')
  library.logger.debug('select random contract', randomNode)
  let isCallbacked = false
  setTimeout(() => {
    if (isCallbacked) return
    isCallbacked = true
    cb('Timeout', undefined, randomNode)
  }, 4000)
  return self.request(method, params, randomNode, (err, result) => {
    if (isCallbacked) return
    isCallbacked = true
    cb(err, result, randomNode)
  })
}

Peer.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

// Events
Peer.prototype.onBind = (scope) => {
  modules = scope
}

Peer.prototype.refresh = () => {
  console.log('-----refresh')
  for (const seed of global.Config.peers.list) {
    const node = {
      host: seed.ip,
      port: seed.port,
    }
    node.id = self.getIdentity(node)
    if (priv.dht) priv.dht.addNode(node)
  }
}

Peer.prototype.onBlockchainReady = () => {
  priv.dht = new DHT()
  const port = global.Config.peerPort
  priv.dht.listen(port, () => {
    library.logger.info(`p2p server listen on ${port}`)
  })
  priv.dht.on('node', (node) => {
    library.logger.info(`find new node ${node.host}:${node.port}`)
  })
  priv.dht.on('broadcast', (msg, node) => {
    self.onpublish(msg, node)
  })
  for (const seed of global.Config.peers.list) {
    const node = {
      host: seed.ip,
      port: seed.port,
    }
    node.id = self.getIdentity(node)
    priv.dht.addNode(node)
  }
  library.bus.message('peerReady')
  utils.loopAsyncFunction(self.refresh.bind(self), 60 * 1000)
}

shared.getPeers = (req, cb) => {
  // FIXME
  cb(null, [])
}

shared.getPeer = (req, cb) => {
  cb(null, {})
}

shared.version = (req, cb) => {
  cb(null, {
    version: library.config.version,
    build: library.config.buildVersion,
    net: library.config.netVersion,
  })
}

module.exports = Peer
