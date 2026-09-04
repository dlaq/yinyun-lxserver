import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJsonSync } from './atomicJsonStore'

export interface PersistedUserRecord {
  name: string
  password?: string
  passwordConfigured?: boolean
  isAdmin?: boolean
  maxSnapshotNum?: number
  'list.addMusicLocationType'?: LX.AddMusicLocationType
}

export interface PersistedUserFile {
  schemaVersion: 1
  revision: number
  users: PersistedUserRecord[]
}

const isUser = (value: any): value is PersistedUserRecord => value && typeof value === 'object' &&
  typeof value.name === 'string' && (!('password' in value) || typeof value.password === 'string')

const isUserFile = (value: unknown): value is PersistedUserFile => Boolean(
  value && typeof value === 'object' && (value as any).schemaVersion === 1 &&
  Number.isInteger((value as any).revision) && (value as any).revision >= 0 &&
  Array.isArray((value as any).users) && (value as any).users.every(isUser),
)

const parse = (raw: string): { file: PersistedUserFile; legacy: boolean } => {
  const value: unknown = JSON.parse(raw)
  if (Array.isArray(value) && value.every(isUser)) {
    return { file: { schemaVersion: 1, revision: 0, users: value }, legacy: true }
  }
  if (!isUserFile(value)) throw new Error('users.json schema validation failed')
  return { file: value, legacy: false }
}

export const readPersistedUsersSync = (filePath: string): { file: PersistedUserFile; legacy: boolean } | null => {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) return null
  try {
    return parse(fs.readFileSync(resolved, 'utf8'))
  } catch (mainError) {
    const evidence = `${resolved}.${new Date().toISOString().replace(/[:.]/g, '-')}.${crypto.randomBytes(4).toString('hex')}.corrupt`
    fs.renameSync(resolved, evidence)
    try {
      const backup = parse(fs.readFileSync(`${resolved}.bak`, 'utf8'))
      atomicWriteJsonSync(resolved, backup.file, { keepBackup: false })
      console.warn(`[UserStore] Recovered users.json from validated backup; invalid file preserved as ${evidence}`)
      return backup
    } catch (backupError) {
      const error = new Error('Critical users.json and its backup are invalid; refusing to start with an empty user list')
      ;(error as any).cause = { mainError, backupError, evidence }
      throw error
    }
  }
}

export const writePersistedUsersSync = (
  filePath: string,
  users: LX.Config['users'],
  options: { includeLegacyPasswords: boolean },
) => {
  let revision = 0
  try { revision = readPersistedUsersSync(filePath)?.file.revision ?? 0 } catch { throw new Error('Refusing to overwrite invalid users.json') }
  const records = users.map(user => ({
    name: user.name,
    ...(options.includeLegacyPasswords ? { password: user.password } : { passwordConfigured: true }),
    isAdmin: user.isAdmin === true,
    maxSnapshotNum: user.maxSnapshotNum,
    'list.addMusicLocationType': user['list.addMusicLocationType'],
  }))
  const file: PersistedUserFile = { schemaVersion: 1, revision: revision + 1, users: records }
  if (!isUserFile(file)) throw new Error('Refusing to write invalid users.json')
  atomicWriteJsonSync(filePath, file, { mode: 0o600 })
  return file
}
