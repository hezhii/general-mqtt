type Callback = (data: any) => void

class WXWebSocket {
  private socketTask: WechatMiniprogram.SocketTask
  readyState: number = 3
  binaryType: string | null | undefined
  onopen: Callback | null = null
  onclose: Callback | null = null
  onerror: Callback | null = null

  constructor(url: string, protocols?: string | string[]) {
    if (typeof protocols === 'string') {
      protocols = [protocols]
    }

    this.readyState = 0
    const socketTask = (this.socketTask = wx.connectSocket({
      url,
      protocols,
    }))

    socketTask.onOpen(this.onSocketOpen)
    socketTask.onClose(this.onSocketClose)
    socketTask.onError(this.onSocketError)
  }

  onSocketOpen = (data: any) => {
    this.readyState = 1
    if (this.onopen) this.onopen(data)
  }

  onSocketClose = (data: any) => {
    this.readyState = 3
    if (this.onclose) this.onclose(data)
  }

  onSocketError = (data: any) => {
    this.readyState = 3
    if (this.onerror) this.onerror(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 2
    this.socketTask.close({
      code,
      reason,
    })
  }

  set onmessage(callback: Callback) {
    this.socketTask.onMessage(callback)
  }

  send(data: string | ArrayBuffer) {
    this.socketTask.send({ data })
  }
}

export default WXWebSocket
