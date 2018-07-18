
class AutoIncrement {
  constructor(sdb) {
    this.sdb = sdb
  }

  get(key) {
    const item = this.sdb.getCached('Variable', key)
    const value = item ? item.value : '0'
    return value
  }

  increment(key) {
    let item = this.sdb.getCached('Variable', key)
    if (item) {
      item.value = app.util.bignumber(item.value).plus(1).toString()
    } else {
      item = this.sdb.create('Variable', key)
      item.value = '1'
    }
    return item.value
  }
}

module.exports = AutoIncrement
