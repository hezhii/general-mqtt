type Callback = (data: any) => void

class WXWebSocket {
  binaryType: string | null | undefined

  constructor(url: string, protocols?: string | string[]) {
    if (typeof protocols === 'string') {
      protocols = [protocols]
    }

    wx.connectSocket({
      url,
      protocols,
    })
  }

  set onclose(callback: Callback) {
    wx.onSocketClose(callback)
  }

  set onerror(callback: Callback) {
    wx.onSocketError(callback)
  }

  set onmessage(callback: Callback) {
    wx.onSocketMessage(callback)
  }

  set onopen(callback: Callback) {
    wx.onSocketOpen(callback)
  }

  send(data: string | ArrayBuffer) {
    wx.sendSocketMessage({ data })
  }

  close(code?: number, reason?: string): void {
    wx.closeSocket({
      code,
      reason,
    })
  }
}

export default WXWebSocket
