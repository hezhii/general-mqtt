/// <reference path="../node_modules/miniprogram-api-typings/index.d.ts" />

type Callback = (data: any) => void

class WXWebSocket {
  binaryType: string | null | undefined
  private socketTask: WechatMiniprogram.SocketTask

  constructor(url: string, protocols?: string | string[]) {
    if (typeof protocols === 'string') {
      protocols = [protocols]
    }

    this.socketTask = wx.connectSocket({
      url,
      protocols,
    })
  }

  set onclose(callback: Callback) {
    this.socketTask.onClose(callback)
  }

  set onerror(callback: Callback) {
    this.socketTask.onError(callback)
  }

  set onmessage(callback: Callback) {
    this.socketTask.onMessage(callback)
  }

  set onopen(callback: Callback) {
    this.socketTask.onOpen(callback)
  }

  send(data: string | ArrayBuffer) {
    this.socketTask.send({ data })
  }

  close(code?: number, reason?: string): void {
    this.socketTask.close({
      code,
      reason,
    })
  }
}

export default WXWebSocket
