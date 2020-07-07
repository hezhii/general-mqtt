import Client, { ConnectOptions, SubscribeOptions } from './mqtt-client/ClientImplementation'
import Message, { MqttMessage } from './mqtt-client/Message'
import ClientImplementation from './mqtt-client/ClientImplementation'
import customStorage from './CustomStorage'
import WXWebSocket from './WXWebSocket'

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

  env?: 'web' | 'wx' | 'rn'
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
    let WebSocketClass: any = window.WebSocket

    if (env === 'wx') {
      storage = customStorage
      WebSocketClass = WXWebSocket
    } else if (env === 'rn') {
      storage = customStorage
      WebSocketClass = global.WebSocket
    }
    this.client = new ClientImplementation(options.uri, options.clientId, storage, WebSocketClass)
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

  unsubscribe(topic: string, handler: Handler, subscribeOptions: SubscribeOptions = { qos: 0 }) {
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

  publish(topic: string, message: string) {
    console.log(`publish:${topic}, message:${message}`)
    const msg = new Message(message)
    msg.destinationName = topic
    this.client.publish(msg)
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

  private _handleClose = () => {
    console.log('Lost connection')
    this.fireEvent('onClose')
  }

  private _getClient(): Promise<ClientImplementation> {}
}

export default Connection
