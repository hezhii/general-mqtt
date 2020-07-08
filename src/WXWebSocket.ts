type Callback = (data: any) => void

class WXWebSocket {
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
    wx.connectSocket({
      url,
      protocols,
    })

    wx.onSocketOpen(this.onSocketOpen)
    wx.onSocketClose(this.onSocketClose)
    wx.onSocketError(this.onSocketError)
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
    wx.closeSocket({
      code,
      reason,
    })
  }

  set onmessage(callback: Callback) {
    wx.onSocketMessage(callback)
  }

  send(data: string | ArrayBuffer) {
    wx.sendSocketMessage({ data })
  }
}

export default WXWebSocket
