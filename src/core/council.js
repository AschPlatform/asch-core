
let modules
let self
const priv = {}
const shared = {}

priv.loaded = false

// const COUNCIL_CONFIG = {
//   startHeight: 1,
//   electionDuration: 21,
//   servingDuration: 105,
// }
const COUNCIL_CONFIG = {
  startHeight: 9476110,
  electionDuration: 25920,
  servingDuration: 1576800,
}

function Council(cb, scope) {
  library = scope
  self = this
  priv.attachApi()

  setImmediate(cb, null, self)
}

// priv methods
priv.attachApi = () => {
}

Council.prototype.sandboxApi = (call, args, cb) => {
  sandboxHelper.callMethod(shared, call, args, cb)
}

Council.prototype.onBind = (scope) => {
  modules = scope
}

Council.prototype.getCouncilInfo = () => {
  const height = modules.blocks.getLastBlock().height
  const sessionDuration = COUNCIL_CONFIG.electionDuration + COUNCIL_CONFIG.servingDuration
  const session = Math.floor((height - COUNCIL_CONFIG.startHeight) / sessionDuration) + 1
  const sessionPosition = height - (session - 1) * sessionDuration - COUNCIL_CONFIG.startHeight
  const status = sessionPosition < COUNCIL_CONFIG.electionDuration ? 0 : 1
  const sessionBegin = COUNCIL_CONFIG.startHeight + (session - 1) * sessionDuration
  const sessionEnd = sessionBegin + sessionDuration - 1
  return {
    electionDuration: COUNCIL_CONFIG.electionDuration,
    servingDuration: COUNCIL_CONFIG.servingDuration,
    session,
    status,
    sessionBegin,
    sessionEnd,
    currentHeight: height,
  }
}

Council.prototype.cleanup = (cb) => {
  priv.loaded = false
  cb()
}

module.exports = Council
