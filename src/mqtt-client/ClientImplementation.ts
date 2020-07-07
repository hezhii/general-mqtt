import { format, decodeMessage, validate } from './utils'
import packageJson from '../../package.json'
import { ERROR, MESSAGE_TYPE, CONNACK_RC } from './consts'
import Message, { MqttMessage } from './Message'
import Pinger from './Pinger'
import WireMessage from './WireMessage'
import WXWebSocket from '../WXWebSocket'

type FailureData = {
  invocationContext: any
  errorCode: number
  errorMessage?: string
}

export interface ConnectOptions {
  timeout?: number
  userName?: string
  password?: string
  willMessage?: MqttMessage
  keepAliveInterval?: number
  cleanSession?: boolean
  useSSL?: boolean
  invocationContext?: unknown
  onSuccess?: (e: any) => void
  onFailure?: (err: FailureData) => void
  hosts?: string[]
  ports?: number[]
  path?: string
  reconnect?: boolean
  mqttVersion?: 3 | 4
  mqttVersionExplicit?: boolean
  uris?: string[]
}

type WebSocketClass = new (url: string, protocols?: string | string[]) => WebSocket | WXWebSocket

export type SubscribeOptions = {
  onSuccess?: (data: { grantedQos?: number; invocationContext: any }) => void
  onFailure?: (err: FailureData) => void
  qos: 0 | 1 | 2
  timeout?: number
  invocationContext?: any
}

class ClientImplementation {
  private storage: Storage
  private webSocket: WebSocketClass
  private connected = false
  private connectOptions: ConnectOptions = { mqttVersion: 4, keepAliveInterval: 60 }

  socket?: WebSocket | WXWebSocket
  uri: string
  clientId: string
  onConnectionLost?: Function
  onMessageDelivered?: Function
  onMessageArrived?: Function
  onConnected?: Function
  disconnectedPublishing = false
  disconnectedBufferSize = 5000
  traceFunction?: Function

  private _localKey: string
  private _traceBuffer: any[] | null = null
  private _MAX_TRACE_ENTRIES = 100
  private _msg_queue: WireMessage[] // 准备发送的 message 队列
  private _buffered_msg_queue: WireMessage[] // 缓存尚未发送的消息，在连接成功后发送消息
  private _sentMessages: { [key: string]: WireMessage } = {}
  private _receivedMessages: { [key: string]: WireMessage } = {}
  private _message_identifier: number
  private _sequence: number
  private maxMessageIdentifier = 65536
  private _reconnecting = false
  private _reconnectTimeout: NodeJS.Timeout | null = null
  private _connectTimeout: number | null = null
  private _reconnectInterval = 1 // Reconnect Delay, starts at 1 second
  private hostIndex?: number
  private _wsuri: string | null
  /* The sendPinger monitors how long we allow before we send data to prove to the server that we are alive. */
  private sendPinger: Pinger | null = null
  private receiveBuffer: Uint8Array | null = null

  constructor(uri: string, clientId: string, storage?: Storage, webSocket?: WebSocketClass) {
    // Check dependencies are satisfied in this browser.
    if (!webSocket && !(global && global.WebSocket)) {
      throw new Error(format(ERROR.UNSUPPORTED, ['WebSocket']))
    }
    if (!storage && !(global && global.localStorage)) {
      throw new Error(format(ERROR.UNSUPPORTED, ['localStorage']))
    }
    if (!('ArrayBuffer' in global && global.ArrayBuffer !== null)) {
      throw new Error(format(ERROR.UNSUPPORTED, ['ArrayBuffer']))
    }

    let clientIdLength = 0
    for (let i = 0; i < clientId.length; i++) {
      let charCode = clientId.charCodeAt(i)
      if (0xd800 <= charCode && charCode <= 0xdbff) {
        i++ // Surrogate pair.
      }
      clientIdLength++
    }
    if (typeof clientId !== 'string' || clientIdLength > 65535)
      throw new Error(format(ERROR.INVALID_ARGUMENT, [clientId, 'clientId']))

    this.trace('Paho.Client', uri, clientId)

    this.uri = uri
    this.clientId = clientId
    this._wsuri = null
    this.storage = storage || global.localStorage
    this.webSocket = webSocket ? webSocket : global.WebSocket

    // Local storagekeys are qualified with the following string.
    // The conditional inclusion of path in the key is for backward
    // compatibility to when the path was not configurable and assumed to
    // be /mqtt
    this._localKey = uri + ':' + clientId + ':'

    // Create private instance-only message queue
    // Internal queue of messages to be sent, in sending order.
    this._msg_queue = []
    this._buffered_msg_queue = []

    // Messages we have sent and are expecting a response for, indexed by their respective message ids.
    this._sentMessages = {}

    // Messages we have received and acknowleged and are expecting a confirm message for
    // indexed by their respective message ids.
    this._receivedMessages = {}

    // Unique identifier for SEND messages, incrementing
    // counter as messages are sent.
    this._message_identifier = 1

    // Used to determine the transmission sequence of stored sent messages.
    this._sequence = 0

    // Load the local state, if any, from the saved version, only restore state relevant to this client.
    Object.keys(this.storage).forEach(key => {
      if (key.indexOf('Sent:' + this._localKey) === 0 || key.indexOf('Received:' + this._localKey) === 0) {
        this.restore(key)
      }
    })
  }

