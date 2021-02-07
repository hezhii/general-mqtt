import ClientImplementation, { ConnectOptions, SubscribeOptions } from './mqtt-client/ClientImplementation'
import Message, { MqttMessage } from './mqtt-client/Message'
import customStorage from './CustomStorage'
import WXWebSocket from './WXWebSocket'

type Handler = (topic: string, payloadString: string) => void

interface ConstructorOptions {
  uri: string
  clientId: string
  autoResubscribe?: boolean // if or not re-subscribe after reconnection
  env?: 'web' | 'wx' | 'rn'
}

type CallbackFunction = (data: any) => void

class Connection {
  client: ClientImplementation
  options: ConstructorOptions
  onConnected: null | ((reconnect: boolean, uri: string | null) => void)

  private topicHandlers: {
    [topic: string]: {
      subscribeOptions: SubscribeOptions
      handlers: Handler[]
    }
  }

  constructor(options: ConstructorOptions) {
    this.options = options
    this.topicHandlers = {}
    this.onConnected = null

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
    this.client.onConnected = this._handleConnected
  }

  set onConnectionLost(callback: CallbackFunction) {
    this.client.onConnectionLost = callback
  }

  set onMessageDelivered(callback: CallbackFunction) {
    this.client.onMessageDelivered = callback
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
    let topicHandler = this.topicHandlers[topic]

    if (!topicHandler) {
      this.client.subscribe(topic, subscribeOptions)
      topicHandler = this.topicHandlers[topic] = {
        handlers: [],
        subscribeOptions,
      }
    }
    topicHandler.handlers.push(handler)
  }

  cleanSubscribe() {
    const topics = Object.keys(this.topicHandlers)

    topics.forEach(topic => {
      this.client.unsubscribe(topic)
    })

    this.topicHandlers = {}
  }

  unsubscribe(topic: string, handler: Handler, subscribeOptions?: SubscribeOptions) {
    const topicHandler = this.topicHandlers[topic]
    const handlers = topicHandler && topicHandler.handlers
    if (!handlers || !handlers.length) {
      this.client.unsubscribe(topic, subscribeOptions)
      return
    }
    const index = handlers.indexOf(handler)
    if (index !== -1) {
      handlers.splice(index, 1)
    }
    if (!handlers.length) {
      delete this.topicHandlers[topic]
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

  private _handleMessage = (payload: MqttMessage) => {
    const { destinationName: resTopic, payloadString } = payload

    const handlers = this.topicHandlers[resTopic] && this.topicHandlers[resTopic].handlers
    if (handlers && handlers.length) {
      handlers.forEach(callback => callback(resTopic, payloadString))
    }
  }

  private _handleConnected = (reconnect: boolean, uri: string | null) => {
    if (this.options.autoResubscribe && reconnect) {
      // re-subscribe after reconnected
      Object.entries(this.topicHandlers).forEach(([topic, { subscribeOptions }]) => {
        this.client.subscribe(topic, subscribeOptions)
      })
    }
    if (this.onConnected) {
      this.onConnected(reconnect, uri)
    }
  }
}

export { Message }

export default Connection
