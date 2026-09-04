import path from 'node:path'
import crypto from 'node:crypto'
import { AtomicJsonStore, isVersionedRecord } from './atomicJsonStore'

const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 })
const ADMIN_USERNAME = '__admin__'
const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ADMIN_ACCESS_TTL_MS = 12 * 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface PasswordHash {
  algorithm: 'scrypt'
  salt: string
  hash: string
  N: 32768
  r: 8
  p: 1
  keylen: 32
}

interface EncryptedCompatibilityPassword {
  algorithm: 'aes-256-gcm'
  schemaVersion: 1
  iv: string
  tag: string
  ciphertext: string
}

export interface CredentialRecord {
  username: string
  kind: 'admin' | 'user'
  credentialVersion: number
  password: PasswordHash
  compatibility: EncryptedCompatibilityPassword
  weakPassword: boolean
  migratedAt: number
}

interface CredentialFile {
  schemaVersion: 1
  revision: number
  credentials: CredentialRecord[]
}

interface SessionRecord {
  sid: string
  username: string
  kind: 'admin' | 'user'
  credentialVersion: number
  accessDigest: string
  refreshDigest: string
  createdAt: number
  accessExpiresAt: number
  refreshExpiresAt: number
  revokedAt?: number
}

interface SessionFile {
  schemaVersion: 1
  revision: number
  sessions: SessionRecord[]
}

interface ApiTokenRecord {
  id: string
  username: string
  name: string
  digest: string
  hint: string
  createdAt: number
  expiresAt: number | null
  lastUsed?: number
  disabled?: boolean
}

interface ApiTokenFile {
  schemaVersion: 1
  revision: number
  tokens: ApiTokenRecord[]
  enabledUsers: Record<string, boolean>
}

const isHash = (value: any): value is PasswordHash => value?.algorithm === 'scrypt' &&
  typeof value.salt === 'string' && typeof value.hash === 'string' &&
  value.N === SCRYPT.N && value.r === SCRYPT.r && value.p === SCRYPT.p && value.keylen === SCRYPT.keylen

const isCompatibility = (value: any): value is EncryptedCompatibilityPassword => value?.algorithm === 'aes-256-gcm' &&
  value.schemaVersion === 1 && typeof value.iv === 'string' && typeof value.tag === 'string' && typeof value.ciphertext === 'string'

const isCredentialFile = (value: unknown): value is CredentialFile => isVersionedRecord(value) &&
  (value as any).schemaVersion === 1 && Array.isArray((value as any).credentials) &&
  (value as any).credentials.every((record: any) => typeof record?.username === 'string' &&
    ['admin', 'user'].includes(record.kind) && Number.isInteger(record.credentialVersion) &&
    record.credentialVersion > 0 && isHash(record.password) && isCompatibility(record.compatibility) &&
    typeof record.weakPassword === 'boolean' && Number.isFinite(record.migratedAt))

const isSessionFile = (value: unknown): value is SessionFile => isVersionedRecord(value) &&
  (value as any).schemaVersion === 1 && Array.isArray((value as any).sessions) &&
  (value as any).sessions.every((record: any) => typeof record?.sid === 'string' &&
    typeof record.username === 'string' && ['admin', 'user'].includes(record.kind) &&
    Number.isInteger(record.credentialVersion) && typeof record.accessDigest === 'string' &&
    typeof record.refreshDigest === 'string' && Number.isFinite(record.createdAt) &&
    Number.isFinite(record.accessExpiresAt) && Number.isFinite(record.refreshExpiresAt))

const isApiTokenFile = (value: unknown): value is ApiTokenFile => isVersionedRecord(value) &&
  (value as any).schemaVersion === 1 && Array.isArray((value as any).tokens) &&
  Boolean((value as any).enabledUsers) && typeof (value as any).enabledUsers === 'object' &&
  !Array.isArray((value as any).enabledUsers) &&
  Object.values((value as any).enabledUsers).every(enabled => typeof enabled === 'boolean') &&
  (value as any).tokens.every((record: any) => typeof record?.id === 'string' &&
    typeof record.username === 'string' && typeof record.name === 'string' && typeof record.digest === 'string' && typeof record.hint === 'string' &&
    Number.isFinite(record.createdAt) && (record.expiresAt === null || Number.isFinite(record.expiresAt)))

