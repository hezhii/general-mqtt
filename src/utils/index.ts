export function delay(delay: number = 5000, fn = () => {}, context = null) {
  let ticket: NodeJS.Timeout
  return {
    run(...args: any) {
      return new Promise((resolve, reject) => {
        ticket = setTimeout(async () => {
          try {
            const res = await fn.apply(context, args)
            resolve(res)
          } catch (err) {
            reject(err)
          }
        }, delay)
      })
    },
    cancel: () => {
      clearTimeout(ticket)
    },
  }
}

interface AVFunction<T = unknown> {
  (value: T): void
}

export function asyncFactory<R = unknown, RE = unknown>(fn: (...args: any) => Promise<R>, timeout: number = 5 * 1000) {
  let requests: { reject: AVFunction<RE>; resolve: AVFunction<R> }[] = []
  let instance: R
  let initializing = false

  return function initiator(context: unknown, ...args: unknown[]): Promise<R> {
    // 实例已经实例化过了
    if (instance !== undefined) {
      return Promise.resolve(instance)
    }

    // 初始化中
    if (initializing) {
      return new Promise((resolve, reject) => {
        requests.push({
          resolve,
          reject,
        })
      })
    }

    initializing = true
    return new Promise((resolve, reject) => {
      requests.push({
        resolve,
        reject,
      })

      const { run, cancel } = delay(timeout)

      run().then(() => {
        const error = new Error('操作超时')
        processRequests('reject', error)
      })

      fn.apply(context, args)
        .then(res => {
          // 初始化成功
          cancel()
          instance = res
          initializing = false
          processRequests('resolve', instance)
        })
        .catch(error => {
          // 初始化失败
          cancel()
          initializing = false
          processRequests('reject', error)
        })
    })
  }

  function processRequests(type: 'resolve' | 'reject', value: any) {
    // 挨个resolve
    requests.forEach(q => {
      q[type](value)
    })
    // 置空请求，之后直接用instance
    requests = []
  }
}