  private _formatConnectOptions(connectOptions: ConnectOptions) {
    connectOptions = connectOptions || {}
    validate(connectOptions, {
      timeout: 'number',
      userName: 'string',
      password: 'string',
      willMessage: 'object',
      keepAliveInterval: 'number',
      cleanSession: 'boolean',
      useSSL: 'boolean',
      invocationContext: 'object',
      onSuccess: 'function',
      onFailure: 'function',
      hosts: 'object',
      ports: 'object',
      reconnect: 'boolean',
      mqttVersion: 'number',
      mqttVersionExplicit: 'boolean',
      uris: 'object',
    })
    // If no keep alive interval is set, assume 60 seconds.
    if (connectOptions.keepAliveInterval === undefined) connectOptions.keepAliveInterval = 60

    if (connectOptions.mqttVersion === undefined) {
      connectOptions.mqttVersionExplicit = false
      connectOptions.mqttVersion = 4
    } else {
      connectOptions.mqttVersionExplicit = true
    }

    if (connectOptions.mqttVersion > 4 || connectOptions.mqttVersion < 3) {
      throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.mqttVersion, 'connectOptions.mqttVersion']))
    }

    //Check that if password is set, so is username
    if (connectOptions.password !== undefined && connectOptions.userName === undefined)
      throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.password, 'connectOptions.password']))

    if (connectOptions.willMessage) {
      if (!(connectOptions.willMessage instanceof Message))
        throw new Error(format(ERROR.INVALID_TYPE, [connectOptions.willMessage, 'connectOptions.willMessage']))
      // The will message must have a payload that can be represented as a string.
      // Cause the willMessage to throw an exception if this is not the case.
      connectOptions.willMessage.stringPayload = null

      if (typeof connectOptions.willMessage.destinationName === 'undefined')
        throw new Error(
          format(ERROR.INVALID_TYPE, [
            typeof connectOptions.willMessage.destinationName,
            'connectOptions.willMessage.destinationName',
          ]),
        )
    }
    if (typeof connectOptions.cleanSession === 'undefined') connectOptions.cleanSession = true
    if (connectOptions.hosts) {
      if (!(connectOptions.hosts instanceof Array))
        throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.hosts, 'connectOptions.hosts']))
      if (connectOptions.hosts.length < 1)
        throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.hosts, 'connectOptions.hosts']))

      let usingURIs = false
      for (let i = 0; i < connectOptions.hosts.length; i++) {
        if (typeof connectOptions.hosts[i] !== 'string')
          throw new Error(
            format(ERROR.INVALID_TYPE, [typeof connectOptions.hosts[i], 'connectOptions.hosts[' + i + ']']),
          )
        if (/^(wss?):\/\/((\[(.+)\])|([^\/]+?))(:(\d+))?(\/.*)$/.test(connectOptions.hosts[i])) {
          if (i === 0) {
            usingURIs = true
          } else if (!usingURIs) {
            throw new Error(
              format(ERROR.INVALID_ARGUMENT, [connectOptions.hosts[i], 'connectOptions.hosts[' + i + ']']),
            )
          }
        } else if (usingURIs) {
          throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.hosts[i], 'connectOptions.hosts[' + i + ']']))
        }
      }

      if (!usingURIs) {
        if (!connectOptions.ports)
          throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.ports, 'connectOptions.ports']))
        if (!(connectOptions.ports instanceof Array))
          throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.ports, 'connectOptions.ports']))
        if (connectOptions.hosts.length !== connectOptions.ports.length)
          throw new Error(format(ERROR.INVALID_ARGUMENT, [connectOptions.ports, 'connectOptions.ports']))

        connectOptions.uris = []

        for (let i = 0; i < connectOptions.hosts.length; i++) {
          if (typeof connectOptions.ports[i] !== 'number' || connectOptions.ports[i] < 0)
            throw new Error(
              format(ERROR.INVALID_TYPE, [typeof connectOptions.ports[i], 'connectOptions.ports[' + i + ']']),
            )
          let host = connectOptions.hosts[i]
          let port = connectOptions.ports[i]

          let ipv6 = host.indexOf(':') !== -1
          const uri = 'ws://' + (ipv6 ? '[' + host + ']' : host) + ':' + port + connectOptions.path
          connectOptions.uris.push(uri)
        }
      } else {
        connectOptions.uris = connectOptions.hosts
      }
    }

    return connectOptions
  }

  connect(connectOptions: ConnectOptions) {
    connectOptions = this._formatConnectOptions(connectOptions)

    // do connect
    const connectOptionsMasked = this._traceMask(connectOptions, 'password')
    this.trace('Client.connect', connectOptionsMasked, this.socket, this.connected)

    if (this.connected) throw new Error(format(ERROR.INVALID_STATE, ['already connected']))
    if (this.socket) throw new Error(format(ERROR.INVALID_STATE, ['already connected']))

    if (this._reconnecting) {
      // connect() function is called while reconnect is in progress.
      // Terminate the auto reconnect process to use new connect options.
      if (this._reconnectTimeout) clearTimeout(this._reconnectTimeout)
      this._reconnectTimeout = null
      this._reconnecting = false
    }

    this.connectOptions = connectOptions
    this._reconnectInterval = 1
    this._reconnecting = false
    if (connectOptions.uris) {
      this.hostIndex = 0
      this._doConnect(connectOptions.uris[0])
    } else {
      this._doConnect(this.uri)
    }
  }

  subscribe(filter: string[] | string, subscribeOptions: SubscribeOptions) {
    if (typeof filter !== 'string' && filter.constructor !== Array) throw new Error('Invalid argument:' + filter)
    subscribeOptions = subscribeOptions || {}
    validate(subscribeOptions, {
      qos: 'number',
      invocationContext: 'object',
      onSuccess: 'function',
      onFailure: 'function',
      timeout: 'number',
    })
    if (subscribeOptions.timeout && !subscribeOptions.onFailure)
      throw new Error('subscribeOptions.timeout specified with no onFailure callback.')
    if (
      typeof subscribeOptions.qos !== 'undefined' &&
      !(subscribeOptions.qos === 0 || subscribeOptions.qos === 1 || subscribeOptions.qos === 2)
    )
      throw new Error(format(ERROR.INVALID_ARGUMENT, [subscribeOptions.qos, 'subscribeOptions.qos']))

    this.trace('Client.subscribe', filter, subscribeOptions)
    if (!this.connected) throw new Error(format(ERROR.INVALID_STATE, ['not connected']))

    const wireMessage = new WireMessage(MESSAGE_TYPE.SUBSCRIBE)
    wireMessage.topics = filter.constructor === Array ? (filter as string[]) : ([filter] as string[])
    if (subscribeOptions.qos === undefined) subscribeOptions.qos = 0
    wireMessage.requestedQos = []
    for (let i = 0; i < wireMessage.topics.length; i++) wireMessage.requestedQos[i] = subscribeOptions.qos

    if (subscribeOptions.onSuccess) {
      const onSuccess = subscribeOptions.onSuccess
      wireMessage.onSuccess = function (grantedQos: number) {
        onSuccess({ invocationContext: subscribeOptions.invocationContext, grantedQos: grantedQos })
      }
    }

    if (subscribeOptions.onFailure) {
      const onFailure = subscribeOptions.onFailure
      wireMessage.onFailure = function (errorCode: number) {
        onFailure({
          invocationContext: subscribeOptions.invocationContext,
          errorCode: errorCode,
          errorMessage: '' + errorCode,
        })
      }
    }

    if (subscribeOptions.timeout && subscribeOptions.onFailure) {
      // 订阅超时时长，如果有该参数则设置一个定时器
      const onFailure = subscribeOptions.onFailure
      wireMessage.timeOut = setTimeout(() => {
        onFailure({
          invocationContext: subscribeOptions.invocationContext,
          errorCode: ERROR.SUBSCRIBE_TIMEOUT.code,
          errorMessage: format(ERROR.SUBSCRIBE_TIMEOUT),
        })
      }, subscribeOptions.timeout)
    }

    // All subscriptions return a SUBACK.
    this._requires_ack(wireMessage)
    this._schedule_message(wireMessage)
  }

  unsubscribe(filter: string[] | string, unsubscribeOptions: SubscribeOptions) {
    if (typeof filter !== 'string' && filter.constructor !== Array) throw new Error('Invalid argument:' + filter)
    unsubscribeOptions = unsubscribeOptions || {}
    validate(unsubscribeOptions, {
      invocationContext: 'object',
      onSuccess: 'function',
      onFailure: 'function',
      timeout: 'number',
    })
    if (unsubscribeOptions.timeout && !unsubscribeOptions.onFailure)
      throw new Error('unsubscribeOptions.timeout specified with no onFailure callback.')

    this.trace('Client.unsubscribe', filter, unsubscribeOptions)

    if (!this.connected) throw new Error(format(ERROR.INVALID_STATE, ['not connected']))

    const wireMessage = new WireMessage(MESSAGE_TYPE.UNSUBSCRIBE)
    wireMessage.topics = filter.constructor === Array ? (filter as string[]) : ([filter] as string[])

    if (unsubscribeOptions.onSuccess) {
      const onSuccess = unsubscribeOptions.onSuccess
      wireMessage.callback = function () {
        onSuccess({ invocationContext: unsubscribeOptions.invocationContext })
      }
    }
    if (unsubscribeOptions.timeout && unsubscribeOptions.onFailure) {
      const onFailure = unsubscribeOptions.onFailure
      wireMessage.timeOut = setTimeout(() => {
        onFailure({
          invocationContext: unsubscribeOptions.invocationContext,
          errorCode: ERROR.UNSUBSCRIBE_TIMEOUT.code,
          errorMessage: format(ERROR.UNSUBSCRIBE_TIMEOUT),
        })
      }, unsubscribeOptions.timeout)
    }

    // All unsubscribes return a SUBACK.
    this._requires_ack(wireMessage)
    this._schedule_message(wireMessage)
  }

  send(topic: string | MqttMessage, payload?: string | Uint8Array, qos?: number, retained?: boolean): void {
    let message

    if (arguments.length === 0) {
      throw new Error('Invalid argument.' + 'length')
    } else if (arguments.length == 1) {
      if (!(topic instanceof Message) && typeof topic !== 'string') throw new Error('Invalid argument:' + typeof topic)

      message = <MqttMessage>topic
      if (typeof message.destinationName === 'undefined')
        throw new Error(format(ERROR.INVALID_ARGUMENT, [message.destinationName, 'Message.destinationName']))
    } else {
      //parameter checking in Message object
      message = new Message(<string | Uint8Array>payload)
      message.destinationName = <string>topic
      if (arguments.length >= 3) message.qos = <number>qos
      if (arguments.length >= 4) message.retained = <boolean>retained
    }

    this.trace('Client.send', message)

    const wireMessage = new WireMessage(MESSAGE_TYPE.PUBLISH)
    wireMessage.payloadMessage = message

    if (this.connected) {
      // Mark qos 1 & 2 message as "ACK required"
      // For qos 0 message, invoke onMessageDelivered callback if there is one.
      // Then schedule the message.
      if (message.qos > 0) {
        this._requires_ack(wireMessage)
      } else if (this.onMessageDelivered) {
        const onMessageDelivered = this.onMessageDelivered
        wireMessage.onDispatched = () => onMessageDelivered(wireMessage.payloadMessage)
      }
      this._schedule_message(wireMessage)
    } else {
      // Currently disconnected, will not schedule this message
      // Check if reconnecting is in progress and disconnected publish is enabled.
      if (this._reconnecting && this.disconnectedPublishing) {
        // Check the limit which include the "required ACK" messages
        let messageCount = Object.keys(this._sentMessages).length + this._buffered_msg_queue.length
        if (messageCount > this.disconnectedBufferSize) {
          throw new Error(format(ERROR.BUFFER_FULL, [this.disconnectedBufferSize]))
        } else {
          if (message.qos > 0) {
            // Mark this message as "ACK required"
            this._requires_ack(wireMessage)
          } else {
            wireMessage.sequence = ++this._sequence
            // Add messages in fifo order to array, by adding to start
            this._buffered_msg_queue.unshift(wireMessage)
          }
        }
      } else {
        throw new Error(format(ERROR.INVALID_STATE, ['not connected']))
      }
    }
  }

  publish(topic: string | MqttMessage, payload?: string | Uint8Array, qos?: number, retained?: boolean) {
    this.send(topic, payload, qos, retained)
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect() {
    this.trace('Client.disconnect')

    if (this._reconnecting) {
      // disconnect() function is called while reconnect is in progress.
      // Terminate the auto reconnect process.
      if (this._reconnectTimeout) clearTimeout(this._reconnectTimeout)
      this._reconnectTimeout = null
      this._reconnecting = false
    }

    if (!this.socket) throw new Error(format(ERROR.INVALID_STATE, ['not connecting or connected']))

    const wireMessage = new WireMessage(MESSAGE_TYPE.DISCONNECT)

    // Run the disconnected call back as soon as the message has been sent,
    // in case of a failure later on in the disconnect processing.
    // as a consequence, the _disconected call back may be run several times.
    wireMessage.onDispatched = () => {
      this._disconnected()
    }

    this._schedule_message(wireMessage)
  }

  getTraceLog() {
    if (this._traceBuffer !== null) {
      this.trace('Client.getTraceLog', new Date())
      this.trace('Client.getTraceLog in flight messages', this._sentMessages.length)
      for (let key in this._sentMessages) this.trace('_sentMessages ', key, this._sentMessages[key])
      for (let key in this._receivedMessages) this.trace('_receivedMessages ', key, this._receivedMessages[key])

      return this._traceBuffer
    }
  }

  startTrace() {
    if (this._traceBuffer === null) {
      this._traceBuffer = []
    }
    this.trace('Client.startTrace', new Date(), packageJson.version)
  }

  stopTrace() {
    this._traceBuffer = null
  }

  trace(...args: any) {
    // Pass trace message back to client's callback function
    const traceFunction = this.traceFunction
    if (traceFunction) {
      traceFunction({ severity: 'Debug', message: args.map((a: any) => JSON.stringify(a)).join('') })
    }

    //buffer style trace
    if (this._traceBuffer !== null) {
      for (let i = 0, max = args.length; i < max; i++) {
        if (this._traceBuffer.length === this._MAX_TRACE_ENTRIES) {
          this._traceBuffer.shift()
        }
        if (i === 0 || typeof args[i] === 'undefined') {
          this._traceBuffer.push(args[i])
        } else {
          this._traceBuffer.push('  ' + JSON.stringify(args[i]))
        }
      }
    }
  }

  store(prefix: string, wireMessage: WireMessage) {
    let storedMessage: any = { type: wireMessage.type, messageIdentifier: wireMessage.messageIdentifier, version: 1 }

    switch (wireMessage.type) {
      case MESSAGE_TYPE.PUBLISH:
        if (wireMessage.pubRecReceived) storedMessage.pubRecReceived = true

        // Convert the payload to a hex string.
        storedMessage.payloadMessage = {}
        let hex = ''
        let messageBytes = wireMessage.payloadMessage && wireMessage.payloadMessage.payloadBytes
        for (let i = 0; i < messageBytes.length; i++) {
          if (messageBytes[i] <= 0xf) hex = hex + '0' + messageBytes[i].toString(16)
          else hex = hex + messageBytes[i].toString(16)
        }
        storedMessage.payloadMessage.payloadHex = hex

        if (wireMessage.payloadMessage) {
          storedMessage.payloadMessage.qos = wireMessage.payloadMessage.qos
          storedMessage.payloadMessage.destinationName = wireMessage.payloadMessage.destinationName
          if (wireMessage.payloadMessage.duplicate) storedMessage.payloadMessage.duplicate = true
          if (wireMessage.payloadMessage.retained) storedMessage.payloadMessage.retained = true
        }

        // Add a sequence number to sent messages.
        if (prefix.indexOf('Sent:') === 0) {
          if (wireMessage.sequence === undefined) wireMessage.sequence = ++this._sequence
          storedMessage.sequence = wireMessage.sequence
        }
        break

      default:
        throw Error(
          format(ERROR.INVALID_STORED_DATA, [prefix + this._localKey + wireMessage.messageIdentifier, storedMessage]),
        )
    }
    this.storage.setItem(prefix + this._localKey + wireMessage.messageIdentifier, JSON.stringify(storedMessage))
  }

  restore(key: string) {
    const value = this.storage.getItem(key)
    if (!value) {
      return
    }
    const storedMessage = JSON.parse(value)

    const wireMessage = new WireMessage(storedMessage.type, storedMessage)

    switch (storedMessage.type) {
      case MESSAGE_TYPE.PUBLISH:
        // Replace the payload message with a Message object.
        let hex = storedMessage.payloadMessage.payloadHex
        const buffer = new ArrayBuffer(hex.length / 2)
        const byteStream = new Uint8Array(buffer)
        let i = 0
        while (hex.length >= 2) {
          const x = parseInt(hex.substring(0, 2), 16)
          hex = hex.substring(2, hex.length)
          byteStream[i++] = x
        }
        const payloadMessage = new Message(byteStream)

        payloadMessage.qos = storedMessage.payloadMessage.qos
        payloadMessage.destinationName = storedMessage.payloadMessage.destinationName
        if (storedMessage.payloadMessage.duplicate) payloadMessage.duplicate = true
        if (storedMessage.payloadMessage.retained) payloadMessage.retained = true
        wireMessage.payloadMessage = payloadMessage

        break

      default:
        throw Error(format(ERROR.INVALID_STORED_DATA, [key, value]))
    }

    if (key.indexOf('Sent:' + this._localKey) === 0) {
      wireMessage.payloadMessage.duplicate = true
      if (wireMessage.messageIdentifier) {
        this._sentMessages[wireMessage.messageIdentifier] = wireMessage
      }
    } else if (key.indexOf('Received:' + this._localKey) === 0) {
      if (wireMessage.messageIdentifier) {
        this._receivedMessages[wireMessage.messageIdentifier] = wireMessage
      }
    }
  }

  private _doConnect(wsurl: string) {
    // When the socket is open, this client will send the CONNECT WireMessage using the saved parameters.
    if (this.connectOptions.useSSL) {
      const uriParts = wsurl.split(':')
      uriParts[0] = 'wss'
      wsurl = uriParts.join(':')
    }
    this._wsuri = wsurl
    this.connected = false

    if (<number>this.connectOptions.mqttVersion < 4) {
      this.socket = new this.webSocket(wsurl, ['mqttv3.1'])
    } else {
      this.socket = new this.webSocket(wsurl, ['mqtt'])
    }
    this.socket.binaryType = 'arraybuffer'
    this.socket.onopen = this._on_socket_open
    this.socket.onmessage = this._on_socket_message
    this.socket.onerror = this._on_socket_error
    this.socket.onclose = this._on_socket_close

    this.sendPinger = new Pinger(this, <number>this.connectOptions.keepAliveInterval)

    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout)
      this._connectTimeout = null
    }

    this._connectTimeout = setTimeout(() => {
      this._disconnected(ERROR.CONNECT_TIMEOUT.code, format(ERROR.CONNECT_TIMEOUT))
    }, this.connectOptions.timeout)
  }

  private _schedule_message(message: WireMessage) {
    // Add messages in fifo order to array, by adding to start
    this._msg_queue.unshift(message)
    // Process outstanding messages in the queue if we have an  open socket, and have received CONNACK.
    if (this.connected) {
      this._process_queue()
    }
  }

  private _process_queue() {
    let message = null

    // Send all queued messages down socket connection
    while ((message = this._msg_queue.pop())) {
      this._socket_send(message)
      // Notify listeners that message was successfully sent
      message.onDispatched && message.onDispatched()
    }
  }

  private _requires_ack(wireMessage: WireMessage) {
    const messageCount = Object.keys(this._sentMessages).length
    if (messageCount > this.maxMessageIdentifier) throw Error('Too many messages:' + messageCount)

    while (this._sentMessages[this._message_identifier] !== undefined) {
      this._message_identifier++
    }
    wireMessage.messageIdentifier = this._message_identifier
    this._sentMessages[wireMessage.messageIdentifier] = wireMessage
    if (wireMessage.type === MESSAGE_TYPE.PUBLISH) {
      this.store('Sent:', wireMessage)
    }
    if (this._message_identifier === this.maxMessageIdentifier) {
      this._message_identifier = 1
    }
  }

  private _on_socket_open = () => {
    // Create the CONNECT message object.
    const wireMessage = new WireMessage(MESSAGE_TYPE.CONNECT, this.connectOptions)
    wireMessage.clientId = this.clientId
    this._socket_send(wireMessage)
  }

  private _on_socket_message = (event: any) => {
    this.trace('Client._on_socket_message', event.data)
    const messages = this._deframeMessages(event.data)
    if (messages && messages.length) {
      for (let i = 0; i < messages.length; i += 1) {
        this._handleMessage(messages[i])
      }
    }
  }

  private _deframeMessages = (data: ArrayBuffer): WireMessage[] | undefined => {
    let byteArray = new Uint8Array(data)
    const messages = []
    if (this.receiveBuffer) {
      const newData = new Uint8Array(this.receiveBuffer.length + byteArray.length)
      newData.set(this.receiveBuffer)
      newData.set(byteArray, this.receiveBuffer.length)
      byteArray = newData
      this.receiveBuffer = null
    }
    try {
      let offset = 0
      while (offset < byteArray.length) {
        const result = decodeMessage(byteArray, offset)
        const wireMessage = result[0]
        offset = result[1]
        if (wireMessage !== null) {
          messages.push(wireMessage)
        } else {
          break
        }
      }
      if (offset < byteArray.length) {
        this.receiveBuffer = byteArray.subarray(offset)
      }
      return messages
    } catch (error) {
      const errorStack =
        error.hasOwnProperty('stack') == 'undefined' ? error.stack.toString() : 'No Error Stack Available'
      this._disconnected(ERROR.INTERNAL_ERROR.code, format(ERROR.INTERNAL_ERROR, [error.message, errorStack]))
    }
  }

  private _handleMessage(wireMessage: WireMessage) {
    this.trace('Client._handleMessage', wireMessage)

    try {
      switch (wireMessage.type) {
        case MESSAGE_TYPE.CONNACK:
          if (this._connectTimeout) {
            clearTimeout(this._connectTimeout)
            this._connectTimeout = null
          }
          if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout)
            this._reconnectTimeout = null
          }

          // If we have started using clean session then clear up the local state.
          if (this.connectOptions.cleanSession) {
            for (let key in this._sentMessages) {
              const sentMessage = this._sentMessages[key]
              this.storage.removeItem('Sent:' + this._localKey + sentMessage.messageIdentifier)
            }
            this._sentMessages = {}

            for (let key in this._receivedMessages) {
              let receivedMessage = this._receivedMessages[key]
              this.storage.removeItem('Received:' + this._localKey + receivedMessage.messageIdentifier)
            }
            this._receivedMessages = {}
          }
          // Client connected and ready for business.
          if (wireMessage.returnCode === 0) {
            this.connected = true
            // Jump to the end of the list of uris and stop looking for a good host.

            if (this.connectOptions.uris) this.hostIndex = this.connectOptions.uris.length
          } else {
            this._disconnected(
              ERROR.CONNACK_RETURNCODE.code,
              format(ERROR.CONNACK_RETURNCODE, [
                <number>wireMessage.returnCode,
                CONNACK_RC[<number>wireMessage.returnCode],
              ]),
            )
            break
          }

          // Resend messages.
          let sequencedMessages = []
          for (let msgId in this._sentMessages) {
            if (this._sentMessages.hasOwnProperty(msgId)) sequencedMessages.push(this._sentMessages[msgId])
          }

          // Also schedule qos 0 buffered messages if any
          if (this._buffered_msg_queue.length > 0) {
            let msg = null
            while ((msg = this._buffered_msg_queue.pop())) {
              sequencedMessages.push(msg)
              if (this.onMessageDelivered) {
                const onMessageDelivered = this.onMessageDelivered
                wireMessage.onDispatched = () => onMessageDelivered(wireMessage.payloadMessage)
              }
            }
          }

          // Sort sentMessages into the original sent order.
          sequencedMessages = sequencedMessages.sort(function (a, b) {
            return a.sequence - b.sequence
          })
          for (let i = 0, len = sequencedMessages.length; i < len; i++) {
            const sentMessage = sequencedMessages[i]
            if (sentMessage.type == MESSAGE_TYPE.PUBLISH && sentMessage.pubRecReceived) {
              const pubRelMessage = new WireMessage(MESSAGE_TYPE.PUBREL, {
                messageIdentifier: sentMessage.messageIdentifier,
              })
              this._schedule_message(pubRelMessage)
            } else {
              this._schedule_message(sentMessage)
            }
          }

          // Execute the connectOptions.onSuccess callback if there is one.
          // Will also now return if this connection was the result of an automatic
          // reconnect and which URI was successfully connected to.
          if (this.connectOptions.onSuccess) {
            this.connectOptions.onSuccess({ invocationContext: this.connectOptions.invocationContext })
          }

          let reconnected = false
          if (this._reconnecting) {
            reconnected = true
            this._reconnectInterval = 1
            this._reconnecting = false
          }

          // Execute the onConnected callback if there is one.
          this._connected(reconnected, this._wsuri)

          // Process all queued messages now that the connection is established.
          this._process_queue()
          break

        case MESSAGE_TYPE.PUBLISH:
          this._receivePublish(wireMessage)
          break

        case MESSAGE_TYPE.PUBACK: {
          const sentMessage = wireMessage.messageIdentifier ? this._sentMessages[wireMessage.messageIdentifier] : null
          // If this is a re flow of a PUBACK after we have restarted receivedMessage will not exist.
          if (wireMessage.messageIdentifier && sentMessage) {
            delete this._sentMessages[wireMessage.messageIdentifier]
            this.storage.removeItem('Sent:' + this._localKey + wireMessage.messageIdentifier)
            if (this.onMessageDelivered) this.onMessageDelivered(sentMessage.payloadMessage)
          }
          break
        }

        case MESSAGE_TYPE.PUBREC: {
          const sentMessage = wireMessage.messageIdentifier ? this._sentMessages[wireMessage.messageIdentifier] : null
          // If this is a re flow of a PUBREC after we have restarted receivedMessage will not exist.
          if (sentMessage) {
            sentMessage.pubRecReceived = true
            const pubRelMessage = new WireMessage(MESSAGE_TYPE.PUBREL, {
              messageIdentifier: wireMessage.messageIdentifier,
            })
            this.store('Sent:', sentMessage)
            this._schedule_message(pubRelMessage)
          }
          break
        }

        case MESSAGE_TYPE.PUBREL: {
          const receivedMessage = wireMessage.messageIdentifier
            ? this._receivedMessages[wireMessage.messageIdentifier]
            : null
          this.storage.removeItem('Received:' + this._localKey + wireMessage.messageIdentifier)
          // If this is a re flow of a PUBREL after we have restarted receivedMessage will not exist.
          if (receivedMessage && wireMessage.messageIdentifier) {
            this._receiveMessage(receivedMessage)
            delete this._receivedMessages[wireMessage.messageIdentifier]
          }
          // Always flow PubComp, we may have previously flowed PubComp but the server lost it and restarted.
          const pubCompMessage = new WireMessage(MESSAGE_TYPE.PUBCOMP, {
            messageIdentifier: wireMessage.messageIdentifier,
          })
          this._schedule_message(pubCompMessage)
          break
        }

        case MESSAGE_TYPE.PUBCOMP: {
          const sentMessage = wireMessage.messageIdentifier && this._sentMessages[wireMessage.messageIdentifier]
          if (sentMessage) {
            if (wireMessage.messageIdentifier) {
              delete this._sentMessages[wireMessage.messageIdentifier]
            }
            this.storage.removeItem('Sent:' + this._localKey + wireMessage.messageIdentifier)
            if (this.onMessageDelivered) this.onMessageDelivered(sentMessage.payloadMessage)
          }
          break
        }

        case MESSAGE_TYPE.SUBACK: {
          const sentMessage = wireMessage.messageIdentifier && this._sentMessages[wireMessage.messageIdentifier]
          if (sentMessage) {
            if (sentMessage.timeOut) sentMessage.timeOut.cancel()
            // This will need to be fixed when we add multiple topic support
            if (wireMessage.returnCode && (<Uint8Array>wireMessage.returnCode)[0] === 0x80) {
              if (sentMessage.onFailure) {
                sentMessage.onFailure(wireMessage.returnCode)
              }
            } else if (sentMessage.onSuccess) {
              sentMessage.onSuccess(wireMessage.returnCode)
            }
            if (wireMessage.messageIdentifier) {
              delete this._sentMessages[wireMessage.messageIdentifier]
            }
          }

          break
        }

        case MESSAGE_TYPE.UNSUBACK: {
          const sentMessage = wireMessage.messageIdentifier && this._sentMessages[wireMessage.messageIdentifier]
          if (sentMessage) {
            if (sentMessage.timeOut) sentMessage.timeOut.cancel()
            if (sentMessage.callback) {
              sentMessage.callback()
            }
            if (wireMessage.messageIdentifier) {
              delete this._sentMessages[wireMessage.messageIdentifier]
            }
          }
          break
        }

        case MESSAGE_TYPE.PINGRESP:
          /* The sendPinger or receivePinger may have sent a ping, the receivePinger has already been reset. */
          this.sendPinger && this.sendPinger.reset()
          break

        case MESSAGE_TYPE.DISCONNECT:
          // Clients do not expect to receive disconnect packets.
          this._disconnected(
            ERROR.INVALID_MQTT_MESSAGE_TYPE.code,
            format(ERROR.INVALID_MQTT_MESSAGE_TYPE, [wireMessage.type]),
          )
          break

        default:
          this._disconnected(
            ERROR.INVALID_MQTT_MESSAGE_TYPE.code,
            format(ERROR.INVALID_MQTT_MESSAGE_TYPE, [wireMessage.type]),
          )
      }
    } catch (error) {
      const errorStack =
        error.hasOwnProperty('stack') == 'undefined' ? error.stack.toString() : 'No Error Stack Available'
      this._disconnected(ERROR.INTERNAL_ERROR.code, format(ERROR.INTERNAL_ERROR, [error.message, errorStack]))
      return
    }
  }

  private _on_socket_error = (error: any) => {
    if (!this._reconnecting) {
      this._disconnected(ERROR.SOCKET_ERROR.code, format(ERROR.SOCKET_ERROR, [error.data]))
    }
  }

  private _on_socket_close = () => {
    if (!this._reconnecting) {
      this._disconnected(ERROR.SOCKET_CLOSE.code, format(ERROR.SOCKET_CLOSE))
    }
  }

  private _socket_send(wireMessage: WireMessage) {
    if (wireMessage.type == 1) {
      const wireMessageMasked = this._traceMask(wireMessage, 'password')
      this.trace('Client._socket_send', wireMessageMasked)
    } else this.trace('Client._socket_send', wireMessage)

    this.socket && this.socket.send(wireMessage.encode())
    /* We have proved to the server we are alive. */
    this.sendPinger && this.sendPinger.reset()
  }

  private _receivePublish(wireMessage: WireMessage) {
    if (!wireMessage.payloadMessage) return

    switch (<string | number>wireMessage.payloadMessage.qos) {
      case 'undefined':
      case 0:
        this._receiveMessage(wireMessage)
        break

      case 1:
        const pubAckMessage = new WireMessage(MESSAGE_TYPE.PUBACK, { messageIdentifier: wireMessage.messageIdentifier })
        this._schedule_message(pubAckMessage)
        this._receiveMessage(wireMessage)
        break

      case 2:
        if (wireMessage.messageIdentifier) {
          this._receivedMessages[wireMessage.messageIdentifier] = wireMessage
        }
        this.store('Received:', wireMessage)
        const pubRecMessage = new WireMessage(MESSAGE_TYPE.PUBREC, { messageIdentifier: wireMessage.messageIdentifier })
        this._schedule_message(pubRecMessage)

        break

      default:
        throw Error('Invaild qos=' + wireMessage.payloadMessage.qos)
    }
  }

  private _receiveMessage(wireMessage: WireMessage) {
    if (this.onMessageArrived) {
      this.onMessageArrived(wireMessage.payloadMessage)
    }
  }

  private _connected(reconnect: boolean, uri: string | null) {
    if (this.onConnected) this.onConnected(reconnect, uri)
  }

  private _reconnect() {
    this.trace('Client._reconnect')
    if (!this.connected) {
      this._reconnecting = true
      if (this.sendPinger) {
        this.sendPinger.cancel()
      }
      if (this._reconnectInterval < 128) this._reconnectInterval = this._reconnectInterval * 2
      if (this.connectOptions.uris) {
        this.hostIndex = 0
        this._doConnect(this.connectOptions.uris[0])
      } else {
        this._doConnect(this.uri)
      }
    }
  }

  /**
   * Client has disconnected either at its own request or because the server
   * or network disconnected it. Remove all non-durable state.
   * @param {errorCode} [number] the error number.
   * @param {errorText} [string] the error text.
   * @ignore
   */
  _disconnected(errorCode?: number, errorText?: string) {
    this.trace('Client._disconnected', errorCode, errorText)

    if (errorCode !== undefined && this._reconnecting) {
      //Continue automatic reconnect process
      this._reconnectTimeout = setTimeout(this._reconnect, this._reconnectInterval)
      return
    }

    this.sendPinger && this.sendPinger.cancel()

    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout)
      this._connectTimeout = null
    }

    // Clear message buffers.
    this._msg_queue = []
    this._buffered_msg_queue = []

    if (this.socket) {
      // Cancel all socket callbacks so that they cannot be driven again by this socket.
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.onclose = null
      this.socket.close()
      this.socket = undefined
    }

    if (this.connectOptions.uris && this.hostIndex && this.hostIndex < this.connectOptions.uris.length - 1) {
      // Try the next host.
      this.hostIndex++
      this._doConnect(this.connectOptions.uris[this.hostIndex])
    } else {
      if (errorCode === undefined) {
        errorCode = ERROR.OK.code
        errorText = format(ERROR.OK)
      }

      // Run any application callbacks last as they may attempt to reconnect and hence create a new socket.
      if (this.connected) {
        this.connected = false
        // Execute the connectionLostCallback if there is one, and we were connected.
        if (this.onConnectionLost) {
          this.onConnectionLost({
            errorCode: errorCode,
            errorMessage: errorText,
            reconnect: this.connectOptions.reconnect,
            uri: this._wsuri,
          })
        }
        if (errorCode !== ERROR.OK.code && this.connectOptions.reconnect) {
          // Start automatic reconnect process for the very first time since last successful connect.
          this._reconnectInterval = 1
          this._reconnect()
          return
        }
      } else {
        // Otherwise we never had a connection, so indicate that the connect has failed.
        if (this.connectOptions.mqttVersion === 4 && this.connectOptions.mqttVersionExplicit === false) {
          this.trace('Failed to connect V4, dropping back to V3')
          this.connectOptions.mqttVersion = 3
          if (this.connectOptions.uris) {
            this.hostIndex = 0
            this._doConnect(this.connectOptions.uris[0])
          } else {
            this._doConnect(this.uri)
          }
        } else if (this.connectOptions.onFailure) {
          this.connectOptions.onFailure({
            invocationContext: this.connectOptions.invocationContext,
            errorCode: errorCode,
            errorMessage: errorText,
          })
        }
      }
    }
  }

  private _traceMask(traceObject: { [key: string]: any }, masked: string) {
    let traceObjectMasked: { [key: string]: any } = {}
    for (let attr in traceObject) {
      if (traceObject.hasOwnProperty(attr)) {
        if (attr == masked) traceObjectMasked[attr] = '******'
        else traceObjectMasked[attr] = traceObject[attr]
      }
    }
    return traceObjectMasked
  }
}

export default ClientImplementation
