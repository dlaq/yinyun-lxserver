import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getUserSpace } from '@/user'
import { tryNormalizeUsername } from '@/utils/username'
import * as fileCache from './fileCache'
import * as serverDownloadQueue from './serverDownloadQueue'
import * as remasterQueue from './remasterQueue'
import {
  PlaylistSharingError,
  createPlaylistShare,
  getPendingPlaylistShares,
  isPlaylistSharingEnabled,
  respondToPlaylistShare,
  setPlaylistSharingEnabled,
} from './playlistSharing'
import { getEnabledSourcePlatforms, setEnabledSourcePlatforms } from './customSourcePlatformPreferences'
import { isSourceSharedWithUser } from './customSourceSharing'
import {
  ACCOUNT_SYNC_MAX_BYTES,
  ACCOUNT_SYNC_SCHEMA_VERSION,
  buildAccountSyncSnapshot,
  restoreAccountSyncSnapshot,
} from './accountSync'
import {
  decodeTrackId,
  encodeApiValue,
  signApiToken,
  verifySignedApiToken,
  type ApiTokenPayload,
} from './apiV1Contract'
import { normalizeLyricsResponse } from './utils/apiLyrics'
import {
  canonicalTrackId,
  metadataAgreement,
  matchTracks,
  mergePlaylistIds,
  playlistSyncConflicts,
  preferExistingPlaylistCandidate,
  PlaylistImportStore,
  PlaylistSyncStore,
  toIntegrationTrack,
  type IntegrationTrack,
  type PlaylistImportRecord,
  type PlaylistSyncRecord,
  SHARED_LIBRARY_MATCH_OPTIONS,
} from './playlistIntegration'
import { SongloftClient, SongloftRequestError, SubsonicClient } from './songloftClient'

const API_PREFIX = '/api/v1'
const ACCESS_TOKEN_TTL = 60 * 60
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60
const MEDIA_TOKEN_TTL = 5 * 60
const MAX_BODY_SIZE = 2 * 1024 * 1024
const QUALITY_ORDER = ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']

interface ApiV1Dependencies {
  serverVersion: string
  getAuthSecret: () => string
  getUsers: () => Array<{ name: string; password: string }>
  isAdminRequest?: (req: IncomingMessage) => boolean
  musicSdk: any
  normalizeSongInfo: (songInfo: any) => any
  resolveSong: (
    songInfo: any,
    quality: string,
    username: string,
    allowQualityFallback: boolean,
    options?: { allowPlatformSwitch?: boolean; allowApiSwitch?: boolean },
  ) => Promise<any>
  isSourceSupported: (source: string, username: string) => boolean
  getLoadedSources: () => any[]
  getLibrary: (username: string, type: 'artists' | 'albums') => Promise<any[]>
  saveLibrary: (username: string, type: 'artists' | 'albums', items: any[]) => Promise<void>
  getLeaderboardBoards: (source: string, username: string) => Promise<any>
  getLeaderboardList: (source: string, bangid: string, page: number, username: string) => Promise<any>
  getSongloftClient?: () => SongloftClient | null
  getSongloftSubsonicClient?: () => SubsonicClient | null
  getPlaylistSyncStore?: (username: string) => PlaylistSyncStore
  getPlaylistImportStore?: (username: string) => PlaylistImportStore
  getLegacyUser?: (req: IncomingMessage) => string | null
}

interface ApiErrorShape {
  status: number
  code: string
  message: string
  details?: unknown
}

class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const revokedTokens = new Map<string, number>()
const activePlaylistSyncs = new Set<string>()
let songloftMatchingCache: { client: SongloftClient; tracks: IntegrationTrack[]; expiresAt: number } | null = null
let songloftMatchingPromise: Promise<IntegrationTrack[]> | null = null
const SONGLOFT_MATCHING_CACHE_TTL = 60_000

type HealthSettings = {
  enabled: boolean
  intervalMinutes: number
  cronExpression: string
  testKeyword: string
  consecutiveFailureThreshold: number
  notify: boolean
  messagePusherEnabled: boolean
  messagePusherUrl: string
  messagePusherToken: string
  messagePusherChannel: string
  barkEnabled: boolean
  barkServerUrl: string
  barkDeviceKey: string
  serverChanEnabled: boolean
  serverChanSendKey: string
}

type HealthReport = {
  checkedAt: string
  ok: boolean
  playlists: number
  tracksChecked: number
  healthyTracks: number
  warningTracks?: number
  keyword?: string
  checks?: Array<{
    source: string
    sourceId?: string
    platform: string
    status: 'ok' | 'warn' | 'error'
    message?: string
    deletable?: boolean
  }>
  failures: Array<{
    playlist: string
    source: string
    sourceId?: string
    deletable?: boolean
    platform?: string
    status?: 'warn' | 'error'
    index: number
    title: string
    artist: string
    message: string
  }>
}

type HealthState = { settings: HealthSettings; report: HealthReport | null; consecutiveFailures: number }

const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  enabled: false,
  intervalMinutes: 360,
  cronExpression: '0 6 * * *',
  testKeyword: '周杰伦',
  consecutiveFailureThreshold: 2,
  notify: false,
  messagePusherEnabled: false,
  messagePusherUrl: '',
  messagePusherToken: '',
  messagePusherChannel: '',
  barkEnabled: false,
  barkServerUrl: 'https://api.day.app',
  barkDeviceKey: '',
  serverChanEnabled: false,
  serverChanSendKey: '',
}
const healthStateCache = new Map<string, HealthState>()
let healthScheduler: NodeJS.Timeout | null = null

const healthStateFile = (username: string) => {
  const dataPath = String((global as any).lx?.dataPath || path.join(process.cwd(), 'data'))
  return path.join(dataPath, 'health', `${encodeURIComponent(username)}.json`)
}

const readHealthState = (username: string): HealthState => {
  const cached = healthStateCache.get(username)
  if (cached) return cached
  let persisted: Partial<HealthState> = {}
  try {
    const filename = healthStateFile(username)
    if (fs.existsSync(filename)) persisted = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch { /* a corrupt health report should not prevent the player from logging in */ }
  const settings = { ...DEFAULT_HEALTH_SETTINGS, ...(persisted.settings || {}) }
  const state: HealthState = {
    settings,
    report: persisted.report || null,
    consecutiveFailures: Math.max(0, Number((persisted as any).consecutiveFailures) || 0),
  }
  healthStateCache.set(username, state)
  return state
}

const writeHealthState = (username: string, state: HealthState) => {
  healthStateCache.set(username, state)
  try {
    const filename = healthStateFile(username)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, JSON.stringify(state, null, 2), 'utf8')
  } catch (error: any) {
    console.warn('[Health] unable to persist health state:', error?.message || error)
  }
}

const publicHealthSettings = (settings: HealthSettings) => ({
  enabled: settings.enabled,
  intervalMinutes: settings.intervalMinutes,
  cronExpression: settings.cronExpression,
  testKeyword: settings.testKeyword,
  consecutiveFailureThreshold: settings.consecutiveFailureThreshold,
  notify: settings.notify,
  messagePusherEnabled: settings.messagePusherEnabled,
  messagePusherUrl: settings.messagePusherUrl,
  messagePusherChannel: settings.messagePusherChannel,
  messagePusherTokenConfigured: Boolean(settings.messagePusherToken),
  barkEnabled: settings.barkEnabled,
  barkServerUrl: settings.barkServerUrl,
  barkDeviceKeyConfigured: Boolean(settings.barkDeviceKey),
  serverChanEnabled: settings.serverChanEnabled,
  serverChanSendKeyConfigured: Boolean(settings.serverChanSendKey),
})

const postHealthNotification = async (settings: HealthSettings, report: HealthReport, force = false) => {
  const hasChannel = Boolean(
    (settings.messagePusherEnabled && settings.messagePusherUrl)
    || (settings.barkEnabled && settings.barkDeviceKey)
    || (settings.serverChanEnabled && settings.serverChanSendKey),
  )
  if (!force && !hasChannel) return
  const content = report.ok
    ? `曲源健康检查通过：检查 ${report.tracksChecked} 个音源平台，全部可解析。`
    : `曲源健康检查发现 ${report.failures.length} 个问题（${report.healthyTracks}/${report.tracksChecked} 个音源平台正常）。`
  const requests: Promise<unknown>[] = []
  const send = (url: string, init: RequestInit) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    requests.push(fetch(url, { ...init, signal: controller.signal }).catch((error: any) => {
      console.warn('[Health] notification failed:', error?.message || error)
    }).finally(() => clearTimeout(timer)))
  }
  if (settings.messagePusherEnabled && settings.messagePusherUrl) {
    send(settings.messagePusherUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.messagePusherToken ? {
          Authorization: `Bearer ${settings.messagePusherToken}`,
          'X-Message-Pusher-Token': settings.messagePusherToken,
        } : {}),
      },
      body: JSON.stringify({
        title: '音云曲源健康检查',
        content,
        channel: settings.messagePusherChannel || undefined,
        token: settings.messagePusherToken || undefined,
        report,
      }),
    })
  }
  if (settings.barkEnabled && settings.barkDeviceKey) {
    const base = String(settings.barkServerUrl || 'https://api.day.app').replace(/\/+$/, '')
    send(`${base}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_key: settings.barkDeviceKey,
        title: '音云曲源健康检查',
        body: content,
        group: 'yinyun-health',
      }),
    })
  }
  if (settings.serverChanEnabled && settings.serverChanSendKey) {
    send(`https://sctapi.ftqq.com/${encodeURIComponent(settings.serverChanSendKey)}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: '音云曲源健康检查', desp: content }).toString(),
    })
  }
  await Promise.all(requests)
}

const cronFieldMatches = (field: string, value: number, min: number, max: number) => {
  const raw = String(field || '').trim()
  if (!raw || raw === '*') return true
  return raw.split(',').some(part => {
    const text = part.trim()
    if (!text) return false
    const [base, stepText] = text.split('/')
    const step = stepText ? Number(stepText) : 1
    if (!Number.isInteger(step) || step < 1) return false
    if (base === '*') return (value - min) % step === 0
    if (base.includes('-')) {
      const [start, end] = base.split('-').map(Number)
      return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end && (value - start) % step === 0
    }
    const exact = Number(base)
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact
  })
}

const cronMatches = (expression: string, date = new Date()) => {
  const fields = String(expression || '').trim().split(/\s+/)
  if (fields.length !== 5) return false
  return cronFieldMatches(fields[0], date.getMinutes(), 0, 59)
    && cronFieldMatches(fields[1], date.getHours(), 0, 23)
    && cronFieldMatches(fields[2], date.getDate(), 1, 31)
    && cronFieldMatches(fields[3], date.getMonth() + 1, 1, 12)
    && cronFieldMatches(fields[4], date.getDay(), 0, 6)
}

const runHealthCheck = async (deps: ApiV1Dependencies, username: string): Promise<HealthReport> => {
  const state = readHealthState(username)
  const store = deps.getPlaylistImportStore?.(username)
  const records = store ? store.load() : []
  const keyword = String(state.settings.testKeyword || '').trim() || DEFAULT_HEALTH_SETTINGS.testKeyword
  const failures: HealthReport['failures'] = []
  const sourceInfos = (deps.getLoadedSources?.() || []).filter(source => {
    if (source?.enabled === false) return false
    const owner = String(source?.owner || '')
    return owner === username || isSourceSharedWithUser(owner, String(source?.id || ''), username)
  })
  const sourceChecks = sourceInfos.flatMap(source => Object.keys(source.sources || {}).map(platform => ({ source, platform })))

  // The reference UI tests each configured source/platform with one fixed
  // keyword. It does not sample imported songs or multiply work by playlist
  // size. Search once, then resolve the first result to verify the complete
  // source path (search + playable URL).
  const checks = await Promise.all(sourceChecks.map(async ({ source, platform }) => {
    const sourceName = String(source.name || source.id || '未知音源')
    const sourceId = String(source.id || '') || undefined
    const base = { source: sourceName, sourceId, platform, deletable: Boolean(sourceId && source.owner === username) }
    try {
      if (!deps.isSourceSupported(platform, username)) {
        return { ...base, status: 'warn' as const, message: '该平台在当前账户中未启用' }
      }
      const sdk = deps.musicSdk?.[platform]
      if (typeof sdk?.musicSearch?.search !== 'function') {
        return { ...base, status: 'error' as const, message: '该平台没有可用的歌曲搜索接口' }
      }
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('检测超时')), 12000))
      const raw = await Promise.race([awaitSdkRequest(sdk.musicSearch.search(keyword, 1, 1)), timeout])
      const items = normalizeSearchResult(raw, platform).items
      if (!items.length) return { ...base, status: 'warn' as const, message: `关键词“${keyword}”没有返回歌曲` }
      const song = deps.normalizeSongInfo(items[0])
      await Promise.race([
        deps.resolveSong(song, '128k', username, true, { allowPlatformSwitch: false, allowApiSwitch: false }),
        timeout,
      ])
      return { ...base, status: 'ok' as const }
    } catch (error: any) {
      return { ...base, status: 'error' as const, message: String(error?.message || '解析失败') }
    }
  }))
  for (const check of checks) {
    if (check.status === 'ok') continue
    if (failures.length >= 100) break
    failures.push({
      playlist: '冒烟测试',
      source: check.source,
      sourceId: check.sourceId,
      deletable: check.deletable,
      platform: check.platform,
      status: check.status,
      index: 0,
      title: keyword,
      artist: check.platform,
      message: check.message || (check.status === 'warn' ? '检查结果需要关注' : '解析失败'),
    })
  }
  const tracksChecked = checks.length
  const healthyTracks = checks.filter(check => check.status === 'ok').length
  const warningTracks = checks.filter(check => check.status === 'warn').length
  const report: HealthReport = {
    checkedAt: new Date().toISOString(),
    ok: checks.every(check => check.status === 'ok'),
    playlists: records.length,
    tracksChecked,
    healthyTracks,
    warningTracks,
    keyword,
    checks,
    failures,
  }
  state.report = report
  state.consecutiveFailures = report.ok ? 0 : state.consecutiveFailures + 1
  writeHealthState(username, state)
  const threshold = Math.max(1, Number(state.settings.consecutiveFailureThreshold) || DEFAULT_HEALTH_SETTINGS.consecutiveFailureThreshold)
  const hasNotificationChannel = Boolean(
    (state.settings.messagePusherEnabled && state.settings.messagePusherUrl)
    || (state.settings.barkEnabled && state.settings.barkDeviceKey)
    || (state.settings.serverChanEnabled && state.settings.serverChanSendKey),
  )
  if ((state.settings.notify || hasNotificationChannel) && (report.ok || state.consecutiveFailures >= threshold)) {
    await postHealthNotification(state.settings, report)
  }
  return report
}

const healthLastCronRun = new Map<string, string>()
const startHealthScheduler = (deps: ApiV1Dependencies) => {
  if (healthScheduler) return
  healthScheduler = setInterval(() => {
    for (const user of deps.getUsers()) {
      const username = tryNormalizeUsername(user.name)
      if (!username) continue
      const state = readHealthState(username)
      if (!state.settings.enabled) continue
      const now = new Date()
      const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
      if (state.settings.cronExpression && cronMatches(state.settings.cronExpression, now)) {
        const key = `${username}:${minuteKey}`
        if (healthLastCronRun.get(username) === minuteKey) continue
        healthLastCronRun.set(username, minuteKey)
        runHealthCheck(deps, username).catch(error => console.warn('[Health] scheduled check failed:', error?.message || error))
        continue
      }
      const last = Date.parse(state.report?.checkedAt || '')
      const interval = Math.max(15, Number(state.settings.intervalMinutes) || DEFAULT_HEALTH_SETTINGS.intervalMinutes) * 60_000
      if (Number.isFinite(last) && Date.now() - last < interval) continue
      runHealthCheck(deps, username).catch(error => console.warn('[Health] scheduled check failed:', error?.message || error))
    }
  }, 60_000)
  healthScheduler.unref?.()
}

const invalidateSongloftMatchingCache = () => {
  songloftMatchingCache = null
}

const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(data))
}

const success = (res: ServerResponse, data: unknown, status = 200) => json(res, status, { data })

const failure = (res: ServerResponse, error: ApiErrorShape) => json(res, error.status, {
  error: {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
})

const readJson = async (req: IncomingMessage, maxBodySize = MAX_BODY_SIZE) => await new Promise<any>((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  let oversized = false
  req.on('data', chunk => {
    if (oversized) return
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBodySize) {
      oversized = true
      reject(new ApiError(413, 'payload_too_large', '请求内容过大'))
      return
    }
    chunks.push(value)
  })
  req.on('end', () => {
    if (oversized) return
    try {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve(text ? JSON.parse(text) : {})
    } catch {
      reject(new ApiError(400, 'invalid_json', '请求内容不是有效的 JSON'))
    }
  })
  req.on('error', reject)
})

const verifyApiToken = (token: string, secret: string, expectedType?: ApiTokenPayload['type']) => {
  const now = Date.now()
  for (const [revokedToken, expiresAt] of revokedTokens) {
    if (expiresAt <= now) revokedTokens.delete(revokedToken)
  }
  const payload = verifySignedApiToken(token, secret, expectedType)
  return payload && (revokedTokens.get(token) || 0) <= now ? payload : null
}

