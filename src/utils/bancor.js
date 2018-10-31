class Bancor {
  constructor(money, stock, owner) {
    this._money = money
    this._stock = stock
    this._owner = owner
  }

  static async create(money, stock, owner) {
    const bancor = new Bancor(money, stock, owner)
    const result = await bancor._init()
    if (result === -1) {
      return null
    }
    return bancor
  }

  async _init() {
    const money = this._money
    const stock = this._stock
    const owner = this._owner
    let bancor
    if (owner) {
      bancor = await app.sdb.loadMany('Bancor', { money, stock, owner }, 1)
    } else {
      bancor = await app.sdb.loadMany('Bancor', { money, stock }, 1)
    }

    if (bancor.length === 0) return -1
    this._bancor = bancor[0]
    this._id = bancor[0].id
    this._owner = bancor[0].owner
    this._moneyCw = bancor[0].moneyCw
    this._stockCw = bancor[0].stockCw
    this._supply = bancor[0].supply
    this._money = bancor[0].money
    this._moneyBalance = bancor[0].moneyBalance
    this._moneyPrecision = bancor[0].moneyPrecision
    this._stock = bancor[0].stock
    this._stockBalance = bancor[0].stockBalance
    this._stockPrecision = bancor[0].stockPrecision
    this._relay = bancor[0].relay
    this._name = bancor[0].name
    this._timestamp = bancor[0].timestamp
    this._fee = bancor[0].fee
    this._status = bancor[0].status
    this._balanceMap = new Map()
    this._cwMap = new Map()
    this._balanceMap.set(this._money, this._moneyBalance)
    this._balanceMap.set(this._stock, this._stockBalance)
    this._cwMap.set(this._money, this._moneyCw)
    this._cwMap.set(this._stock, this._stockCw)
    return 1
  }

  getBancorInfo() {
    return {
      id: this._id,
      owner: this._owner,
      moneyCw: this._moneyCw,
      stockCw: this._stockCw,
      supply: this._supply,
      money: this._money,
      moneyBalance: this._moneyBalance,
      moneyPrecision: this._moneyPrecision,
      stock: this._stock,
      stockBalance: this._stockBalance,
      stockPrecision: this._stockPrecision,
      relay: this._relay,
      name: this._name,
      timestamp: this._timestamp,
      fee: this._fee,
      status: this._status,
    }
  }

  // Use connected token to buy relay token
  async buyRT(currency, amount, isExchange) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = app.util.bignumber(this._supply)
    const T = amount
    const C = app.util.bignumber(this._balanceMap.get(currency))
    const F = this._cwMap.get(currency)
    const E = R.times(app.util.bigdecimal(T.div(C).plus(1).toString()).pow(F).minus(1)).round()
    if (E.gt(R.div(100))) throw new Error('Buy too many')
    app.logger.debug(`--->buyRT: supply = ${this._supply} + ${E.toString()}, ${currency} balance = ${this._balanceMap.get(currency)} + ${amount.toString()}`)
    this._balanceMap.set(currency,
      app.util.bignumber(this._balanceMap.get(currency)).plus(amount).toString())
    this._supply = app.util.bignumber(this._supply).plus(E).toString()
    app.logger.debug(`--->buyRT: supply = ${this._supply},  ${currency} balance = ${this._balanceMap.get(currency)}`)
    if (isExchange) {
      await this.updateBancorDB(currency)
    }
    return E
  }

  // Sell relay token to get assigned connected token
  async sellRT(currency, amount, isExchange) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = app.util.bignumber(this._supply)
    const C = app.util.bignumber(this._balanceMap.get(currency))
    const F = 1 / this._cwMap.get(currency)
    const E = amount
    const T = C.times(app.util.bigdecimal(E.div(R).plus(1).toString()).pow(F).minus(1)).round()
    if (amount.gt(R.div(100))) throw new Error('Sell too many')
    app.logger.debug(`--->sellRT: supply = ${this._supply} - ${amount.toString()}, ${currency} balance = ${this._balanceMap.get(currency)} - ${T.toString()}`)
    if (app.util.bignumber(this._balanceMap.get(currency)).lt(T)) throw new Error(`Balance in bancor ${this._name} is not enough`)
    if (app.util.bignumber(this._supply).lt(amount)) throw new Error(`Supply in bancor ${this._name} is not enough`)
    this._balanceMap.set(currency,
      app.util.bignumber(this._balanceMap.get(currency)).minus(T).toString())
    this._supply = app.util.bignumber(this._supply).minus(amount).toString()
    app.logger.debug(`--->sellRT: supply = ${this._supply},  ${currency} balance = ${this._balanceMap.get(currency)}`)
    if (isExchange) {
      await this.updateBancorDB(currency)
    }
    return T
  }

  async updateBancorDB(currency) {
    app.logger.debug(`--->updateBancorDB: supply = ${this._supply}, ${currency} balance = ${this._balanceMap.get(currency)}`)
    if (currency === this._money) {
      await app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      await app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
  }

  // Get relay token price from one connected token
  getPriceFromCurrencyToRT(currency) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    return app.util.bigdecimal(this._supply)
      .times((app.util.bigdecimal(1)
        .div(app.util.bigdecimal(this._balanceMap.get(currency))).plus(1))
        .pow(this._cwMap.get(currency))
        .minus(1))
  }

  // Get connected token price from one relay token
  getPriceFromRTToCurrency(currency) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    return app.util.bigdecimal(this._balanceMap.get(currency))
      .times((app.util.bigdecimal(1)
        .div(app.util.bigdecimal(this._supply)).plus(1))
        .pow(this._cwMap.get(currency))
        .minus(1))
  }

  // Exchange based on the amount of target currency
  // return values are how much source currency was used and target amount
  async exchangeByTarget(sourceCurrency, targetCurrency, targetAmount, isExchange) {
    const amount = app.util.bignumber(targetAmount)
    if (!this._bancor) throw new Error('Bancor was not initialized')
    const actualRT = await this.buyRT(targetCurrency, amount, isExchange)
    const actualSourceAmount = await this.sellRT(sourceCurrency, actualRT, isExchange)
    return {
      sourceAmount: actualSourceAmount,
      targetAmount: amount,
    }
  }

  // Exchange based on the amount of source currency
  // return values are source amount and how much target currency was get
  async exchangeBySource(sourceCurrency, targetCurrency, sourceAmount, isExchange) {
    const amount = app.util.bignumber(sourceAmount)
    if (!this._bancor) throw new Error('Bancor was not initialized')
    const actualRT = await this.buyRT(sourceCurrency, amount, isExchange)
    const actualTargetAmount = await this.sellRT(targetCurrency, actualRT, isExchange)
    return {
      sourceAmount: amount,
      targetAmount: actualTargetAmount,
    }
  }
}

module.exports = Bancor
