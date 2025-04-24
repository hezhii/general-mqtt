import { ConnectOptions, FailureData } from './mqtt-client/ClientImplementation'
import Connection, { ConstructorOptions } from './Connection'
import { asyncFactory } from './utils'

type InitOptions = {
  debug?: boolean
  onConnectFailure?: (err: FailureData) => void // 初次连接失败时上报事件
  firstConnectRetry?: boolean // 第一次连接失败时无限重试
}

class ConnectionManager {
  static connectOptions: ConstructorOptions & ConnectOptions & InitOptions

  static initConnectionOptions(connectOptions: ConstructorOptions & ConnectOptions & InitOptions) {
    this.connectOptions = connectOptions
  }

  private static initConnection(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const {
        uri,
        clientId,
        autoResubscribe,
        env,
        debug,
        onConnectFailure,
        firstConnectRetry,
        ...reset
      } = ConnectionManager.connectOptions
      const mqttConnection = new Connection({
        uri,
        clientId,
        autoResubscribe,
        env,
      })

      if (debug) {
        mqttConnection.traceFunction = data => console.debug('%cgeneral-mqtt', 'color:#faad14', data)
      }

      mqttConnection.onConnected = () => {
        resolve(mqttConnection)
      }

      const doConnect = () => {
        mqttConnection.connect({
          ...reset,
          onFailure: err => {
            onConnectFailure && onConnectFailure(err)
            if (firstConnectRetry) {
              doConnect()
            } else {
              reject(err)
            }
          },
        })
      }

      doConnect()
    })
  }

  private static asyncInitiator = asyncFactory(ConnectionManager.initConnection)

  static sharedInstance() {
    return this.asyncInitiator(this.connectOptions)
  }
}

export default ConnectionManager
