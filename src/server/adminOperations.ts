import path from 'node:path'
import crypto from 'node:crypto'
import { AtomicJsonStore, isVersionedRecord } from './atomicJsonStore'

export type AdminOperationKind = 'playlist-repair' | 'source-sync' | 'playlist-sync'
export type AdminOperationState = 'previewed' | 'applying' | 'completed' | 'rolled_back' | 'failed'

export interface AdminOperationRecord {
  id: string
  kind: AdminOperationKind
  state: AdminOperationState
  adminSid: string
  inputHash: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  confirmationDigest: string
  confirmationConsumedAt?: number
  preview: unknown
  journal?: unknown
  result?: unknown
  error?: string
}

interface AdminOperationFile {
  schemaVersion: 1
  revision: number
  operations: AdminOperationRecord[]
}

const isOperationRecord = (value: unknown): value is AdminOperationRecord => {
  if (!value || typeof value !== 'object') return false
  const item = value as any
  return typeof item.id === 'string' &&
    ['playlist-repair', 'source-sync', 'playlist-sync'].includes(item.kind) &&
    ['previewed', 'applying', 'completed', 'rolled_back', 'failed'].includes(item.state) &&
    typeof item.adminSid === 'string' &&
    typeof item.inputHash === 'string' &&
    typeof item.confirmationDigest === 'string' &&
    Number.isFinite(item.createdAt) &&
    Number.isFinite(item.updatedAt) &&
    Number.isFinite(item.expiresAt)
}

const isOperationFile = (value: unknown): value is AdminOperationFile => isVersionedRecord(value) &&
  (value as any).schemaVersion === 1 &&
  Array.isArray((value as any).operations) &&
  (value as any).operations.every(isOperationRecord)

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

const timingSafeTextEqual = (left: string, right: string) => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export class AdminOperationError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'AdminOperationError'
  }
}

export class AdminOperationManager {
  private readonly store: AtomicJsonStore<AdminOperationFile>
  private readonly ttlMs: number
  private readonly retentionMs: number

  constructor(dataPath: string, options: { ttlMs?: number; retentionMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.retentionMs = options.retentionMs ?? 90 * 24 * 60 * 60 * 1000
    this.store = new AtomicJsonStore(path.join(dataPath, 'admin-operations', 'operations.json'), {
      validate: isOperationFile,
      critical: true,
      mode: 0o600,
      createDefault: () => ({ schemaVersion: 1, revision: 0, operations: [] }),
      onWarning: (message, error) => console.warn('[AdminOperations]', message, error || ''),
    })
  }

  private prune(operations: AdminOperationRecord[], now = Date.now()) {
    return operations.filter(operation => operation.updatedAt >= now - this.retentionMs || operation.state === 'applying')
  }

  async createPreview(input: {
    kind: AdminOperationKind
    adminSid: string
    inputHash: string
    preview: unknown
    journal?: unknown
  }) {
    const now = Date.now()
    const id = `${input.kind}_${now}_${crypto.randomBytes(8).toString('hex')}`
    const confirmationToken = crypto.randomBytes(32).toString('base64url')
    const record: AdminOperationRecord = {
      id,
      kind: input.kind,
      state: 'previewed',
      adminSid: input.adminSid,
      inputHash: input.inputHash,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      confirmationDigest: digest(confirmationToken),
      preview: input.preview,
      journal: input.journal,
    }
    await this.store.update(file => ({
      ...file,
      operations: [...this.prune(file.operations, now), record],
    }))
    return { operation: this.publicRecord(record), confirmationToken }
  }

  async consumeConfirmation(input: {
    operationId: string
    confirmationToken: string
    adminSid: string
    currentInputHash: string
  }): Promise<AdminOperationRecord> {
    let consumed: AdminOperationRecord | null = null
    await this.store.update(file => {
      const record = file.operations.find(operation => operation.id === input.operationId)
      if (!record) throw new AdminOperationError(404, 'operation_not_found', '操作不存在')
      if (record.adminSid !== input.adminSid) throw new AdminOperationError(403, 'confirmation_session_mismatch', '确认令牌不属于当前管理员会话')
      if (record.state !== 'previewed' || record.confirmationConsumedAt) {
        throw new AdminOperationError(409, 'confirmation_already_used', '确认令牌已使用或操作状态已变化')
      }
      if (record.expiresAt <= Date.now()) throw new AdminOperationError(409, 'confirmation_expired', '确认令牌已过期，请重新预览')
      if (record.inputHash !== input.currentInputHash) {
        throw new AdminOperationError(409, 'preview_stale', '数据在预览后发生变化，请重新预览')
      }
      if (!timingSafeTextEqual(record.confirmationDigest, digest(input.confirmationToken || ''))) {
        throw new AdminOperationError(403, 'confirmation_invalid', '确认令牌无效')
      }
      record.state = 'applying'
      record.confirmationConsumedAt = Date.now()
      record.updatedAt = Date.now()
      consumed = structuredClone(record)
      return file
    })
    if (!consumed) throw new AdminOperationError(500, 'confirmation_failed', '无法确认操作')
    return consumed
  }

  async update(
    operationId: string,
    state: Exclude<AdminOperationState, 'previewed'>,
    patch: { journal?: unknown; result?: unknown; error?: string } = {},
  ) {
    let updated: AdminOperationRecord | null = null
    await this.store.update(file => {
      const record = file.operations.find(operation => operation.id === operationId)
      if (!record) throw new AdminOperationError(404, 'operation_not_found', '操作不存在')
      record.state = state
      record.updatedAt = Date.now()
      if ('journal' in patch) record.journal = patch.journal
      if ('result' in patch) record.result = patch.result
      if ('error' in patch) record.error = patch.error
      updated = structuredClone(record)
      return file
    })
    return this.publicRecord(updated!)
  }

  async get(operationId: string, adminSid: string) {
    const file = await this.store.read()
    const operation = file.operations.find(item => item.id === operationId)
    if (!operation) throw new AdminOperationError(404, 'operation_not_found', '操作不存在')
    if (operation.adminSid !== adminSid) throw new AdminOperationError(403, 'operation_forbidden', '无权查看该操作')
    return this.publicRecord(operation)
  }

  async listApplying() {
    const file = await this.store.read()
    return file.operations.filter(item => item.state === 'applying').map(item => structuredClone(item))
  }

  private publicRecord(record: AdminOperationRecord) {
    const { confirmationDigest: _confirmationDigest, adminSid: _adminSid, ...safe } = structuredClone(record)
    return safe
  }
}
