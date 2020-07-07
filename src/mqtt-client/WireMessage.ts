import { MESSAGE_TYPE, MqttProtoIdentifierv3, MqttProtoIdentifierv4 } from './consts'
import { UTF8Length, encodeMBI, writeString, writeUint16 } from './utils'
import { MqttMessage } from './Message'

interface WireMessageOptions {
  messageIdentifier?: number
  mqttVersion?: 3 | 4
  clientId?: string
  willMessage?: MqttMessage
  userName?: string
  password?: string
  topics?: string[]
  requestedQos?: (0 | 1 | 2)[]
  payloadMessage?: MqttMessage
  cleanSession?: boolean
  keepAliveInterval?: number
  [key: string]: any
}

/**
 * Construct an MQTT wire protocol message.
 * @param type MQTT packet type.
 * @param options optional wire message attributes.
 *
 * Optional properties
 *
 * messageIdentifier: message ID in the range [0..65535]
 * payloadMessage:	Application Message - PUBLISH only
 * // connectStrings:	array of 0 or more Strings to be put into the CONNECT payload
 * topics:			array of strings (SUBSCRIBE, UNSUBSCRIBE)
 * requestQoS:		array of QoS values [0..2]
 *
 * "Flag" properties
 * cleanSession:	true if present / false if absent (CONNECT)
 * willMessage:  	true if present / false if absent (CONNECT)
 * isRetained:		true if present / false if absent (CONNECT)
 * userName:		true if present / false if absent (CONNECT)
 * password:		true if present / false if absent (CONNECT)
 * keepAliveInterval:	integer [0..65535]  (CONNECT)
 *
 * @private
 * @ignore
 */
class WireMessage {
  type: number
  sessionPresent?: boolean
  returnCode?: Uint8Array | number
  messageIdentifier?: number
  payloadMessage?: MqttMessage
  mqttVersion?: 3 | 4
  clientId?: string
  willMessage?: MqttMessage
  userName?: string
  password?: string
  topics?: string[]
  requestedQos?: (0 | 1 | 2)[] = []
  cleanSession?: boolean
  keepAliveInterval?: number
  onDispatched?: () => void // 消息成功出去时的回调
  onSuccess?: (data: any) => void // 操作成功的回调
  onFailure?: (data: any) => void; // 操作失败的回调

  [key: string]: any

  public constructor(type: number, options?: WireMessageOptions) {
    this.type = type
    for (const name in options) {
      if (options.hasOwnProperty(name)) {
        this[name] = options[name]
      }
    }
  }

