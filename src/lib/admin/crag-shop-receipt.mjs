import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
const KEY = 'receipt.key'

export function loadOrderReceiptKey(dataDir, hasOrders) {
  const absolute = path.resolve(dataDir)
  if (process.platform !== 'linux' || /^\/mnt\/[a-z](?:\/|$)/i.test(absolute))
    throw new Error('private storage required')
  const uid = process.getuid()
  const handles = []
  const openDir = (file) => {
    const fd = fs.openSync(file, DIR)
    handles.push(fd)
    return fd
  }
  const at = (fd, name) => `/proc/self/fd/${fd}/${name}`
  try {
    let fd = openDir('/')
    for (const part of absolute.split('/').filter(Boolean)) {
      fd = openDir(at(fd, part))
      const st = fs.fstatSync(fd)
      const stickyRoot = st.uid === 0 && st.mode & 0o1000
      if ((st.uid !== 0 && st.uid !== uid) || (st.mode & 0o022 && !stickyRoot)) {
        throw new Error('unsafe data path')
      }
    }
    // Require a persistent local filesystem with POSIX ownership, fsync and hard links.
    const fsType = fs.statfsSync(`/proc/self/fd/${fd}`).type
    if (![0xef53, 0x794c7630, 0x58465342, 0x9123683e, 0x2fc12fc1, 0xf2f52010].includes(fsType >>> 0)) {
      throw new Error('unsupported private filesystem')
    }
    const directory = at(fd, 'crag-shop-private')
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const privateFd = openDir(directory)
    const st = fs.fstatSync(privateFd)
    if (st.uid !== uid || (st.mode & 0o7777) !== 0o700) throw new Error('unsafe private directory')
    const keyPath = at(privateFd, KEY)
    const read = () => {
      const keyFd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try {
        const st = fs.fstatSync(keyFd)
        if (!st.isFile() || st.uid !== uid || (st.mode & 0o7777) !== 0o600 || st.size !== 32) {
          throw new Error('unsafe receipt key')
        }
        const key = Buffer.alloc(32)
        if (fs.readSync(keyFd, key, 0, 32, 0) !== 32) throw new Error('invalid receipt key')
        return key
      } finally {
        fs.closeSync(keyFd)
      }
    }
    let key
    try {
      key = read()
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      if (hasOrders()) {
        // Another process may have just published the key and reserved the first order.
        key = read()
      } else {
        const temp = at(privateFd, `.receipt-${randomUUID()}`)
        const tempFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
        try {
          fs.fchmodSync(tempFd, 0o600)
          fs.writeFileSync(tempFd, randomBytes(32))
          fs.fsyncSync(tempFd)
          try {
            fs.linkSync(temp, keyPath)
          } catch (err) {
            if (err.code !== 'EEXIST') throw err
          }
        } finally {
          fs.closeSync(tempFd)
          fs.unlinkSync(temp)
        }
        key = read()
      }
    }
    // A concurrent reader must also flush the published directory entries before reserving.
    fs.fsyncSync(privateFd)
    fs.fsyncSync(fd)
    return key
  } finally {
    for (const fd of handles.reverse()) fs.closeSync(fd)
  }
}

export function deriveOrderReceipt(key, orderId) {
  return createHmac('sha256', key).update(`order-receipt:${orderId}`).digest('base64url')
}
