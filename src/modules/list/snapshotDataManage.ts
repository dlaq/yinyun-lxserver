import { throttle } from '@/utils/common'
import fs from 'node:fs'
import path from 'node:path'
import { syncLog } from '@/utils/log4js'
import { checkAndCreateDirSync } from '@/utils'
import { getUserConfig, type UserDataManage } from '@/user/data'
import { File } from '@/constants'
import { atomicWriteJsonSync } from '@/server/atomicJsonStore'
import { assertPlaylistData } from '@/server/playlistInvariants'

interface SnapshotInfo {
  latest: string | null
  time: number
  list: string[]
}
export class SnapshotDataManage {
  userDataManage: UserDataManage
  listDir: string
  snapshotDir: string
  snapshotInfoFilePath: string
  snapshotInfo: SnapshotInfo
  private readonly saveSnapshotInfoThrottle: () => void

  clearOldSnapshot = async () => {
    if (!this.snapshotInfo) return
    const snapshotList = [...this.snapshotInfo.list]
    // console.log(snapshotList.length, lx.config.maxSnapshotNum)
    const userMaxSnapshotNum = getUserConfig(this.userDataManage.userName).maxSnapshotNum
    let requiredSave = snapshotList.length > userMaxSnapshotNum
    while (snapshotList.length > userMaxSnapshotNum) {
      const name = snapshotList.pop()
      if (name) {
        await this.removeSnapshot(name)
        this.snapshotInfo.list.splice(this.snapshotInfo.list.indexOf(name), 1)
      } else break
    }
    if (requiredSave) this.saveSnapshotInfo(this.snapshotInfo)
  }

  getSnapshotInfo = async (): Promise<SnapshotInfo> => {
    return this.snapshotInfo
  }

  saveSnapshotInfo = (info: SnapshotInfo) => {
    this.snapshotInfo = info
    this.saveSnapshotInfoThrottle()
  }

  getSnapshot = async (name: string): Promise<LX.Sync.List.ListData> => {
    const filePath = path.join(this.snapshotDir, `snapshot_${name}`)
    try {
      const listData: unknown = JSON.parse((await fs.promises.readFile(filePath)).toString('utf-8'))
      assertPlaylistData(listData, { allowHistoricalDuplicates: true })
      return listData
    } catch (err: any) {
      syncLog.error(`Critical snapshot unavailable ${filePath}: ${err?.message || err}`)
      throw err
    }
  }

  saveSnapshot = async (name: string, data: string) => {
    syncLog.info('saveSnapshot', this.userDataManage.userName, name)
    const filePath = path.join(this.snapshotDir, `snapshot_${name}`)
    try {
      const parsed: unknown = JSON.parse(data)
      assertPlaylistData(parsed)
      atomicWriteJsonSync(filePath, parsed, { mode: 0o600 })
    } catch (err) {
      syncLog.error(err)
      throw err
    }
  }

  saveSnapshotWithTime = async (name: string, data: string, time: number) => {
    syncLog.info('saveSnapshotWithTime', this.userDataManage.userName, name, time)
    const filePath = path.join(this.snapshotDir, `snapshot_${name}`)
    try {
      const parsed: unknown = JSON.parse(data)
      assertPlaylistData(parsed)
      atomicWriteJsonSync(filePath, parsed, { mode: 0o600 })
      if (time) {
        const date = new Date(time)
        fs.utimesSync(filePath, date, date)
      }
    } catch (err) {
      syncLog.error(err)
      throw err
    }
  }

  removeSnapshot = async (name: string) => {
    syncLog.info('removeSnapshot', this.userDataManage.userName, name)
    const filePath = path.join(this.snapshotDir, `snapshot_${name}`)
    try {
      fs.unlinkSync(filePath)
    } catch (err) {
      syncLog.error(err)
    }
  }

  getSnapshotListWithMeta = async () => {
    const list = []
    try {
      const files = await fs.promises.readdir(this.snapshotDir)
      for (const file of files) {
        if (!file.startsWith('snapshot_')) continue
        const name = file.replace('snapshot_', '')
        const filePath = path.join(this.snapshotDir, file)
        try {
          const stat = await fs.promises.stat(filePath)
          list.push({
            id: name,
            time: stat.mtimeMs,
            size: stat.size,
          })
        } catch (e) {
          // ignore missing files
        }
      }
    } catch (err) {
      syncLog.error(err)
    }
    // Sort by time desc
    return list.sort((a, b) => b.time - a.time)
  }

  setLatest = (name: string) => {
    this.snapshotInfo.latest = name
    this.saveSnapshotInfoThrottle()
  }


  constructor(userDataManage: UserDataManage) {
    this.userDataManage = userDataManage

    this.listDir = path.join(userDataManage.userDir, File.listDir)
    checkAndCreateDirSync(this.listDir)

    this.snapshotDir = path.join(this.listDir, File.listSnapshotDir)
    checkAndCreateDirSync(this.snapshotDir)

    this.snapshotInfoFilePath = path.join(this.listDir, File.listSnapshotInfoJSON)
    if (fs.existsSync(this.snapshotInfoFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.snapshotInfoFilePath).toString())
      if (!parsed || !Array.isArray(parsed.list) || !(parsed.latest === null || typeof parsed.latest === 'string') || !Number.isFinite(parsed.time)) {
        throw new Error(`Invalid snapshot index: ${this.snapshotInfoFilePath}`)
      }
      this.snapshotInfo = parsed
    } else this.snapshotInfo = { latest: null, time: 0, list: [] }

    this.saveSnapshotInfoThrottle = throttle(() => {
      try {
        atomicWriteJsonSync(this.snapshotInfoFilePath, this.snapshotInfo, { mode: 0o600 })
        void this.clearOldSnapshot()
      } catch (error) {
        console.error(error)
      }
    })

  }
}
// type UserDataManages = Map<string, UserDataManage>

// export const createUserDataManage = (user: LX.UserConfig) => {
//   const manage = Object.create(userDataManage) as typeof userDataManage
//   manage.userDir = user.dataPath
// }
