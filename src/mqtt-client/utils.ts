import { ERROR, MqttError, MESSAGE_TYPE } from './consts'
import WireMessage from './WireMessage'
import Message from './Message'

/**
 * Validate an object's parameter names to ensure they
 * match a list of expected letiables name for this option
 * type. Used to ensure option object passed into the API don't
 * contain erroneous parameters.
 * @param {Object} obj - User options object
 * @param {Object} keys - valid keys and types that may exist in obj.
 * @throws {Error} Invalid option parameter found.
 */
export function validate(obj: any, keys: any) {
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      if (keys.hasOwnProperty(key)) {
        if (typeof obj[key] !== keys[key]) throw new Error(format(ERROR.INVALID_TYPE, [typeof obj[key], key]))
      } else {
        let errorStr = 'Unknown property, ' + key + '. Valid properties are:'
        for (const validKey in keys) if (keys.hasOwnProperty(validKey)) errorStr = errorStr + ' ' + validKey
        throw new Error(errorStr)
      }
    }
  }
}

/**
 * Format an error message text.
 * @param {MqttError} ERROR value above.
 * @param {(string | number)[]} [array] substituted into the text.
 * @return the text with the substitutions made.
 */
export function format(error: MqttError, substitutions?: any) {
  let text = error.text
  if (substitutions) {
    let field
    let start
    for (let i = 0; i < substitutions.length; i++) {
      field = '{' + i + '}'
      start = text.indexOf(field)
      if (start > 0) {
        const part1 = text.substring(0, start)
        const part2 = text.substring(start + field.length)
        text = part1 + substitutions[i] + part2
      }
    }
  }
  return text
}

export function decodeMessage(input: Uint8Array, pos: number): [WireMessage | null, number] {
  const startingPos = pos
  let first = input[pos]
  const type = first >> 4
  const messageInfo = (first &= 0x0f)
  pos += 1

  // Decode the remaining length (MBI format)

  let digit
  let remLength = 0
  let multiplier = 1
  do {
    if (pos === input.length) {
      return [null, startingPos]
    }
    digit = input[pos++]
    remLength += (digit & 0x7f) * multiplier
    multiplier *= 128
  } while ((digit & 0x80) !== 0)

  const endPos = pos + remLength
  if (endPos > input.length) {
    return [null, startingPos]
  }

  const wireMessage = new WireMessage(type)
  switch (type) {
    case MESSAGE_TYPE.CONNACK:
      const connectAcknowledgeFlags = input[pos++]
      if (connectAcknowledgeFlags & 0x01) wireMessage.sessionPresent = true
      wireMessage.returnCode = input[pos++]
      break

    case MESSAGE_TYPE.PUBLISH:
      const qos = (messageInfo >> 1) & 0x03

      const len = readUint16(input, pos)
      pos += 2
      const topicName = parseUTF8(input, pos, len)
      pos += len
      // If QoS 1 or 2 there will be a messageIdentifier
      if (qos > 0) {
        wireMessage.messageIdentifier = readUint16(input, pos)
        pos += 2
      }

      const message = new Message(input.subarray(pos, endPos))
      if ((messageInfo & 0x01) === 0x01) message.retained = true
      if ((messageInfo & 0x08) === 0x08) message.duplicate = true
      message.qos = qos
      message.destinationName = topicName
      wireMessage.payloadMessage = message
      break

    case MESSAGE_TYPE.PUBACK:
    case MESSAGE_TYPE.PUBREC:
    case MESSAGE_TYPE.PUBREL:
    case MESSAGE_TYPE.PUBCOMP:
    case MESSAGE_TYPE.UNSUBACK:
      wireMessage.messageIdentifier = readUint16(input, pos)
      break

    case MESSAGE_TYPE.SUBACK:
      wireMessage.messageIdentifier = readUint16(input, pos)
      pos += 2
      wireMessage.returnCode = input.subarray(pos, endPos)
      break

    default:
      break
  }

  return [wireMessage, endPos]
}

export function writeUint16(input: number | undefined, buffer: Uint8Array, offset: number) {
  if (!input) {
    return offset
  }
  buffer[offset++] = input >> 8 // MSB
  buffer[offset++] = input % 256 // LSB
  return offset
}

export function writeString(input: string | undefined | null, utf8Length: number, buffer: Uint8Array, offset: number) {
  if (!input) {
    return offset
  }
  offset = writeUint16(utf8Length, buffer, offset)
  stringToUTF8(input, buffer, offset)
  return offset + utf8Length
}

export function readUint16(buffer: Uint8Array, offset: number) {
  return 256 * buffer[offset] + buffer[offset + 1]
}

