import { ConnectOptions } from './mqtt-client/ClientImplementation'
import Connection, { ConstructorOptions } from './Connection'
import { asyncFactory } from './utils'

type InitOptions = {
  debug: boolean
}

class ConnectionManager {
  static connectOptions: ConstructorOptions & ConnectOptions & InitOptions

  static initConnectionOptions(connectOptions: ConstructorOptions & ConnectOptions & InitOptions) {
    this.connectOptions = connectOptions
  }

  private static initConnection(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const { uri, clientId, autoResubscribe, env, debug, ...reset } = ConnectionManager.connectOptions
      const mqttConnection = new Connection({
        uri,
        clientId,
        autoResubscribe,
        env,
      })

      if (debug) {
        mqttConnection.traceFunction = data => console.log('%cgeneral-mqtt', 'color:#faad14', data)
      }

      mqttConnection.onConnected = () => {
        resolve(mqttConnection)
      }

      mqttConnection.connect({
        ...reset,
        onFailure: err => {
          reject(err)
        },
      })
    })
  }

  private static asyncInitiator = asyncFactory(ConnectionManager.initConnection, 30 * 1000)

  static sharedInstance() {
    return this.asyncInitiator(this.connectOptions)
  }
}

export default ConnectionManager
