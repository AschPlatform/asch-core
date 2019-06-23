const assert = require('assert')

const DEFAULT_FIFO_CACHE_CAPACITY = 1024

module.exports = class FIFOCache {
  constructor(capacity) {
    this._capacity = capacity || DEFAULT_FIFO_CACHE_CAPACITY
    this._keysQueue = []
    this._cachedItems = new Map()
  }

  has(key) {
    return this._cachedItems.has(key)
  }

  get(key) {
    return this._cachedItems.get(key)
  }

  add(key, value) {
    assert(!this.has(key), `key '${key}' exists already`)

    if (this.full) {
      firstKey = this._keysQueue.shift()
      this._cachedItems.delete(firstKey)
    }

    this._keysQueue.push(key)
    this._cachedItems.set(key, value)
    return this._cachedItems.size
  }

  evit(key) {
    if (!this._cachedItems.has(key)) return undefined

    const keyIndex = this._keysQueue.indexOf(key)
    this._keysQueue.slice(keyIndex, 1)

    const value = this._cachedItems.get(key)
    this._cachedItems.delete(key)

    return value
  }

  refesh(key, value) {
    assert(this.has(key), `key '${key}' not found`)

    this.evit(key)
    this.add(key, value)
  }

  put(key, value) {
    if (this.has(key)) {
      this.refesh(key, value)
    } else {
      this.add(key, value)
    }
  }

  get capacity() {
    return this._capacity
  }

  get avaialbe() {
    return this.capacity - this.size
  }

  get size() {
    return this._cachedItems.size
  }

  get full() {
    return this.size >= this.capacity
  }
}
