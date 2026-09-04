export const parseNetworkPlaylistInterval = (value: unknown) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || ['off', 'none', 'disable', '0'].includes(raw)) return 0
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/)
  if (!match) return 6 * 60 * 60 * 1000
  const count = Number(match[1])
  if (!Number.isFinite(count) || count <= 0) return 0
  const multiplier = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2] || 'h']
  return Math.max(30 * 1000, count * (multiplier || 60 * 60 * 1000))
}

export const networkPlaylistSongKey = (song: any) => `${String(song?.source || '')}:${String(song?.songmid ?? song?.songId ?? song?.id ?? song?.hash ?? '')}`

export const networkPlaylistsAreEqual = (local: any[], remote: any[]) => (
  local.length === remote.length && local.every((song, index) => networkPlaylistSongKey(song) === networkPlaylistSongKey(remote[index]))
)

export const getNetworkPlaylistSongs = (response: any): any[] => {
  if (!response || !Array.isArray(response.list)) {
    throw new Error('Remote playlist response is incomplete; preserving last successful state')
  }
  return response.list
}

export const pruneNetworkPlaylistState = <T>(state: Record<string, T>, activeIds: Iterable<string>): Record<string, T> => {
  const allowed = new Set(activeIds)
  return Object.fromEntries(Object.entries(state).filter(([id]) => allowed.has(id)))
}
