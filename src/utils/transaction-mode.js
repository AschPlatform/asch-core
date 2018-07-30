function isDirectMode(mode) {
  let result = false
  if (mode === undefined || mode === null || mode === 0) {
    result = true
  }
  return result
}

function isRequestMode(mode) {
  let result = false
  if (mode === 1) {
    result = true
  }
  return result
}

module.exports = {
  DIRECT: 0,
  REQUEST: 1,
  isDirectMode,
  isRequestMode,
}
