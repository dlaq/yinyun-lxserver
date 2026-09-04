import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export class RemoteUrlPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteUrlPolicyError'
  }
}

const parseIpv4 = (address: string) => {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? parts
    : null
}

const isPublicIpv4 = (address: string) => {
  const parts = parseIpv4(address)
  if (!parts) return false
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

const parseIpv6Words = (rawAddress: string): number[] | null => {
  let address = rawAddress.toLowerCase().split('%')[0]
  const embeddedIpv4 = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (embeddedIpv4) {
    const parts = parseIpv4(embeddedIpv4)
    if (!parts) return null
    address = address.slice(0, -embeddedIpv4.length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  if ((address.match(/::/g) || []).length > 1) return null
  const [leftText, rightText = ''] = address.split('::')
  const left = leftText ? leftText.split(':') : []
  const right = rightText ? rightText.split(':') : []
  if ([...left, ...right].some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null
  const missing = 8 - left.length - right.length
  if (missing < 0 || (!address.includes('::') && missing !== 0)) return null
  return [...left, ...Array(missing).fill('0'), ...right].map(word => Number.parseInt(word, 16))
}

const isPublicIpv6 = (address: string) => {
  const words = parseIpv6Words(address)
  if (!words || words.length !== 8) return false
  if (words.every(word => word === 0) || words.slice(0, 7).every(word => word === 0) && words[7] === 1) return false
  // IPv4-mapped/compatible addresses inherit the IPv4 policy.
  if (words.slice(0, 5).every(word => word === 0) && [0, 0xffff].includes(words[5])) {
    return isPublicIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`)
  }
  // The well-known DNS64 prefix embeds an IPv4 destination in the final
  // 32 bits. Apply the same policy so an IPv6 literal cannot use NAT64 to
  // reach an otherwise blocked private IPv4 service.
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)) {
    return isPublicIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`)
  }
  if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 1) return false // local-use translation
  if (words[0] === 0x2001 && words[1] === 0x0002) return false // benchmarking
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return false // ORCHID
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return false // ORCHIDv2
  if (words[0] === 0x2002) {
    const embedded = `${words[1] >> 8}.${words[1] & 255}.${words[2] >> 8}.${words[2] & 255}`
    return isPublicIpv4(embedded)
  }
  const firstByte = words[0] >> 8
  if ((firstByte & 0xfe) === 0xfc) return false // fc00::/7 unique-local
  if (words[0] >= 0xfe80 && words[0] <= 0xfebf) return false // link-local
  if (firstByte === 0xff) return false // multicast
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false // documentation
  return true
}

export const isPublicIpAddress = (address: string) => {
  const family = net.isIP(address.split('%')[0])
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false
}

export interface PublicRemoteTarget {
  url: URL
  addresses: Array<{ address: string; family: 4 | 6 }>
  lookup: (...args: any[]) => void
}

export const resolvePublicRemoteTarget = async (
  rawUrl: string,
  lookupAll: (hostname: string) => Promise<Array<{ address: string; family: number }>> = hostname => dns.promises.lookup(hostname, { all: true, verbatim: true }),
): Promise<PublicRemoteTarget> => {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new RemoteUrlPolicyError('invalid_remote_url', '远程媒体地址无效') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new RemoteUrlPolicyError('invalid_remote_protocol', '远程媒体只允许 HTTP 或 HTTPS')
  if (url.username || url.password) throw new RemoteUrlPolicyError('remote_url_credentials_forbidden', '远程媒体地址不能包含用户名或密码')

  const normalizedHostname = (url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname).split('%')[0]
  const literalFamily = net.isIP(normalizedHostname)
  const resolved = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookupAll(normalizedHostname)
  const addresses = resolved
    .map(item => ({ address: String(item.address).split('%')[0], family: Number(item.family) as 4 | 6 }))
    .filter(item => item.family === 4 || item.family === 6)
  if (!addresses.length) throw new RemoteUrlPolicyError('remote_dns_empty', '远程媒体域名没有可用地址')
  if (addresses.some(item => !isPublicIpAddress(item.address))) {
    throw new RemoteUrlPolicyError('remote_private_address', '远程媒体地址解析到了私网、回环或保留地址')
  }

  let cursor = 0
  const pinnedLookup = (_hostname: string, options: any, callback?: (...args: any[]) => void) => {
    const cb = typeof options === 'function' ? options : callback
    if (typeof cb !== 'function') throw new Error('DNS lookup callback is required')
    if (typeof options === 'object' && options?.all) {
      cb(null, addresses.map(item => ({ ...item })))
      return
    }
    const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0)
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter(item => item.family === requestedFamily)
      : addresses
    if (!candidates.length) {
      const error = Object.assign(new Error('No approved address for requested family'), { code: 'ENOTFOUND' })
      cb(error)
      return
    }
    const selected = candidates[cursor++ % candidates.length]
    cb(null, selected.address, selected.family)
  }
  return { url, addresses, lookup: pinnedLookup }
}

export const fetchPublicRemoteBuffer = async (
  rawUrl: string,
  options: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; headers?: Record<string, string> } = {},
): Promise<{ data: Buffer; contentType: string; statusCode: number }> => {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRedirects = options.maxRedirects ?? 5
  const fetchOne = async (url: string, redirects: number): Promise<{ data: Buffer; contentType: string; statusCode: number }> => {
    if (redirects > maxRedirects) throw new RemoteUrlPolicyError('remote_redirect_limit', '远程媒体重定向次数过多')
    const target = await resolvePublicRemoteTarget(url)
    const client = target.url.protocol === 'https:' ? https : http
    return await new Promise((resolve, reject) => {
      const request = client.request(target.url, {
        method: 'GET',
        lookup: target.lookup as any,
        headers: { 'User-Agent': 'Yinyun/1.0', Accept: 'image/*,application/octet-stream;q=0.8', ...(options.headers || {}) },
      }, response => {
        const statusCode = response.statusCode || 0
        if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
          const next = new URL(response.headers.location, target.url).href
          response.resume()
          void fetchOne(next, redirects + 1).then(resolve, reject)
          return
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume()
          reject(new RemoteUrlPolicyError('remote_http_error', `远程媒体请求失败: HTTP ${statusCode}`))
          return
        }
        const declared = Number(response.headers['content-length'] || 0)
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy()
          reject(new RemoteUrlPolicyError('remote_response_too_large', '远程媒体响应超过大小限制'))
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', chunk => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += value.length
          if (received > maxBytes) {
            response.destroy(new RemoteUrlPolicyError('remote_response_too_large', '远程媒体响应超过大小限制'))
            return
          }
          chunks.push(value)
        })
        response.on('end', () => resolve({
          data: Buffer.concat(chunks),
          contentType: String(response.headers['content-type'] || 'application/octet-stream'),
          statusCode,
        }))
        response.on('error', reject)
      })
      request.setTimeout(timeoutMs, () => request.destroy(new RemoteUrlPolicyError('remote_timeout', '远程媒体请求超时')))
      request.on('error', reject)
      request.end()
    })
  }
  return fetchOne(rawUrl, 0)
}