const issueToken = (
  username: string,
  type: ApiTokenPayload['type'],
  ttl: number,
  secret: string,
  extra: Partial<ApiTokenPayload> = {},
) => {
  const now = Math.floor(Date.now() / 1000)
  return signApiToken({ sub: username, type, iat: now, exp: now + ttl, ...extra }, secret)
}

const issueSession = (username: string, secret: string) => ({
  tokenType: 'Bearer',
  accessToken: issueToken(username, 'access', ACCESS_TOKEN_TTL, secret),
  accessTokenExpiresIn: ACCESS_TOKEN_TTL,
  refreshToken: issueToken(username, 'refresh', REFRESH_TOKEN_TTL, secret),
  refreshTokenExpiresIn: REFRESH_TOKEN_TTL,
  user: { username },
})

const getBearerToken = (req: IncomingMessage) => {
  const header = req.headers.authorization
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null
  return match?.[1] || null
}

const requireUser = (req: IncomingMessage, deps: ApiV1Dependencies, url?: URL) => {
  const token = getBearerToken(req)
  let payload = token ? verifyApiToken(token, deps.getAuthSecret(), 'access') : null
  if (!payload && url?.searchParams.get('token')) {
    const mediaToken = url.searchParams.get('token')!
    const mediaPayload = verifyApiToken(mediaToken, deps.getAuthSecret(), 'media')
    const trackId = url.pathname.match(/^\/api\/v1\/library\/tracks\/([^/]+)\/(?:stream|cover)$/)?.[1]
    if (mediaPayload && trackId && mediaPayload.trackId === decodeURIComponent(trackId)) payload = mediaPayload
  }
  const username = payload ? tryNormalizeUsername(payload.sub) : deps.getLegacyUser?.(req) || null
  if (!username || !deps.getUsers().some(user => user.name === username)) {
    throw new ApiError(401, 'unauthorized', '登录状态无效或已过期')
  }
  return username
}

const parsePositiveInt = (value: string | null, fallback: number, max: number) => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

const encodeTrackId = (item: any) => encodeApiValue(JSON.stringify({
  f: item.filename,
  d: item.folder,
  l: item.storageLocation,
}))

const parseDurationSeconds = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value || '').trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

const toTrack = (item: any) => ({
  id: encodeTrackId(item),
  catalogId: item.id,
  songmid: item.songmid || item.id,
  title: item.name || '',
  artist: item.singer || '',
  album: item.album || '',
  albumId: item.albumId || null,
  addedAt: Number(item.mtime || 0),
  publishTime: item.releaseDate || item.songInfo?.publishTime || item.songInfo?.releaseDate || item.songInfo?.year || null,
  source: item.source || 'unknown',
  requestedSource: item.requestedSource || null,
  downloadSource: item.downloadSource || item.source || 'unknown',
  quality: item.quality || 'unknown',
  bitrate: Number(item.bitrate || 0) || (
    Number(item.size) > 0 && parseDurationSeconds(item.interval) > 0
      ? Math.round(Number(item.size) * 8 / parseDurationSeconds(item.interval) / 1000)
      : 0
  ),
  duration: item.interval || null,
  size: Number(item.size || 0),
  folder: item.folder,
  extension: item.ext || '',
  hasCover: item.hasCover === true,
  hasLyrics: item.hasLyric === true || !!item.lyricFilename || item.hasEmbedLyric === true,
  streamPath: `${API_PREFIX}/library/tracks/${encodeURIComponent(encodeTrackId(item))}/stream`,
  coverPath: `${API_PREFIX}/library/tracks/${encodeURIComponent(encodeTrackId(item))}/cover`,
  raw: item.songInfo || {
    id: item.id,
    songmid: item.songmid || item.id,
    name: item.name,
    singer: item.singer,
    albumName: item.album,
    albumId: item.albumId,
    publishTime: item.releaseDate || null,
    source: item.source,
    interval: item.interval,
    img: item.img,
  },
})

const getTrackItem = async (username: string, rawId: string) => {
  const decoded = decodeTrackId(rawId)
  if (!decoded) throw new ApiError(404, 'track_not_found', '歌曲不存在')
  // Integration candidates may come from either configured storage root.  The
  // normal library listing historically follows the active root only, but a
  // preview token must resolve the exact shared music file selected by the
  // matcher (including a file living on the alternate root).
  const items = await fileCache.getDownloadedMusicItemsAcrossLocations(username)
  const item = items.find((candidate: any) => (
    candidate.filename === decoded.filename &&
    candidate.folder === decoded.folder &&
    (!decoded.location || candidate.storageLocation === decoded.location)
  ))
  if (!item) {
    // A freshly copied file can be playable before its secondary index has
    // finished syncing.  The track id already carries a validated relative
    // path and storage root, so use an existence check as a safe last resort
    // instead of returning a transient 404 on the first preview click.
    try {
      const physicalPath = fileCache.getCacheFilePath(
        username,
        decoded.folder === 'music',
        decoded.filename,
        decoded.location,
      )
      if (fs.existsSync(physicalPath) && fs.statSync(physicalPath).isFile()) {
        return {
          item: {
            filename: decoded.filename,
            folder: decoded.folder,
            storageLocation: decoded.location,
          },
          decoded,
        }
      }
    } catch { /* keep the public 404 below for an actually missing file */ }
    throw new ApiError(404, 'track_not_found', '歌曲不存在或曲库索引已更新')
  }
  return { item, decoded }
}

const normalizeOnlineTrack = (song: any, source: string) => ({
  id: song.id || `${song.source || source}_${song.songmid || song.hash || ''}`,
  title: song.name || song.title || '',
  artist: song.singer || song.artist || '',
  album: song.albumName || song.album || song.meta?.albumName || '',
  source: song.source || source,
  duration: song.interval || song.duration || null,
  artworkUrl: song.artworkUrl || song.coverUrl || song.cover_url || song.albumArt || song.album_art || song.albumCover || song.album_cover || song.img || song.picUrl || song.pic_url || song.meta?.picUrl || null,
  raw: song,
})

const collectTrackIds = (value: any) => {
  const source = String(value?.source || value?.meta?.source || '').toLowerCase()
  const ids = new Set<string>()
  for (const candidate of [value?.id, value?.songmid, value?.songId, value?.hash, value?.meta?.songId, value?.meta?.songmid, value?.meta?.hash]) {
    if (candidate === undefined || candidate === null || String(candidate).trim() === '') continue
    const id = String(candidate).trim()
    ids.add(id)
    if (!source) continue
    const prefix = `${source}_`
    ids.add(id.startsWith(prefix) ? id.slice(prefix.length) : `${prefix}${id}`)
  }
  return ids
}

const createLocalTrackIndex = (localItems: any[]) => {
  const index = new Map<string, any[]>()
  for (const item of localItems) {
    const ids = collectTrackIds({ ...item.songInfo, id: item.id, songmid: item.songmid, source: item.source })
    for (const id of ids) index.set(id, [...(index.get(id) || []), item])
  }
  return index
}

const findLocalPlaylistTrack = (song: any, localIndex: Map<string, any[]>) => {
  const songIds = collectTrackIds(song)
  const candidates = [...new Set([...songIds].flatMap(id => localIndex.get(id) || []))]
  if (!candidates.length) return null
  return candidates.sort((left, right) => {
    const folderScore = Number(right.folder === 'music') - Number(left.folder === 'music')
    if (folderScore) return folderScore
    const qualityScore = QUALITY_ORDER.indexOf(right.quality) - QUALITY_ORDER.indexOf(left.quality)
    return qualityScore || Number(right.size || 0) - Number(left.size || 0)
  })[0]
}

const mergeLocalTrackMetadata = (onlineTrack: any, localItem: any) => {
  if (!localItem) return onlineTrack
  const localTrack = toTrack(localItem)
  return {
    ...onlineTrack,
    quality: localTrack.quality,
    bitrate: localTrack.bitrate,
    size: localTrack.size,
    extension: localTrack.extension,
    hasCover: localTrack.hasCover,
    hasLyrics: localTrack.hasLyrics,
    localTrackId: localTrack.id,
    streamPath: localTrack.streamPath,
    coverPath: localTrack.coverPath,
  }
}

const withSignedArtwork = (track: any, username: string, secret: string) => {
  const localTrackId = track.localTrackId || (track.streamPath ? track.id : '')
  if (!track.hasCover || !track.coverPath || !localTrackId) return track
  const token = issueToken(username, 'media', MEDIA_TOKEN_TTL, secret, { trackId: localTrackId })
  return { ...track, artworkUrl: `${track.coverPath}?token=${encodeURIComponent(token)}` }
}

const normalizeSearchResult = (value: any, source: string) => {
  const list = Array.isArray(value) ? value : Array.isArray(value?.list) ? value.list : []
  return {
    items: list.map((song: any) => normalizeOnlineTrack(song, source)),
    total: Number(value?.total || list.length),
    page: Number(value?.page || 1),
    limit: Number(value?.limit || list.length),
  }
}

const normalizeAlbum = (item: any, source: string) => ({
  id: String(item.id || item.mid || item.albumMid || ''),
  name: item.name || item.albumName || item.info?.name || '',
  artist: item.artistName || item.artist || item.singer || item.info?.author || '',
  artworkUrl: item.picUrl || item.img || item.info?.img || null,
  source: item.source || source,
  publishTime: item.publishTime || item.info?.publishTime || null,
  trackCount: Number(item.size || item.total || item.count || 0),
  kind: 'album',
  raw: item,
})

const fetchAllPages = async (
  fetchPage: (page: number, limit: number) => Promise<any>,
  pageSize = 100,
  maxPages = 20,
) => {
  const items: any[] = []
  let total = 0
  let complete = false
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page, pageSize)
    const pageItems = Array.isArray(result) ? result : Array.isArray(result?.list) ? result.list : []
    items.push(...pageItems)
    total = Math.max(total, Number(result?.total) || 0)
    if (pageItems.length < pageSize || (total > 0 && items.length >= total)) {
      complete = true
      break
    }
  }
  return { items, total: total || items.length, complete }
}

const normalizeEntityResult = (value: any, source: string, type: 'singer' | 'album') => {
  const list = Array.isArray(value) ? value : Array.isArray(value?.list) ? value.list : []
  return {
    items: list.map((item: any) => type === 'singer' ? ({
      id: String(item.id || item.mid || ''),
      name: item.name || '',
      title: item.name || '',
      artist: item.name || '',
      artworkUrl: item.picUrl || item.img || null,
      source: item.source || source,
      kind: 'singer',
      raw: item,
    }) : ({
      id: String(item.id || item.mid || ''),
      name: item.name || '',
      title: item.name || '',
      artist: item.artistName || item.artist || '',
      artworkUrl: item.picUrl || item.img || null,
      source: item.source || source,
      kind: 'album',
      raw: item,
    })),
    total: Number(value?.total || list.length),
    page: Number(value?.page || 1),
    limit: Number(value?.limit || list.length),
  }
}

const getPlaylist = async (username: string, playlistId: string) => {
  const data = await getUserSpace(username).listManage.getListData()
  if (playlistId === 'default') return { id: 'default', name: '试听列表', list: data.defaultList }
  if (playlistId === 'love') return { id: 'love', name: '我的收藏', list: data.loveList }
  const playlist = data.userList.find(item => item.id === playlistId)
  if (!playlist) throw new ApiError(404, 'playlist_not_found', '歌单不存在')
  return playlist
}

