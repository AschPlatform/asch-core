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
      bancor = await app.sdb.findAll(
        'Bancor',
        {
          condition: {
            money,
            stock,
            owner,
          },
        },
      )
    } else {
      bancor = await app.sdb.findAll(
        'Bancor',
        {
          condition: {
            money,
            stock,
          },
        },
      )
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
  async buyRT(currency, amount) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    // const R = this._supply
    const R = app.util.bignumber(this._supply).toNumber()
    const T = amount.toNumber()
    const C = app.util.bignumber(this._balanceMap.get(currency)).toNumber()
    const F = this._cwMap.get(currency)
    const E = R * (((1 + T / C) ** F) - 1)
    this._balanceMap.set(currency,
      app.util.bignumber(this._balanceMap.get(currency)).plus(amount).toString(10))
    // this._supply += E
    this._supply = app.util.bignumber(this._supply)
      .plus(this.getBigNumber(E).toNumber()).toString(10)
    if (currency === this._money) {
      await app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      await app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
    return E
  }

  // Sell relay token to get assigned connected token
  async sellRT(currency, amount) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = app.util.bignumber(this._supply).toNumber()
    const C = app.util.bignumber(this._balanceMap.get(currency)).toNumber()
    const F = 1 / this._cwMap.get(currency)
    const E = amount.toNumber()
    const T = C * (((1 + E / R) ** F) - 1)
    this._balanceMap.set(currency,
      app.util.bignumber(this._balanceMap.get(currency))
        .minus(this.getBigNumber(T).toNumber()).toString(10))
    // this._supply -= amount
    this._supply = app.util.bignumber(this._supply).minus(amount).toString(10)
    if (currency === this._money) {
      await app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      await app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
    return T
  }

  getBigNumber(amount) {
    let result
    const stringAmount = String(amount)
    const loc = stringAmount.indexOf('.')
    if (loc > 0) {
      result = app.util.bignumber(stringAmount.substring(0, loc))
    } else {
      result = app.util.bignumber(stringAmount)
    }
    return result
  }

  // Get relay token price from one connected token
  getPriceFromCurrencyToRT(currency) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    return app.util.bignumber(this._supply).toNumber()
          * ((((1 + 1 / app.util.bignumber(this._balanceMap.get(currency)).toNumber())
          ** this._cwMap.get(currency)) - 1))
  }

  // Get connected token price from one relay token
  getPriceFromRTToCurrency(currency) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    return app.util.bignumber(this._balanceMap.get(currency)).toNumber()
          * ((((1 + 1 / app.util.bignumber(this._supply).toNumber())
          ** (1 / this._cwMap.get(currency))) - 1))
  }

  // Exchange based on the amount of target currency
  // return values are how much source currency was used and target amount
  async exchangeByTarget(sourceCurrency, targetCurrency, targetAmount, isExchange) {
    const amount = app.util.bignumber(targetAmount).toNumber()
    if (!this._bancor) throw new Error('Bancor was not initialized')
    const needsRT = this.getPriceFromCurrencyToRT(targetCurrency) * amount
    const needsSrcAmount = this.getPriceFromRTToCurrency(sourceCurrency) * needsRT
    if (isExchange) {
      const actualRT = await this.buyRT(sourceCurrency, this.getBigNumber(needsSrcAmount))
      const actualTargetAmount = await this.sellRT(targetCurrency, this.getBigNumber(actualRT))
      return {
        sourceAmount: this.getBigNumber(needsSrcAmount),
        targetAmount: this.getBigNumber(actualTargetAmount),
      }
    }
    return {
      sourceAmount: this.getBigNumber(needsSrcAmount),
      targetAmount: this.getBigNumber(amount),
    }
  }

  // Exchange based on the amount of source currency
  // return values are source amount and how much target currency was get
  async exchangeBySource(sourceCurrency, targetCurrency, sourceAmount, isExchange) {
    const amount = app.util.bignumber(sourceAmount).toNumber()
    if (!this._bancor) throw new Error('Bancor was not initialized')
    const getsRT = this.getPriceFromCurrencyToRT(sourceCurrency) * amount
    const getsTargetAmount = this.getPriceFromRTToCurrency(targetCurrency) * getsRT
    if (isExchange) {
      const actualRT = await this.buyRT(sourceCurrency, this.getBigNumber(amount))
      const actualTargetAmount = await this.sellRT(targetCurrency, this.getBigNumber(actualRT))
      return {
        sourceAmount: this.getBigNumber(amount),
        targetAmount: this.getBigNumber(actualTargetAmount),
      }
    }
    return {
      sourceAmount: this.getBigNumber(amount),
      targetAmount: (this.getBigNumber(getsTargetAmount)),
    }
  }
}

module.exports = Bancor
