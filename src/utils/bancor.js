class Bancor {
  constructor(money, stock, owner) {
    this._money = money
    this._stock = stock
    this._owner = owner
  }

  static async create(money, stock, owner) {
    const bancor = new Bancor(money, stock, owner)
    const result = await bancor._init()
    if (!result) {
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
      bancor = await app.sdb.findOne(
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
      bancor = await app.sdb.findOne(
        'Bancor',
        {
          condition: {
            money,
            stock,
          },
        },
      )
    }

    // if (!bancor) throw new Error('bancor is not found')
    if (!bancor) return null
    this._bancor = bancor
    this._owner = bancor.owner
    this._moneyCw = bancor.moneyCw
    this._stockCw = bancor.stockCw
    this._supply = bancor.supply
    this._money = bancor.money
    this._moneyBalance = bancor.moneyBalance
    this._stock = bancor.stock
    this._stockBalance = bancor.stockBalance
    this._relay = bancor.relay
    this._balanceMap = new Map()
    this._cwMap = new Map()
    this._balanceMap.set(this._money, this._moneyBalance)
    this._balanceMap.set(this._stock, this._stockBalance)
    this._cwMap.set(this._money, this._moneyCw)
    this._cwMap.set(this._stock, this._stockCw)
  }

  async buyRT(currency, amount) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = this._supply
    const T = amount
    const C = this._balanceMap.get(currency)
    const F = this._cwMap.get(currency)
    // const E = R * ((Math.pow(1 + T / C, F) - 1))
    const E = R * (((1 + T / C) ** F) - 1)
    this._balanceMap.set(currency, this._balanceMap.get(currency) + T)
    this._supply += E
    if (currency === this._money) {
      await app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      await app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
    return E
  }

  async sellRT(currency, amount) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = this._supply
    const C = this._balanceMap.get(currency)
    const F = 1 / this._cwMap.get(currency)
    const E = amount
    // const T = C * (Math.pow(1 + E / R, F) - 1)
    const T = C * (((1 + E / R) ** F) - 1)
    this._balanceMap.set(currency, this._balanceMap.get(currency) - T)
    this._supply -= amount
    if (currency === this._money) {
      await app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      await app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
    return T
  }

  getPriceFromCurrencyToRT(currency) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    // return this._supply
    // * ((Math.pow(1 + 1 / this._balanceMap.get(currency), this._cwMap.get(currency)) - 1))
    return this._supply * ((((1 + 1 / this._balanceMap.get(currency))
                              ** this._cwMap.get(currency)) - 1))
  }

  getPriceFromRTToCurrency(currency) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    // return this._balanceMap.get(currency)
    //  * ((Math.pow(1 + 1 / this._supply, 1 / this._cwMap.get(currency)) - 1))
    return this._balanceMap.get(currency)
       * ((((1 + 1 / this._supply) ** (1 / this._cwMap.get(currency))) - 1))
  }

  async exchangeByTarget(sourceCurrency, targetCurrency, targetAmount, isExchange) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    const needsRT = this.getPriceFromCurrencyToRT(targetCurrency) * targetAmount
    const needsSrcAmount = this.getPriceFromRTToCurrency(sourceCurrency) * needsRT
    if (isExchange) {
      const actualRT = await this.buyRT(sourceCurrency, Math.ceil(needsSrcAmount * 1.2))
      const actualTargetAmount = await this.sellRT(targetCurrency, Math.ceil(actualRT))
      return {
        sourceAmount: Math.ceil(needsSrcAmount * 1.2),
        targetAmount: Math.floor(actualTargetAmount),
      }
    }
    return {
      sourceAmount: Math.ceil(needsSrcAmount),
      targetAmount,
    }
  }

  async exchangeBySource(sourceCurrency, targetCurrency, sourceAmount, isExchange) {
    if (!this._bancor) throw new Error('Bancor was not initialized')
    const getsRT = this.getPriceFromCurrencyToRT(sourceCurrency) * sourceAmount
    const getsTargetAmount = this.getPriceFromRTToCurrency(targetCurrency) * getsRT
    if (isExchange) {
      const actualRT = await this.buyRT(sourceCurrency, sourceAmount)
      const actualTargetAmount = await this.sellRT(targetCurrency, actualRT)
      return {
        sourceAmount,
        targetAmount: Math.floor(actualTargetAmount),
      }
    }
    return {
      sourceAmount,
      targetAmount: Math.floor(getsTargetAmount),
    }
  }
}

module.exports = Bancor
