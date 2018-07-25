
function getCurrencyFlag(currency) {
  if (currency === 'XAS') {
    return 1
  } if (currency.indexOf('.') !== -1) {
    // UIA
    return 2
  }
  // gateway currency
  return 3
}

class BalanceManager {
  constructor(sdb) {
    this.sdb = sdb
  }

  get(address, currency) {
    const item = this.sdb.get('Balance', { address, currency })
    const balance = item ? item.balance : '0'
    return app.util.bignumber(balance)
  }

  increase(address, currency, amount) {
    if (app.util.bignumber(amount).eq(0)) return
    const key = { address, currency }
    let item = this.sdb.get('Balance', key)
    if (item) {
      item.balance = app.util.bignumber(item.balance).plus(amount).toString(10)
      app.sdb.update('Balance', { balance: item.balance }, key)
    } else {
      item = this.sdb.create('Balance', {
        address,
        currency,
        balance: amount,
        flag: getCurrencyFlag(currency),
      })
    }
  }

  decrease(address, currency, amount) {
    this.increase(address, currency, `-${amount}`)
  }

  transfer(currency, amount, from, to) {
    this.decrease(from, currency, amount)
    this.increase(to, currency, amount)
  }
}

module.exports = BalanceManager
