export const API_V1_PREFIX = '/api/v1'

export type ApiNamespace = 'native' | 'admin' | 'player' | 'legacy' | 'none'

/**
 * Media elements cannot send the player's x-user-token header, so a small
 * read-only allowlist accepts the same credential in the query string.
 */
export const allowsPlayerQueryToken = (pathname: string, method: string | undefined): boolean => (
  method === 'GET' && (
    pathname === '/api/v1/player/music/cache/cover' ||
    pathname.startsWith('/api/v1/player/music/cache/file/') ||
    pathname === '/api/v1/player/music/download'
  )
)

export const classifyApiNamespace = (pathname: string): ApiNamespace => {
  if (pathname === '/api' || (pathname.startsWith('/api/') && !pathname.startsWith(`${API_V1_PREFIX}/`))) {
    return 'legacy'
  }
  if (pathname === `${API_V1_PREFIX}/admin` || pathname.startsWith(`${API_V1_PREFIX}/admin/`)) {
    return 'admin'
  }
  if (pathname === `${API_V1_PREFIX}/player` || pathname.startsWith(`${API_V1_PREFIX}/player/`)) {
    return 'player'
  }
  if (pathname === API_V1_PREFIX || pathname.startsWith(`${API_V1_PREFIX}/`)) {
    return 'native'
  }
  return 'none'
}
