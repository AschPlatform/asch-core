const path = require('path')
const ip = require('ip')
const crypto = require('crypto')
const _ = require('lodash')
const DHT = require('bittorrent-dht')
const axios = require('axios')
const Router = require('../utils/router.js')
const sandboxHelper = require('../utils/sandbox.js')
const { promisify } = require('util')
const Database = require('nedb')
const { EventEmitter } = require('events')
// const fs = require('fs')

let modules
let library
let self

const SAVE_PEERS_INTERVAL = 1 * 60 * 1000
const CHECK_BUCKET_OUTDATE = 3 * 60 * 1000
const RECONNECT_SEED_INTERVAL = 30 * 1000

const CHECK_COMPATIABLE_NODES_INTERVAL = 1 * 60 * 1000
const CHECK_UNCOMPATIABLE_NODES_INTERVAL = 2 * 60 * 1000
const DEFAULT_PEER_TIMEOUT = 4 * 1000

// interface NodeInfo {
//   host: string
//   port: number
//   status: NodeStatus
//   updateAt: timestamp
//   isSeed: boolean

//   height: number
//   blockId: string
//   magic: string
//   net: string
//   version: string
// }

const NodeStatus = {
  Unknow : 0,
  Healthy : 1,
  Unhealthy : 2,

  Uncompatiable : -1
}

class NodeManager extends EventEmitter {
  constructor() {
    super()
    this._allNodes = new Map()
    this._shackingNodes = new Set()
    this._isChecking = false
    this._checkCompatiableTimer = undefined
    this._checkUncompatiableTimer = undefined
  }

  get healthyNodes() {
    return [...this._allNodes.values()].filter(n => n.status === NodeStatus.Healthy)
  }

  get compatibleNodes() {
    return [...this._allNodes.values()].filter(n => n.status === NodeStatus.Healthy || n.status === NodeStatus.Unhealthy)
  }

  get uncompatibleNodes() {
    return [...this._allNodes.values()].filter(n => n.status === NodeStatus.Uncompatiable || n.status === NodeStatus.Unknow)
  }

  isHealthy( height, blockId ) {
    const lastBlock = modules.blocks.getLastBlock()
    return lastBlock.height <= height + 100
  }

  isCompatible ( net, version, magic ) {
    if (net !== library.config.netVersion) return false
    if (magic && magic !== library.config.magic) return false

    if (version === library.config.version)  return true

    const [nodeMajor, nodeMinor, nodePath] = version
    if ([nodeMajor, nodeMajor, nodePath].some(v => !Number.isInteger(v))) return false

    const [major, minor, path ] = library.config.version.split('.')

    return nodeMajor === major && minor === nodeMinor && path <= nodePath
  }

  startCheckNodes() {
    const checkCompatiableNodes = () => this.compatibleNodes
      .forEach( node => this._checkCompatiableNode(node) )

    const checkUncompatiableNodes = () => this.uncompatibleNodes
      .forEach( node => this._checkUncompatiableNode(node) )

    if (this._isChecking) return 

    library.logger.debug(`start check nodes`)

    this._isChecking = true
    this._checkCompatiableTimer = setInterval(checkCompatiableNodes, CHECK_COMPATIABLE_NODES_INTERVAL)
    this._checkUncompatiableTimer = setInterval(checkUncompatiableNodes, CHECK_UNCOMPATIABLE_NODES_INTERVAL)
  }

  stopCheckNodes() {
    if (!this._isChecking) return 

    if (this._checkCompatiableTimer)
      clearInterval(this._checkUncompatiableNode)
    if (this._checkCompatiableTimer)
      clearInterval(this._checkUncompatiableNode)
  }

  updateNodeHealthy(peer, height, blockId) {
    const node = this.getNodeInfo(peer)
    if (node === undefined)  return false
    if (node.status === NodeStatus.Uncompatiable || node.status === NodeStatus.Unknow) return false

    const status = this.isHealthy(height, blockId) ? NodeStatus.Healthy : NodeStatus.Unhealthy
    this._updateNode(node, { status, height, blockId })

    return true
  }

