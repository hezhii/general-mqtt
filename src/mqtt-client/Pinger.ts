import ClientImplementation from './ClientImplementation'
import WireMessage from './WireMessage'
import { MESSAGE_TYPE, ERROR } from './consts'
import { format } from './utils'

/**
 * Repeat keepalive requests, monitor responses.
 */
class Pinger {
  private client: ClientImplementation
  private keepAliveInterval: number // millisecond
  private isReset: boolean = false
  private timeout: NodeJS.Timeout | null = null
  private pingReq: ArrayBuffer = new WireMessage(MESSAGE_TYPE.PINGREQ).encode()

  /**
   *
   * @param client
   * @param keepAliveInterval second
   */
  constructor(client: ClientImplementation, keepAliveInterval: number) {
    this.client = client
    this.keepAliveInterval = keepAliveInterval * 1000
  }

  private doPing = () => {
    if (this.isReset) {
      this.isReset = false
      this.client.trace('Pinger.doPing', 'send PINGREQ')
      if (this.client.socket) {
        this.client.socket.send(this.pingReq) // 直接通过 socket 发送 PING message
      }
      this.timeout = setTimeout(this.doPing, this.keepAliveInterval)
    } else {
      this.client.trace('Pinger.doPing', 'Timed out')
      this.client._disconnected(ERROR.PING_TIMEOUT.code, format(ERROR.PING_TIMEOUT))
    }
  }

  reset() {
    this.isReset = true
    this.cancel()

    if (this.keepAliveInterval > 0) this.timeout = setTimeout(this.doPing, this.keepAliveInterval)
  }

  cancel() {
    if (this.timeout) {
      clearTimeout(this.timeout)
    }
    this.timeout = null
  }
}

export default Pinger
