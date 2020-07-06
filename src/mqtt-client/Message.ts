import { format, parseUTF8, UTF8Length, stringToUTF8 } from './utils'
import { ERROR } from './consts'

/**
 * An application message, sent or received.
 * <p>
 * All attributes may be null, which implies the default values.
 *
 * @name Paho.Message
 * @constructor
 * @param {String|ArrayBuffer} payload The message data to be sent.
 * <p>
 * @property {string} payloadString <i>read only</i> The payload as a string if the payload consists of valid UTF-8 characters.
 * @property {ArrayBuffer} payloadBytes <i>read only</i> The payload as an ArrayBuffer.
 * <p>
 * @property {string} destinationName <b>mandatory</b> The name of the destination to which the message is to be sent
 *                    (for messages about to be sent) or the name of the destination from which the message has been received.
 *                    (for messages received by the onMessage function).
 * <p>
 * @property {number} qos The Quality of Service used to deliver the message.
 * <dl>
 *     <dt>0 Best effort (default).
 *     <dt>1 At least once.
 *     <dt>2 Exactly once.
 * </dl>
 * <p>
 * @property {Boolean} retained If true, the message is to be retained by the server and delivered
 *                     to both current and future subscriptions.
 *                     If false the server only delivers the message to current subscribers, this is the default for new Messages.
 *                     A received message has the retained boolean set to true if the message was published
 *                     with the retained boolean set to true
 *                     and the subscrption was made after the message has been published.
 * <p>
 * @property {Boolean} duplicate <i>read only</i> If true, this message might be a duplicate of one which has already been received.
 *                     This is only set on messages received from the server.
 *
 */
class Message implements MqttMessage {
  payload: Payload

  constructor(newPayload: Payload) {
    if (
      typeof newPayload === 'string' ||
      newPayload instanceof ArrayBuffer ||
      (ArrayBuffer.isView(newPayload) && !(newPayload instanceof DataView))
    ) {
      this.payload = newPayload
    } else {
      throw format(ERROR.INVALID_ARGUMENT, [newPayload.toString(), 'newPayload'])
    }
  }

  get payloadString(): string {
    if (typeof this.payload === 'string') return this.payload
    else return parseUTF8(this.payload, 0, this.payload.length)
  }

  get payloadBytes(): Uint8Array {
    const payload = this.payload
    if (typeof payload === 'string') {
      const buffer = new ArrayBuffer(UTF8Length(payload))
      const byteStream = new Uint8Array(buffer)
      stringToUTF8(payload, byteStream, 0)

      return byteStream
    } else {
      return payload
    }
  }

  get destinationName(): string {
    return this.destinationName
  }

  set destinationName(newDestinationName: string) {
    if (typeof newDestinationName === 'string') this.destinationName = newDestinationName
    else throw new Error(format(ERROR.INVALID_ARGUMENT, [newDestinationName, 'newDestinationName']))
  }

  get qos(): number {
    return this.qos
  }

  set qos(newQos: number) {
    if (newQos === 0 || newQos === 1 || newQos === 2) this.qos = newQos
    else throw new Error('Invalid argument:' + newQos)
  }

  get retained(): boolean {
    return this.retained
  }

  set retained(newRetained: boolean) {
    if (typeof newRetained === 'boolean') this.retained = newRetained
    else throw new Error(format(ERROR.INVALID_ARGUMENT, [newRetained, 'newRetained']))
  }

  get topic(): string {
    return this.destinationName
  }

  set topic(newTopic: string) {
    this.destinationName = newTopic
  }

  get duplicate(): boolean {
    return this.duplicate
  }

  set duplicate(newDuplicate: boolean) {
    this.duplicate = newDuplicate
  }

  get stringPayload(): string | null {
    return this.stringPayload
  }

  set stringPayload(newStringPayload: string | null) {
    this.stringPayload = newStringPayload
  }
}

type Payload = string | Uint8Array

export interface MqttMessage {
  readonly payloadString: string
  readonly payloadBytes: any
  destinationName: string
  qos: number
  retained?: boolean
  duplicate?: boolean

  payload: Payload
  stringPayload?: string | null
}

export default Message
