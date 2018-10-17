module.exports = {
  getGasPrice: (currency) => {
    if (currency) {
      return 1
    }
    return null
  },
}
