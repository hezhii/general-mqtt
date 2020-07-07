const valuesMap = new Map()

class CustomStorage implements Storage {
  get length(): number {
    return valuesMap.size
  }

  /**
   * Empties the list associated with the object of all key/value pairs, if there are any.
   */
  clear(): void {
    valuesMap.clear()
  }

  /**
   * Returns the current value associated with the given key, or null if the given key does not exist in the list associated with the object.
   */
  getItem(key: string): string | null {
    const stringKey = String(key)
    if (valuesMap.has(key)) {
      return valuesMap.get(stringKey)
    }
    return null
  }

  /**
   * Returns the name of the nth key in the list, or null if n is greater than or equal to the number of key/value pairs in the object.
   */
  key(index: number): string | null {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'key' on 'Storage': 1 argument required, but only 0 present.") // this is a TypeError implemented on Chrome, Firefox throws Not enough arguments to Storage.key.
    }
    const arr = Array.from(valuesMap.keys())
    return arr[index]
  }

  /**
   * Removes the key/value pair with the given key from the list associated with the object, if a key/value pair with the given key exists.
   */
  removeItem(key: string): void {
    valuesMap.delete(key)
  }

  /**
   * Sets the value of the pair identified by key to value, creating a new key/value pair if none existed for key previously.
   *
   * Throws a "QuotaExceededError" DOMException exception if the new value couldn't be set. (Setting could fail if, e.g., the user has disabled storage for the site, or if the quota has been exceeded.)
   */
  setItem(key: string, value: string): void {
    valuesMap.set(String(key), String(value))
  }

  [name: string]: any
}

const storage = new Proxy(new CustomStorage(), {
  set(target, prop, value) {
    if (CustomStorage.prototype.hasOwnProperty(prop)) {
      target[prop as string] = value
    } else {
      target.setItem(prop as string, value)
    }
    return true
  },

  get(target, prop) {
    if (CustomStorage.prototype.hasOwnProperty(name)) {
      return target[prop as string]
    }
    if (valuesMap.has(name)) {
      return target.getItem(prop as string)
    }
  },
})

export default storage