  setUncompatiable(ip, magic) {
    this._allNodes.forEach( node => {
      if (node.host === ip) {
        this._updateNode(node, { magic, status: NodeStatus.Uncompatiable})
      }
    })
  }

  getNodeInfo(peer) {
    return this._allNodes.get(this._makeId(peer))
  }

  addPeer(peer, id) {
    id = id || this._makeId(peer)
    if (this._allNodes.has(id) || this._shackingNodes.has(id)) return 

    this._shackingNodes.add(id)
    library.logger.debug(`nodeManager add peer ${peer.host}:${peer.port}`)

    this._shackhands(peer, (err, info) => {
      this._shackingNodes.delete(id)
      const { host, port, isSeed, status } = peer
      const node = { host, port, isSeed } 
      if (err && status === NodeStatus.Uncompatiable) {
        return
      }
      const updateInfo = info || { status: NodeStatus.Unknow }
      this._updateNode(node, updateInfo)
      this._allNodes.set(id, node)
    })
  }

  removePeer(id) {
    this._allNodes.delete(id)
  }

  _updateNode(node, info) {
    const { height, blockId, magic, status, net, version } = info || {}
    const origin = Object.assign({}, node)
    const data = { status, height, blockId, magic, net, version, updateAt: Date.now() }
    let modifier = {}
    Object.keys(data).forEach(k => { if (data[k] !== undefined) modifier[k] = data[k] })
    Object.assign(node, modifier)

    this.emit('change', origin, modifier)
  }

  _makeId(peer) { return priv.getNodeIdentity(peer) }

  async _sleep( ms ) {
    return new Promise((resolve, reject) => {
      setTimeout( () => resolve(), ms)
    })
  }

  _httpGet(peer, path, cb) {
    const url = `http://${peer.host}:${peer.port - 1}/api/${path}`
    axios.get(url, {}, { timeout: priv.peerTimeout })
      .then ( response => {
        const data = response.data
        return data.success ? cb(undefined, data) : cb(data.error || 'Get from server failed')
      }) 
      .catch( err => cb(String(err)) )
  }

  _httpPost(peer, path, cb) {
    const url = `http://${peer.host}:${peer.port - 1}/peer/${path}`
    const options =  {
      timeout: priv.peerTimeout,
      headers: {
        magic: global.Config.magic,
        version: global.Config.version,
      }
    }
    axios.post(url, {}, options)
      .then ( response => {
        const data = response.data
        library.logger.debug(`post ${url}, `, response.data)
        return data ? cb(undefined, data, response.headers) : cb(data.error || 'request server failed')
      })
      .catch( err => {
        const headers = (err.response) ? err.response.headers : undefined
        library.logger.debug(`post ${url} error, `, String(err))
        cb(String(err), undefined, headers)
      })
  }

  async _retry( asyncFunc, maxRetry, times = 1) {
    try {
      return await asyncFunc()
    }
    catch( err ){
      library.logger.debug(`nodeManager retry async call, retry = ${times}`)
      if (times >= maxRetry) throw err
      const ms = 3 ** times * 1000
      await _sleep(ms)
      await _retry(asyncFunc, maxRetry, times + 1)
    }
  }

  async _getVersion(peer) {
    return new Promise((resolve, reject) => {
      this._httpGet(peer, 'peers/version', (err, ret)=>{
        if (err) return reject(err)
        resolve(ret)
      })
    })
  }

  async _getMagicAndHeight(peer) {
    return new Promise((resolve, reject) => {
      this._httpPost(peer, 'getHeight', (err, ret, headers) => {
        const magic = headers !== undefined ? headers.magic : undefined
        if (magic) { 
          let result = ret || {}
          result['magic'] = magic
          return resolve(result)
        } 
        reject(String(err) || `get magic and height failed`)
      })
    })
  }

