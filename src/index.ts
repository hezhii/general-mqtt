import ClientImplementation, { ConnectOptions, SubscribeOptions } from './mqtt-client/ClientImplementation'
import Message, { MqttMessage } from './mqtt-client/Message'
import customStorage from './CustomStorage'
import WXWebSocket from './WXWebSocket'

type Handler = (topic: string, payloadString: string) => void

interface ConstructorOptions {
  uri: string
  clientId: string
  env?: 'web' | 'wx' | 'rn'
}

type CallbackFunction = (data: any) => void

class Connection {
  client: ClientImplementation

  private topicHandlers: {
    [topic: string]: Handler[]
  }
  private eventListeners: {
    [eventName: string]: ((data: any) => void)[]
  }

  constructor(options: ConstructorOptions) {
    this.topicHandlers = {}
    this.eventListeners = {}

    const { env = 'web' } = options
    let storage
    let WebSocketClass

    if (env === 'wx') {
      storage = customStorage
      WebSocketClass = WXWebSocket
    } else if (env === 'rn') {
      storage = customStorage
      WebSocketClass = global.WebSocket
    } else {
      storage = window.localStorage
      WebSocketClass = window.WebSocket
    }
    this.client = new ClientImplementation(options.uri, options.clientId, storage, WebSocketClass)
    this.client.onMessageArrived = this._handleMessage
  }

  set onConnectionLost(callback: CallbackFunction) {
    this.client.onConnectionLost = callback
  }

  set onMessageDelivered(callback: CallbackFunction) {
    this.client.onMessageDelivered = callback
  }

  set onConnected(callback: CallbackFunction) {
    this.client.onConnected = callback
  }

  set disconnectedPublishing(disconnectedPublishing: boolean) {
    this.client.disconnectedPublishing = disconnectedPublishing
  }

  set disconnectedBufferSize(disconnectedBufferSize: number) {
    this.client.disconnectedBufferSize = disconnectedBufferSize
  }

  set traceFunction(callback: CallbackFunction) {
    this.client.traceFunction = callback
  }

  connect(options: ConnectOptions) {
    this.client.connect(options)
  }

  disconnect() {
    this.client.disconnect()
  }

  /**
   * subscribe a topic with handler, the handler will be called when receive the messsage
   *
   * @param {string} topic
   * @param {Function} handler
   * @param subscribeOptions
   */
  subscribe(topic: string, handler: Handler, subscribeOptions: SubscribeOptions = { qos: 0 }) {
    let handlers = this.topicHandlers[topic]

    if (!handlers || !handlers.length) {
      this.client.subscribe(topic, subscribeOptions)
      handlers = this.topicHandlers[topic] = []
    }
    handlers.push(handler)
  }

  cleanSubscribe() {
    const topics = Object.keys(this.topicHandlers)

    topics.forEach(topic => {
      this.client.unsubscribe(topic)
    })

    this.topicHandlers = {}
  }

  unsubscribe(topic: string, handler: Handler, subscribeOptions?: SubscribeOptions) {
    const handlers = this.topicHandlers[topic]
    if (!handlers) {
      this.client.unsubscribe(topic, subscribeOptions)
      return
    }
    const index = handlers.indexOf(handler)
    if (index !== -1) {
      handlers.splice(index, 1)
    }
    if (!handlers.length) {
      this.client.unsubscribe(topic, subscribeOptions)
    }
  }

  publish(topic: string | MqttMessage, payload?: string | Uint8Array, qos?: number, retained?: boolean) {
    this.client.publish(topic, payload, qos, retained)
  }

  /**
   * Publish a message to the topic and subscribe to the topic of receiving messages,
   * the promise will be resolved when got a reply
   *
   * @param topic
   * @param message
   * @param topicRes
   */
  publishWithPromise(topic: string, message: string, topicRes: string) {
    let handler: Handler
    let timeout: NodeJS.Timeout
    const messagePromise = new Promise(resolve => {
      handler = (_, payloadString) => {
        resolve(payloadString)
        this.unsubscribe(topicRes, handler)
        clearTimeout(timeout)
      }
      this.subscribe(topicRes, handler, {
        qos: 0,
        onSuccess: () => {
          this.publish(topic, message)
        },
      })
    })

    const timePromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        // 请求超时后取消订阅
        this.unsubscribe(topicRes, handler)

        const err = new Error('Time out')
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
}

export default Connection
