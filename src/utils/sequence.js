const util = require('util')
const async = require('async')

const TASK_TIMEOUT_MS = 10 * 1000

function tick(task, cb) {
  let isCallbacked = false
  const done = (err, res) => {
    if (isCallbacked) {
      return
    }
    isCallbacked = true
    if (task.done) {
      setImmediate(task.done, err, res)
    }
    setImmediate(cb)
  }
  setTimeout(() => {
    if (!isCallbacked) {
      done('Worker task timeout')
    }
  }, TASK_TIMEOUT_MS)
  let args = [done]
  if (task.args) {
    args = args.concat(task.args)
  }
  try {
    task.worker.apply(task.worker, args)
  } catch (e) {
    library.logger.error('Worker task failed:', e)
    done(e.toString())
  }
}

class Sequence {
  constructor(config) {
    this.counter = 1
    this.name = config.name

    this.queue = async.queue(tick, 1)
  }

  add(worker, args, cb) {
    let done
    if (!cb && args && typeof args === 'function') {
      done = args
    } else {
      done = cb
    }
    if (worker && typeof worker === 'function') {
      const task = { worker, done }
      if (util.isArray(args)) {
        task.args = args
      }
      task.counter = this.counter++
      this.queue.push(task)
    }
  }

  count() {
    return this.sequence.length
  }
}

module.exports = Sequence