/**
 * Encodes an MQTT Multi-Byte Integer
 */
export function encodeMBI(number: number) {
  const output = new Array(1)
  let numBytes = 0

  do {
    let digit = number % 128
    number = number >> 7
    if (number > 0) {
      digit |= 0x80
    }
    output[numBytes++] = digit
  } while (number > 0 && numBytes < 4)

  return output
}

/**
 * Takes a String and calculates its length in bytes when encoded in UTF8.
 */
export function UTF8Length(input?: string) {
  if (!input) {
    return 0
  }
  let output = 0
  for (let i = 0; i < input.length; i++) {
    const charCode = input.charCodeAt(i)
    if (charCode > 0x7ff) {
      // Surrogate pair means its a 4 byte character
      if (0xd800 <= charCode && charCode <= 0xdbff) {
        i++
        output++
      }
      output += 3
    } else if (charCode > 0x7f) output += 2
    else output++
  }
  return output
}

/**
 * Takes a String and writes it into an array as UTF8 encoded bytes.
 */
export function stringToUTF8(input: string, output: Uint8Array, start: number) {
  let pos = start
  for (let i = 0; i < input.length; i++) {
    let charCode = input.charCodeAt(i)

    // Check for a surrogate pair.
    if (0xd800 <= charCode && charCode <= 0xdbff) {
      const lowCharCode = input.charCodeAt(++i)
      if (isNaN(lowCharCode)) {
        throw new Error(format(ERROR.MALFORMED_UNICODE, [charCode, lowCharCode]))
      }
      charCode = ((charCode - 0xd800) << 10) + (lowCharCode - 0xdc00) + 0x10000
    }

    if (charCode <= 0x7f) {
      output[pos++] = charCode
    } else if (charCode <= 0x7ff) {
      output[pos++] = ((charCode >> 6) & 0x1f) | 0xc0
      output[pos++] = (charCode & 0x3f) | 0x80
    } else if (charCode <= 0xffff) {
      output[pos++] = ((charCode >> 12) & 0x0f) | 0xe0
      output[pos++] = ((charCode >> 6) & 0x3f) | 0x80
      output[pos++] = (charCode & 0x3f) | 0x80
    } else {
      output[pos++] = ((charCode >> 18) & 0x07) | 0xf0
      output[pos++] = ((charCode >> 12) & 0x3f) | 0x80
      output[pos++] = ((charCode >> 6) & 0x3f) | 0x80
      output[pos++] = (charCode & 0x3f) | 0x80
    }
  }
  return output
}

export function parseUTF8(input: Uint8Array, offset: number, length: number) {
  let output = ''
  let utf16
  let pos = offset

  while (pos < offset + length) {
    const byte1 = input[pos++]
    if (byte1 < 128) utf16 = byte1
    else {
      const byte2 = input[pos++] - 128
      if (byte2 < 0) throw new Error(format(ERROR.MALFORMED_UTF, [byte1.toString(16), byte2.toString(16), '']))
      if (byte1 < 0xe0)
        // 2 byte character
        utf16 = 64 * (byte1 - 0xc0) + byte2
      else {
        const byte3 = input[pos++] - 128
        if (byte3 < 0)
          throw new Error(format(ERROR.MALFORMED_UTF, [byte1.toString(16), byte2.toString(16), byte3.toString(16)]))
        if (byte1 < 0xf0)
          // 3 byte character
          utf16 = 4096 * (byte1 - 0xe0) + 64 * byte2 + byte3
        else {
          const byte4 = input[pos++] - 128
          if (byte4 < 0)
            throw new Error(
              format(ERROR.MALFORMED_UTF, [
                byte1.toString(16),
                byte2.toString(16),
                byte3.toString(16),
                byte4.toString(16),
              ]),
            )
          if (byte1 < 0xf8)
            // 4 byte character
            utf16 = 262144 * (byte1 - 0xf0) + 4096 * byte2 + 64 * byte3 + byte4
          // longer encodings are not supported
          else
            throw new Error(
              format(ERROR.MALFORMED_UTF, [
                byte1.toString(16),
                byte2.toString(16),
                byte3.toString(16),
                byte4.toString(16),
              ]),
            )
        }
      }
    }

    if (utf16 > 0xffff) {
      // 4 byte character - express as a surrogate pair
      utf16 -= 0x10000
      output += String.fromCharCode(0xd800 + (utf16 >> 10)) // lead character
      utf16 = 0xdc00 + (utf16 & 0x3ff) // trail character
    }
    output += String.fromCharCode(utf16)
  }
  return output
}
