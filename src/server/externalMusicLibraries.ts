import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeUsername } from '@/utils/username'

export const EXTERNAL_LOCATION_PREFIX = 'external:'
const EXTERNAL_CONFIG_FILE = 'externalLibraries.json'
const EXTERNAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface ExternalMusicLibrary {
  id: string
  username: string
  name: string
  enabled: boolean
  createdAt: number
}

const getDataPath = () => String((global as any).lx?.dataPath || path.join(process.cwd(), 'data'))
const getConfigPath = () => path.join(getDataPath(), EXTERNAL_CONFIG_FILE)
const getExternalRoot = () => path.resolve(process.env.EXTERNAL_MUSIC_ROOT || path.join(process.cwd(), 'external'))

const isPathInside = (child: string, parent: string) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const resolveExternalPath = (library: Pick<ExternalMusicLibrary, 'username' | 'name'>, requireExisting = false) => {
  const root = getExternalRoot()
  const candidate = path.resolve(root, library.username, library.name)
  if (!isPathInside(candidate, root)) throw new Error('外部音乐库路径越界')

  const rootReal = fs.existsSync(root) ? fs.realpathSync.native(root) : root
  if (!fs.existsSync(candidate)) {
    if (requireExisting) throw new Error(`外部音乐库目录不存在: ${candidate}`)
    return candidate
  }
  const candidateReal = fs.realpathSync.native(candidate)
  if (!isPathInside(candidateReal, rootReal)) throw new Error('外部音乐库符号链接指向允许根目录之外')
  if (!fs.statSync(candidateReal).isDirectory()) throw new Error('外部音乐库路径不是目录')
  return candidateReal
}

const readLibraries = (): ExternalMusicLibrary[] => {
  try {
    const value = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))
    if (!Array.isArray(value) || !value.every(isValidLibrary)) throw new Error('Invalid external library configuration')
    return value.map(item => ({
      id: item.id,
      username: item.username,
      name: item.name,
      enabled: item.enabled !== false,
      createdAt: Number(item.createdAt) || 0,
    }))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`Failed to read external library configuration: ${error?.message || error}`)
  }
}

const writeLibraries = (libraries: ExternalMusicLibrary[]) => {
  fs.mkdirSync(getDataPath(), { recursive: true })
  const target = getConfigPath()
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  const handle = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(libraries, null, 2)}\n`, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporary, target)
}

const isValidLibrary = (value: any): value is ExternalMusicLibrary => (
  value && typeof value.id === 'string' && /^[a-z0-9_-]{8,100}$/i.test(value.id) &&
  typeof value.username === 'string' && typeof value.name === 'string' &&
  EXTERNAL_NAME_PATTERN.test(value.name)
)

const userExists = (username: string) => (
  Array.isArray((global as any).lx?.config?.users) &&
  (global as any).lx.config.users.some((user: any) => user.name === username)
)

const makeId = (username: string, name: string) => `external_${crypto.createHash('sha256').update(`${username}\0${name}`).digest('hex').slice(0, 24)}`

export const normalizeExternalLibraryName = (value: unknown) => {
  const name = String(value || '').trim()
  if (!EXTERNAL_NAME_PATTERN.test(name)) {
    throw new Error('库名称只能包含字母、数字、点、下划线和短横线，长度为 1-64 个字符')
  }
  return name
}

export const listExternalMusicLibraries = (username?: string): ExternalMusicLibrary[] => {
  const normalized = username ? normalizeUsername(username) : ''
  return readLibraries().filter(item => item.enabled && (!normalized || item.username === normalized))
}

export const listAllExternalMusicLibraries = (): ExternalMusicLibrary[] => readLibraries()

export const getExternalMusicLibrary = (id: string, username?: string) => {
  const library = readLibraries().find(item => item.id === id && item.enabled)
  if (!library) return null
  if (username && library.username !== normalizeUsername(username)) return null
  return library
}

export const getExternalLocation = (library: ExternalMusicLibrary): string => `${EXTERNAL_LOCATION_PREFIX}${library.id}`

export const getExternalLibraryByLocation = (location: string, username?: string) => {
  if (!location.startsWith(EXTERNAL_LOCATION_PREFIX)) return null
  const id = location.slice(EXTERNAL_LOCATION_PREFIX.length)
  if (!/^[a-z0-9_-]{8,100}$/i.test(id)) return null
  return getExternalMusicLibrary(id, username)
}

export const getExternalMusicPath = (library: ExternalMusicLibrary) => resolveExternalPath(library)

export const getExternalIndexPath = (library: ExternalMusicLibrary, folder: 'cache' | 'music') => {
  const indexDir = path.join(getDataPath(), 'external-index', library.username, library.id)
  fs.mkdirSync(indexDir, { recursive: true })
  return path.join(indexDir, folder === 'music' ? 'music_index.json' : 'cache_index.json')
}

export const createExternalMusicLibrary = (usernameValue: unknown, nameValue: unknown): ExternalMusicLibrary => {
  const username = normalizeUsername(usernameValue)
  const name = normalizeExternalLibraryName(nameValue)
  if (!userExists(username)) throw new Error('用户不存在')

  const libraries = readLibraries()
  const existing = libraries.find(item => item.username === username && item.name.toLowerCase() === name.toLowerCase())
  if (existing) return existing

  resolveExternalPath({ username, name }, true)

  const library: ExternalMusicLibrary = {
    id: makeId(username, name),
    username,
    name,
    enabled: true,
    createdAt: Date.now(),
  }
  libraries.push(library)
  writeLibraries(libraries)
  return library
}

export const removeExternalMusicLibrary = (id: string): ExternalMusicLibrary | null => {
  const libraries = readLibraries()
  const library = libraries.find(item => item.id === id)
  if (!library) return null
  writeLibraries(libraries.filter(item => item.id !== id))
  const indexDir = path.join(getDataPath(), 'external-index', library.username, library.id)
  fs.rmSync(indexDir, { recursive: true, force: true })
  return library
}

export const getExternalLibraryContainerPath = (library: ExternalMusicLibrary) => `/server/external/${library.username}/${library.name}`

export const getExternalLibraryInfo = (library: ExternalMusicLibrary) => ({
  ...library,
  location: getExternalLocation(library),
  containerPath: getExternalLibraryContainerPath(library),
  hostPath: getExternalMusicPath(library),
  available: fs.existsSync(getExternalMusicPath(library)),
  readOnly: true,
})
