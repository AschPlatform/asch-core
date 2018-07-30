function isDirectMode(mode) {
  return (mode === undefined || mode === null || mode === 0)
}

function isRequestMode(mode) {
  return mode === 1
}

module.exports = {
  DIRECT: 0,
  REQUEST: 1,
  isDirectMode,
  isRequestMode,
}