  public encode() {
    // Compute the first byte of the fixed header
    let first = (this.type & 0x0f) << 4

    /*
     * Now calculate the length of the variable header + payload by adding up the lengths
     * of all the component parts
     */

    let remLength = 0
    const topicStrLength = []
    let destinationNameLength = 0
    let willMessagePayloadBytes
    let payloadBytes

    // if the message contains a messageIdentifier then we need two bytes for that
    if (this.messageIdentifier) remLength += 2

    switch (this.type) {
      // If this a Connect then we need to include 12 bytes for its header
      case MESSAGE_TYPE.CONNECT:
        switch (this.mqttVersion) {
          case 3:
            remLength += MqttProtoIdentifierv3.length + 3
            break
          case 4:
            remLength += MqttProtoIdentifierv4.length + 3
            break
        }

        remLength += UTF8Length(this.clientId) + 2
        if (this.willMessage) {
          remLength += UTF8Length(this.willMessage.destinationName) + 2
          // Will message is always a string, sent as UTF-8 characters with a preceding length.
          willMessagePayloadBytes = this.willMessage.payloadBytes
          if (!(willMessagePayloadBytes instanceof Uint8Array))
            willMessagePayloadBytes = new Uint8Array(willMessagePayloadBytes)
          remLength += willMessagePayloadBytes.byteLength + 2
        }
        if (this.userName) remLength += UTF8Length(this.userName) + 2
        if (this.password) remLength += UTF8Length(this.password) + 2
        break

      // Subscribe, Unsubscribe can both contain topic strings
      case MESSAGE_TYPE.SUBSCRIBE:
        if (this.topics && this.requestedQos) {
          first |= 0x02 // Qos = 1;
          for (let i = 0; i < this.topics.length; i++) {
            topicStrLength[i] = UTF8Length(this.topics[i])
            remLength += topicStrLength[i] + 2
          }
          remLength += this.requestedQos.length // 1 byte for each topic's Qos
          // QoS on Subscribe only
        }
        break

      case MESSAGE_TYPE.UNSUBSCRIBE:
        if (this.topics) {
          first |= 0x02 // Qos = 1;
          for (let i = 0; i < this.topics.length; i++) {
            topicStrLength[i] = UTF8Length(this.topics[i])
            remLength += topicStrLength[i] + 2
          }
        }
        break

      case MESSAGE_TYPE.PUBREL:
        first |= 0x02 // Qos = 1;
        break

      case MESSAGE_TYPE.PUBLISH:
        if (this.payloadMessage) {
          if (this.payloadMessage.duplicate) first |= 0x08
          first = first |= this.payloadMessage.qos << 1
          if (this.payloadMessage.retained) first |= 0x01
          destinationNameLength = UTF8Length(this.payloadMessage.destinationName)
          remLength += destinationNameLength + 2
          payloadBytes = this.payloadMessage.payloadBytes
          remLength += payloadBytes.byteLength
          if (payloadBytes instanceof ArrayBuffer) payloadBytes = new Uint8Array(payloadBytes)
          else if (!(payloadBytes instanceof Uint8Array)) payloadBytes = new Uint8Array(payloadBytes.buffer)
        }
        break

      case MESSAGE_TYPE.DISCONNECT:
        break

      default:
        break
    }

    // Now we can allocate a buffer for the message

    const mbi = encodeMBI(remLength) // Convert the length to MQTT MBI format
    let pos = mbi.length + 1 // Offset of start of variable header
    const buffer = new ArrayBuffer(remLength + pos)
    const byteStream = new Uint8Array(buffer) // view it as a sequence of bytes

    // Write the fixed header into the buffer
    byteStream[0] = first
    byteStream.set(mbi, 1)

    // If this is a PUBLISH then the variable header starts with a topic
    if (this.type === MESSAGE_TYPE.PUBLISH)
      pos = writeString(
        this.payloadMessage && this.payloadMessage.destinationName,
        destinationNameLength,
        byteStream,
        pos,
      )
    // If this is a CONNECT then the variable header contains the protocol name/version, flags and keepalive time
    else if (this.type === MESSAGE_TYPE.CONNECT) {
      switch (this.mqttVersion) {
        case 3:
          byteStream.set(MqttProtoIdentifierv3, pos)
          pos += MqttProtoIdentifierv3.length
          break
        case 4:
          byteStream.set(MqttProtoIdentifierv4, pos)
          pos += MqttProtoIdentifierv4.length
          break
      }
      let connectFlags = 0
      if (this.cleanSession) connectFlags = 0x02
      if (this.willMessage) {
        connectFlags |= 0x04
        connectFlags |= this.willMessage.qos << 3
        if (this.willMessage.retained) {
          connectFlags |= 0x20
        }
      }
      if (this.userName) connectFlags |= 0x80
      if (this.password) connectFlags |= 0x40
      byteStream[pos++] = connectFlags
      pos = writeUint16(this.keepAliveInterval, byteStream, pos)
    }

    // Output the messageIdentifier - if there is one
    if (this.messageIdentifier) pos = writeUint16(this.messageIdentifier, byteStream, pos)

    switch (this.type) {
      case MESSAGE_TYPE.CONNECT:
        pos = writeString(this.clientId, UTF8Length(this.clientId), byteStream, pos)
        if (this.willMessage) {
          pos = writeString(
            this.willMessage.destinationName,
            UTF8Length(this.willMessage.destinationName),
            byteStream,
            pos,
          )
          if (willMessagePayloadBytes) {
            pos = writeUint16(willMessagePayloadBytes.byteLength, byteStream, pos)
            byteStream.set(willMessagePayloadBytes, pos)
            pos += willMessagePayloadBytes.byteLength
          }
        }
        if (this.userName) pos = writeString(this.userName, UTF8Length(this.userName), byteStream, pos)
        if (this.password) pos = writeString(this.password, UTF8Length(this.password), byteStream, pos)
        break

      case MESSAGE_TYPE.PUBLISH:
        if (payloadBytes) {
          // PUBLISH has a text or binary payload, if text do not add a 2 byte length field, just the UTF characters.
          byteStream.set(payloadBytes, pos)
        }

        break

      //    	    case MESSAGE_TYPE.PUBREC:
      //    	    case MESSAGE_TYPE.PUBREL:
      //    	    case MESSAGE_TYPE.PUBCOMP:
      //    	    	break;

      case MESSAGE_TYPE.SUBSCRIBE:
        if (this.topics && this.requestedQos) {
          // SUBSCRIBE has a list of topic strings and request QoS
          for (let i = 0; i < this.topics.length; i++) {
            pos = writeString(this.topics[i], topicStrLength[i], byteStream, pos)
            byteStream[pos++] = this.requestedQos[i]
          }
        }
        break

      case MESSAGE_TYPE.UNSUBSCRIBE:
        if (this.topics) {
          // UNSUBSCRIBE has a list of topic strings
          for (let i = 0; i < this.topics.length; i++)
            pos = writeString(this.topics[i], topicStrLength[i], byteStream, pos)
        }
        break

      default:
      // Do nothing.
    }

    return buffer
  }
}

export default WireMessage
