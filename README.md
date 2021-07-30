# general-mqtt

A general mqtt client that can be used in Wechat mini program, web, react native. It also encapsulates some common functions.

## Usage

### singleton

```js
ConnectionManager.initConnectionOptions({
  debug: true,
  uri: '',
  clientId: '',
  env: 'web',
  userName: '',
  password: '',
  reconnect: true,
  timeout: 5,
  cleanSession: true,
  maxReconnectTimeInterval: 32,
})

const conn = await ConnectionManager.sharedInstance()

conn.subscribe('/test', (topic, msg) => console.log(topic, msg), {
  onSuccess() {
    conn.publish('/test', 'hello world')
  },
})
```
