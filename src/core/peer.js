const path = require('path')
const fs = require('fs')
const ip = require('ip')
const crypto = require('crypto')
const base58check = require('../utils/base58check')
const ed = require('../utils/ed')
const _ = require('lodash')
const P2PNode = require('fastp2p')
const PeerInfo = require('fastp2p/peer-addr')
const Router = require('../utils/router.js')
const sandboxHelper = require('../utils/sandbox.js')

let modules
let library
let self

const DEFAULT_PEER_TIMEOUT = 4000

const priv = {
  peerTimeout: null,
  nodeIdentity: null,
  p2pNode: null,

  generateRandomIdentity: () => {
    const random = String(Math.round(Math.random() * 1000000000)) + String(Date.now())
    const hash = crypto.createHash('sha256').update(random, 'utf-8').digest()
    const keypair = ed.MakeKeypair(hash)
    return {
      id: priv.generatePeerId(keypair.publicKey),
      publicKey: keypair.publicKey.toString('hex'),
      privateKey: keypair.privateKey.toString('hex')
    }
  },

  generatePeerId: (publicKey) => {
    const hash1 = crypto.createHash('sha256').update(publicKey).digest()
    const hash2 = crypto.createHash('ripemd160').update(hash1).digest()
    return 'P' + base58check.encode(hash2)
  },

  getNodeIdentity: (path) => {
    if (!fs.existsSync(path)) {
      const identity = priv.generateRandomIdentity()
      fs.writeFileSync(path, JSON.stringify(identity))
      return identity
    }

    const content = fs.readFileSync(path).toString('utf8')
    return JSON.parse(content)
  },

  getLocalPeerId: () => {
    return priv.nodeIdentity.id
  },
  
  getAddress(ip, port, id) {
    return `/ipv4/${ip}/tcp/${port}/${id}`
  },

  initP2P: async (p2pOptions) => {
    const { publicIp, peerPort, peersDbDir, timeout = DEFAULT_PEER_TIMEOUT, seedList = [] } = p2pOptions 
    
    const nodeIdPath = path.join(peersDbDir, 'nodeId')
    const identity = priv.getNodeIdentity(nodeIdPath)
    const p2pNode = new P2PNode({
      config: {
        seeds: seedList.map(n => priv.getAddress(n.ip, n.port, n.id)),
        publicIp: ip.isPublic(publicIp) ? publicIp : '',
        peerDb: path.join(peersDbDir, 'peers.db')
      },
      port: peerPort,
      id: identity.id
    })

    priv.nodeIdentity = identity
    priv.peerTimeout = timeout
    priv.p2pNode = p2pNode

    await p2pNode.initialize()
    p2pNode.start()
  },

  isConnected: (peerId) => {
    return priv.p2pNode.connections.has(peerId)
  },

  getRandomPeerId: () => {  
    let peerIds = priv.getPeerIds() 
    //peerIds = peerIds.length === 0 ? priv.bootstrapPeerIds : peerIds
    const rnd = Math.floor(Math.random() * peerIds.length)
    return peerIds[rnd]     
  },

  getPeerIds: () => {
    return priv.p2pNode.getPeers()
  },

  getPeers: () => {
    return priv.p2pNode.discovery.peerBook.getUnbannedPeers()
  },

  handleRPC: (method, handler) => {
    priv.p2pNode.rpc.serve(method, handler)
  },

  peerRequest: (peerId, method, params, timeout, cb) => {
    let isCallbacked = false
    setTimeout(() => {
      if (isCallbacked) return
      isCallbacked = true
      cb(`requet ${method} from ${peerId} timeout`, params)
    }, timeout || priv.peerTimeout)

    return priv.p2pNode.rpc.request(peerId, method, params, (err, result) => {
      if (isCallbacked) return
      isCallbacked = true
      cb(err, result, peerId)
    })
  },

  publish: (topic, data) => {
    priv.p2pNode.gossip.publish(topic, data)
  },

  subscribe: (topic, handler) => {
    const isBuffer = (value) => {
      return !!value && typeof value === 'object' &&
        value['type'] === 'Buffer' && 
        Array.isArray(value['data'])
    }

    priv.p2pNode.gossip.subscribe(topic, (msg, peerId) => {
      const { topic, data } = msg
      if (!topic) {
        library.logger.debug('Receive invalid publish message topic', topic, msg)
        return
      }

      let formattedData = {}
      if (!!data) {
        for (const key in data) {
          const item = data[key]
          formattedData[key] = isBuffer(item) ? Buffer.from(item['data']) : item
        }
      }
      
      handler(formattedData, peerId, (err, forward) => {
        // if (err) {
        //   library.logger.debug('Fail to handler publish message', msg, err)
        //   return 
        // }
  
        if (forward) {
          priv.p2pNode.gossip.forward(msg)
        }
      })
    })
  },
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
    return res.status(500).send({ success: false, error: 'Blockchain is loading' })
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

Peer.prototype.getPeerId = () => {
  return priv.getLocalPeerId()
}

Peer.prototype.isConnected = (peerId) => {
  return priv.isConnected(peerId)
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

Peer.prototype.handleRPC = (method, handler) => {
  //handler: (req: { params, peer }, callback) => void
  priv.handleRPC(method, handler)
}

Peer.prototype.subscribe = (topic, handler) => {
  //handler: (message, peerId, callback) => void
  //foward the message if arguments[1] of callback is true 
  priv.subscribe(topic, handler)
}

Peer.prototype.publish = (topic, data) => {
  if (!priv.p2pNode) {
    library.logger.warn('network is not ready')
    return
  }
  priv.publish(topic, data)
}

Peer.prototype.request = (method, params, peerId, cb) => {
  if (!priv.p2pNode) {
    library.logger.warn('network is not ready')
    return
  }
  library.logger.debug(`start to request '${method}' params = %t from ${peerId},`, params)
  priv.peerRequest(peerId, method, params, undefined, cb)
}

Peer.prototype.randomRequest = (method, params, cb) => {
  const peerId = priv.getRandomPeerId()
  if (!peerId) return cb('None peer found')
  
  library.logger.debug('select random peer', peerId)
  self.request(method, params, peerId, cb)
}

Peer.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

// Events
Peer.prototype.onBind = (scope) => {
  modules = scope
}

Peer.prototype.onBlockchainReady = () => {
  const { publicIp, peerPort } = library.config
  const { list, blackList, timeout } = library.config.peers
  
  priv.attachApi()
  priv.initP2P({
    publicIp,
    peerPort,
    seedList: list,
    blackList: blackList,
    timeout,
    peersDbDir: global.Config.dataDir,
  }).then(() => {
    library.logger.info('initialize p2p network OK')
    library.bus.message('peerReady')
  }).catch((err) => {
    library.logger.error('Fail to initialize p2p netwrok', err)
  })
}

shared.getPeers = (req, cb) => {
  if (!priv.p2pNode) {
    library.logger.warn('network is not ready')
    return
  }
  const peers = priv.getPeers().map(p => {
    const { host, port, id } = PeerInfo.parse(p.addr)
    return { host, port, id }
  })
  setImmediate(()=> cb(null, { peers })) 
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