const scrypt = async (password: string, salt: Buffer) => await new Promise<Buffer>((resolve, reject) => {
  crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (error, result) => {
    if (error) reject(error)
    else resolve(result as Buffer)
  })
})

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const base64urlJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

const safeEqual = (left: Buffer, right: Buffer) => left.length === right.length && crypto.timingSafeEqual(left, right)

export class AuthServiceError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'AuthServiceError'
  }
}

export interface AuthenticatedSession {
  sid: string
  username: string
  kind: 'admin' | 'user'
  credentialVersion: number
}

export class AuthService {
  readonly enabled: boolean
  readonly allowLegacyAdminHeader: boolean
  private readonly masterKey: Buffer | null
  private readonly signingKey: Buffer | null
  private readonly credentials: AtomicJsonStore<CredentialFile>
  private readonly sessions: AtomicJsonStore<SessionFile>
  private readonly apiTokens: AtomicJsonStore<ApiTokenFile>
  private credentialCache = new Map<string, CredentialRecord>()
  private sessionCache = new Map<string, SessionRecord>()
  private apiTokenCache = new Map<string, ApiTokenRecord>()
  private apiTokenEnabledUsers = new Map<string, boolean>()
  private apiTokenLastUsedPersistedAt = new Map<string, number>()
  private initialized = false
  private failures = new Map<string, number[]>()

