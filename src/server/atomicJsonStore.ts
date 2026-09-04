import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export class AtomicJsonStoreError extends Error {
  constructor(
    public readonly code: 'missing' | 'invalid' | 'io' | 'revision_conflict',
    public readonly filePath: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AtomicJsonStoreError'
  }
}

export interface AtomicJsonStoreOptions<T> {
  validate: (value: unknown) => value is T
  critical?: boolean
  createDefault?: () => T
  backupPath?: string
  mode?: number
  onWarning?: (message: string, error?: unknown) => void
}

const queues = new Map<string, Promise<void>>()

const withFileLock = async <T>(filePath: string, task: () => Promise<T>): Promise<T> => {
  const key = path.resolve(filePath)
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const chain = previous.then(() => current)
  queues.set(key, chain)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (queues.get(key) === chain) queues.delete(key)
  }
}

const parseAndValidate = <T>(raw: string, validate: (value: unknown) => value is T): T => {
  const value: unknown = JSON.parse(raw)
  if (!validate(value)) throw new Error('JSON schema validation failed')
  return value
}

const fsyncParentDirectory = async (filePath: string) => {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(path.dirname(filePath), fs.constants.O_RDONLY)
    await handle.sync()
  } catch (error: any) {
    // Windows does not consistently allow fsync on directory handles. Linux,
    // including the production container, does and therefore keeps the full
    // rename durability guarantee.
    if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EINVAL', 'EBADF'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

const safeTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-')

export class AtomicJsonStore<T> {
  readonly filePath: string
  readonly backupPath: string
  private readonly options: Required<Pick<AtomicJsonStoreOptions<T>, 'critical' | 'mode'>> & AtomicJsonStoreOptions<T>

  constructor(filePath: string, options: AtomicJsonStoreOptions<T>) {
    this.filePath = path.resolve(filePath)
    this.backupPath = path.resolve(options.backupPath ?? `${filePath}.bak`)
    this.options = {
      critical: options.critical ?? true,
      mode: options.mode ?? 0o600,
      ...options,
    }
  }

  private warn(message: string, error?: unknown) {
    this.options.onWarning?.(message, error)
  }

  private async readValidated(filePath: string): Promise<T> {
    return parseAndValidate(await fs.promises.readFile(filePath, 'utf8'), this.options.validate)
  }

  private async preserveCorruptEvidence() {
    const evidencePath = `${this.filePath}.${safeTimestamp()}.${crypto.randomBytes(4).toString('hex')}.corrupt`
    try {
      await fs.promises.rename(this.filePath, evidencePath)
      await fsyncParentDirectory(this.filePath)
      this.warn(`Invalid JSON preserved as ${evidencePath}`)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') this.warn(`Could not preserve invalid JSON ${this.filePath}`, error)
    }
  }

  private async readUnlocked(): Promise<T> {
    try {
      return await this.readValidated(this.filePath)
    } catch (mainError: any) {
      const missing = mainError?.code === 'ENOENT'
      if (!missing) await this.preserveCorruptEvidence()

      try {
        const backup = await this.readValidated(this.backupPath)
        await this.writeUnlocked(backup, false)
        this.warn(`Recovered ${this.filePath} from its validated backup`, mainError)
        return backup
      } catch (backupError: any) {
        if (missing && backupError?.code === 'ENOENT' && this.options.createDefault) {
          const initial = this.options.createDefault()
          if (!this.options.validate(initial)) {
            throw new AtomicJsonStoreError('invalid', this.filePath, 'Default value failed schema validation')
          }
          await this.writeUnlocked(initial, false)
          return initial
        }

        const code = missing && backupError?.code === 'ENOENT' ? 'missing' : 'invalid'
        const message = this.options.critical
          ? `Critical JSON state is unavailable: ${this.filePath}`
          : `Derived JSON state is unavailable and may be rebuilt: ${this.filePath}`
        throw new AtomicJsonStoreError(code, this.filePath, message, { mainError, backupError })
      }
    }
  }

  private async writeUnlocked(value: T, keepPreviousAsBackup = true): Promise<void> {
    if (!this.options.validate(value)) {
      throw new AtomicJsonStoreError('invalid', this.filePath, `Refusing to write invalid JSON state: ${this.filePath}`)
    }

    const directory = path.dirname(this.filePath)
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    const tempPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)

    try {
      if (keepPreviousAsBackup) {
        try {
          const previous = await this.readValidated(this.filePath)
          await this.writeFileAtomically(this.backupPath, `${JSON.stringify(previous, null, 2)}\n`)
        } catch (error: any) {
          if (error?.code !== 'ENOENT') this.warn(`Previous JSON was not eligible for backup: ${this.filePath}`, error)
        }
      }
      await this.writeFileAtomically(this.filePath, serialized, tempPath)
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => undefined)
      if (error instanceof AtomicJsonStoreError) throw error
      throw new AtomicJsonStoreError('io', this.filePath, `Atomic JSON write failed: ${this.filePath}`, error)
    }
  }

  private async writeFileAtomically(targetPath: string, contents: string, suppliedTempPath?: string) {
    const directory = path.dirname(targetPath)
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
    const tempPath = suppliedTempPath ?? path.join(
      directory,
      `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    )
    const handle = await fs.promises.open(tempPath, 'wx', this.options.mode)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.promises.chmod(tempPath, this.options.mode)
    await fs.promises.rename(tempPath, targetPath)
    await fsyncParentDirectory(targetPath)
  }

  async read(): Promise<T> {
    return withFileLock(this.filePath, () => this.readUnlocked())
  }

  async write(value: T): Promise<void> {
    await withFileLock(this.filePath, () => this.writeUnlocked(value))
  }

  async update(mutator: (current: T) => T | Promise<T>, expectedRevision?: number): Promise<T> {
    return withFileLock(this.filePath, async () => {
      const current = await this.readUnlocked()
      const currentRevision = typeof (current as any)?.revision === 'number' ? (current as any).revision : undefined
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        throw new AtomicJsonStoreError(
          'revision_conflict',
          this.filePath,
          `JSON revision changed (expected ${expectedRevision}, got ${String(currentRevision)})`,
        )
      }
      const next = await mutator(structuredClone(current))
      if (currentRevision !== undefined && typeof (next as any)?.revision === 'number') {
        ;(next as any).revision = currentRevision + 1
      }
      await this.writeUnlocked(next)
      return next
    })
  }
}

export const isVersionedRecord = (value: unknown): value is { schemaVersion: number; revision: number } => {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Number.isInteger((value as any).schemaVersion) &&
    (value as any).schemaVersion > 0 &&
    Number.isInteger((value as any).revision) &&
    (value as any).revision >= 0,
  )
}

export const atomicWriteJsonSync = (
  filePath: string,
  value: unknown,
  options: { mode?: number; keepBackup?: boolean } = {},
) => {
  const resolved = path.resolve(filePath)
  const directory = path.dirname(resolved)
  const mode = options.mode ?? 0o600
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  const writeTarget = (target: string, contents: Buffer | string) => {
    const temp = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
    const fd = fs.openSync(temp, 'wx', mode)
    try {
      fs.writeFileSync(fd, contents)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(temp, mode)
    fs.renameSync(temp, target)
  }
  if (options.keepBackup !== false && fs.existsSync(resolved)) {
    try {
      const previous = fs.readFileSync(resolved)
      JSON.parse(previous.toString('utf8'))
      writeTarget(`${resolved}.bak`, previous)
    } catch { /* invalid prior state is never promoted to backup */ }
  }
  writeTarget(resolved, serialized)
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY)
    try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
  }
}
