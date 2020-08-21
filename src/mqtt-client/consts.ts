/**
 * Unique message type identifiers, with associated
 * associated integer values.
 * @private
 */
export enum MESSAGE_TYPE {
  CONNECT = 1,
  CONNACK = 2,
  PUBLISH = 3,
  PUBACK = 4,
  PUBREC = 5,
  PUBREL = 6,
  PUBCOMP = 7,
  SUBSCRIBE = 8,
  SUBACK = 9,
  UNSUBSCRIBE = 10,
  UNSUBACK = 11,
  PINGREQ = 12,
  PINGRESP = 13,
  DISCONNECT = 14,
}

export interface MqttError {
  code: number
  text: string
}

/**
 * Unique message type identifiers, with associated
 * associated integer values.
 * @private
 */
export const ERROR = {
  OK: { code: 0, text: 'AMQJSC0000I OK.' },
  CONNECT_TIMEOUT: { code: 1, text: 'AMQJSC0001E Connect timed out.' },
  SUBSCRIBE_TIMEOUT: { code: 2, text: 'AMQJS0002E Subscribe timed out.' },
  UNSUBSCRIBE_TIMEOUT: { code: 3, text: 'AMQJS0003E Unsubscribe timed out.' },
  PING_TIMEOUT: { code: 4, text: 'AMQJS0004E Ping timed out.' },
  INTERNAL_ERROR: { code: 5, text: 'AMQJS0005E Internal error. Error Message: {0}, Stack trace: {1}' },
  CONNACK_RETURNCODE: { code: 6, text: 'AMQJS0006E Bad Connack return code:{0} {1}.' },
  SOCKET_ERROR: { code: 7, text: 'AMQJS0007E Socket error:{0}.' },
  SOCKET_CLOSE: { code: 8, text: 'AMQJS0008I Socket closed.' },
  MALFORMED_UTF: { code: 9, text: 'AMQJS0009E Malformed UTF data:{0} {1} {2}.' },
  UNSUPPORTED: { code: 10, text: 'AMQJS0010E {0} is not supported by this browser.' },
  INVALID_STATE: { code: 11, text: 'AMQJS0011E Invalid state {0}.' },
  INVALID_TYPE: { code: 12, text: 'AMQJS0012E Invalid type {0} for {1}.' },
  INVALID_ARGUMENT: { code: 13, text: 'AMQJS0013E Invalid argument {0} for {1}.' },
  UNSUPPORTED_OPERATION: { code: 14, text: 'AMQJS0014E Unsupported operation.' },
  INVALID_STORED_DATA: { code: 15, text: 'AMQJS0015E Invalid data in local storage key={0} value={1}.' },
  INVALID_MQTT_MESSAGE_TYPE: { code: 16, text: 'AMQJS0016E Invalid MQTT message type {0}.' },
  MALFORMED_UNICODE: { code: 17, text: 'AMQJS0017E Malformed Unicode string:{0} {1}.' },
  BUFFER_FULL: { code: 18, text: 'AMQJS0018E Message buffer is full, maximum buffer size: {0}.' },
  EXTERNAL_ERROR: { code: 19, text: 'AMQJS0005E External error. Error Message: {0}, Stack trace: {1}' },
}

/** CONNACK RC Meaning. */
export const CONNACK_RC: { [key: number]: string } = {
  0: 'Connection Accepted',
  1: 'Connection Refused: unacceptable protocol version',
  2: 'Connection Refused: identifier rejected',
  3: 'Connection Refused: server unavailable',
  4: 'Connection Refused: bad user name or password',
  5: 'Connection Refused: not authorized',
}

// MQTT protocol and version                6     M     Q     I     s     d     p     3
export const MqttProtoIdentifierv3 = [0x00, 0x06, 0x4d, 0x51, 0x49, 0x73, 0x64, 0x70, 0x03]
// MQTT proto/version for 311               4     M     Q     T     T    4
export const MqttProtoIdentifierv4 = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04]