const safePlaylistArtwork = (value: unknown) => {
  const artwork = String(value || '').trim()
  if (!artwork) return null
  // Covers are rendered as an image URL by both the admin page and the web
  // player.  Keep the whitelist deliberately small so a playlist edit cannot
  // persist a javascript: or other executable URL in a user snapshot.
  if (/^https?:\/\//i.test(artwork) || artwork.startsWith('/') || /^data:image\//i.test(artwork)) return artwork
  return null
}

const songArtwork = (song: any) => safePlaylistArtwork(
  song?.artworkUrl || song?.coverUrl || song?.cover_url || song?.albumArt || song?.album_art ||
  song?.albumCover || song?.album_cover || song?.img || song?.picUrl || song?.pic_url ||
  song?.meta?.picUrl || song?.meta?.img || song?.album?.picUrl || song?.al?.picUrl,
)

const playlistSongMatchesId = (song: any, coverSongId: string) => {
  if (!coverSongId) return false
  const target = String(coverSongId)
  return [...collectTrackIds(song)].some(id => id === target)
}

const playlistArtwork = (playlist: any, items: any[] = playlist?.list || []) => {
  const explicit = safePlaylistArtwork(playlist?.coverUrl || playlist?.artworkUrl || playlist?.cover)
  if (explicit) return explicit
  const selected = String(playlist?.coverSongId || '').trim()
  if (selected) {
    const selectedSong = items.find(song => playlistSongMatchesId(song, selected))
    const selectedArtwork = songArtwork(selectedSong)
    if (selectedArtwork) return selectedArtwork
  }
  return items.map(songArtwork).find(Boolean) || null
}

const publicPlaylistImportRecord = (record: PlaylistImportRecord) => ({
  importId: record.importId,
  name: record.name,
  source: record.source,
  sourcePlaylistId: record.sourcePlaylistId || null,
  sourcePlaylistName: record.sourcePlaylistName || record.name,
  yinyunPlaylistId: record.yinyunPlaylistId,
  trackCount: record.tracks.length,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

const findExistingPlaylistImport = (
  store: PlaylistImportStore,
  source: string,
  sourcePlaylistId: string | undefined,
): PlaylistImportRecord | undefined => {
  if (!sourcePlaylistId) return undefined
  return store.list()
    .filter(record => record.source === source && record.sourcePlaylistId === sourcePlaylistId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
}

const requireSongloftClient = (deps: ApiV1Dependencies) => {
  const client = deps.getSongloftClient?.()
  if (!client || !client.configured) throw new ApiError(503, 'songloft_not_configured', 'Songloft 原生 API 尚未配置')
  return client
}

const requireSongloftSubsonicClient = (deps: ApiV1Dependencies) => {
  const client = deps.getSongloftSubsonicClient?.()
  if (!client) throw new ApiError(503, 'songloft_subsonic_not_configured', 'Songloft Subsonic API 尚未配置')
  return client
}

const requireIntegrationAdmin = (req: IncomingMessage, deps: ApiV1Dependencies) => {
  if (!deps.isAdminRequest?.(req)) throw new ApiError(403, 'integration_admin_required', '该操作需要音云管理后台权限')
}

const refreshYinyunLibraryIndex = async (username: string) => {
  const locations = [
    fileCache.getCacheLocation(),
    fileCache.getCacheLocation() === fileCache.CACHE_ROOTS.DATA ? fileCache.CACHE_ROOTS.ROOT : fileCache.CACHE_ROOTS.DATA,
  ]
  const uniqueLocations = [...new Set(locations)]
  await Promise.all(uniqueLocations.map(location => fileCache.syncCacheIndex(username, ['music'], location)))
  const items = await fileCache.getDownloadedMusicItemsAcrossLocations(username)
  return { locations: uniqueLocations, tracks: items.length }
}

const readSongloftPlaylists = async (deps: ApiV1Dependencies) => {
  const native = deps.getSongloftClient?.()
  if (native?.configured) return { source: 'native', playlists: await native.listPlaylists() }
  const subsonic = deps.getSongloftSubsonicClient?.()
  if (subsonic) return { source: 'subsonic', playlists: await subsonic.listPlaylists() }
  throw new ApiError(503, 'songloft_not_configured', 'Songloft 原生或 Subsonic API 尚未配置')
}

const normalizePlaylistName = (value: unknown) => String(value || '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ')
  .toLocaleLowerCase()

const getUserLocalIntegrationTracks = async (username: string): Promise<IntegrationTrack[]> => {
  // Playlist matching is against the downloaded/local music tree only.  This
  // intentionally excludes yinyun's transient cache so MusicHub (and any
  // external copier) cannot become a second download/metadata pipeline.
  const items = await fileCache.getDownloadedMusicItemsAcrossLocations(username)
  return items.map(item => toIntegrationTrack({
    ...item,
    id: item.id,
    title: item.name,
    artist: item.singer,
    album: item.album,
    duration: item.interval,
    relativePath: item.filename,
    isLocal: true,
    folder: item.folder || 'music',
    storageLocation: item.storageLocation || (item as any)._localStorageLocation,
  }))
}

const getSongloftTracksForMatching = async (deps: ApiV1Dependencies, sourceTracks: IntegrationTrack[] = []) => {
  const client = deps.getSongloftClient?.()
  if (client?.configured) {
    if (songloftMatchingCache?.client === client && songloftMatchingCache.expiresAt > Date.now()) return songloftMatchingCache.tracks
    if (!songloftMatchingPromise) {
      songloftMatchingPromise = client.listAllSongs()
        .then(tracks => {
          songloftMatchingCache = { client, tracks, expiresAt: Date.now() + SONGLOFT_MATCHING_CACHE_TTL }
          return tracks
        })
        .finally(() => { songloftMatchingPromise = null })
    }
    return songloftMatchingPromise
  }

  const subsonic = deps.getSongloftSubsonicClient?.()
  if (!subsonic) return []
  const lookup = new Map<string, IntegrationTrack>()
  for (const track of sourceTracks) {
    const query = `${track.artist} ${track.title}`.trim()
    if (!query) continue
    for (const candidate of await subsonic.searchSongs(query, 25)) lookup.set(String(candidate.id), candidate)
  }
  return [...lookup.values()]
}

// [YINYUN-INTEGRATION] The two index counters deliberately use the native
// provider views, not a guessed file count.  Yinyun reads the shared music
// tree through its own cache index; Songloft reads the same tree through its
// own scan database.  Keeping both values visible makes an index drift
// diagnosable instead of silently treating one provider as authoritative.
const getLibraryIndexStatus = async (deps: ApiV1Dependencies, username: string) => {
  const [yinyunItems, scan] = await Promise.all([
    fileCache.getDownloadedMusicItemsAcrossLocations(username),
    deps.getSongloftClient?.()?.configured
      ? deps.getSongloftClient()!.scanProgress()
      : Promise.resolve({ status: 'unavailable' }),
  ])
  const songloft = deps.getSongloftClient?.()
  // The scan endpoint already reports Songloft's authoritative indexed-file
  // count.  Do not call listAllSongs() here: that paginates the whole catalog
  // and made a simple status refresh wait tens of seconds (or look like a
  // no-op) on a few-thousand-track library.  Full song metadata remains
  // available to the matching path, which is cached independently.
  const reportedSongloftTracks = Number((scan as any)?.local_song_count ?? (scan as any)?.song_count ?? (scan as any)?.total_files)
  const songloftTracks = songloft?.configured || deps.getSongloftSubsonicClient?.()
    ? (Number.isFinite(reportedSongloftTracks) ? reportedSongloftTracks : 0)
    : 0
  return {
    yinyunTracks: yinyunItems.length,
    yinyunAudioTracks: yinyunItems.filter(item => Boolean(item.ext && ['mp3', 'flac', 'm4a', 'ogg', 'wav'].includes(String(item.ext).toLowerCase()))).length,
    songloftTracks,
    scan,
    locations: [fileCache.getCacheLocation(), fileCache.getCacheLocation() === fileCache.CACHE_ROOTS.DATA ? fileCache.CACHE_ROOTS.ROOT : fileCache.CACHE_ROOTS.DATA],
    algorithm: 'relative_path → ISRC → fingerprint → title/artist/album/duration → fuzzy (ambiguous when candidates are too close)',
  }
}

const playlistTrackIds = (tracks: IntegrationTrack[]) => tracks.map(track => canonicalTrackId(track))

const buildLocalSongInfo = (track: IntegrationTrack) => {
  const raw = (track.raw && typeof track.raw === 'object') ? track.raw as any : {}
  const relativePath = String(track.relativePath || raw.filename || `${track.artist}/${track.title}`).replace(/\\/g, '/')
  const storageLocation = String(raw.storageLocation || raw._localStorageLocation || '')
  const id = String(track.id || '').startsWith('local_')
    ? String(track.id)
    : `local_${crypto.createHash('sha256').update(`${storageLocation}\0${relativePath}`).digest('hex').slice(0, 32)}`
  return {
    ...raw,
    id,
    source: 'local',
    songmid: raw.songmid || id,
    name: track.title,
    singer: track.artist,
    albumName: track.album || '',
    interval: track.duration || raw.interval || '0',
    _localFilename: relativePath,
    _localFolder: raw.folder || 'music',
    _localStorageLocation: storageLocation || undefined,
  }
}

const publicIntegrationTrack = (track?: IntegrationTrack) => track ? ({
  id: track.id ?? null,
  source: track.source || null,
  sourceId: track.sourceId ?? null,
  title: track.title,
  artist: track.artist,
  album: track.album || '',
  duration: track.duration || null,
  artworkUrl: track.artworkUrl || null,
  relativePath: track.relativePath || null,
  isLocal: Boolean(track.isLocal || track.folder || track.storageLocation || (track.raw && typeof track.raw === 'object' && ((track.raw as any).folder || (track.raw as any).filename))),
  folder: track.folder || (track.raw && typeof track.raw === 'object' ? (track.raw as any).folder || null : null),
  storageLocation: track.storageLocation || (track.raw && typeof track.raw === 'object' ? (track.raw as any).storageLocation || null : null),
  localTrackId: (track.isLocal || track.folder || track.storageLocation || (track.raw && typeof track.raw === 'object' && ((track.raw as any).folder || (track.raw as any).filename))) && (track.relativePath || (track.raw && typeof track.raw === 'object' ? (track.raw as any).filename : ''))
    ? encodeTrackId({
      filename: track.relativePath || (track.raw as any)?.filename,
      folder: track.folder || (track.raw as any)?.folder || 'music',
      storageLocation: track.storageLocation || (track.raw as any)?.storageLocation || (track.raw as any)?._localStorageLocation,
    })
    : null,
  isrc: track.isrc || null,
  hasFingerprint: Boolean(track.fingerprint),
}) : null

const isLocalIntegrationTrack = (track?: IntegrationTrack | null) => Boolean(
  track && (track.isLocal || track.folder || track.storageLocation || (track.raw && typeof track.raw === 'object' && ((track.raw as any).folder || (track.raw as any).filename))),
)

const publicTrackMatch = (match: ReturnType<typeof matchTracks>[number]) => ({
  status: match.status,
  score: Number(match.score.toFixed(4)),
  method: match.method,
  source: publicIntegrationTrack(match.source),
  candidate: publicIntegrationTrack(match.candidate),
  candidates: match.candidates.map(item => ({
    score: Number(item.score.toFixed(4)),
    method: item.method,
    track: publicIntegrationTrack(item.track),
  })),
})

const awaitSdkRequest = async (value: any) => value?.promise ? await value.promise : await value

// “聚合”只是一层统一搜索，不新增音源脚本，也不改 Songloft。实际结果保留
// source 字段，后续试听和下载仍会回到对应的在线平台解析地址。
const AGGREGATE_SOURCE_ORDER = ['wy', 'tx', 'kw', 'kg', 'mg', 'bd']

const getAggregateSources = (deps: ApiV1Dependencies, username: string) => {
  const ordered = [...AGGREGATE_SOURCE_ORDER, ...Object.keys(deps.musicSdk || {})]
  return [...new Set(ordered)].filter(source => (
    source !== 'aggregate' &&
    deps.isSourceSupported(source, username) &&
    typeof deps.musicSdk?.[source]?.musicSearch?.search === 'function'
  ))
}

const searchAggregate = async (
  deps: ApiV1Dependencies,
  username: string,
  query: string,
  page: number,
  limit: number,
) => {
  const sources = getAggregateSources(deps, username)
  if (!sources.length) throw new ApiError(409, 'source_unavailable', '当前账户没有可用的在线音源')
  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const groups = await Promise.all(sources.map(async source => {
    try {
      const result = await awaitSdkRequest(deps.musicSdk[source].musicSearch.search(query, page, safeLimit))
      return normalizeSearchResult(result, source).items
    } catch (error: any) {
      // 单个平台暂时不可用不能阻断其他平台结果。
      console.warn(`[AggregateSearch] ${source} failed: ${error?.message || error}`)
      return []
    }
  }))
  const seen = new Set<string>()
  const items = groups.flat().filter(item => {
    const key = `${item.source}:${String(item.id || item.title).trim()}:${String(item.artist).trim()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { items: items.slice(0, safeLimit), total: items.length, page, limit: safeLimit, sources }
}

const resolveAggregateTrack = async (
  deps: ApiV1Dependencies,
  username: string,
  track: IntegrationTrack,
) => {
  const query = [track.title, track.artist, track.album].filter(Boolean).join(' ')
  if (!query) return null
  const result = await searchAggregate(deps, username, query, 1, 30)
  const candidates = result.items.map(item => toIntegrationTrack(item))
  const match = matchTracks([track], candidates, { threshold: 0, ambiguityMargin: 0 })[0]
  const candidate = match?.candidate
  if (!candidate?.source || !deps.isSourceSupported(String(candidate.source), username)) return null
  return candidate
}

const getExternalPlaylist = async (deps: ApiV1Dependencies, username: string, source: string, id: string, page: number) => {
  if (!deps.isSourceSupported(source, username)) throw new ApiError(409, 'source_unavailable', `当前账户没有可用的 ${source} 音源`)
  const sdk = deps.musicSdk[source]
  const methodOwner = sdk?.songList?.getListDetail ? sdk.songList : sdk?.userPlaylist
  const method = methodOwner?.getListDetail
  if (typeof method !== 'function') throw new ApiError(400, 'playlist_unsupported', '该平台不支持歌单详情')
  const result = await awaitSdkRequest(method.call(methodOwner, id, page))
  const list = Array.isArray(result) ? result : Array.isArray(result?.list) ? result.list : []
  return {
    source,
    id,
    name: String(result?.name || result?.title || result?.info?.name || ''),
    page,
    tracks: list.map((item: any) => toIntegrationTrack(deps.normalizeSongInfo({ ...item, source: item?.source || source }))),
  }
}

/** Accept either an explicit provider/id pair or a common share URL.  The
 * provider still has to be one of the yinyun-loaded music SDKs; this parser
 * only removes URL plumbing from the import UI and never downloads from the
 * third-party site directly. */
const parseExternalPlaylistRef = (body: any) => {
  const rawUrl = String(body.url || body.playlistUrl || '').trim()
  let source = String(body.source || '').trim().toLowerCase()
  let id = String(body.id ?? body.playlistId ?? '').trim()
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl)
      const host = parsed.hostname.toLocaleLowerCase()
      if (!source) {
        source = host.includes('163.com') || host.includes('netease') ? 'wy'
          : host.includes('y.qq.com') || host.includes('qq.com') ? 'tx'
            : host.includes('kuwo.cn') ? 'kw'
              : host.includes('kugou.com') ? 'kg'
                : host.includes('migu.cn') ? 'mg' : ''
      }
      if (!id) {
        id = parsed.searchParams.get('id') || parsed.searchParams.get('playlistId') || parsed.searchParams.get('pid') || ''
        if (!id && parsed.hash) {
          const hash = parsed.hash.replace(/^#/, '')
          const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash
          const hashParams = new URLSearchParams(hashQuery)
          id = hashParams.get('id') || hashParams.get('playlistId') || hashParams.get('pid') || ''
        }
        if (!id) {
          const segments = parsed.pathname.split('/').map(item => item.trim()).filter(Boolean)
          id = segments.reverse().find(item => /\d/.test(item) || /^[A-Za-z0-9_-]{6,}$/.test(item)) || ''
        }
      }
    } catch {
      // Let the normal validation below return a stable API error.
    }
  }
  return { source, id, url: rawUrl }
}

const normalizeImportedSong = (deps: ApiV1Dependencies, track: IntegrationTrack, fallbackSource: string) => {
  const raw = track.raw && typeof track.raw === 'object' ? { ...(track.raw as any) } : {}
  const source = String(raw.source || track.source || fallbackSource || '').trim()
  if (!source) throw new ApiError(400, 'track_source_required', '导入歌曲缺少音源，无法使用音云下载')
  const song = deps.normalizeSongInfo({
    ...raw,
    id: raw.id ?? track.id ?? track.sourceId,
    songmid: raw.songmid ?? track.sourceId ?? track.id,
    source,
    name: raw.name ?? track.title,
    singer: raw.singer ?? track.artist,
    albumName: raw.albumName ?? track.album ?? '',
    interval: raw.interval ?? track.duration ?? '',
  })
  if (!song || !song.source) throw new ApiError(400, 'track_source_required', '导入歌曲缺少音源，无法使用音云下载')
  return song
}

const isNonYinyunDownloadSource = (source: unknown) => {
  const value = String(source || '').trim().toLowerCase()
  return !value || ['songloft', 'subsonic', 'navidrome', 'musichub'].includes(value)
}

const dedupeSongs = (songs: any[]) => {
  const seen = new Set<string>()
  return songs.filter(song => {
    const id = String(song?.id || `${song?.source || ''}:${song?.songmid || song?.name || ''}:${song?.singer || ''}`)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

type PlaylistImportMatch = ReturnType<typeof matchTracks>[number] & {
  matchedBy?: 'yinyun' | 'songloft' | 'local'
  yinyun?: ReturnType<typeof matchTracks>[number]
  songloft?: ReturnType<typeof matchTracks>[number]
  local?: ReturnType<typeof matchTracks>[number]
}

const choosePlaylistImportMatch = (
  yinyunMatch: ReturnType<typeof matchTracks>[number],
  songloftMatch: ReturnType<typeof matchTracks>[number],
): PlaylistImportMatch => {
  if (yinyunMatch.status === 'matched') return { ...yinyunMatch, matchedBy: 'yinyun' }
  if (songloftMatch.status === 'matched') return { ...songloftMatch, matchedBy: 'songloft' }
  if (yinyunMatch.status === 'ambiguous') return { ...yinyunMatch, matchedBy: 'yinyun' }
  if (songloftMatch.status === 'ambiguous') return { ...songloftMatch, matchedBy: 'songloft' }
  return { ...yinyunMatch, matchedBy: undefined }
}

const anchorSongloftSources = (
  tracks: IntegrationTrack[],
  yinyunMatches: ReturnType<typeof matchTracks>,
) => tracks.map((track, index) => {
  const anchor = yinyunMatches[index]
  const relativePath = anchor?.status === 'matched' ? anchor.candidate?.relativePath : undefined
  return relativePath ? { ...track, relativePath: String(relativePath).replace(/^music\//i, '') } : track
})

/**
 * Find a physical shared-library file even when one provider has not finished
 * indexing it yet. The candidate must still pass the same metadata sanity rule
 * used by relative-path matching; a filename alone is never enough.
 */
const bestSharedLocalCandidate = (
  source: IntegrationTrack,
  matches: Array<ReturnType<typeof matchTracks>[number] | undefined>,
) => matches.flatMap(match => [
  ...(match?.candidates || []).map(item => ({ track: item.track, score: Number(item.score || 0) })),
  ...(match?.candidate ? [{ track: match.candidate, score: Number(match.score || 0) }] : []),
])
  .filter((item): item is { track: IntegrationTrack; score: number } => Boolean(item.track && isLocalIntegrationTrack(item.track)))
  .filter(item => metadataAgreement(source, item.track).strong)
  .sort((left, right) => right.score - left.score)[0] || null

const promoteSharedLocalMatch = (
  match: ReturnType<typeof matchTracks>[number],
  candidate: IntegrationTrack,
  score: number,
) => ({
  ...match,
  status: 'matched' as const,
  candidate,
  score: Math.max(score, Number(match.score || 0), 0.82),
  method: 'shared_local_file',
  candidates: [{ track: candidate, score: Math.max(score, 0.82), method: 'shared_local_file' }, ...(match.candidates || [])]
    .filter((item, index, list) => index === list.findIndex(other => String(other.track.relativePath || '') === String(item.track.relativePath || ''))),
})

const getPlaylistMatches = async (
  deps: ApiV1Dependencies,
  username: string,
  tracks: IntegrationTrack[],
): Promise<PlaylistImportMatch[]> => {
  const localTracks = await getUserLocalIntegrationTracks(username)
  const songloftTracks = await getSongloftTracksForMatching(deps, tracks)
  const yinyunMatches = matchTracks(tracks, localTracks, SHARED_LIBRARY_MATCH_OPTIONS)
  // The two providers can expose different embedded tags for the same shared
  // file (for example Songloft may identify a soundtrack file as a different
  // artist). Once Yinyun has a confident local candidate, carry its relative
  // path into the Songloft comparison. `matchTrack` still requires metadata
  // agreement for a path hit; the path is a physical-file key, not a blanket
  // score override. This keeps the shared file aligned while rejecting a
  // stale index entry whose title/artist/album are unrelated.
  const songloftSources = anchorSongloftSources(tracks, yinyunMatches)
  const songloftMatches = matchTracks(songloftSources, songloftTracks, SHARED_LIBRARY_MATCH_OPTIONS)
  return tracks.map((_, index) => {
    let yinyun = yinyunMatches[index]
    let songloft = songloftMatches[index]
    const shared = bestSharedLocalCandidate(tracks[index], [yinyun, songloft])
    // A shared file is a valid match for both views once metadata agrees,
    // even if either provider's scan database is one refresh behind. This
    // prevents a known local file from entering the download queue again.
    if (shared) {
      yinyun = promoteSharedLocalMatch(yinyun, shared.track, shared.score)
      songloft = promoteSharedLocalMatch(songloft, shared.track, shared.score)
    }
    const effective = shared
      ? { ...promoteSharedLocalMatch(choosePlaylistImportMatch(yinyun, songloft), shared.track, shared.score), matchedBy: 'local' as const }
      : choosePlaylistImportMatch(yinyun, songloft)
    const local = shared
      ? promoteSharedLocalMatch({ ...yinyun, source: tracks[index] }, shared.track, shared.score)
      : undefined
    return { ...effective, yinyun, songloft, local }
  })
}

const getPlaylistImportMatches = async (
  deps: ApiV1Dependencies,
  username: string,
  record: PlaylistImportRecord,
) => {
  const matches = await getPlaylistMatches(deps, username, record.tracks)
  return matches.map((match, index) => {
    const provider = record.resolutions?.[String(index)]
    if (!provider) return match
    const selected = provider === 'local' ? match.local : match[provider]
    const markProviderMatched = (providerMatch: ReturnType<typeof matchTracks>[number], candidate: IntegrationTrack) => ({
      ...providerMatch,
      status: 'matched' as const,
      candidate,
      score: Math.max(Number(providerMatch.score || 0), 1),
      method: providerMatch.method || 'confirmed',
      candidates: providerMatch.candidates?.length
        ? providerMatch.candidates
        : [{ track: candidate, score: 1, method: 'confirmed' }],
    })
    if (!selected?.candidate) {
      // The provider can temporarily reorder or omit a candidate while its
      // index is rescanning.  Reuse the persisted user choice instead of
      // regressing the row to “需确认”.
      const persisted = record.resolvedCandidates?.[String(index)]
      if (!persisted?.title) return match
      const yinyun = provider === 'yinyun' || provider === 'local' ? markProviderMatched(match.yinyun || match, persisted) : match.yinyun
      const songloft = provider === 'songloft' || provider === 'local' ? markProviderMatched(match.songloft || match, persisted) : match.songloft
      return {
        ...match,
        status: 'matched' as const,
        candidate: persisted,
        score: 1,
        method: 'confirmed_snapshot',
        candidates: [{ track: persisted, score: 1, method: 'confirmed_snapshot' }],
        matchedBy: provider,
        yinyun,
        songloft,
      }
    }
    // An ambiguous match still exposes its best candidate.  The explicit
    // user choice turns that candidate into the effective matched result;
    // without this conversion the confirmation button would have no effect.
    const yinyun = provider === 'yinyun' || provider === 'local' ? markProviderMatched(match.yinyun || match, selected.candidate) : match.yinyun
    const songloft = provider === 'songloft' || provider === 'local' ? markProviderMatched(match.songloft || match, selected.candidate) : match.songloft
    return { ...selected, status: 'matched' as const, yinyun, songloft, matchedBy: provider }
  })
}

const publicImportItem = (match: PlaylistImportMatch, index: number, deps: ApiV1Dependencies, username: string, source: string) => {
  const replaceable = match.status === 'matched' && isLocalIntegrationTrack(match.candidate)
  // A provider index may temporarily report "missing" while its candidate
  // list already contains the shared local file (for example while Songloft
  // is rescanning).  Keep that physical-file evidence explicit so the UI can
  // show the local match without inflating either provider's authoritative
  // indexed count.
  const providerMatches = [match.yinyun, match.songloft, match.local, match]
  const localCandidate = providerMatches
    .flatMap(item => [
      ...(item?.candidates || []).map(candidate => ({ track: candidate.track, score: candidate.score })),
      item?.candidate ? { track: item.candidate, score: item.score } : null,
    ])
    .filter((item): item is { track: IntegrationTrack; score: number } => Boolean(item?.track && isLocalIntegrationTrack(item.track)))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0]?.track
  return {
  index,
  ...publicTrackMatch(match),
  matchedBy: match.matchedBy || null,
  yinyun: publicTrackMatch(match.yinyun || match),
  songloft: publicTrackMatch(match.songloft || match),
  availability: {
    yinyun: (match.yinyun || match).status,
    songloft: (match.songloft || match).status,
    local: localCandidate ? 'matched' : 'missing',
  },
  localCandidate: publicIntegrationTrack(localCandidate),
  replaceable,
  downloadable: (match.status !== 'matched' || replaceable) && !isNonYinyunDownloadSource(match.source.source) && deps.isSourceSupported(String(match.source.source || source), username),
  }
}

// Count the effective decision and each provider independently.  The latter
// is important when both indexes found the same file: showing Songloft as zero
// merely because Yinyun won the tie made a healthy shared library look broken.
const playlistImportCounts = (matches: PlaylistImportMatch[]) => ({
  total: matches.length,
  localMatched: matches.filter(item => item.status === 'matched').length,
  yinyunMatched: matches.filter(item => item.yinyun?.status === 'matched').length,
  songloftMatched: matches.filter(item => item.songloft?.status === 'matched').length,
  missing: matches.filter(item => item.status === 'missing').length,
  ambiguous: matches.filter(item => item.status === 'ambiguous').length,
})

// Replace the corresponding imported playlist entry after the user confirms
// a local candidate.  Matching by canonical ID plus occurrence number keeps
// repeated songs in their original order and avoids overwriting a later row
// when a playlist contains the same song more than once.
const replaceConfirmedPlaylistTrack = async (
  deps: ApiV1Dependencies,
  username: string,
  record: PlaylistImportRecord,
  index: number,
  candidate: IntegrationTrack,
  previousCandidate?: IntegrationTrack,
) => {
  const targetId = canonicalTrackId(record.tracks[index])
  const occurrence = record.tracks.slice(0, index + 1).filter(track => canonicalTrackId(track) === targetId).length
  if (!targetId || occurrence < 1) return false
  const playlist = await getPlaylist(username, record.yinyunPlaylistId)
  let seen = 0
  let targetIndex = -1
  const sourceId = String(record.tracks[index].sourceId ?? record.tracks[index].id ?? '').trim()
  const previousPath = String(previousCandidate?.relativePath || '').replace(/\\/g, '/').toLocaleLowerCase()
  for (let itemIndex = 0; itemIndex < playlist.list.length; itemIndex++) {
    try {
      const itemId = canonicalTrackId(toIntegrationTrack(deps.normalizeSongInfo(playlist.list[itemIndex])))
      const raw = playlist.list[itemIndex] && typeof playlist.list[itemIndex] === 'object' ? playlist.list[itemIndex] as any : {}
      const itemSourceId = String(raw.sourceId ?? raw.songmid ?? raw.id ?? '').trim()
      const itemPath = String(raw._localFilename || raw.relativePath || raw.filename || '').replace(/\\/g, '/').toLocaleLowerCase()
      if (previousPath && itemPath && previousPath === itemPath) {
        targetIndex = itemIndex
        break
      }
      if (itemSourceId && sourceId && itemSourceId === sourceId) {
        targetIndex = itemIndex
        break
      }
      if (itemId === targetId) {
        seen += 1
        if (seen === occurrence) {
          targetIndex = itemIndex
          break
        }
      }
    } catch {
      // An unrelated malformed playlist row must not prevent confirmation.
    }
  }
  const nextList = [...playlist.list]
  const localSong = buildLocalSongInfo(candidate)
  if (targetIndex >= 0) {
    nextList[targetIndex] = localSong
  } else {
    const candidatePath = String(candidate.relativePath || '').replace(/\\/g, '/').toLocaleLowerCase()
    const alreadyPresent = candidatePath && nextList.some(item => {
      const raw = item && typeof item === 'object' ? item as any : {}
      return String(raw._localFilename || raw.relativePath || '').replace(/\\/g, '/').toLocaleLowerCase() === candidatePath
    })
    if (alreadyPresent) return true
    // Imported playlists dedupe repeated source rows, so a source index can
    // legitimately have no one-to-one position in the stored list.  Append
    // the explicitly confirmed local candidate instead of silently dropping
    // the user's decision.
    nextList.push(localSong)
  }
  const manage = getUserSpace(username).listManage
  await manage.listDataManage.listMusicOverwrite(record.yinyunPlaylistId, nextList as any)
  await manage.createSnapshot()
  return true
}

const cacheItemToIntegrationTrack = (item: any): IntegrationTrack => toIntegrationTrack({
  ...item,
  id: item?.id,
  title: item?.name,
  artist: item?.singer,
  album: item?.album,
  duration: item?.interval,
  relativePath: item?.filename,
  isLocal: true,
})

const normalizedTrackPath = (track?: Pick<IntegrationTrack, 'relativePath'> | null) => String(track?.relativePath || '')
  .replace(/\\/g, '/')
  .replace(/^.*\/music\//i, '')
  .replace(/^\/+/, '')
  .toLocaleLowerCase()

const findCompletedLocalTrack = async (username: string, task: any): Promise<any> => {
  const items = await fileCache.getDownloadedMusicItemsAcrossLocations(username)
  const activeSongKey = String(task?.activeSongKey || '')
  const taskQuality = String(task?.quality || task?.requestedQuality || '')
  const exact = items
    .filter(item => item.folder === 'music')
    .filter(item => {
      const key = `${fileCache.normalizeSongId({ id: item.id, songmid: item.songmid, source: item.source })}_${item.quality}`
      return (activeSongKey && key === activeSongKey) || (
        !activeSongKey && taskQuality && String(item.quality) === taskQuality &&
        String(item.id) === String(task?.songInfo?.id || task?.songInfo?.songmid || '')
      )
    })
    .sort((left, right) => Number(right.mtime || 0) - Number(left.mtime || 0))
  if (exact[0]) return exact[0]

  const sourceTrack = toIntegrationTrack(task?.songInfo || {})
  const localTracks = items.filter(item => item.folder === 'music').map(cacheItemToIntegrationTrack)
  const matches = matchTracks([sourceTrack], localTracks, { ...SHARED_LIBRARY_MATCH_OPTIONS, ambiguityMargin: 0 })
  return matches[0]?.candidate?.raw && typeof matches[0].candidate.raw === 'object'
    ? matches[0].candidate.raw
    : matches[0]?.candidate
}

const syncSongloftReplacement = async (
  deps: ApiV1Dependencies,
  username: string,
  playlistId: string,
  playlistName: string,
  previousTrack: IntegrationTrack,
  nextTrack: IntegrationTrack,
) => {
  const client = deps.getSongloftClient?.()
  if (!client?.configured) return { updated: false, reason: 'songloft_unavailable' }
  const store = deps.getPlaylistSyncStore?.(username)
  store?.load()
  const mapped = store?.get(`${username}:${playlistId}`)
  const remotePlaylists = await client.listPlaylists()
  const remoteId = Number(mapped?.songloftPlaylistId || remotePlaylists.find(item => normalizePlaylistName(item.name) === normalizePlaylistName(playlistName))?.id)
  if (!Number.isFinite(remoteId) || remoteId <= 2) return { updated: false, reason: 'songloft_playlist_not_mapped' }

  let remoteLibrary = await client.listAllSongs()
  const currentSongs = await client.getPlaylistSongs(remoteId)
  const matchRemote = (track: IntegrationTrack) => matchTracks([track], remoteLibrary, { ...SHARED_LIBRARY_MATCH_OPTIONS, threshold: 0.82, ambiguityMargin: 0 })[0]?.candidate
  let previousRemote = matchRemote(previousTrack)
  let nextRemote = matchRemote(nextTrack)
  // Songloft indexes asynchronously.  A replacement can therefore finish
  // downloading before its new file is visible in the remote library.  Start
  // one normal scan and poll the read-only library endpoint briefly so the
  // playlist update is eventual instead of silently leaving the old song.
  if (!nextRemote) {
    try { await client.startScan(false) } catch (error: any) {
      console.warn('[PlaylistReplacement] Songloft scan request failed:', error?.message || error)
    }
    for (const delayMs of [1500, 3000, 5000]) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      try {
        remoteLibrary = await client.listAllSongs()
        nextRemote = matchRemote(nextTrack)
        previousRemote = matchRemote(previousTrack)
        if (nextRemote) break
      } catch (error: any) {
        console.warn('[PlaylistReplacement] Songloft library retry failed:', error?.message || error)
      }
    }
  }
  const previousId = asRemoteSongId(previousRemote)
  const nextId = asRemoteSongId(nextRemote)
  if (!nextId) return { updated: false, reason: 'songloft_replacement_not_indexed' }
  const currentIds = new Set(currentSongs.map(asRemoteSongId).filter((id): id is number => id !== null))
  if (!currentIds.has(nextId)) await client.addPlaylistSongs(remoteId, [nextId])
  if (previousId !== null && previousId !== nextId && currentIds.has(previousId)) await client.removePlaylistSong(remoteId, previousId)
  return { updated: true, songloftPlaylistId: remoteId, removedSongId: previousId, addedSongId: nextId }
}

/**
 * Apply an explicitly selected online replacement only after the queue task
 * has materialized a new local file.  This is deliberately a completion hook:
 * a failed download never removes the old file or changes either playlist.
 */
export const completePlaylistReplacement = async (deps: ApiV1Dependencies, task: any) => {
  const replacement = task?.replacement
  if (!replacement || !task?.username) return { updated: false, reason: 'not_a_replacement' }
  const username = String(task.username)
  const previousTrack = toIntegrationTrack(replacement.original || {})
  const completedItem = await findCompletedLocalTrack(username, task)
  if (!completedItem || completedItem.folder !== 'music' || !completedItem.filename) {
    console.warn('[PlaylistReplacement] completed local file could not be identified', { taskId: task?.id, username })
    return { updated: false, reason: 'completed_file_not_found' }
  }
  const nextTrack = cacheItemToIntegrationTrack(completedItem)
  const nextPath = normalizedTrackPath(nextTrack)
  const previousPath = normalizedTrackPath(previousTrack)
  if (!nextPath || (previousPath && nextPath === previousPath)) {
    console.warn('[PlaylistReplacement] replacement resolved to the original file', { taskId: task?.id, previousPath, nextPath })
    return { updated: false, reason: 'same_file' }
  }

  const importStore = deps.getPlaylistImportStore?.(username)
  importStore?.load()
  const importRecord = replacement.importId ? importStore?.get(String(replacement.importId)) : undefined
  let playlistUpdated = false
  if (importRecord && Number.isInteger(Number(replacement.index))) {
    playlistUpdated = await replaceConfirmedPlaylistTrack(
      deps,
      username,
      importRecord,
      Number(replacement.index),
      nextTrack,
      previousTrack,
    )
  } else if (replacement.playlistId) {
    const playlist = await getPlaylist(username, String(replacement.playlistId))
    const oldIndex = playlist.list.findIndex((item: any) => normalizedTrackPath(toIntegrationTrack(deps.normalizeSongInfo(item))) === previousPath)
    if (oldIndex >= 0) {
      const nextList = [...playlist.list]
      nextList[oldIndex] = buildLocalSongInfo(nextTrack)
      const manage = getUserSpace(username).listManage
      await manage.listDataManage.listMusicOverwrite(String(replacement.playlistId), nextList as any)
      await manage.createSnapshot()
      playlistUpdated = true
    }
  }
  if (!playlistUpdated) return { updated: false, reason: 'playlist_row_not_found' }

  // The new playlist row is durable before deleting the old file.  This keeps
  // a failed playlist write from causing data loss.
  const previousItem: any = (await fileCache.getDownloadedMusicItemsAcrossLocations(username)).find(item => (
    item.filename && normalizedTrackPath({ relativePath: item.filename }) === previousPath &&
    item.folder === 'music'
  ))
  if (previousItem && previousItem.filename !== completedItem.filename) {
    try {
      fileCache.removeCacheFile(previousItem.filename, username, 'music', previousItem.storageLocation)
    } catch (error: any) {
      console.warn('[PlaylistReplacement] old file removal failed:', error?.message || error)
    }
  }

  let songloft: any = null
  try {
    const playlist = await getPlaylist(username, String(replacement.playlistId || importRecord?.yinyunPlaylistId || ''))
    songloft = await syncSongloftReplacement(deps, username, String(replacement.playlistId || importRecord?.yinyunPlaylistId || ''), playlist.name, previousTrack, nextTrack)
  } catch (error: any) {
    songloft = { updated: false, reason: error?.message || 'songloft_sync_failed' }
    console.warn('[PlaylistReplacement] Songloft playlist update failed:', error?.message || error)
  }
  return { updated: true, playlistUpdated: true, removedFile: previousItem?.filename || null, songloft }
}

const getImportSelection = (body: any, record: PlaylistImportRecord, matches: ReturnType<typeof matchTracks>) => {
  const mode = body.mode === 'all' ? 'all' : 'selected'
  const indexes = new Set((Array.isArray(body.indexes) ? body.indexes : []).map((value: any) => Number(value)).filter((value: number) => Number.isInteger(value) && value >= 0))
  const ids = new Set((Array.isArray(body.trackIds) ? body.trackIds : body.trackId !== undefined ? [body.trackId] : []).map((value: any) => String(value)))
  const overrides = body.selections && typeof body.selections === 'object' ? body.selections : {}
  return matches
    .map((match, index) => ({ match, index, track: record.tracks[index] }))
    .filter(({ match, index, track }) => {
      const override = overrides[String(index)] && typeof overrides[String(index)] === 'object' ? overrides[String(index)] : null
      const replacingLocal = Boolean(override?.replaceLocal)
      if (mode === 'all') return match.status === 'missing'
      if (!indexes.has(index) && !ids.has(String(track.id ?? track.sourceId ?? '')) && !ids.has(canonicalTrackId(track))) return false
      // A matched row can only enter a manual completion batch when the user
      // explicitly selected an online version as a replacement.
      return match.status !== 'matched' || replacingLocal
    })
}

const enqueuePlaylistImportDownloads = async (
  deps: ApiV1Dependencies,
  username: string,
  record: PlaylistImportRecord,
  matches: ReturnType<typeof matchTracks>,
  body: any,
) => {
  const selected = getImportSelection(body, record, matches)
  const quality = QUALITY_ORDER.includes(body.quality) ? body.quality : 'flac'
  const overrides = body.selections && typeof body.selections === 'object' ? body.selections : {}
  const skipped: Array<{ index: number; reason: string }> = []
  const buildInput = async ({ match, index, track }: { match: any; index: number; track: IntegrationTrack }) => {
    const override = overrides[String(index)] && typeof overrides[String(index)] === 'object' ? overrides[String(index)] : null
    const replacingLocal = Boolean(override?.replaceLocal && match.status === 'matched' && isLocalIntegrationTrack(match.candidate))
    // Manual completion may select a different online version.  Only accept a
    // compact public track object; raw/provider-private fields never become a
    // download source without passing through normalizeImportedSong.
    let selectedTrack = override ? toIntegrationTrack({
      id: override.id ?? override.sourceId,
      sourceId: override.sourceId ?? override.id,
      source: override.source,
      title: override.title || override.name,
      artist: override.artist || override.singer,
      album: override.album || override.albumName,
      duration: override.duration || override.interval,
      relativePath: override.relativePath,
    }) : track
    // 一键补齐固定走聚合结果。这样歌单原始来源暂时失效时仍可从其他
    // 已启用平台下载；手工补齐则保留用户在对话框中明确选择的版本。
    if (!override && body.mode === 'all') {
      try {
        const aggregate = await resolveAggregateTrack(deps, username, track)
        if (!aggregate) {
          skipped.push({ index, reason: 'aggregate_no_match' })
          return null
        }
        selectedTrack = aggregate
      } catch (error: any) {
        console.warn(`[AggregateDownload] index=${index} failed: ${error?.message || error}`)
        skipped.push({ index, reason: 'aggregate_search_failed' })
        return null
      }
    }
    const source = String(selectedTrack.source || record.source || '')
    if (isNonYinyunDownloadSource(source) || !deps.isSourceSupported(source, username)) {
      skipped.push({ index, reason: 'source_unavailable' })
      return null
    }
    try {
      const songInfo = normalizeImportedSong(deps, selectedTrack, record.source)
      return {
        id: `import_${record.importId}_${index}`,
        songInfo,
        quality,
        enableOnlyDownloadMode: true,
        cacheLyric: body.downloadLyrics !== false,
        embedLyric: body.embedLyrics !== false,
        playlistName: record.name,
        playlistId: record.yinyunPlaylistId,
        playlistImportId: record.importId,
        replacement: replacingLocal ? {
          importId: record.importId,
          playlistId: record.yinyunPlaylistId,
          index,
          original: publicIntegrationTrack(match.candidate),
        } : undefined,
        queuedAt: new Date().toISOString(),
      }
    } catch {
      skipped.push({ index, reason: 'invalid_song' })
      return null
    }
  }
  const inputs: any[] = []
  // 每批最多并行 4 首；每首内部再并行访问启用音源，避免一键补齐
  // 对单个平台造成突发请求。
  for (let offset = 0; offset < selected.length; offset += 4) {
    const batch = await Promise.all(selected.slice(offset, offset + 4).map(buildInput))
    inputs.push(...batch.filter(Boolean))
  }
  const queued = serverDownloadQueue.enqueue(username, inputs)
  return { selected: selected.map(item => item.index), queued, skipped }
}

const asRemoteSongId = (track?: IntegrationTrack | null) => {
  const id = Number(track?.id ?? track?.sourceId)
  return Number.isFinite(id) && id > 0 ? id : null
}

const sourceView = (source: any, username: string) => {
  const supportedSources = Object.keys(source.sources || {})
  return {
    id: source.id,
    name: source.name,
    version: source.version,
    author: source.author,
    owner: source.owner,
    enabled: source.enabled !== false,
    shared: source.owner !== username,
    readOnly: source.owner !== username,
    supportedPlatforms: supportedSources,
    enabledPlatforms: getEnabledSourcePlatforms(username, source.owner, source.id, supportedSources),
  }
}

export const apiV1OpenApi = {
  openapi: '3.1.0',
  info: {
    title: '音云 API',
    version: '1.4.0',
    description: '音云原生客户端使用的稳定接口。旧网页接口与 Subsonic 接口不属于本契约。',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Yinyun token' },
    },
  },
  paths: {
    '/api/v1/capabilities': { get: { security: [], summary: '查询服务器能力' } },
    '/api/v1/auth/login': { post: { security: [], summary: '用户登录' } },
    '/api/v1/auth/refresh': { post: { security: [], summary: '刷新访问令牌' } },
    '/api/v1/auth/logout': { post: { summary: '注销当前令牌' } },
    '/api/v1/auth/me': { get: { summary: '查询当前用户' } },
    '/api/v1/sync/snapshot': {
      get: { summary: '导出当前账户同步快照' },
      put: { summary: '将客户端同步快照恢复到当前账户' },
    },
    '/api/v1/library/tracks': { get: { summary: '查询本地曲库' } },
    '/api/v1/library/tracks/{id}/stream': { get: { summary: 'Range 流式播放本地歌曲' } },
    '/api/v1/library/tracks/{id}/cover': { get: { summary: '读取本地歌曲封面' } },
    '/api/v1/search': { get: { summary: '搜索在线曲库' } },
    '/api/v1/leaderboards': { get: { summary: '查询排行榜列表' } },
    '/api/v1/leaderboards/{id}/tracks': { get: { summary: '查询排行榜歌曲' } },
    '/api/v1/library/artists': { get: { summary: '查询收藏歌手' }, put: { summary: '覆盖收藏歌手' } },
    '/api/v1/library/albums': { get: { summary: '查询收藏专辑' }, put: { summary: '覆盖收藏专辑' } },
    '/api/v1/artists/{id}': { get: { summary: '查询歌手、全部歌曲及专辑' } },
    '/api/v1/albums/{id}': { get: { summary: '查询专辑及全部歌曲' } },
    '/api/v1/tracks/resolve': { post: { summary: '解析在线歌曲播放地址' } },
    '/api/v1/tracks/qualities': { get: { summary: '查询支持的音质标识' } },
    '/api/v1/lyrics': { post: { summary: '读取歌词' } },
    '/api/v1/playlists': { get: { summary: '查询歌单' }, post: { summary: '创建歌单' } },
    '/api/v1/integration/songloft/status': { get: { summary: '查询 Songloft 集成状态' } },
    '/api/v1/integration/songloft/playlists': { get: { summary: '查询 Songloft 歌单' } },
    '/api/v1/integration/songloft/scan': { get: { summary: '查询 Songloft 扫描进度' }, post: { summary: '触发 Songloft 曲库扫描' } },
    '/api/v1/integration/library/status': { get: { summary: '查询音云与 Songloft 当前曲库索引数量' } },
    '/api/v1/integration/library/refresh/yinyun': { post: { summary: '只刷新音云曲库索引' } },
    '/api/v1/integration/library/refresh/songloft': { post: { summary: '只触发 Songloft 曲库扫描' } },
    '/api/v1/integration/library/refresh': { post: { summary: '刷新音云与 Songloft 两端曲库索引' } },
    '/api/v1/integration/match': { post: { summary: '将歌曲与音云、Songloft 本地曲库匹配' } },
    '/api/v1/integration/playlist/resolve': { post: { summary: '解析网络歌单为统一歌曲列表' } },
    '/api/v1/integration/playlist/import': { post: { summary: '导入第三方网络歌单并标记本地缺失歌曲' } },
    '/api/v1/integration/playlist/imports': { get: { summary: '查询当前用户现有音云导入歌单' } },
    '/api/v1/integration/playlist/import/{importId}': { get: { summary: '查询已导入歌单的本地匹配状态' } },
    '/api/v1/integration/playlist/resolve-item': { post: { summary: '确认一首歌使用音云或 Songloft 候选' } },
    '/api/v1/integration/playlist/complete': { post: { summary: '手工或一键补齐导入歌单的缺失歌曲' } },
    '/api/v1/integration/playlists/sync': { post: { summary: '双向同步音云与 Songloft 歌单' } },
    '/api/v1/integration/playlists/sync/{yinyunPlaylistId}': { delete: { summary: '删除音云歌单对应的 Songloft 映射歌单' } },
    '/api/v1/integration/songloft/playlists/{playlistId}': { delete: { summary: '删除指定 Songloft 歌单' } },
    '/api/v1/health/settings': { get: { summary: '查询曲源健康检查设置' }, put: { summary: '更新曲源健康检查设置' } },
    '/api/v1/health/status': { get: { summary: '查询最近一次曲源健康检查' } },
    '/api/v1/health/test': { post: { summary: '立即测试导入音源解析能力' } },
    '/api/v1/health/notify-test': { post: { summary: '测试健康检查告警推送' } },
    '/api/v1/downloads': { get: { summary: '查询服务端下载队列' }, post: { summary: '加入服务端下载队列' } },
    '/api/v1/replacement': { get: { summary: '查询洗版任务' }, post: { summary: '启动洗版任务' } },
    '/api/v1/sources': { get: { summary: '查询可用音源及平台开关' } },
    '/api/v1/shares/inbox': { get: { summary: '查询待处理歌单分享' } },
    '/api/v1/events': { get: { summary: '订阅下载、洗版和分享状态事件' } },
  },
}

export const createApiV1Handler = (deps: ApiV1Dependencies) => async (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> => {
  const pathname = url.pathname
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return false
  startHealthScheduler(deps)

  try {
    if ((pathname === API_PREFIX || pathname === `${API_PREFIX}/capabilities`) && req.method === 'GET') {
      success(res, {
        product: 'yinyun',
        serverVersion: deps.serverVersion,
        apiVersion: '1.4.0',
        playerPath: '/',
        features: {
          localLibrary: true,
          onlineSearch: true,
          rangeStreaming: true,
          lyrics: true,
          playlists: true,
          favoriteArtists: true,
          favoriteAlbums: true,
          artistAlbumDetails: true,
          leaderboards: true,
          serverDownloads: true,
          replacement: true,
          healthChecks: true,
          customSources: true,
          playlistSharing: true,
          playlistImport: {
            resolve: true,
            localMatch: true,
            manualDownload: true,
            oneClickDownload: true,
          },
          accountSync: {
            schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
            maxSnapshotBytes: ACCOUNT_SYNC_MAX_BYTES,
            restore: true,
          },
          events: 'sse',
          subsonic: global.lx.config['subsonic.enable'] === true,
        },
        supportedQualities: QUALITY_ORDER,
      })
      return true
    }

    if (pathname === `${API_PREFIX}/openapi.json` && req.method === 'GET') {
      json(res, 200, apiV1OpenApi, { 'Cache-Control': 'public, max-age=300' })
      return true
    }

    if (pathname === `${API_PREFIX}/auth/login` && req.method === 'POST') {
      const body = await readJson(req)
      const username = tryNormalizeUsername(body.username)
      const user = username && deps.getUsers().find(item => item.name === username && item.password === body.password)
      if (!user) throw new ApiError(401, 'invalid_credentials', '用户名或密码错误')
      success(res, issueSession(user.name, deps.getAuthSecret()))
      return true
    }

    if (pathname === `${API_PREFIX}/auth/refresh` && req.method === 'POST') {
      const body = await readJson(req)
      const payload = verifyApiToken(body.refreshToken, deps.getAuthSecret(), 'refresh')
      const username = payload ? tryNormalizeUsername(payload.sub) : null
      if (!username || !deps.getUsers().some(item => item.name === username)) {
        throw new ApiError(401, 'invalid_refresh_token', '刷新令牌无效或已过期')
      }
      revokedTokens.set(body.refreshToken, payload!.exp * 1000)
      success(res, issueSession(username, deps.getAuthSecret()))
      return true
    }

    if (pathname === `${API_PREFIX}/auth/logout` && req.method === 'POST') {
      const token = getBearerToken(req)
      const payload = token ? verifyApiToken(token, deps.getAuthSecret(), 'access') : null
      if (token && payload) revokedTokens.set(token, payload.exp * 1000)
      success(res, { loggedOut: true })
      return true
    }

    const username = requireUser(req, deps, url)

    if (pathname === `${API_PREFIX}/health/settings` && req.method === 'GET') {
      const state = readHealthState(username)
      success(res, publicHealthSettings(state.settings))
      return true
    }

    if (pathname === `${API_PREFIX}/health/settings` && req.method === 'PUT') {
      const body = await readJson(req)
      const current = readHealthState(username)
      const next: HealthSettings = {
        ...current.settings,
        enabled: body.enabled === undefined ? current.settings.enabled : Boolean(body.enabled),
        intervalMinutes: Math.min(7 * 24 * 60, Math.max(15, Number(body.intervalMinutes) || current.settings.intervalMinutes)),
        cronExpression: String(body.cronExpression ?? current.settings.cronExpression).trim().slice(0, 100),
        testKeyword: String(body.testKeyword ?? current.settings.testKeyword).trim().slice(0, 100),
        consecutiveFailureThreshold: Math.min(20, Math.max(1, Number(body.consecutiveFailureThreshold) || current.settings.consecutiveFailureThreshold)),
        notify: body.notify === undefined ? current.settings.notify : Boolean(body.notify),
        messagePusherEnabled: body.messagePusherEnabled === undefined ? current.settings.messagePusherEnabled : Boolean(body.messagePusherEnabled),
        messagePusherUrl: String(body.messagePusherUrl ?? current.settings.messagePusherUrl).trim().slice(0, 1000),
        messagePusherToken: body.messagePusherToken === undefined
          ? current.settings.messagePusherToken
          : String(body.messagePusherToken || '').trim().slice(0, 1000),
        messagePusherChannel: String(body.messagePusherChannel ?? current.settings.messagePusherChannel).trim().slice(0, 200),
        barkEnabled: body.barkEnabled === undefined ? current.settings.barkEnabled : Boolean(body.barkEnabled),
        barkServerUrl: String(body.barkServerUrl ?? current.settings.barkServerUrl).trim().replace(/\/+$/, '').slice(0, 500),
        barkDeviceKey: body.barkDeviceKey === undefined
          ? current.settings.barkDeviceKey
          : String(body.barkDeviceKey || '').trim().slice(0, 500),
        serverChanEnabled: body.serverChanEnabled === undefined ? current.settings.serverChanEnabled : Boolean(body.serverChanEnabled),
        serverChanSendKey: body.serverChanSendKey === undefined
          ? current.settings.serverChanSendKey
          : String(body.serverChanSendKey || '').trim().slice(0, 500),
      }
      current.settings = next
      writeHealthState(username, current)
      success(res, publicHealthSettings(next))
      return true
    }

    if (pathname === `${API_PREFIX}/health/status` && req.method === 'GET') {
      const state = readHealthState(username)
      success(res, { settings: publicHealthSettings(state.settings), report: state.report })
      return true
    }

    if (pathname === `${API_PREFIX}/health/test` && req.method === 'POST') {
      success(res, await runHealthCheck(deps, username))
      return true
    }

    if (pathname === `${API_PREFIX}/health/notify-test` && req.method === 'POST') {
      const state = readHealthState(username)
      const report: HealthReport = {
        checkedAt: new Date().toISOString(),
        ok: false,
        playlists: 0,
        tracksChecked: 1,
        healthyTracks: 0,
        warningTracks: 0,
        keyword: String(state.settings.testKeyword || '').trim() || undefined,
        checks: [{
          source: 'message-pusher',
          platform: '推送',
          status: 'error',
          message: '这是一次手动推送测试，不代表真实音源故障。',
        }],
        failures: [{
          playlist: '推送测试',
          source: 'message-pusher',
          platform: '推送',
          status: 'error',
          index: 0,
          title: '曲源健康检查推送测试',
          artist: username,
          message: '这是一次手动推送测试，不代表真实音源故障。',
        }],
      }
      await postHealthNotification(state.settings, report, true)
      success(res, { sent: Boolean(
        (state.settings.messagePusherEnabled && state.settings.messagePusherUrl)
        || (state.settings.barkEnabled && state.settings.barkDeviceKey)
        || (state.settings.serverChanEnabled && state.settings.serverChanSendKey),
      ) })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/songloft/status` && req.method === 'GET') {
      const client = deps.getSongloftClient?.() || null
      const configured = Boolean(client?.configured)
      let available = false
      let errorCode: string | null = null
      if (configured) {
        try {
          available = await client!.health()
          if (!available) errorCode = 'unhealthy'
        } catch (error: any) {
          errorCode = error?.name === 'AbortError' ? 'timeout' : 'unreachable'
        }
      } else {
        errorCode = 'not_configured'
      }
      const subsonic = deps.getSongloftSubsonicClient?.() || null
      let subsonicAvailable = false
      if (subsonic) {
        try { subsonicAvailable = await subsonic.ping() } catch { subsonicAvailable = false }
      }
      success(res, {
        configured,
        available,
        errorCode,
        subsonicConfigured: Boolean(subsonic),
        subsonicAvailable,
      })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/songloft/playlists` && req.method === 'GET') {
      success(res, await readSongloftPlaylists(deps))
      return true
    }

    const songloftPlaylistDeleteMatch = pathname.match(/^\/api\/v1\/integration\/songloft\/playlists\/([^/]+)$/)
    if (songloftPlaylistDeleteMatch && req.method === 'DELETE') {
      const playlistId = Number(decodeURIComponent(songloftPlaylistDeleteMatch[1]))
      if (!Number.isInteger(playlistId) || playlistId <= 0) throw new ApiError(400, 'invalid_songloft_playlist', 'Songloft 歌单 ID 无效')
      const client = requireSongloftClient(deps)
      const playlists = await client.listPlaylists()
      const playlist = playlists.find(item => Number(item.id) === playlistId)
      if (!playlist) throw new ApiError(404, 'songloft_playlist_not_found', 'Songloft 歌单不存在')
      if (playlist.type === 'radio' || playlistId <= 2 || (Array.isArray((playlist as any).labels) && (playlist as any).labels.includes('built_in'))) {
        throw new ApiError(400, 'songloft_playlist_readonly', 'Songloft 系统歌单不能删除')
      }
      await client.deletePlaylist(playlistId)
      success(res, { deleted: true, playlistId })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/songloft/scan` && req.method === 'GET') {
      const client = requireSongloftClient(deps)
      success(res, await client.scanProgress())
      return true
    }

    if (pathname === `${API_PREFIX}/integration/songloft/scan` && req.method === 'POST') {
      requireIntegrationAdmin(req, deps)
      const client = requireSongloftClient(deps)
      const body = await readJson(req)
      invalidateSongloftMatchingCache()
      success(res, await client.startScan(body.reimport === true), 202)
      return true
    }

    if (pathname === `${API_PREFIX}/integration/library/status` && req.method === 'GET') {
      success(res, await getLibraryIndexStatus(deps, username))
      return true
    }

    if (pathname === `${API_PREFIX}/integration/library/refresh/yinyun` && req.method === 'POST') {
      const yinyun = await refreshYinyunLibraryIndex(username)
      invalidateSongloftMatchingCache()
      success(res, { yinyun, message: '音云曲库索引已刷新；Songloft 索引未触发' }, 202)
      return true
    }

    if (pathname === `${API_PREFIX}/integration/library/refresh/songloft` && req.method === 'POST') {
      const client = requireSongloftClient(deps)
      const body = await readJson(req)
      invalidateSongloftMatchingCache()
      success(res, { songloft: await client.startScan(body.reimport === true), message: 'Songloft 曲库扫描已提交；音云索引未触发' }, 202)
      return true
    }

    if (pathname === `${API_PREFIX}/integration/library/refresh` && req.method === 'POST') {
      const client = requireSongloftClient(deps)
      const body = await readJson(req)
      const yinyun = await refreshYinyunLibraryIndex(username)
      invalidateSongloftMatchingCache()
      const songloft = await client.startScan(body.reimport === true)
      success(res, { yinyun, songloft, message: '音云索引已刷新，Songloft 扫描已提交；请等待扫描完成后再匹配' }, 202)
      return true
    }

    if (pathname === `${API_PREFIX}/integration/playlist/resolve` && req.method === 'POST') {
      const body = await readJson(req)
      const ref = parseExternalPlaylistRef(body)
      const source = ref.source
      const id = ref.id
      const page = parsePositiveInt(String(body.page || '1'), 1, 10000)
      if (!source || !id) throw new ApiError(400, 'playlist_source_and_id_required', '缺少网络歌单来源或 ID（也可提供歌单分享 URL）')
      success(res, { ...(await getExternalPlaylist(deps, username, source, id, page)), url: ref.url || null })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/playlist/import` && req.method === 'POST') {
      const body = await readJson(req)
      const ref = parseExternalPlaylistRef(body)
      let source = ref.source
      let sourcePlaylistId = ref.id || undefined
      let sourcePlaylistName = ''
      let sourceTracks: IntegrationTrack[] = []

      if (source && sourcePlaylistId) {
        const resolved = await getExternalPlaylist(deps, username, source, sourcePlaylistId, parsePositiveInt(String(body.page || '1'), 1, 10000))
        sourcePlaylistName = resolved.name
        sourceTracks = resolved.tracks
      } else if (Array.isArray(body.tracks)) {
        if (!source) source = String(body.fallbackSource || '').trim()
        if (!source) throw new ApiError(400, 'playlist_source_required', '直接导入歌曲时必须提供 source')
        sourceTracks = body.tracks.map((item: any) => {
          const raw = item?.raw && typeof item.raw === 'object' ? { ...item.raw } : { ...(item || {}) }
          const normalized = deps.normalizeSongInfo({
            ...raw,
            source: raw.source || item?.source || source,
            name: raw.name || item?.title,
            singer: raw.singer || item?.artist,
            albumName: raw.albumName || item?.album || '',
            interval: raw.interval || item?.duration || '',
          })
          return toIntegrationTrack(normalized)
        }).filter((track: IntegrationTrack) => track.title || track.artist)
        sourcePlaylistName = String(body.name || '').trim()
      } else {
        throw new ApiError(400, 'playlist_source_or_tracks_required', '请提供网络歌单来源与 ID，或直接提供歌曲列表')
      }
      if (!sourceTracks.length) throw new ApiError(400, 'playlist_empty', '网络歌单没有可导入的歌曲')
      if (sourceTracks.length > 10000) throw new ApiError(413, 'tracks_too_large', '歌曲数量超过限制')
      if (!source) source = String(sourceTracks[0]?.source || '').trim()
      if (!source) throw new ApiError(400, 'playlist_source_required', '导入歌单缺少音源')

      const store = deps.getPlaylistImportStore?.(username)
      if (!store) throw new ApiError(503, 'playlist_import_store_unavailable', '导入歌单存储尚未配置')
      store.load()
      const existing = body.reuseExisting !== false ? findExistingPlaylistImport(store, source, sourcePlaylistId) : undefined

      let localMatches: PlaylistImportMatch[]
      try {
        localMatches = await getPlaylistMatches(deps, username, sourceTracks)
      } catch (error: any) {
        // A temporary Songloft outage must not prevent importing the source
        // playlist; the next open/refresh can retry shared-library matching.
        console.warn('[PlaylistImport] Songloft matching unavailable:', error?.message || error)
        const fallback = matchTracks(sourceTracks, await getUserLocalIntegrationTracks(username), SHARED_LIBRARY_MATCH_OPTIONS)
        localMatches = fallback.map(match => ({ ...match, matchedBy: match.status === 'matched' ? 'yinyun' : undefined }))
      }
      const name = String(body.name || sourcePlaylistName || `导入歌单 ${new Date().toLocaleDateString('zh-CN')}`).trim().slice(0, 100)
      if (!name) throw new ApiError(400, 'invalid_playlist_name', '导入歌单名称不能为空')
      const manage = getUserSpace(username).listManage
      let yinyunPlaylistId = String(body.yinyunPlaylistId || existing?.yinyunPlaylistId || '').trim()
      let created = false
      if (yinyunPlaylistId) {
        await getPlaylist(username, yinyunPlaylistId)
      } else {
        yinyunPlaylistId = `mobile_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
        await manage.listDataManage.userListCreate({ id: yinyunPlaylistId, name, position: -1, locationUpdateTime: Date.now() })
        created = true
      }

      const playlistSongs = dedupeSongs(sourceTracks.map((track, index) => {
        const match = localMatches[index]
        return match.status === 'matched' && match.candidate
          ? buildLocalSongInfo(match.candidate)
          : normalizeImportedSong(deps, track, source)
      }))
      // Reusing the same source playlist is an update of that imported list,
      // not another append operation. This removes stale rows from older
      // imports while preserving the stable Yinyun playlist identity.
      const replace = created || body.replace === true || Boolean(existing && !body.createNew)
      if (replace) await manage.listDataManage.listMusicOverwrite(yinyunPlaylistId, playlistSongs as any)
      else await manage.listDataManage.listMusicAdd(yinyunPlaylistId, playlistSongs as any, 'bottom')
      await manage.createSnapshot()

      const importId = existing && !body.createNew ? existing.importId : `import_${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const record: PlaylistImportRecord = {
        importId,
        username,
        source,
        sourcePlaylistId,
        sourcePlaylistName: sourcePlaylistName || undefined,
        name,
        yinyunPlaylistId,
        tracks: sourceTracks,
        createdAt: existing && !body.createNew ? existing.createdAt : now,
        updatedAt: now,
      }
      await store.upsert(record)

      let download: Awaited<ReturnType<typeof enqueuePlaylistImportDownloads>> | null = null
      if (body.autoDownload === true) {
        download = await enqueuePlaylistImportDownloads(deps, username, record, localMatches, { ...body, mode: 'all' })
      }
      success(res, {
        importId,
        yinyunPlaylistId,
        name,
        created,
        reused: Boolean(existing && !body.createNew),
        items: localMatches.map((match, index) => publicImportItem(match, index, deps, username, source)),
        counts: playlistImportCounts(localMatches),
        download,
      }, 201)
      return true
    }

    if (pathname === `${API_PREFIX}/integration/playlist/imports` && req.method === 'GET') {
      const store = deps.getPlaylistImportStore?.(username)
      if (!store) throw new ApiError(503, 'playlist_import_store_unavailable', '导入歌单存储尚未配置')
      const playlistData = await getUserSpace(username).listManage.getListData()
      const playlists = [
        { id: 'default', name: '试听列表', trackCount: playlistData.defaultList.length },
        { id: 'love', name: '我的收藏', trackCount: playlistData.loveList.length },
        ...playlistData.userList.map(item => ({ id: item.id, name: item.name, trackCount: item.list.length })),
      ]
      const playlistIds = new Set(playlists.map(item => String(item.id)))
      const records = store.load()
        .filter(record => playlistIds.has(String(record.yinyunPlaylistId)))
        .map(publicPlaylistImportRecord)
      success(res, { records, playlists })
      return true
    }

    const importStatusMatch = pathname.match(/^\/api\/v1\/integration\/playlist\/import\/([^/]+)$/)
    if (importStatusMatch && req.method === 'GET') {
      const importId = decodeURIComponent(importStatusMatch[1])
      const store = deps.getPlaylistImportStore?.(username)
      if (!store) throw new ApiError(503, 'playlist_import_store_unavailable', '导入歌单存储尚未配置')
      store.load()
      const record = store.get(importId)
      if (!record || record.username !== username) throw new ApiError(404, 'playlist_import_not_found', '导入歌单记录不存在')
      const matches = await getPlaylistImportMatches(deps, username, record)
      success(res, {
        importId,
        yinyunPlaylistId: record.yinyunPlaylistId,
        name: record.name,
        source: record.source,
        sourcePlaylistId: record.sourcePlaylistId || null,
        items: matches.map((match, index) => publicImportItem(match, index, deps, username, record.source)),
        counts: playlistImportCounts(matches),
      })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/playlist/resolve-item` && req.method === 'POST') {
      const body = await readJson(req)
      const importId = String(body.importId || '').trim()
      const index = Number(body.index)
      const provider: 'yinyun' | 'songloft' | 'local' | '' = body.provider === 'songloft'
        ? 'songloft'
        : body.provider === 'local'
          ? 'local'
          : body.provider === 'yinyun' ? 'yinyun' : ''
      if (!importId || !Number.isInteger(index) || index < 0 || !provider) {
        throw new ApiError(400, 'invalid_playlist_resolution', '需要导入记录 ID、歌曲序号和候选来源（local、yinyun 或 songloft）')
      }
      const store = deps.getPlaylistImportStore?.(username)
      if (!store) throw new ApiError(503, 'playlist_import_store_unavailable', '导入歌单存储尚未配置')
      store.load()
      const record = store.get(importId)
      if (!record || record.username !== username) throw new ApiError(404, 'playlist_import_not_found', '导入歌单记录不存在')
      if (!record.tracks[index]) throw new ApiError(404, 'playlist_track_not_found', '导入记录中不存在该歌曲序号')
      const rawMatches = await getPlaylistMatches(deps, username, record.tracks)
      const selected = provider === 'local' ? rawMatches[index]?.local : rawMatches[index]?.[provider]
      if (!selected?.candidate || !['matched', 'ambiguous'].includes(selected.status)) {
        throw new ApiError(409, 'playlist_candidate_unavailable', '所选来源当前没有可确认的本地候选，请先刷新两个曲库索引')
      }
      const resolutions = { ...(record.resolutions || {}), [String(index)]: provider }
      const resolvedCandidates = {
        ...(record.resolvedCandidates || {}),
        [String(index)]: toIntegrationTrack(selected.candidate),
      }
      const updatedRecord: PlaylistImportRecord = { ...record, resolutions, resolvedCandidates, updatedAt: new Date().toISOString() }
      await store.upsert(updatedRecord)
      const playlistUpdated = await replaceConfirmedPlaylistTrack(deps, username, updatedRecord, index, selected.candidate)
      const matches = await getPlaylistImportMatches(deps, username, updatedRecord)
      success(res, {
        importId,
        index,
        provider,
        playlistUpdated,
        item: publicImportItem(matches[index], index, deps, username, record.source),
        items: matches.map((match, itemIndex) => publicImportItem(match, itemIndex, deps, username, record.source)),
        counts: playlistImportCounts(matches),
      })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/playlist/complete` && req.method === 'POST') {
      const body = await readJson(req)
      const importId = String(body.importId || '').trim()
      if (!importId) throw new ApiError(400, 'import_id_required', '缺少导入歌单 ID')
      const store = deps.getPlaylistImportStore?.(username)
      if (!store) throw new ApiError(503, 'playlist_import_store_unavailable', '导入歌单存储尚未配置')
      store.load()
      const record = store.get(importId)
      if (!record || record.username !== username) throw new ApiError(404, 'playlist_import_not_found', '导入歌单记录不存在')
      const matches = await getPlaylistImportMatches(deps, username, record)
      const download = await enqueuePlaylistImportDownloads(deps, username, record, matches, {
        ...body,
        mode: body.all === true ? 'all' : body.mode,
      })
      success(res, {
        importId,
        yinyunPlaylistId: record.yinyunPlaylistId,
        mode: body.all === true ? 'all' : body.mode === 'all' ? 'all' : 'selected',
        items: matches.map((match, index) => publicImportItem(match, index, deps, username, record.source)),
        counts: playlistImportCounts(matches),
        download,
      }, 202)
      return true
    }

    if (pathname === `${API_PREFIX}/integration/match` && req.method === 'POST') {
      const body = await readJson(req)
      let sourceTracks: IntegrationTrack[] = []
      if (Array.isArray(body.tracks)) {
        sourceTracks = body.tracks.map((item: any) => toIntegrationTrack(item)).filter((track: IntegrationTrack) => track.title || track.artist)
      } else if (body.yinyunPlaylistId) {
        const playlist = await getPlaylist(username, String(body.yinyunPlaylistId))
        sourceTracks = playlist.list.map((item: any) => toIntegrationTrack(deps.normalizeSongInfo(item)))
      } else if (body.source && (body.sourcePlaylistId ?? body.playlistId) !== undefined) {
        const playlist = await getExternalPlaylist(deps, username, String(body.source), String(body.sourcePlaylistId ?? body.playlistId), 1)
        sourceTracks = playlist.tracks
      }
      if (!sourceTracks.length) throw new ApiError(400, 'tracks_required', '请提供待匹配歌曲或歌单')
      if (sourceTracks.length > 10000) throw new ApiError(413, 'tracks_too_large', '歌曲数量超过限制')
      const hasSongloftSource = Boolean(deps.getSongloftClient?.()?.configured || deps.getSongloftSubsonicClient?.())
      if (!hasSongloftSource) throw new ApiError(503, 'songloft_not_configured', 'Songloft 原生或 Subsonic API 尚未配置')
      const localTracks = await getUserLocalIntegrationTracks(username)
      const localMatches = matchTracks(sourceTracks, localTracks, SHARED_LIBRARY_MATCH_OPTIONS)
      const songloftTracks = await getSongloftTracksForMatching(deps, sourceTracks)
      const songloftMatches = matchTracks(anchorSongloftSources(sourceTracks, localMatches), songloftTracks, SHARED_LIBRARY_MATCH_OPTIONS)
      const items = sourceTracks.map((track, index) => ({
        source: publicIntegrationTrack(track),
        yinyun: publicTrackMatch(localMatches[index]),
        songloft: publicTrackMatch(songloftMatches[index]),
        canonicalId: canonicalTrackId(track),
      }))
      success(res, {
        items,
        counts: {
          total: items.length,
          yinyunMatched: localMatches.filter(item => item.status === 'matched').length,
          songloftMatched: songloftMatches.filter(item => item.status === 'matched').length,
          yinyunAmbiguous: localMatches.filter(item => item.status === 'ambiguous').length,
          songloftAmbiguous: songloftMatches.filter(item => item.status === 'ambiguous').length,
          yinyunMissing: localMatches.filter(item => item.status === 'missing').length,
          songloftMissing: songloftMatches.filter(item => item.status === 'missing').length,
        },
      })
      return true
    }

    if (pathname === `${API_PREFIX}/integration/playlists/sync` && req.method === 'POST') {
      const isAdmin = Boolean(deps.isAdminRequest?.(req))
      const body = await readJson(req)
      const yinyunPlaylistId = String(body.yinyunPlaylistId || '').trim()
      if (!yinyunPlaylistId) throw new ApiError(400, 'yinyun_playlist_required', '缺少音云歌单 ID')
      const direction = body.direction || 'merge'
      const mode = body.mode || 'merge'
      if (!['push', 'pull', 'merge'].includes(direction)) throw new ApiError(400, 'invalid_sync_direction', '同步方向必须是 push、pull 或 merge')
      if (!['merge', 'replace'].includes(mode)) throw new ApiError(400, 'invalid_sync_mode', '同步模式必须是 merge 或 replace')
      if (mode === 'replace' && direction === 'pull') throw new ApiError(400, 'invalid_sync_mode', 'pull 方向不支持 replace 模式')
      if (!isAdmin && (direction !== 'push' || !['merge', 'replace'].includes(mode))) {
        throw new ApiError(403, 'playlist_sync_mode_forbidden', '播放器用户只能使用“音云 → Songloft”的推送同步')
      }
      const syncLockKey = `${username}:${yinyunPlaylistId}`
      if (activePlaylistSyncs.has(syncLockKey)) throw new ApiError(409, 'playlist_sync_in_progress', '该音云歌单正在同步，请等待当前任务完成')
      activePlaylistSyncs.add(syncLockKey)
      try {
      const client = requireSongloftClient(deps)
      const yinyunPlaylist = await getPlaylist(username, yinyunPlaylistId)
      const playlists = await client.listPlaylists()
      const store = deps.getPlaylistSyncStore?.(username)
      store?.load()
      const syncId = `${username}:${yinyunPlaylistId}`
      const previous = store?.get(syncId)
      let songloftPlaylist: any
      let playlistResolution: 'explicit' | 'mapped' | 'existing_name' | 'created' = 'existing_name'
      if (body.songloftPlaylistId !== undefined && body.songloftPlaylistId !== null && String(body.songloftPlaylistId).trim()) {
        const id = Number(body.songloftPlaylistId)
        if (!Number.isFinite(id) || id <= 0) throw new ApiError(400, 'invalid_songloft_playlist', 'Songloft 歌单 ID 无效')
        songloftPlaylist = playlists.find(item => Number(item.id) === id)
        if (!songloftPlaylist) throw new ApiError(404, 'songloft_playlist_not_found', 'Songloft 歌单不存在')
        playlistResolution = 'explicit'
      } else {
        const mapped = previous?.songloftPlaylistId
          ? playlists.find(item => Number(item.id) === Number(previous.songloftPlaylistId))
          : undefined
        if (mapped) {
          songloftPlaylist = mapped
          playlistResolution = 'mapped'
        }
        const sameName = playlists.filter(item => normalizePlaylistName(item.name) === normalizePlaylistName(yinyunPlaylist.name))
        if (!songloftPlaylist && sameName.length > 1) throw new ApiError(409, 'songloft_playlist_name_ambiguous', 'Songloft 中存在多个同名歌单，请明确选择目标歌单')
        if (!songloftPlaylist) songloftPlaylist = sameName[0]
        if (!songloftPlaylist) {
          songloftPlaylist = await client.createPlaylist(yinyunPlaylist.name)
          if (!songloftPlaylist?.id) throw new ApiError(502, 'songloft_playlist_create_failed', 'Songloft 歌单创建未返回 ID')
          playlistResolution = 'created'
        } else if (playlistResolution !== 'mapped') {
          playlistResolution = 'existing_name'
        }
      }

      const remotePlaylistId = Number(songloftPlaylist.id)
      if (!Number.isFinite(remotePlaylistId) || remotePlaylistId <= 0) throw new ApiError(502, 'invalid_songloft_playlist', 'Songloft 歌单 ID 无效')
      if (['mapped', 'explicit'].includes(playlistResolution) && normalizePlaylistName(songloftPlaylist.name) !== normalizePlaylistName(yinyunPlaylist.name)) {
        try {
          await client.renamePlaylist(remotePlaylistId, yinyunPlaylist.name)
          songloftPlaylist.name = yinyunPlaylist.name
        } catch (error: any) {
          console.warn('[PlaylistSync] Songloft 歌单重命名失败，保留映射:', error?.message || error)
        }
      }
      const initialLocalTracks = yinyunPlaylist.list.map((item: any) => toIntegrationTrack(deps.normalizeSongInfo(item)))
      let remotePlaylistTracks = await client.getPlaylistSongs(remotePlaylistId)
      const initialRemoteIds = remotePlaylistTracks.map(canonicalTrackId)
      const initialLocalIds = initialLocalTracks.map(canonicalTrackId)
      const initialMerge = mergePlaylistIds(previous?.lastCommonIds || [], initialLocalIds, initialRemoteIds)
      const result: any = { direction, mode, yinyunPlaylistId, songloftPlaylistId: remotePlaylistId, playlistResolution, push: null, pull: null }

      const push = async () => {
        const library = await client.listAllSongs()
        // Songloft may index the same shared file through an older organized path
        // and the new flat download path. For playlist writes either exact
        // title/artist entity is valid, so duplicate identities are deterministic
        // instead of blocking the whole playlist as ambiguous.
        const currentIds = Array.from(new Set(remotePlaylistTracks.map(track => asRemoteSongId(track)).filter((id): id is number => id !== null)))
        const currentIdSet = new Set(currentIds.map(String))
        const matches = matchTracks(initialLocalTracks, library, SHARED_LIBRARY_MATCH_OPTIONS)
          .map(match => preferExistingPlaylistCandidate(match, currentIdSet))
        const unmatched = matches.filter(item => item.status !== 'matched')
        const desiredIds = Array.from(new Set(matches
          .filter(item => item.status === 'matched' && item.candidate)
          .map(item => asRemoteSongId(item.candidate!))
          .filter((id): id is number => id !== null)))
        if (mode === 'replace' && unmatched.length) {
          throw new ApiError(
            409,
            'playlist_replace_unmatched',
            `有 ${unmatched.length} 首歌曲未能可靠匹配，已取消覆盖同步以保护 Songloft 原歌单`,
            { unmatched: unmatched.map(publicTrackMatch) },
          )
        }
        const desiredSet = new Set(desiredIds)
        const removedIds = mode === 'replace' ? currentIds.filter(id => !desiredSet.has(id)) : []
        const addedIds = desiredIds.filter(id => !currentIds.includes(id))
        // Add first. If Songloft or the network fails halfway through, the
        // remote playlist remains a safe superset instead of losing entries.
        if (addedIds.length) await client.addPlaylistSongs(remotePlaylistId, addedIds)
        for (const id of removedIds) await client.removePlaylistSong(remotePlaylistId, id)
        if (mode === 'replace' && desiredIds.length) await client.reorderPlaylist(remotePlaylistId, desiredIds)
        remotePlaylistTracks = await client.getPlaylistSongs(remotePlaylistId)
        return {
          matches: matches.map(publicTrackMatch),
          addedIds,
          removedIds,
          reordered: mode === 'replace' && desiredIds.length > 0,
          unmatched: unmatched.map(publicTrackMatch),
        }
      }

      const pull = async () => {
        const localLibrary = await getUserLocalIntegrationTracks(username)
        const matches = matchTracks(remotePlaylistTracks, localLibrary, SHARED_LIBRARY_MATCH_OPTIONS)
        const existingIds = new Set((await getPlaylist(username, yinyunPlaylistId)).list.map((item: any) => canonicalTrackId(toIntegrationTrack(deps.normalizeSongInfo(item)))))
        const toAdd: any[] = []
        for (const match of matches) {
          if (match.status !== 'matched' || !match.candidate) continue
          const id = canonicalTrackId(match.candidate)
          if (existingIds.has(id)) continue
          existingIds.add(id)
          toAdd.push(buildLocalSongInfo(match.candidate))
        }
        if (toAdd.length) {
          const manage = getUserSpace(username).listManage
          await manage.listDataManage.listMusicAdd(yinyunPlaylistId, toAdd as any, 'bottom')
          await manage.createSnapshot()
        }
        return {
          matches: matches.map(publicTrackMatch),
          added: toAdd.length,
          unmatched: matches.filter(item => item.status !== 'matched').map(publicTrackMatch),
        }
      }

      if (direction === 'push' || direction === 'merge') result.push = await push()
      if (direction === 'pull' || direction === 'merge') {
        // A merge observes the remote list after the push so remote-only local
        // files can flow back into the yinyun playlist in the same operation.
        remotePlaylistTracks = await client.getPlaylistSongs(remotePlaylistId)
        result.pull = await pull()
      }

      const finalYinyunPlaylist = await getPlaylist(username, yinyunPlaylistId)
      const finalLocalTracks = finalYinyunPlaylist.list.map((item: any) => toIntegrationTrack(deps.normalizeSongInfo(item)))
      remotePlaylistTracks = await client.getPlaylistSongs(remotePlaylistId)
      const finalLocalIds = finalLocalTracks.map(canonicalTrackId)
      const finalRemoteIds = remotePlaylistTracks.map(canonicalTrackId)
      const finalMerge = mergePlaylistIds(previous?.lastCommonIds || [], finalLocalIds, finalRemoteIds)
      if (store) {
        const record: PlaylistSyncRecord = {
          syncId,
          username,
          name: yinyunPlaylist.name,
          yinyunPlaylistId,
          songloftPlaylistId: remotePlaylistId,
          enabled: true,
          lastCommonIds: finalMerge.ids,
          lastYinyunHash: PlaylistSyncStore.hashIds(finalLocalIds),
          lastSongloftHash: PlaylistSyncStore.hashIds(finalRemoteIds),
          updatedAt: new Date().toISOString(),
        }
        await store.upsert(record)
        result.record = record
      }
      // An authoritative replace intentionally resolves previous divergence.
      // Keeping its pre-write warning makes a successful idempotent sync look
      // conflicted in the management UI.
      result.conflicts = playlistSyncConflicts(direction, mode, initialMerge.conflicts, finalMerge.conflicts)
      result.counts = {
        yinyunTracks: finalLocalTracks.length,
        songloftTracks: remotePlaylistTracks.length,
      }
      success(res, result)
      } finally {
        activePlaylistSyncs.delete(syncLockKey)
      }
      return true
    }

    const syncDeleteMatch = pathname.match(/^\/api\/v1\/integration\/playlists\/sync\/([^/]+)$/)
    if (syncDeleteMatch && req.method === 'DELETE') {
      const yinyunPlaylistId = decodeURIComponent(syncDeleteMatch[1])
      if (['default', 'love'].includes(yinyunPlaylistId)) throw new ApiError(400, 'playlist_readonly', '系统歌单不能删除')
      const store = deps.getPlaylistSyncStore?.(username)
      store?.load()
      const record = store?.get(`${username}:${yinyunPlaylistId}`)
      if (!store || !record) { success(res, { deleted: false, mapped: false }); return true }
      const client = deps.getSongloftClient?.()
      if (client?.configured) {
        const remote = (await client.listPlaylists()).find(item => Number(item.id) === Number(record.songloftPlaylistId))
        if (remote && remote.type !== 'radio' && Number(remote.id) > 2 && !(Array.isArray((remote as any).labels) && (remote as any).labels.includes('built_in'))) {
          await client.deletePlaylist(Number(remote.id))
        }
      }
      await store.remove(record.syncId)
      success(res, { deleted: true, mapped: true, songloftPlaylistId: record.songloftPlaylistId })
      return true
    }

    if (pathname === `${API_PREFIX}/auth/me` && req.method === 'GET') {
      success(res, { username, isAdmin: username === 'admin' })
      return true
    }

    if (pathname === `${API_PREFIX}/sync/snapshot` && req.method === 'GET') {
      success(res, await buildAccountSyncSnapshot(username))
      return true
    }

    if (pathname === `${API_PREFIX}/sync/snapshot` && req.method === 'PUT') {
      const body = await readJson(req, ACCOUNT_SYNC_MAX_BYTES + 64 * 1024)
      if (body.confirm !== 'restore') {
        throw new ApiError(400, 'restore_confirmation_required', '恢复同步数据前必须明确确认')
      }
      try {
        const snapshot = await restoreAccountSyncSnapshot(username, body.snapshot, {
          expectedEmpty: body.expectedEmpty === true,
          expectedRevision: typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined,
        })
        success(res, snapshot)
      } catch (error: any) {
        const message = error?.message || String(error)
        if (message.includes('already contains') || message.includes('changed')) {
          throw new ApiError(409, 'sync_conflict', message)
        }
        throw new ApiError(400, 'invalid_sync_snapshot', message)
      }
      return true
    }

    if (pathname === `${API_PREFIX}/tracks/qualities` && req.method === 'GET') {
      success(res, QUALITY_ORDER.map(id => ({ id, label: {
        '128k': '标准音质', '320k': '高音质', flac: '无损音质',
        flac24bit: '24bit无损', hires: '高解析度', atmos: '空间音频',
        atmos_plus: '增强空间音频', master: '母带音质',
      }[id] || id })))
      return true
    }

    if (pathname === `${API_PREFIX}/library/tracks` && req.method === 'GET') {
      const page = parsePositiveInt(url.searchParams.get('page'), 1, 100000)
      const limit = parsePositiveInt(url.searchParams.get('limit'), 100, 500)
      const query = (url.searchParams.get('query') || '').trim().toLocaleLowerCase()
      const folder = url.searchParams.get('folder')
      const all = await fileCache.getCacheList(username)
      const filtered = all.filter((item: any) => (
        (!folder || item.folder === folder) &&
        (!query || `${item.name}\n${item.singer}\n${item.album}`.toLocaleLowerCase().includes(query))
      ))
      const offset = (page - 1) * limit
      success(res, { items: filtered.slice(offset, offset + limit).map(toTrack).map(track => withSignedArtwork(track, username, deps.getAuthSecret())), page, limit, total: filtered.length })
      return true
    }

    const localTrackMatch = pathname.match(/^\/api\/v1\/library\/tracks\/([^/]+)\/(stream|cover|stream-token)$/)
    if (localTrackMatch) {
      const trackId = decodeURIComponent(localTrackMatch[1])
      const action = localTrackMatch[2]
      const { decoded } = await getTrackItem(username, trackId)
      if (action === 'stream-token' && req.method === 'POST') {
        const token = issueToken(username, 'media', MEDIA_TOKEN_TTL, deps.getAuthSecret(), { trackId })
        success(res, { token, expiresIn: MEDIA_TOKEN_TTL, path: `${API_PREFIX}/library/tracks/${encodeURIComponent(trackId)}/stream?token=${encodeURIComponent(token)}` })
        return true
      }
      if (action === 'stream' && (req.method === 'GET' || req.method === 'HEAD')) {
        fileCache.serveCacheFile(req, res, decoded.filename, username, decoded.folder, decoded.location)
        return true
      }
      if (action === 'cover' && req.method === 'GET') {
        const cover = await fileCache.getCacheCover(decoded.filename, username, decoded.location) as any
        if (!cover?.data) throw new ApiError(404, 'cover_not_found', '歌曲没有可用封面')
        res.writeHead(200, { 'Content-Type': cover.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
        res.end(cover.data)
        return true
      }
    }

    if (pathname === `${API_PREFIX}/search` && req.method === 'GET') {
      const query = (url.searchParams.get('query') || '').trim()
      const source = url.searchParams.get('source') || 'tx'
      const type = url.searchParams.get('type') || 'song'
      const page = parsePositiveInt(url.searchParams.get('page'), 1, 10000)
      const limit = parsePositiveInt(url.searchParams.get('limit'), 30, 100)
      if (!query) throw new ApiError(400, 'query_required', '请输入搜索内容')
      if (source === 'aggregate') {
        if (type !== 'song') throw new ApiError(400, 'aggregate_type_unsupported', '聚合音源只支持歌曲搜索')
        success(res, await searchAggregate(deps, username, query, page, limit))
        return true
      }
      if (!deps.isSourceSupported(source, username)) throw new ApiError(409, 'source_unavailable', `当前账户没有可用的 ${source} 音源`)
      if (type === 'singer' || type === 'album') {
        const method = type === 'singer' ? 'searchSinger' : 'searchAlbum'
        if (!deps.musicSdk[source]?.extendSearch?.[method]) throw new ApiError(400, 'search_unsupported', '该平台不支持此类搜索')
        const result = await deps.musicSdk[source].extendSearch[method](query, page, limit)
        success(res, normalizeEntityResult(result, source, type))
        return true
      }
      if (!deps.musicSdk[source]?.musicSearch?.search) throw new ApiError(400, 'search_unsupported', '该平台不支持歌曲搜索')
      const result = await deps.musicSdk[source].musicSearch.search(query, page, limit)
      success(res, normalizeSearchResult(result, source))
      return true
    }

    const entityDetailMatch = pathname.match(/^\/api\/v1\/(artists|albums)\/([^/]+)$/)
    if (entityDetailMatch && req.method === 'GET') {
      const kind = entityDetailMatch[1] as 'artists' | 'albums'
      const id = decodeURIComponent(entityDetailMatch[2])
      const source = url.searchParams.get('source') || 'tx'
      if (!id) throw new ApiError(400, 'entity_id_required', '缺少歌手或专辑 ID')
      if (!deps.isSourceSupported(source, username)) throw new ApiError(409, 'source_unavailable', `当前账户没有可用的 ${source} 音源`)
      const detailSdk = deps.musicSdk[source]?.extendDetail
      if (!detailSdk) throw new ApiError(400, 'detail_unsupported', '该平台不支持歌手或专辑详情')

      if (kind === 'artists') {
        if (!detailSdk.getArtistSongs || !detailSdk.getArtistAlbums) {
          throw new ApiError(400, 'artist_detail_unsupported', '该平台不支持歌手详情')
        }
        const detailPromise = detailSdk.getArtistDetail
          ? Promise.resolve(detailSdk.getArtistDetail(id)).catch(() => null)
          : Promise.resolve(null)
        const [detail, songs, albums] = await Promise.all([
          detailPromise,
          fetchAllPages((page, limit) => detailSdk.getArtistSongs(id, page, limit, 'hot')),
          fetchAllPages((page, limit) => detailSdk.getArtistAlbums(id, page, limit, 'time')),
        ])
        const normalizedSongs = normalizeSearchResult({ list: songs.items, total: songs.total }, source)
        success(res, {
          kind: 'singer',
          entity: {
            id,
            name: detail?.name || url.searchParams.get('name') || '',
            source,
            artworkUrl: detail?.avatar || null,
            description: detail?.desc || '',
          },
          songs: normalizedSongs.items,
          songCount: normalizedSongs.total,
          songsComplete: songs.complete,
          albums: albums.items.map(item => normalizeAlbum(item, source)),
          albumCount: albums.total,
          albumsComplete: albums.complete,
        })
        return true
      }

      if (!detailSdk.getAlbumSongs) throw new ApiError(400, 'album_detail_unsupported', '该平台不支持专辑详情')
      const album = await detailSdk.getAlbumSongs(id)
      const normalizedSongs = normalizeSearchResult(album, source)
      const firstTrack = normalizedSongs.items[0]
      success(res, {
        kind: 'album',
        entity: {
          id,
          name: album?.name || url.searchParams.get('name') || firstTrack?.album || '',
          artist: url.searchParams.get('artist') || firstTrack?.artist || '',
          source,
          artworkUrl: firstTrack?.artworkUrl || null,
          publishTime: album?.publishTime || null,
        },
        songs: normalizedSongs.items,
        songCount: normalizedSongs.total,
      })
      return true
    }

    const libraryMatch = pathname.match(/^\/api\/v1\/library\/(artists|albums)$/)
    if (libraryMatch && (req.method === 'GET' || req.method === 'PUT')) {
      const type = libraryMatch[1] as 'artists' | 'albums'
      if (req.method === 'GET') {
        success(res, await deps.getLibrary(username, type))
        return true
      }
      const body = await readJson(req)
      if (!Array.isArray(body.items)) throw new ApiError(400, 'items_required', '收藏数据必须是数组')
      if (body.items.length > 10000) throw new ApiError(413, 'items_too_large', '收藏数量超过限制')
      await deps.saveLibrary(username, type, body.items)
      success(res, { items: body.items })
      return true
    }

    const leaderboardMatch = pathname.match(/^\/api\/v1\/leaderboards(?:\/([^/]+)\/tracks)?$/)
    if (leaderboardMatch && req.method === 'GET') {
      const source = url.searchParams.get('source') || 'tx'
      if (!deps.isSourceSupported(source, username)) throw new ApiError(409, 'source_unavailable', `当前账户没有可用的 ${source} 音源`)
      if (leaderboardMatch[1]) {
        const page = parsePositiveInt(url.searchParams.get('page'), 1, 10000)
        const result = await deps.getLeaderboardList(source, decodeURIComponent(leaderboardMatch[1]), page, username)
        success(res, normalizeSearchResult(result, source))
      } else {
        success(res, await deps.getLeaderboardBoards(source, username))
      }
      return true
    }

    if (pathname === `${API_PREFIX}/tracks/resolve` && req.method === 'POST') {
      const body = await readJson(req)
      const song = deps.normalizeSongInfo(body.track || body.songInfo)
      if (!song?.source) throw new ApiError(400, 'invalid_track', '歌曲信息不完整')
      const requestedQuality = QUALITY_ORDER.includes(body.quality) ? body.quality : 'flac'
      const resolved = await deps.resolveSong(song, requestedQuality, username, body.allowQualityFallback !== false, {
        allowPlatformSwitch: body.allowPlatformSwitch !== false,
        allowApiSwitch: body.allowSourceSwitch !== false,
      })
      success(res, {
        url: resolved.url,
        quality: resolved.quality,
        requestedQuality,
        requestedSource: resolved.requestedSource || song.source,
        actualSource: resolved.downloadSource || resolved.songInfo?.source || song.source,
        sourceName: resolved.sourceName || null,
        track: resolved.songInfo || song,
      })
      return true
    }

    if (pathname === `${API_PREFIX}/lyrics` && req.method === 'POST') {
      const body = await readJson(req)
      const song = deps.normalizeSongInfo(body.track || body.songInfo)
      const local = fileCache.getLocalLyrics(song, username)
      if (local.exists && local.content) {
        success(res, normalizeLyricsResponse(local.content, local.source || 'local'))
        return true
      }
      if (!song?.source || !deps.musicSdk[song.source]?.getLyric) throw new ApiError(404, 'lyrics_not_found', '没有可用歌词')
      const request = deps.musicSdk[song.source].getLyric(song)
      const result = request?.promise ? await request.promise : await request
      success(res, { ...result, source: song.source })
      return true
    }

    if (pathname === `${API_PREFIX}/playlists` && req.method === 'GET') {
      const data = await getUserSpace(username).listManage.getListData()
      success(res, [
        { id: 'default', name: '试听列表', trackCount: data.defaultList.length, artworkUrl: playlistArtwork({ list: data.defaultList }) },
        { id: 'love', name: '我的收藏', trackCount: data.loveList.length, artworkUrl: playlistArtwork({ list: data.loveList }) },
        ...data.userList.map(item => ({
          id: item.id,
          name: item.name,
          trackCount: item.list.length,
          coverSongId: item.coverSongId || null,
          artworkUrl: playlistArtwork(item),
        })),
      ])
      return true
    }

    if (pathname === `${API_PREFIX}/playlists` && req.method === 'POST') {
      const body = await readJson(req)
      const name = String(body.name || '').trim()
      if (!name || name.length > 100) throw new ApiError(400, 'invalid_playlist_name', '歌单名称不能为空且不能超过 100 个字符')
      const id = `mobile_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
      const manage = getUserSpace(username).listManage
      await manage.listDataManage.userListCreate({ id, name, position: -1, locationUpdateTime: Date.now() })
      await manage.createSnapshot()
      success(res, { id, name, trackCount: 0 }, 201)
      return true
    }

    const playlistMatch = pathname.match(/^\/api\/v1\/playlists\/([^/]+)(?:\/tracks(?:\/([^/]+))?)?$/)
    if (playlistMatch) {
      const playlistId = decodeURIComponent(playlistMatch[1])
      const trackId = playlistMatch[2] ? decodeURIComponent(playlistMatch[2]) : null
      const manage = getUserSpace(username).listManage
      if (req.method === 'GET' && !trackId) {
        const playlist = await getPlaylist(username, playlistId)
        const localItems = await fileCache.getCacheList(username)
        const localIndex = createLocalTrackIndex(localItems)
        // Some original Yinyun entries have no artwork even though Songloft's
        // index has it.  Use Songloft metadata as a read-only artwork fallback;
        // the shared audio file and the playlist source remain authoritative.
        let songloftTracks: IntegrationTrack[] = []
        if (deps.getSongloftClient?.()?.configured || deps.getSongloftSubsonicClient?.()) {
          try { songloftTracks = await getSongloftTracksForMatching(deps, playlist.list.map(song => toIntegrationTrack(deps.normalizeSongInfo({ ...song })))) } catch { songloftTracks = [] }
        }
        const items = playlist.list.map(song => {
          const normalizedSong = deps.normalizeSongInfo({ ...song })
          const onlineTrack: any = normalizeOnlineTrack(normalizedSong, song.source || 'unknown')
          if (!onlineTrack.artworkUrl && songloftTracks.length) {
            const fallback = matchTracks([toIntegrationTrack(normalizedSong)], songloftTracks, { ...SHARED_LIBRARY_MATCH_OPTIONS, threshold: 0.82 })[0]
            if (fallback?.candidate && fallback.score >= 0.82 && fallback.candidate.artworkUrl) onlineTrack.artworkUrl = fallback.candidate.artworkUrl
          }
          return withSignedArtwork(mergeLocalTrackMetadata(
            onlineTrack,
            findLocalPlaylistTrack(normalizedSong, localIndex),
          ), username, deps.getAuthSecret())
        })
        const artworkUrl = playlistArtwork(playlist, items)
        success(res, {
          id: playlist.id,
          name: playlist.name,
          coverSongId: (playlist as any).coverSongId || null,
          artworkUrl,
          items,
        })
        return true
      }
      if (req.method === 'PATCH' && !pathname.includes('/tracks')) {
        if (['default', 'love'].includes(playlistId)) throw new ApiError(400, 'playlist_readonly', '系统歌单不能修改')
        const body = await readJson(req)
        const playlist = await getPlaylist(username, playlistId)
        const name = body.name === undefined ? String(playlist.name || '').trim() : String(body.name || '').trim()
        if (!name || name.length > 100) throw new ApiError(400, 'invalid_playlist_name', '歌单名称无效')
        const next: any = { ...playlist, name, locationUpdateTime: Date.now() }
        if (Object.prototype.hasOwnProperty.call(body, 'coverSongId')) {
          const coverSongId = String(body.coverSongId || '').trim()
          if (coverSongId.length > 300) throw new ApiError(400, 'invalid_playlist_cover', '歌单封面歌曲编号无效')
          if (coverSongId) next.coverSongId = coverSongId
          else delete next.coverSongId
        }
        if (Object.prototype.hasOwnProperty.call(body, 'coverUrl')) {
          const coverUrl = safePlaylistArtwork(body.coverUrl)
          if (body.coverUrl && !coverUrl) throw new ApiError(400, 'invalid_playlist_cover', '歌单封面地址无效')
          if (coverUrl) next.coverUrl = coverUrl
          else delete next.coverUrl
        }
        await manage.listDataManage.userListsUpdate([next])
        await manage.createSnapshot()
        success(res, { id: playlistId, name, coverSongId: next.coverSongId || null, coverUrl: next.coverUrl || null })
        return true
      }
      if (req.method === 'DELETE' && !pathname.includes('/tracks')) {
        if (['default', 'love'].includes(playlistId)) throw new ApiError(400, 'playlist_readonly', '系统歌单不能删除')
        await getPlaylist(username, playlistId)
        await manage.listDataManage.userListsRemove([playlistId])
        await manage.createSnapshot()
        // 删除音云用户歌单后，按已保存的映射删除对应 Songloft 歌单。
        // 只删除歌单实体，不触碰共享音乐文件；系统歌单仍受保护。
        const syncStore = deps.getPlaylistSyncStore?.(username)
        syncStore?.load()
        const syncRecord = syncStore?.get(`${username}:${playlistId}`)
        const songloft = deps.getSongloftClient?.()
        if (syncStore && syncRecord && songloft?.configured) {
          try {
            const remote = (await songloft.listPlaylists()).find(item => Number(item.id) === Number(syncRecord.songloftPlaylistId))
            if (remote && remote.type !== 'radio' && Number(remote.id) > 2 && !(Array.isArray((remote as any).labels) && (remote as any).labels.includes('built_in'))) {
              await songloft.deletePlaylist(Number(remote.id))
            }
            await syncStore.remove(`${username}:${playlistId}`)
          } catch (error: any) {
            console.warn('[PlaylistSync] 音云歌单已删除，但 Songloft 映射清理失败:', error?.message || error)
          }
        }
        res.writeHead(204); res.end()
        return true
      }
      if (req.method === 'POST' && pathname.endsWith('/tracks')) {
        await getPlaylist(username, playlistId)
        const body = await readJson(req)
        const tracks = Array.isArray(body.tracks) ? body.tracks : body.track ? [body.track] : []
        if (!tracks.length) throw new ApiError(400, 'tracks_required', '请选择要加入的歌曲')
        await manage.listDataManage.listMusicAdd(playlistId, tracks.map(deps.normalizeSongInfo), body.position === 'top' ? 'top' : 'bottom')
        await manage.createSnapshot()
        success(res, { added: tracks.length })
        return true
      }
      if (req.method === 'DELETE' && trackId) {
        await getPlaylist(username, playlistId)
        await manage.listDataManage.listMusicRemove(playlistId, [trackId])
        await manage.createSnapshot()
        res.writeHead(204); res.end()
        return true
      }
    }

    if (pathname === `${API_PREFIX}/downloads` && req.method === 'GET') {
      success(res, { concurrency: serverDownloadQueue.getConcurrency(username), items: serverDownloadQueue.list(username) })
      return true
    }
    if (pathname === `${API_PREFIX}/downloads` && req.method === 'POST') {
      const body = await readJson(req)
      const rawItems = Array.isArray(body.items) ? body.items : body.track ? [{ track: body.track, quality: body.quality }] : []
      if (!rawItems.length) throw new ApiError(400, 'tracks_required', '请选择要下载的歌曲')
      const items = rawItems.map((item: any) => ({
        id: item.id || crypto.randomUUID(),
        songInfo: deps.normalizeSongInfo(item.track || item.songInfo),
        quality: QUALITY_ORDER.includes(item.quality) ? item.quality : 'flac',
        enableOnlyDownloadMode: true,
        cacheLyric: item.downloadLyrics !== false,
        embedLyric: item.embedLyrics !== false,
        sidecarLyricFormat: item.sidecarLyricFormat,
        embedLyricFormat: item.embedLyricFormat,
      }))
      success(res, { items: serverDownloadQueue.enqueue(username, items) }, 202)
      return true
    }
    if (pathname === `${API_PREFIX}/downloads/concurrency` && req.method === 'PUT') {
      const body = await readJson(req)
      success(res, { concurrency: serverDownloadQueue.setConcurrency(username, body.concurrency) })
      return true
    }
    if (pathname === `${API_PREFIX}/downloads/resume` && req.method === 'POST') {
      const body = await readJson(req)
      const replacement = body.songInfo || body.track || (body.source ? body : undefined)
      serverDownloadQueue.resume(username, body.id, replacement)
      success(res, { resumed: true, sourceChanged: Boolean(replacement) }); return true
    }
    if (pathname === `${API_PREFIX}/downloads/pause` && req.method === 'POST') {
      const body = await readJson(req); serverDownloadQueue.pause(username, body.id); success(res, { paused: true }); return true
    }
    if (pathname === `${API_PREFIX}/downloads` && req.method === 'DELETE') {
      const body = await readJson(req); serverDownloadQueue.remove(username, { id: body.id, all: body.all, completed: body.completed, history: body.history }); res.writeHead(204); res.end(); return true
    }

    if (pathname === `${API_PREFIX}/replacement` && req.method === 'GET') {
      success(res, remasterQueue.getStatus(username, Number(url.searchParams.get('offset') || 0), parsePositiveInt(url.searchParams.get('limit'), 100, 200)))
      return true
    }
    if (pathname === `${API_PREFIX}/replacement` && req.method === 'POST') {
      const body = await readJson(req)
      const status = await remasterQueue.start(username, body.targetQuality || 'flac', body.filenames, {
        allowPlatformSwitch: body.allowPlatformSwitch !== false,
        allowApiSwitch: body.onlyFirstSource !== true,
      })
      success(res, status, 202)
      return true
    }
    if (pathname === `${API_PREFIX}/replacement/cancel` && req.method === 'POST') {
      success(res, { cancelled: remasterQueue.cancel(username) })
      return true
    }

    if (pathname === `${API_PREFIX}/sources` && req.method === 'GET') {
      const sources = deps.getLoadedSources().filter(source => (
        source.owner === username || isSourceSharedWithUser(source.owner, source.id, username)
      ))
      success(res, sources.map(source => sourceView(source, username)))
      return true
    }
    const sourcePlatformsMatch = pathname.match(/^\/api\/v1\/sources\/([^/]+)\/platforms$/)
    if (sourcePlatformsMatch && req.method === 'PUT') {
      const body = await readJson(req)
      const sourceId = decodeURIComponent(sourcePlatformsMatch[1])
      const owner = tryNormalizeUsername(body.owner) || username
      const source = deps.getLoadedSources().find(item => item.id === sourceId && item.owner === owner)
      if (!source || (owner !== username && !isSourceSharedWithUser(owner, sourceId, username))) {
        throw new ApiError(404, 'source_not_found', '音源不存在')
      }
      const enabledPlatforms = setEnabledSourcePlatforms(username, owner, sourceId, body.enabledPlatforms, Object.keys(source.sources || {}))
      success(res, { enabledPlatforms })
      return true
    }

    if (pathname === `${API_PREFIX}/shares/settings`) {
      if (req.method === 'GET') { success(res, { enabled: isPlaylistSharingEnabled(username) }); return true }
      if (req.method === 'PUT') { const body = await readJson(req); success(res, { enabled: setPlaylistSharingEnabled(username, body.enabled === true) }); return true }
    }
    if (pathname === `${API_PREFIX}/shares/inbox` && req.method === 'GET') {
      success(res, getPendingPlaylistShares(username)); return true
    }
    if (pathname === `${API_PREFIX}/shares` && req.method === 'POST') {
      const body = await readJson(req); success(res, await createPlaylistShare(username, body.toUsername, body.playlistId), 202); return true
    }
    const shareMatch = pathname.match(/^\/api\/v1\/shares\/([^/]+)$/)
    if (shareMatch && req.method === 'POST') {
      const body = await readJson(req); success(res, await respondToPlaylistShare(username, decodeURIComponent(shareMatch[1]), body.action)); return true
    }

    if (pathname === `${API_PREFIX}/events` && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      let previous = ''
      const send = () => {
        const value = JSON.stringify({
          downloads: serverDownloadQueue.list(username),
          replacement: remasterQueue.getStatus(username, 0, 0),
          pendingShares: getPendingPlaylistShares(username).length,
        })
        if (value !== previous) {
          previous = value
          res.write(`event: state\ndata: ${value}\n\n`)
        } else {
          res.write(': keep-alive\n\n')
        }
      }
      send()
      const timer = setInterval(send, 2000)
      req.on('close', () => clearInterval(timer))
      return true
    }

    throw new ApiError(404, 'endpoint_not_found', '接口不存在')
  } catch (error: any) {
    if (error instanceof PlaylistSharingError) {
      failure(res, { status: error.statusCode, code: error.code, message: error.message })
    } else if (error instanceof SongloftRequestError) {
      failure(res, { status: 502, code: 'songloft_upstream_error', message: 'Songloft API 请求失败', details: { status: error.status } })
    } else if (error instanceof ApiError) {
      failure(res, error)
    } else {
      console.error('[API v1]', error)
      failure(res, { status: 500, code: 'internal_error', message: error?.message || '服务器内部错误' })
    }
    return true
  }
}
