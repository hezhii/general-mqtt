export function delayExec(delay: number = 5000, fn = () => Promise.resolve(), context = null) {
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

type AVFunction<T = unknown> = (value: T) => void

export function asyncFactory<R = unknown, RE = unknown>(fn: (...args: any) => Promise<R>, timeout?: number) {
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

      let cancle: () => void
      if (timeout) {
        const delayExecResult = delayExec(timeout)
        cancle = delayExecResult.cancel

        delayExecResult.run().then(() => {
          const error = new Error('操作超时')
          processRequests('reject', error)
        })
      }

      fn.apply(context, args)
        .then(res => {
          // 初始化成功
          cancle && cancle()
          instance = res
          initializing = false
          processRequests('resolve', instance)
        })
        .catch(error => {
          // 初始化失败
          cancle && cancle()
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

export const sleep = (ms: number) => {
  return new Promise(resolve => setTimeout(resolve as any, ms))
}
