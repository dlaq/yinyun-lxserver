import crypto from 'node:crypto'

import type { IntegrationTrack } from './playlistIntegration'

export type SongloftPlaylist = {
  id: number
  name: string
  type?: string
  description?: string
  songCount?: number
}

export type SongloftClientOptions = {
  baseUrl: string
  username?: string
  password?: string
  accessToken?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type SubsonicClientOptions = {
  baseUrl: string
  username: string
  password: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class SongloftRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message)
    this.name = 'SongloftRequestError'
  }
}

const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, '')

const bodyValue = (body: any, key: string) => body?.[key] ?? body?.data?.[key]

const relativeMusicPath = (value: unknown) => {
  const raw = String(value || '').replace(/\\/g, '/')
  const marker = raw.toLocaleLowerCase().lastIndexOf('/music/')
  if (marker >= 0) return raw.slice(marker + '/music/'.length)
  return raw.replace(/^\/?music\//i, '').replace(/^\/+/, '')
}

const mapSong = (song: any): IntegrationTrack => ({
  id: song?.id,
  title: String(song?.title || song?.name || ''),
  artist: String(song?.artist || song?.singer || ''),
  album: String(song?.album || song?.album_name || ''),
  duration: Number(song?.duration || 0) || undefined,
  artworkUrl: song?.artworkUrl || song?.coverUrl || song?.cover_url || song?.albumArt || song?.album_art || song?.albumCover || song?.album_cover || song?.albumArtUrl || song?.cover || song?.image || song?.picUrl || song?.pic_url || song?.img || undefined,
  relativePath: relativeMusicPath(song?.file_path || song?.filePath || song?.path || ''),
  isLocal: Boolean(song?.file_path || song?.filePath || song?.path),
  folder: Boolean(song?.file_path || song?.filePath || song?.path) ? 'music' : undefined,
  isrc: song?.isrc || '',
  fingerprint: song?.fingerprint || '',
  source: 'songloft',
  raw: song,
})

export class SongloftClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private accessToken: string
  private loginPromise: Promise<string> | null = null

  constructor(private readonly options: SongloftClientOptions) {
    this.baseUrl = trimBase(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.accessToken = options.accessToken || ''
  }

  get configured() { return Boolean(this.baseUrl && (this.accessToken || (this.options.username && this.options.password))) }

  private async login() {
    if (!this.options.username || !this.options.password) throw new Error('Songloft native API credentials are not configured')
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = this.requestJson('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: this.options.username, password: this.options.password }),
      skipAuth: true,
    }).then(body => {
      const token = String(body?.access_token || body?.token || body?.data?.access_token || '')
      if (!token) throw new Error('Songloft login response did not contain an access token')
      this.accessToken = token
      return token
    }).finally(() => { this.loginPromise = null })
    return this.loginPromise
  }

  private async requestJson(pathname: string, init: RequestInit & { skipAuth?: boolean } = {}, retry = true): Promise<any> {
    const { skipAuth, ...requestInit } = init
    if (!skipAuth && !this.accessToken && this.configured) await this.login()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = new Headers(requestInit.headers)
      headers.set('Accept', 'application/json')
      if (requestInit.body && !headers.has('Content-Type') && !(typeof FormData !== 'undefined' && requestInit.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json')
      }
      if (!skipAuth && this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`)
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...requestInit, headers, signal: controller.signal })
      const text = await response.text()
      let body: any = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      if (response.status === 401 && retry && !skipAuth && this.options.username && this.options.password) {
        this.accessToken = ''
        await this.login()
        return this.requestJson(pathname, init, false)
      }
      if (!response.ok) throw new SongloftRequestError(response.status, `Songloft API request failed: ${response.status}`, body)
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  async health() {
    const body = await this.requestJson('/health', { skipAuth: true })
    return body?.status === 'ok'
  }

  async listSongs(options: { keyword?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams({ type: 'local', limit: String(options.limit ?? 1000), offset: String(options.offset ?? 0) })
    if (options.keyword) params.set('keyword', options.keyword)
    const body = await this.requestJson(`/songs?${params.toString()}`)
    const songs = bodyValue(body, 'songs') || []
    return { songs: Array.isArray(songs) ? songs.map(mapSong) : [], total: Number(bodyValue(body, 'total') || songs.length) }
  }

  async listAllSongs() {
    const songs: IntegrationTrack[] = []
    let offset = 0
    const limit = 1000
    while (true) {
      const page = await this.listSongs({ limit, offset })
      songs.push(...page.songs)
      if (page.songs.length < limit || songs.length >= page.total) break
      offset += page.songs.length
    }
    return songs
  }

  async countSongs() {
    const page = await this.listSongs({ limit: 1, offset: 0 })
    if (!Number.isFinite(page.total) || page.total < 0) {
      throw new SongloftRequestError(502, 'Songloft song count is invalid', { total: page.total })
    }
    return page.total
  }

  async listPlaylists() {
    const body = await this.requestJson('/playlists?limit=1000&offset=0')
    const playlists = bodyValue(body, 'playlists')
    if (!Array.isArray(playlists)) throw new SongloftRequestError(502, 'Songloft playlist response did not contain a playlists array')
    return playlists as SongloftPlaylist[]
  }

  async createPlaylist(name: string, description = '') {
    const body = await this.requestJson('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, type: 'normal', description }),
    })
    return (body?.playlist || body?.data || body) as SongloftPlaylist
  }

  async renamePlaylist(playlistId: number, name: string) {
    const body = await this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    })
    return (body?.playlist || body?.data || body) as SongloftPlaylist
  }

  async deletePlaylist(playlistId: number) {
    return this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}`, { method: 'DELETE' })
  }

  async getPlaylistSongs(playlistId: number) {
    const body = await this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}/songs?limit=100000&offset=0`)
    const songs = bodyValue(body, 'songs')
    if (!Array.isArray(songs)) {
      throw new SongloftRequestError(502, 'Songloft playlist response did not contain a songs array')
    }
    const totalValue = bodyValue(body, 'total')
    const total = totalValue === undefined || totalValue === null ? songs.length : Number(totalValue)
    if (!Number.isFinite(total) || total < 0 || total !== songs.length) {
      throw new SongloftRequestError(502, 'Songloft playlist response count is inconsistent', {
        playlistId,
        returned: songs.length,
        total: totalValue,
      })
    }
    return songs.map(mapSong)
  }

  async addPlaylistSongs(playlistId: number, songIds: Array<number | string>) {
    const body = await this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}/songs`, {
      method: 'POST',
      body: JSON.stringify({ song_ids: songIds.map(value => Number(value)).filter(Number.isFinite) }),
    })
    return body?.data || body
  }

  async removePlaylistSong(playlistId: number, songId: number) {
    return this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}/songs/${encodeURIComponent(String(songId))}`, { method: 'DELETE' })
  }

  async reorderPlaylist(playlistId: number, songIds: number[]) {
    return this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}/songs/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ song_ids: songIds }),
    })
  }

  async uploadPlaylistCover(playlistId: number, data: Uint8Array, filename = 'cover.jpg') {
    const form = new FormData()
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    form.append('file', new Blob([copy.buffer], { type: 'image/jpeg' }), filename)
    return this.requestJson(`/playlists/${encodeURIComponent(String(playlistId))}/cover`, {
      method: 'POST',
      body: form,
    })
  }

  async startScan(reimport = false) {
    return this.requestJson('/scan', { method: 'POST', body: JSON.stringify({ reimport }) })
  }

  async scanProgress() { return this.requestJson('/scan/progress') }
}

export class SubsonicClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: SubsonicClientOptions) {
    this.baseUrl = trimBase(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl || globalThis.fetch
  }

  private params(extra: Record<string, string | number> = {}) {
    const salt = crypto.randomBytes(8).toString('hex')
    const params = new URLSearchParams({
      u: this.options.username,
      t: crypto.createHash('md5').update(`${this.options.password}${salt}`).digest('hex'),
      s: salt,
      v: '1.16.1',
      c: 'yinyun-playlist-sync',
      f: 'json',
    })
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value))
    return params
  }

  private async call(endpoint: string, extra: Record<string, string | number> = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${endpoint.replace(/^\/+/, '')}?${this.params(extra)}`, { signal: controller.signal, headers: { Accept: 'application/json' } })
      const body = await response.json() as any
      const payload = body?.['subsonic-response']
      if (!response.ok || payload?.status !== 'ok') throw new Error(`Subsonic API request failed: ${payload?.error?.message || response.status}`)
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  async ping() { await this.call('ping.view'); return true }

  async searchSongs(query: string, count = 100) {
    const payload = await this.call('search3.view', { query, songCount: count, artistCount: 0, albumCount: 0 })
    const songs = payload?.searchResult3?.song || []
    return Array.isArray(songs) ? songs.map(mapSong) : []
  }

  async listPlaylists() {
    const payload = await this.call('getPlaylists.view')
    return Array.isArray(payload?.playlists?.playlist) ? payload.playlists.playlist as SongloftPlaylist[] : []
  }

  async getPlaylistSongs(playlistId: string | number) {
    const payload = await this.call('getPlaylist.view', { id: playlistId })
    const songs = payload?.playlist?.entry || []
    return Array.isArray(songs) ? songs.map(mapSong) : []
  }
}

export const mapSongloftSong = mapSong