  _shackhands (peer, cb) {
    library.logger.debug(`start shackhands with ${peer.host}:${peer.port}`)
    const self = this
    Promise.all([
      this._getVersion(peer), 
      this._getMagicAndHeight(peer)
    ])
    .then( results => {
      const [versionRet, lastBlockRet] = results
      library.logger.log(`shack hands, `, versionRet, lastBlockRet)
      if (!versionRet.success) return cb(versionRet.err || 'get version failed')

      const { net, version } = versionRet
      const { height, blockId, magic } = lastBlockRet

      let status = this.isCompatible(net, version, magic) ? NodeStatus.Unhealthy : NodeStatus.Uncompatiable
      if (status === NodeStatus.Uncompatiable) {
        return cb(undefined, { net, version, status })
      }

      status = this.isHealthy( height, blockId ) ? NodeStatus.Healthy : NodeStatus.Unhealthy
      return cb(undefined,{ net, version, status, magic, height, blockId }) 
    })
    .catch(err => {
      cb(err)
    }) 
  }

  _checkCompatiableNode(node) {
    if (Date.now() - (node.updateAt || 0) < CHECK_COMPATIABLE_NODES_INTERVAL) {
      return 
    }
    library.logger.debug(`nodeManager check compatiable node ${node.host}:${node.port}`)
    this._getMagicAndHeight(node)
      .then(info => this.updateNodeHealthy(node, info.height, info.blockId))
      .catch(err => this._updateNode(node, { status : NodeStatus.Unhealthy }))
  }

  _checkUncompatiableNode(node) {
    if (Date.now() - (node.updateAt || 0) < CHECK_UNCOMPATIABLE_NODES_INTERVAL) {
      return 
    }

    library.logger.debug(`nodeManager check uncompatiable node ${node.host}:${node.port}`)
    this._shackhands(node, (err, info) => {
      if (err && node.status === NodeStatus.Uncompatiable) {
        return
      }
      const updateInfo = info || { status: NodeStatus.Unknow }
      this._updateNode(node, updateInfo)
    })
  }
}


