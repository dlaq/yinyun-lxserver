import fs from 'node:fs'
import path from 'node:path'
import { File } from '@/constants'
import { getUserDirname, getUserSpace } from '@/user'
import { normalizeUsername } from '@/utils/username'
import { getNetworkPlaylistSongs, networkPlaylistsAreEqual, parseNetworkPlaylistInterval, pruneNetworkPlaylistState } from './networkPlaylistMonitorUtils'

type NetworkPlaylistStatus = {
  listId: string
  name: string
  source: string
  sourceListId: string
  changed: boolean
  checkedAt: number
  localCount: number
  remoteCount?: number
  error?: string
  lastSuccessAt?: number
}

type MonitorDeps = {
  getUsers: () => Array<{ name: string }>
  musicSdk: any
  normalizeSongInfo: (value: any) => any
}

const MIN_INTERVAL_MS = 30 * 1000

const getStatePath = (username: string) => path.join(
  global.lx.userPath,
  getUserDirname(username),
  File.userNetworkPlaylistCheckJSON,
)

const readState = (username: string): Record<string, NetworkPlaylistStatus> => {
  const filePath = getStatePath(username)
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid network playlist state')
    return value
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[NetworkPlaylistMonitor] corrupt state for ${username}: ${error?.message || error}`)
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch { /* derived monitor state may be rebuilt even if evidence preservation fails */ }
    }
    return {}
  }
}

const writeState = (username: string, state: Record<string, NetworkPlaylistStatus>) => {
  const filePath = getStatePath(username)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporary, filePath)
  try {
    const directory = fs.openSync(path.dirname(filePath), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } catch { /* directory fsync is unavailable on some platforms */ }
}

const getUserSettings = (username: string): Record<string, any> => {
  try {
    const settingsPath = path.join(getUserSpace(username).dataManage.userDir, File.userSettingsJSON)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return settings && typeof settings === 'object' ? settings : {}
  } catch {
    return {}
  }
}

const getTargetLists = async (username: string) => {
  const data = await getUserSpace(username).listManage.getListData()
  return data.userList.filter(list => !!list?.source && !!list?.sourceListId)
}

export class NetworkPlaylistMonitor {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly initialChecks = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<NetworkPlaylistStatus[]>>()

  constructor(private readonly deps: MonitorDeps) {}

  private stopTimer(username: string) {
    const timer = this.timers.get(username)
    if (timer) clearInterval(timer)
    this.timers.delete(username)
    const initialCheck = this.initialChecks.get(username)
    if (initialCheck) clearTimeout(initialCheck)
    this.initialChecks.delete(username)
  }

  stop() {
    for (const username of new Set([...this.timers.keys(), ...this.initialChecks.keys()])) this.stopTimer(username)
  }

  private runScheduledCheck(username: string) {
    if (!this.deps.getUsers().some(user => user.name === username)) return
    void this.checkUser(username).catch(error => {
      console.warn(`[NetworkPlaylistMonitor] scheduled check failed for ${username}: ${error?.message || error}`)
    })
  }

  reloadUser(username: string) {
    const normalized = normalizeUsername(username)
    this.stopTimer(normalized)
    if (!this.deps.getUsers().some(user => user.name === normalized)) return
    const settings = getUserSettings(normalized)
    if (settings.autoUpdateNetworkList !== true) return
    const interval = parseNetworkPlaylistInterval(settings.networkListAutoCheckInterval)
    if (!interval) return
    const timer = setInterval(() => this.runScheduledCheck(normalized), interval)
    timer.unref?.()
    this.timers.set(normalized, timer)
    const initialCheck = setTimeout(() => {
      this.initialChecks.delete(normalized)
      this.runScheduledCheck(normalized)
    }, 1000)
    initialCheck.unref?.()
    this.initialChecks.set(normalized, initialCheck)
  }

  start() {
    this.stop()
    for (const user of this.deps.getUsers()) this.reloadUser(user.name)
  }

  async checkUser(username: string) {
    const normalized = normalizeUsername(username)
    const active = this.running.get(normalized)
    if (active) return active
    const task = this.runCheck(normalized).finally(() => this.running.delete(normalized))
    this.running.set(normalized, task)
    return task
  }

  private async runCheck(normalized: string): Promise<NetworkPlaylistStatus[]> {
    const state = readState(normalized)
    const lists = await getTargetLists(normalized)
    const activeState = pruneNetworkPlaylistState(state, lists.map(list => list.id))
    for (const listId of Object.keys(state)) delete state[listId]
    Object.assign(state, activeState)
    for (const list of lists) {
      const previous = state[list.id]
      const entry: NetworkPlaylistStatus = {
        listId: list.id,
        name: list.name,
        source: list.source!,
        sourceListId: list.sourceListId!,
        changed: previous?.changed === true,
        checkedAt: Date.now(),
        localCount: Array.isArray(list.list) ? list.list.length : 0,
        ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      }
      try {
        const sdk = this.deps.musicSdk[list.source!]
        if (!sdk?.songList?.getListDetail) throw new Error(`Source ${list.source} does not support song list details`)
        const result = await sdk.songList.getListDetail(list.sourceListId, 1)
        const remote = getNetworkPlaylistSongs(result).map(this.deps.normalizeSongInfo)
        entry.remoteCount = remote.length
        entry.changed = !networkPlaylistsAreEqual(Array.isArray(list.list) ? list.list : [], remote)
        entry.lastSuccessAt = entry.checkedAt
        delete entry.error
      } catch (error: any) {
        entry.error = error?.message || String(error)
        // Keep the previous changed state on a transient upstream failure.
        if (previous?.changed === true) entry.changed = true
        console.warn(`[NetworkPlaylistMonitor] ${normalized}/${list.id}: ${entry.error}`)
      }
      state[list.id] = entry
    }
    writeState(normalized, state)
    return Object.values(state)
  }

  getStatus(username: string) {
    return Object.values(readState(normalizeUsername(username)))
  }

  async checkAndGetStatus(username: string) {
    await this.checkUser(username)
    return this.getStatus(username)
  }
}
