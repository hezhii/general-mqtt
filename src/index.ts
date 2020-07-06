import Client, { ConnectOptions, SubscribeOptions } from './mqtt-client/ClientImplementation'
import Message, { MqttMessage } from './mqtt-client/Message'
import ClientImplementation from './mqtt-client/ClientImplementation'

type Handler = (topic: string, payloadString: string) => void

interface ConstructorOptions extends ConnectOptions {
  uri: string
  clientId: string
  onConnectionLost?: () => void
  onMessageDelivered?: () => void
  onMessageArrived?: () => void
  onConnected?: () => void
  disconnectedPublishing?: boolean
  disconnectedBufferSize?: boolean
  traceFunction?: () => void

  env?: string
}

class Connection {
  client: ClientImplementation
  private options: ConstructorOptions

  private topicHandlers: {
    [topic: string]: Handler[]
  }
  private eventListeners: {
    [eventName: string]: ((data: any) => void)[]
  }

  constructor(options: ConstructorOptions) {
    this.options = options

    this.topicHandlers = {}
    this.eventListeners = {}

    this._handleMessage = this._handleMessage.bind(this)
    this._handleClose = this._handleClose.bind(this)

    const { env = 'web' } = options
    let storage = window.localStorage
    let WebSocketClass = window.WebSocket
    if (env !== 'web') {
    }
    this.client = new ClientImplementation(options.uri, options.clientId, storage, WebSocketClass)
  }

  disconnect() {
    this.client.disconnect()
  }

  subscribe(topic: string, callback: Handler, subscribeOptions: SubscribeOptions = { qos: 0 }) {
    let handlers = this.topicHandlers[topic]

    if (!handlers || !handlers.length) {
      this.client.subscribe(topic, subscribeOptions)
      handlers = this.topicHandlers[topic] = []
    }
    handlers.push(callback)
  }

  // 取消 topic 的某个 handler，如果一个 handler 也没有了，则取消订阅 topic
  unsubscribe(topic: string, callback: Handler, subscribeOptions: SubscribeOptions = { qos: 0 }) {
    const handlers = this.topicHandlers[topic]
    if (!handlers) {
      this.client.unsubscribe(topic, subscribeOptions)
      return
    }
    const index = handlers.indexOf(callback)
    if (index !== -1) {
      handlers.splice(index, 1)
    }
    if (!handlers.length) {
      this.client.unsubscribe(topic, subscribeOptions)
    }
  }

  publish(topic: string, message: string) {
    console.log(`publish:${topic}, message:${message}`)
    const msg = new Message(message)
    msg.destinationName = topic
    this.client.publish(msg)
  }

  /**
   * 发送 Mqtt 请求。
   *
   * 1. 订阅结果返回的 Topic，成功后执行下面的步骤
   * 2. 注册结果返回 Topic 的 handler
   * 3. 发送消息
   * 4. 取消订阅
   * 5. 收到结果过后，handler 中 resolve(data)
   *
   * **需要取消订阅**，阿里云 Broker 对 Topic 的订阅数量限制，目前测试下来超过 30 个以后，订阅之后收不到消息。
   *
   * @param topic - 发布消息的 topic
   * @param message - 发送的消息
   * @param topicRes - 请求结果返回时，接收结果的 topic
   * @return {Promise<any>}
   */
  publishWithPromise(topic: string, message: string, topicRes: string) {
    let handler: Handler
    const messagePromise = new Promise(resolve => {
      handler = (topic, message) => {
        resolve(message)
        this.unsubscribe(topicRes, handler)
      }
      this.subscribe(topicRes, handler)
      this.publish(topic, message)
    })

    const timePromise = new Promise((resolve, reject) => {
      setTimeout(() => {
        // 请求超时后取消订阅
        this.unsubscribe(topicRes, handler)

        const err = new Error('请求超时')
        err.name = 'TIME_OUT'
        reject(err)
      }, 20000)
    })

    return Promise.race([messagePromise, timePromise])
  }

  addEventListener(eventName: string, callback: (data: any) => void) {
    let listeners = this.eventListeners[eventName]

    if (!listeners) {
      listeners = this.eventListeners[eventName] = []
    }

    listeners.push(callback)
  }

  removeEventListener(eventName: string, callback: (data: any) => void) {
    const listeners = this.eventListeners[eventName]

    if (!listeners) {
      return
    }

    const index = listeners.indexOf(callback)

    if (index !== -1) {
      listeners.splice(index, 1)
    }
  }

  fireEvent(eventName: string, data?: any) {
    ;(this.eventListeners[eventName] || []).forEach(callback => callback(data))
  }

  private _handleMessage = (payload: MqttMessage) => {
    const { destinationName: resTopic, payloadString } = payload
    ;(this.topicHandlers[resTopic] || []).forEach(callback => callback(resTopic, payloadString))
  }

  private _handleClose = () => {
    console.log('Lost connection')
    this.fireEvent('onClose')
  }

  private _getClient(): Promise<ClientImplementation> {}
}

export default Connection