  constructor(dataPath: string, masterKeyBase64 = process.env.AUTH_MASTER_KEY || '') {
    let masterKey: Buffer | null = null
    try {
      const decoded = Buffer.from(masterKeyBase64, 'base64')
      if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === masterKeyBase64.trim().replace(/=+$/, '')) masterKey = decoded
    } catch { /* handled below */ }
    this.masterKey = masterKey
    this.enabled = Boolean(masterKey)
    this.allowLegacyAdminHeader = process.env.AUTH_ALLOW_LEGACY_ADMIN_HEADER === 'true'
    this.signingKey = masterKey
      ? Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from('yinyun-auth-signing-v1'), 32))
      : null

    const authPath = path.join(dataPath, 'auth')
    this.credentials = new AtomicJsonStore(path.join(authPath, 'credentials.json'), {
      validate: isCredentialFile,
      createDefault: () => ({ schemaVersion: 1, revision: 0, credentials: [] }),
      mode: 0o600,
      critical: true,
    })
    this.sessions = new AtomicJsonStore(path.join(authPath, 'sessions.json'), {
      validate: isSessionFile,
      createDefault: () => ({ schemaVersion: 1, revision: 0, sessions: [] }),
      mode: 0o600,
      critical: true,
    })
    this.apiTokens = new AtomicJsonStore(path.join(authPath, 'api-tokens.json'), {
      validate: isApiTokenFile,
      createDefault: () => ({ schemaVersion: 1, revision: 0, tokens: [], enabledUsers: {} }),
      mode: 0o600,
      critical: true,
    })
  }

  getSigningSecret() {
    if (!this.signingKey) throw new AuthServiceError(503, 'auth_master_key_missing', 'AUTH_MASTER_KEY 未配置')
    return this.signingKey.toString('base64url')
  }

  private requireEnabled() {
    if (!this.enabled || !this.masterKey || !this.signingKey) {
      throw new AuthServiceError(503, 'auth_master_key_missing', 'AUTH_MASTER_KEY 未配置，认证迁移和新会话已中止')
    }
  }

  private cacheKey(username: string, kind: 'admin' | 'user') {
    return `${kind}:${username}`
  }

  private async createCredential(username: string, kind: 'admin' | 'user', password: string): Promise<CredentialRecord> {
    this.requireEnabled()
    const salt = crypto.randomBytes(16)
    const hash = await scrypt(password, salt)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey!, iv)
    cipher.setAAD(Buffer.from(`${username}:1`, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
    const minimum = kind === 'admin' ? 12 : 8
    return {
      username,
      kind,
      credentialVersion: 1,
      password: {
        algorithm: 'scrypt',
        salt: salt.toString('base64'),
        hash: hash.toString('base64'),
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        keylen: SCRYPT.keylen,
      },
      compatibility: {
        algorithm: 'aes-256-gcm',
        schemaVersion: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
      weakPassword: password.length < minimum,
      migratedAt: Date.now(),
    }
  }

  async initialize(legacy: { users: Array<{ name: string; password?: string }>; adminPassword?: string }) {
    if (!this.enabled) {
      this.initialized = true
      return { migrated: false, reason: 'AUTH_MASTER_KEY missing' }
    }

    let credentialFile = await this.credentials.read()
    const additions: CredentialRecord[] = []
    if (legacy.adminPassword && !credentialFile.credentials.some(item => item.kind === 'admin')) {
      additions.push(await this.createCredential(ADMIN_USERNAME, 'admin', legacy.adminPassword))
    }
    for (const user of legacy.users) {
      if (credentialFile.credentials.some(item => item.kind === 'user' && item.username === user.name)) continue
      if (!user.password) throw new AuthServiceError(503, 'legacy_password_missing', `用户 ${user.name} 缺少可迁移密码`)
      additions.push(await this.createCredential(user.name, 'user', user.password))
    }
    if (additions.length) {
      credentialFile = await this.credentials.update(file => ({ ...file, credentials: [...file.credentials, ...additions] }))
    }
    this.credentialCache = new Map(credentialFile.credentials.map(item => [this.cacheKey(item.username, item.kind), item]))

    const now = Date.now()
    const sessionFile = await this.sessions.update(file => ({
      ...file,
      sessions: file.sessions.filter(item => !item.revokedAt && item.refreshExpiresAt > now),
    }))
    this.sessionCache = new Map(sessionFile.sessions.map(item => [item.sid, item]))
    const tokenFile = await this.apiTokens.read()
    this.apiTokenCache = new Map(tokenFile.tokens.map(item => [item.digest, item]))
    this.apiTokenEnabledUsers = new Map(Object.entries(tokenFile.enabledUsers || {}))
    this.initialized = true
    return { migrated: additions.length > 0, credentialCount: credentialFile.credentials.length }
  }

  private requireInitialized() {
    if (!this.initialized) throw new AuthServiceError(503, 'auth_not_initialized', '认证服务尚未初始化')
    this.requireEnabled()
  }

  private async verifyCredential(record: CredentialRecord | undefined, password: string) {
    if (!record) {
      await scrypt(password, crypto.randomBytes(16))
      return false
    }
    const actual = await scrypt(password, Buffer.from(record.password.salt, 'base64'))
    return safeEqual(actual, Buffer.from(record.password.hash, 'base64'))
  }

  private failureKey(username: string, ip: string) {
    return `${username}\n${ip}`
  }

  private async rateLimit(username: string, ip: string) {
    const key = this.failureKey(username, ip)
    const now = Date.now()
    const recent = (this.failures.get(key) ?? []).filter(time => time > now - 10 * 60 * 1000)
    this.failures.set(key, recent)
    if (recent.length >= 5) {
      const delay = Math.min(5000, 500 * (recent.length - 4))
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  private recordFailure(username: string, ip: string) {
    const key = this.failureKey(username, ip)
    this.failures.set(key, [...(this.failures.get(key) ?? []), Date.now()])
  }

  private signToken(payload: Record<string, unknown>) {
    const body = base64urlJson({ ...payload, nonce: crypto.randomBytes(16).toString('base64url') })
    const signature = crypto.createHmac('sha256', this.signingKey!).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  private parseToken(token: string): Record<string, any> | null {
    const [body, signature, extra] = token.split('.')
    if (!body || !signature || extra) return null
    const expected = crypto.createHmac('sha256', this.signingKey!).update(body).digest()
    let actual: Buffer
    try { actual = Buffer.from(signature, 'base64url') } catch { return null }
    if (!safeEqual(actual, expected)) return null
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  }

  private async issueSession(record: CredentialRecord) {
    const now = Date.now()
    const sid = crypto.randomUUID()
    const accessToken = this.signToken({ sid, cv: record.credentialVersion, kind: record.kind, typ: 'access' })
    const refreshToken = this.signToken({ sid, cv: record.credentialVersion, kind: record.kind, typ: 'refresh' })
    const session: SessionRecord = {
      sid,
      username: record.username,
      kind: record.kind,
      credentialVersion: record.credentialVersion,
      accessDigest: sha256(accessToken),
      refreshDigest: sha256(refreshToken),
      createdAt: now,
      accessExpiresAt: now + (record.kind === 'admin' ? ADMIN_ACCESS_TTL_MS : ACCESS_TTL_MS),
      refreshExpiresAt: now + REFRESH_TTL_MS,
    }
    await this.sessions.update(file => ({ ...file, sessions: [...file.sessions, session] }))
    this.sessionCache.set(sid, session)
    return {
      token: accessToken,
      accessToken,
      refreshToken,
      sid,
      expiresAt: session.accessExpiresAt,
      username: record.kind === 'admin' ? 'admin' : record.username,
      credentialVersion: record.credentialVersion,
    }
  }

  private async login(kind: 'admin' | 'user', username: string, password: string, ip: string) {
    this.requireInitialized()
    await this.rateLimit(username, ip)
    const record = this.credentialCache.get(this.cacheKey(username, kind))
    if (!await this.verifyCredential(record, password)) {
      this.recordFailure(username, ip)
      return null
    }
    this.failures.delete(this.failureKey(username, ip))
    return this.issueSession(record!)
  }

  async loginAdmin(password: string, ip: string) {
    return this.login('admin', ADMIN_USERNAME, password, ip)
  }

  async loginUser(username: string, password: string, ip: string) {
    return this.login('user', username, password, ip)
  }

  verifyAccessToken(token: string, expectedKind?: 'admin' | 'user'): AuthenticatedSession | null {
    if (!this.enabled || !this.initialized || !this.signingKey) return null
    const payload = this.parseToken(token)
    if (!payload || payload.typ !== 'access' || typeof payload.sid !== 'string') return null
    const session = this.sessionCache.get(payload.sid)
    if (!session || session.revokedAt || session.accessExpiresAt <= Date.now()) return null
    if (expectedKind && session.kind !== expectedKind) return null
    if (payload.cv !== session.credentialVersion || payload.kind !== session.kind) return null
    if (!safeEqual(Buffer.from(sha256(token)), Buffer.from(session.accessDigest))) return null
    const credential = this.credentialCache.get(this.cacheKey(session.username, session.kind))
    if (!credential || credential.credentialVersion !== session.credentialVersion) return null
    return {
      sid: session.sid,
      username: session.kind === 'admin' ? 'admin' : session.username,
      kind: session.kind,
      credentialVersion: session.credentialVersion,
    }
  }

  verifyApiToken(token: string): string | null {
    if (!this.enabled || !this.initialized) return null
    const record = this.apiTokenCache.get(sha256(token))
    if (!record || this.apiTokenEnabledUsers.get(record.username) === false || record.disabled || (record.expiresAt && record.expiresAt <= Date.now())) return null
    const now = Date.now()
    record.lastUsed = now
    if ((this.apiTokenLastUsedPersistedAt.get(record.digest) || 0) < now - 60_000) {
      this.apiTokenLastUsedPersistedAt.set(record.digest, now)
      void this.apiTokens.update(file => {
        const persisted = file.tokens.find(item => item.digest === record.digest)
        if (persisted) persisted.lastUsed = now
        return file
      }).catch(error => console.warn('[Auth] Failed to persist API token use', error?.message || error))
    }
    return record.username
  }

  private publicApiToken(record: ApiTokenRecord) {
    return {
      id: record.id,
      name: record.name,
      tokenMasked: record.hint,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastUsed: record.lastUsed,
      disabled: record.disabled === true,
    }
  }

  async importLegacyApiTokens(entries: Array<{
    username: string
    enabled: boolean
    tokens: Array<{ token: string; name?: string; createdAt?: number; expiresAt?: number | null; lastUsed?: number; disabled?: boolean }>
  }>) {
    this.requireInitialized()
    const next = await this.apiTokens.update(file => {
      const existing = new Set(file.tokens.map(item => item.digest))
      const tokens = [...file.tokens]
      const enabledUsers = { ...(file.enabledUsers || {}) }
      for (const entry of entries) {
        enabledUsers[entry.username] = entry.enabled !== false
        for (const legacy of entry.tokens) {
          if (typeof legacy.token !== 'string' || !legacy.token) continue
          const digest = sha256(legacy.token)
          if (existing.has(digest)) continue
          existing.add(digest)
          tokens.push({
            id: `legacy_${digest.slice(0, 24)}`,
            username: entry.username,
            name: String(legacy.name || '迁移 Token').slice(0, 100),
            digest,
            hint: `${legacy.token.slice(0, 6)}...${legacy.token.slice(-4)}`,
            createdAt: Number.isFinite(legacy.createdAt) ? Number(legacy.createdAt) : Date.now(),
            expiresAt: legacy.expiresAt == null ? null : Number(legacy.expiresAt),
            lastUsed: Number.isFinite(legacy.lastUsed) ? Number(legacy.lastUsed) : undefined,
            disabled: legacy.disabled === true,
          })
        }
      }
      return { ...file, tokens, enabledUsers }
    })
    this.apiTokenCache = new Map(next.tokens.map(item => [item.digest, item]))
    this.apiTokenEnabledUsers = new Map(Object.entries(next.enabledUsers || {}))
    return next.tokens.length
  }

  listApiTokens(username: string) {
    this.requireInitialized()
    return {
      enabled: this.apiTokenEnabledUsers.get(username) !== false,
      tokens: [...this.apiTokenCache.values()].filter(item => item.username === username).map(item => this.publicApiToken(item)),
    }
  }

  async setApiTokenAuthEnabled(username: string, enabled: boolean) {
    this.requireInitialized()
    const next = await this.apiTokens.update(file => ({
      ...file,
      enabledUsers: { ...(file.enabledUsers || {}), [username]: enabled },
    }))
    this.apiTokenEnabledUsers = new Map(Object.entries(next.enabledUsers || {}))
  }

  async createApiToken(username: string, input: { name?: string; expiresAt?: number | null }) {
    this.requireInitialized()
    const token = `lx_tk_${crypto.randomBytes(32).toString('hex')}`
    const record: ApiTokenRecord = {
      id: crypto.randomUUID(),
      username,
      name: String(input.name || '未命名 Token').trim().slice(0, 100) || '未命名 Token',
      digest: sha256(token),
      hint: `${token.slice(0, 6)}...${token.slice(-4)}`,
      createdAt: Date.now(),
      expiresAt: input.expiresAt == null ? null : Number(input.expiresAt),
    }
    const next = await this.apiTokens.update(file => ({ ...file, tokens: [...file.tokens, record] }))
    this.apiTokenCache = new Map(next.tokens.map(item => [item.digest, item]))
    return { token, metadata: this.publicApiToken(record) }
  }

  private findApiToken(username: string, identifier: string) {
    const digestValue = identifier.startsWith('lx_tk_') ? sha256(identifier) : ''
    return [...this.apiTokenCache.values()].find(item => item.username === username && (
      item.id === identifier || item.hint === identifier || (digestValue && item.digest === digestValue)
    ))
  }

  async removeApiToken(username: string, identifier: string) {
    this.requireInitialized()
    const record = this.findApiToken(username, identifier)
    if (!record) return false
    const next = await this.apiTokens.update(file => ({ ...file, tokens: file.tokens.filter(item => item.id !== record.id) }))
    this.apiTokenCache = new Map(next.tokens.map(item => [item.digest, item]))
    return true
  }

  async updateApiToken(username: string, identifier: string, patch: { name?: string; expiresAt?: number | null; disabled?: boolean }) {
    this.requireInitialized()
    const record = this.findApiToken(username, identifier)
    if (!record) return null
    const next = await this.apiTokens.update(file => {
      const target = file.tokens.find(item => item.id === record.id)
      if (!target) return file
      if (patch.name !== undefined) target.name = String(patch.name).trim().slice(0, 100) || target.name
      if (patch.expiresAt !== undefined) target.expiresAt = patch.expiresAt == null ? null : Number(patch.expiresAt)
      if (patch.disabled !== undefined) target.disabled = patch.disabled === true
      return file
    })
    this.apiTokenCache = new Map(next.tokens.map(item => [item.digest, item]))
    return this.publicApiToken(next.tokens.find(item => item.id === record.id)!)
  }

  async rotateRefreshToken(refreshToken: string) {
    this.requireInitialized()
    const payload = this.parseToken(refreshToken)
    if (!payload || payload.typ !== 'refresh' || typeof payload.sid !== 'string') return null
    const current = this.sessionCache.get(payload.sid)
    if (!current || current.revokedAt || current.refreshExpiresAt <= Date.now()) return null
    if (!safeEqual(Buffer.from(sha256(refreshToken)), Buffer.from(current.refreshDigest))) return null
    const credential = this.credentialCache.get(this.cacheKey(current.username, current.kind))
    if (!credential || credential.credentialVersion !== current.credentialVersion) return null
    await this.revokeSession(current.sid)
    return this.issueSession(credential)
  }

  async revokeSession(sid: string) {
    const cached = this.sessionCache.get(sid)
    if (!cached || cached.revokedAt) return
    const revokedAt = Date.now()
    await this.sessions.update(file => {
      const session = file.sessions.find(item => item.sid === sid)
      if (session) session.revokedAt = revokedAt
      return file
    })
    cached.revokedAt = revokedAt
  }

  async logoutToken(token: string) {
    const session = this.verifyAccessToken(token)
    if (session) await this.revokeSession(session.sid)
  }

  decryptCompatibilityPassword(username: string): string {
    this.requireInitialized()
    const kind = username === ADMIN_USERNAME ? 'admin' : 'user'
    const record = this.credentialCache.get(this.cacheKey(username, kind))
    if (!record) throw new AuthServiceError(404, 'credential_not_found', '用户凭据不存在')
    const encrypted = record.compatibility
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey!, Buffer.from(encrypted.iv, 'base64'))
    decipher.setAAD(Buffer.from(`${username}:${encrypted.schemaVersion}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }

  verifyCompatibilityPassword(username: string, password: string) {
    if (!this.enabled || !this.initialized) return false
    try {
      return safeEqual(Buffer.from(this.decryptCompatibilityPassword(username)), Buffer.from(password))
    } catch {
      return false
    }
  }

  verifySubsonicToken(username: string, token: string, salt: string) {
    if (!this.enabled || !this.initialized) return false
    try {
      const expected = crypto.createHash('md5').update(this.decryptCompatibilityPassword(username) + salt).digest('hex')
      return safeEqual(Buffer.from(expected), Buffer.from(token.toLowerCase()))
    } catch {
      return false
    }
  }

  async setPassword(username: string, kind: 'admin' | 'user', password: string, allowWeakMigration = false) {
    this.requireInitialized()
    const minimum = kind === 'admin' ? 12 : 8
    if (!allowWeakMigration && password.length < minimum) {
      throw new AuthServiceError(400, 'password_too_short', `${kind === 'admin' ? '管理员' : '用户'}密码至少 ${minimum} 位`)
    }
    const next = await this.createCredential(kind === 'admin' ? ADMIN_USERNAME : username, kind, password)
    const existing = this.credentialCache.get(this.cacheKey(next.username, kind))
    next.credentialVersion = (existing?.credentialVersion ?? 0) + 1
    const file = await this.credentials.update(current => ({
      ...current,
      credentials: [...current.credentials.filter(item => !(item.username === next.username && item.kind === kind)), next],
    }))
    this.credentialCache = new Map(file.credentials.map(item => [this.cacheKey(item.username, item.kind), item]))
    const revokeAt = Date.now()
    const sessions = await this.sessions.update(current => {
      for (const session of current.sessions) {
        if (session.username === next.username && session.kind === kind && !session.revokedAt) session.revokedAt = revokeAt
      }
      return current
    })
    this.sessionCache = new Map(sessions.sessions.map(item => [item.sid, item]))
    return { credentialVersion: next.credentialVersion, weakPassword: next.weakPassword }
  }

  async renameUser(oldUsername: string, newUsername: string) {
    this.requireInitialized()
    if (oldUsername === newUsername) return
    const oldRecord = this.credentialCache.get(this.cacheKey(oldUsername, 'user'))
    if (!oldRecord) throw new AuthServiceError(404, 'credential_not_found', '用户凭据不存在')
    if (this.credentialCache.has(this.cacheKey(newUsername, 'user'))) {
      throw new AuthServiceError(409, 'credential_exists', '目标用户凭据已存在')
    }
    const password = this.decryptCompatibilityPassword(oldUsername)
    const next = await this.createCredential(newUsername, 'user', password)
    next.credentialVersion = oldRecord.credentialVersion + 1
    const credentials = await this.credentials.update(file => ({
      ...file,
      credentials: [...file.credentials.filter(item => !(item.kind === 'user' && item.username === oldUsername)), next],
    }))
    this.credentialCache = new Map(credentials.credentials.map(item => [this.cacheKey(item.username, item.kind), item]))
    await this.revokeUserSessions(oldUsername)
  }

  async deleteUser(username: string) {
    this.requireInitialized()
    const credentials = await this.credentials.update(file => ({
      ...file,
      credentials: file.credentials.filter(item => !(item.kind === 'user' && item.username === username)),
    }))
    this.credentialCache = new Map(credentials.credentials.map(item => [this.cacheKey(item.username, item.kind), item]))
    await this.revokeUserSessions(username)
    const tokenFile = await this.apiTokens.update(file => ({
      ...file,
      tokens: file.tokens.filter(item => item.username !== username),
      enabledUsers: Object.fromEntries(Object.entries(file.enabledUsers || {}).filter(([name]) => name !== username)),
    }))
    this.apiTokenCache = new Map(tokenFile.tokens.map(item => [item.digest, item]))
  }

  private async revokeUserSessions(username: string) {
    const revokedAt = Date.now()
    const sessions = await this.sessions.update(file => {
      for (const session of file.sessions) {
        if (session.kind === 'user' && session.username === username && !session.revokedAt) session.revokedAt = revokedAt
      }
      return file
    })
    this.sessionCache = new Map(sessions.sessions.map(item => [item.sid, item]))
  }

  getCredentialStates() {
    return [...this.credentialCache.values()]
      .filter(item => item.kind === 'user')
      .map(item => ({
        name: item.username,
        passwordConfigured: true,
        credentialVersion: item.credentialVersion,
        weakPassword: item.weakPassword,
      }))
  }

  verifyMigrationCompleteness(usernames: string[]) {
    this.requireInitialized()
    const admin = this.credentialCache.get(this.cacheKey(ADMIN_USERNAME, 'admin'))
    if (!admin) throw new AuthServiceError(409, 'admin_credential_missing', '管理员凭据尚未迁移')
    this.decryptCompatibilityPassword(ADMIN_USERNAME)
    for (const username of usernames) {
      const credential = this.credentialCache.get(this.cacheKey(username, 'user'))
      if (!credential) throw new AuthServiceError(409, 'user_credential_missing', `用户 ${username} 的凭据尚未迁移`)
      this.decryptCompatibilityPassword(username)
    }
    return true
  }
}

export const getBearerToken = (authorization: string | string[] | undefined) => {
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  const match = typeof value === 'string' ? value.match(/^Bearer\s+(.+)$/i) : null
  return match?.[1]?.trim() || ''
}

let activeAuthService: AuthService | null = null

export const setActiveAuthService = (service: AuthService) => {
  activeAuthService = service
}

export const getActiveAuthService = () => activeAuthService