const priv = {
  handlers: {},
  dht: null,
  peerTimeout: DEFAULT_PEER_TIMEOUT,
  nodeManager: new NodeManager(),

  getNodeIdentity: (node) => {
    const address = `${node.host}:${node.port}`
    return crypto.createHash('ripemd160').update(address).digest()
  },

  getSeedPeerNodes: seedPeers => seedPeers.map((peer) => {
    const node = { host: peer.ip, port: Number(peer.port) }
    node.id = priv.getNodeIdentity(node)
    return node
  }),

  initP2P: async (p2pOptions) => {
    let lastNodes = []
    if (p2pOptions.persistentPeers) {
      const peerNodesDbPath = path.join(p2pOptions.peersDbDir, 'peers.db')
      try {
        lastNodes = await promisify(priv.initNodesDb)(peerNodesDbPath)
        lastNodes = lastNodes || []
        app.logger.debug(`load last node peers success, ${JSON.stringify(lastNodes)}`)
      } catch (e) {
        app.logger.error('Last nodes not found', e)
      }
    }
    const bootstrapNodes = [...priv.getSeedPeerNodes(p2pOptions.seedPeers)]
    const [host, port] = [p2pOptions.publicIp, p2pOptions.peerPort]
    const dht = new DHT({
      timeBucketOutdated: CHECK_BUCKET_OUTDATE,
      bootstrap: bootstrapNodes,
      nodeId: priv.getNodeIdentity({ host, port }),
    })
    
    priv.dht = dht
    priv.peerTimeout = p2pOptions.timeout || DEFAULT_PEER_TIMEOUT
    priv.bootstrapNodes = bootstrapNodes
  
    bootstrapNodes.forEach(node => {
      priv.nodeManager.addPeer({ host: node.host, port: node.port, isSeed: true })
    })

    priv.nodeManager.on('change', (node, modifier) => {
      library.logger.debug('node changed', node, modifier)
      if (modifier.status === NodeStatus.Uncompatiable ) {
        dht.addBlackIPs(node.host)
      }
      else if (modifier.status === NodeStatus.Healthy || modifier.status === NodeStatus.Unhealthy) {
        dht.removeBlackIP(node.host)
      }
    })

    
    dht.addBlackIPs(...(p2pOptions.blackPeers || []).map(p=>p.id))
    dht.listen(port, () => library.logger.info(`p2p server listen on ${port}`))

    dht.on('node', (node) => {
      const nodeId = node.id.toString('hex')
      library.logger.info(`add node (${nodeId}) ${node.host}:${node.port}`)
      priv.updateNode(nodeId, node)
      priv.nodeManager.addPeer(node, nodeId)
    })

    dht.on('remove', (nodeId, reason) => {
      library.logger.info(`remove node (${nodeId}), reason: ${reason}`)
      priv.removeNode(nodeId)
      priv.nodeManager.removePeer(nodeId)
    })

    dht.on('error', (err) => {
      library.logger.warn('dht error message', err)
    })

    dht.on('black', (peer, type, message) =>{
      library.logger.debug('black list', priv.dht.blackList())
      library.logger.debug(`black node (${peer.host||peer.address}:${peer.port}) message, type: ${type}, ${message && message.topic} `)
    })

    dht.on('warning', (msg) => {
      library.logger.warn('dht warning message', msg)
    })

    if (p2pOptions.eventHandlers) {
      Object.keys(p2pOptions.eventHandlers).forEach(eventName =>
        dht.on(eventName, p2pOptions.eventHandlers[eventName]))
    }

    lastNodes.forEach(n => dht.addNode(n))
   
    setInterval(() => {
      const allNodes = dht.nodes.toArray()
      const isInDht = n => allNodes.some(dn => dn.host === n.host && dn.port === n.port)
      bootstrapNodes.filter(node => !isInDht(node))
        .filter(n => n.host !== host && n.port !== port)
        .forEach(n => dht.addNode(n))
    }, RECONNECT_SEED_INTERVAL)

    priv.nodeManager.startCheckNodes()
  },

  findSeenNodesInDb: (callback) => {
    priv.nodesDb.find({ /* seen: { $exists: true } */ })
      .sort({ seen: -1 })
      .exec((err, nodes) => {
        if (err) return callback(err)

        // filter duplicated nodes
        const nodesMap = new Map()
        nodes.forEach((n) => {
          const address = `${n.host}:${n.port}`
          if (!nodesMap.has(address)) nodesMap.set(address, n)
        })
        return callback(err, [...nodesMap.values()])
      })
  },

  initNodesDb: (peerNodesDbPath, cb) => {
    if (!priv.nodesDb) {
      const db = new Database({ filename: peerNodesDbPath, autoload: true })
      priv.nodesDb = db
      db.persistence.setAutocompactionInterval(SAVE_PEERS_INTERVAL)

      const errorHandler = err => err && app.logger.info('peer node index error', err)
      db.ensureIndex({ fieldName: 'id' }, errorHandler)
      db.ensureIndex({ fieldName: 'seen' }, errorHandler)
    }

    priv.findSeenNodesInDb(cb)
  },

  updateNode: (nodeId, node, callback) => {
    if (!nodeId || !node) return

    const upsertNode = Object.assign({}, node)
    upsertNode.id = nodeId
    priv.nodesDb.update({ id: nodeId }, upsertNode, { upsert: true }, (err, data) => {
      if (err) app.logger.warn(`faild to update node (${nodeId}) ${node.host}:${node.port}`)
      if (_.isFunction(callback)) callback(err, data)
    })
  },

  removeNode: (nodeId, callback) => {
    if (!nodeId) return

    priv.nodesDb.remove({ id: nodeId }, (err, numRemoved) => {
      if (err) app.logger.warn(`faild to remove node id (${nodeId})`)
      if (_.isFunction(callback)) callback(err, numRemoved)
    })
  },

  getCompatibleNodes: () => {
    return priv.nodeManager.compatibleNodes
  },

  getRandomNode: ()=>{  
    let nodes = priv.getCompatibleNodes() 
    nodes = nodes.length === 0 ? priv.bootstrapNodes : nodes
    const rnd = Math.floor(Math.random() * nodes.length)
    return nodes[rnd]     
  },

  broadcast: (message, peers) =>{
    function getRandomPeers(count, allNodes) {
      if (allNodes.length <= count) return allNodes
  
      const randomPeers = []
      while(count-- > 0 && allNodes.length > 0) {
        const rnd = Math.floor(Math.random() * allNodes.length)
        const peer = allNodes[rnd]
        allNodes.splice(rnd, 1)
        randomPeers.push(peer)
      }
      return randomPeers
    }

    let nodes = priv.getCompatibleNodes() 
    nodes = nodes.length === 0 ? priv.bootstrapNodes : nodes
    peers = peers || getRandomPeers(20, nodes)
    library.logger.debug('broadcast to nodes', peers)
    priv.dht.broadcast(message, peers)
  }
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

Peer.prototype.subscribe = (topic, handler) => {
  priv.handlers[topic] = handler
}

Peer.prototype.onpublish = (msg, peer) => {
  if (!msg || !msg.topic || !priv.handlers[msg.topic.toString()]) {
    library.logger.debug('Receive invalid publish message topic', msg)
    return
  }

  if (msg.magic && msg.magic !== library.config.magic) {
    library.logger.debug('Receive invalid publish message magic', msg)
    priv.nodeManager.setUncompatiable(peer.host, msg.magic)
    return
  }
  priv.handlers[msg.topic](msg, peer)
}

Peer.prototype.publish = (topic, message, recursive = 1) => {
  if (!priv.dht) {
    library.logger.warn('dht network is not ready')
    return
  }
  message.topic = topic
  message.magic = library.config.magic
  message.recursive = recursive
  // TODO: Optimize broadcasting efficiency
  if (true) {
    library.logger.debug('broadcast message %s to bootstrap nodes', topic)
    priv.broadcast(message, priv.bootstrapNodes)
  }
  priv.broadcast(message)
}

Peer.prototype.setNodeUncompatiable = (ip, magic) => {
  if (!priv.dht) return 
  priv.nodeManager.setUncompatiable(ip, magic)
}

Peer.prototype.request = (method, params, contact, cb) => {
  const address = `${contact.host}:${contact.port - 1}`
  const uri = `http://${address}/peer/${method}`
  library.logger.debug(`start to request ${uri}`)

  const options = {
    timeout: priv.peerTimeout,
    headers: {
      magic: global.Config.magic,
      version: global.Config.version,
    }
  }
  axios.post(uri, params, options)
    .then( response => {
      const result = response.data
      if (response.status !== 200) {
        library.logger.debug('remote service error', result)
        return cb(`Invalid status code: ${response.status}`)
      }
      return cb(null, result)
    })
    .catch(err=> cb(err.toString()))
}

Peer.prototype.randomRequest = (method, params, cb) => {
  const randomNode = priv.getRandomNode()
  if (!randomNode) return cb('No contact')
  library.logger.debug('select random contact', randomNode)
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

Peer.prototype.onBlockchainReady = () => {
  const { publicIp, peerPort } = library.config
  const { list, blackList, timeout, persistent } = library.config.peers

  priv.initP2P({
    publicIp,
    peerPort,
    seedPeers: list,
    blackPeers: blackList,
    timeout,
    persistentPeers: persistent !== false,
    peersDbDir: global.Config.dataDir,
    eventHandlers: {
      broadcast: (msg, node) => self.onpublish(msg, node),
    },
  }).then(() => {
    library.bus.message('peerReady')
  }).catch((err) => {
    library.logger.error('Failed to init dht', err)
  })
}

shared.getPeers = (req, cb) => {
  priv.findSeenNodesInDb((err, nodes) => {
    let peers = []
    if (err) {
      library.logger.error('Failed to find nodes in db', err)
    } else {
      peers = nodes
    }
    cb(null, { count: peers.length, peers })
  })
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
