class Bancor {
  constructor(money, stock, owner) {
    let bancor
    if (owner) {
      bancor = app.sdb.findOne(
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
      bancor = app.sdb.findOne(
        'Bancor',
        {
          condition: {
            money,
            stock,
          },
        },
      )
    }

    if (!bancor) throw new Error('bancor is not found')
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

  buyRT(currency, amount) {
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = this._supply
    const T = amount
    const C = this._balanceMap.get(currency)
    const F = this._cwMap.get(currency)
    const E = R * ((Math.pow(1 + T / C, F) - 1))
    this._balanceMap.set(currency, this._balanceMap.get(currency) + T)
    this._supply += E
    if (currency === this._money) {
      app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
    return E
  }

  sellRT(currency, amount) {
    if (this._balanceMap.get(currency) === undefined || this._cwMap.get(currency) === undefined) throw new Error('cw or balance is not found')
    const R = this._supply
    const C = this._balanceMap.get(currency)
    const F = 1 / this._cwMap.get(currency)
    const E = amount
    const T = C * (Math.pow(1 + E / R, F) - 1)
    this._balanceMap.set(currency, this._balanceMap.get(currency) - T)
    this._supply -= amount
    if (currency === this._money) {
      app.sdb.update('Bancor', { moneyBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    } else if (currency === this._stock) {
      app.sdb.update('Bancor', { stockBalance: this._balanceMap.get(currency), supply: this._supply }, { owner: this._owner, money: this._money, stock: this._stock })
    }
    return T
  }

  getPriceFromCurrencyToRT(currency) {
    return this._supply
              * ((Math.pow(1 + 1 / this._balanceMap.get(currency), this._cwMap.get(currency)) - 1))
  }

  getPriceFromRTToCurrency(currency) {
    return this._balanceMap.get(currency)
              * ((Math.pow(1 + 1 / this._supply, 1 / this._cwMap.get(currency)) - 1))
  }

  exchangeByTarget(sourceCurrency, targetCurrency, targetAmount, isExchange) {
    const needsRT = this.getPriceFromCurrencyToRT(targetCurrency) * targetAmount
    const needsSrcAmount = this.getPriceFromRTToCurrency(sourceCurrency) * needsRT
    if (isExchange) {
      const actualRT = this.buyRT(sourceCurrency, needsSrcAmount * 1.2)
      const actualTargetAmount = this.sellRT(targetCurrency, actualRT)
      return {
        sourceAmount: needsSrcAmount * 1.2,
        targetAmount: Math.floor(actualTargetAmount),
      }
    }
    return {
      sourceAmount: needsSrcAmount,
      targetAmount,
    }
  }

  exchangeBySource(sourceCurrency, targetCurrency, sourceAmount, isExchange) {
    const getsRT = this.getPriceFromCurrencyToRT(sourceCurrency) * sourceAmount
    const getsTargetAmount = this.getPriceFromRTToCurrency(targetCurrency) * getsRT
    if (isExchange) {
      const actualRT = this.buyRT(sourceCurrency, sourceAmount)
      const actualTargetAmount = this.sellRT(targetCurrency, actualRT)
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
