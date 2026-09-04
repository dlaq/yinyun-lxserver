import * as fs from 'fs'
import * as path from 'path'
import * as dns from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import { extractMetadata, loadUserApi, initUserApis, getApiStatus } from './userApi'
import { normalizeUsername } from '@/utils/username'
import { getUserSourcePath } from '@/user'
import {
    getSharedUsers,
    isSourceSharedWithUser,
    readSourceShares,
    removeSourceShare,
    setSourceShare,
    writeSourceShares,
} from './customSourceSharing'
import {
    getEnabledSourcePlatforms,
    removeSourcePlatformPreferences,
    setEnabledSourcePlatforms,
} from './customSourcePlatformPreferences'
import { atomicWriteJsonSync } from './atomicJsonStore'
import { getActiveAuthService, getBearerToken } from './authService'

export interface StoredSource {
    id: string
    name: string
    version: string | number
    author: string
    description: string
    homepage: string
    size: number
    supportedSources: string[]
    enabled: boolean
    uploadTime: string
    sourceUrl?: string
    allowUnsafeVM: boolean
    requireUnsafe: boolean
}

export interface AccountSyncSource {
    id: string
    name: string
    version: string | number
    author: string
    description: string
    homepage: string
    supportedSources: string[]
    enabledSources: string[]
    sourceUrl?: string
    content: string
}

const MAX_SOURCE_SCRIPT_BYTES = 2 * 1024 * 1024
const SOURCE_IMPORT_TIMEOUT_MS = 15_000

const readBody = async (req: IncomingMessage, limit = MAX_SOURCE_SCRIPT_BYTES): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversized = false
    req.on('data', chunk => {
        if (oversized) return
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += value.length
        if (size > limit) {
            oversized = true
            reject(new Error('Request body is too large'))
            return
        }
        chunks.push(value)
    })
    req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks).toString('utf-8')) })
    req.on('error', reject)
})

const sendJson = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
}

const assertUsername = (username: string) => {
    let value: string
    try {
        value = normalizeUsername(username)
    } catch {
        throw new Error('Authenticated username required')
    }
    if (!global.lx.config.users.some(user => user.name === value)) {
        throw new Error('User not found')
    }
    return value
}

const getSourceDir = (username: string) => {
    return getUserSourcePath(assertUsername(username))
}

const readSources = (username: string): StoredSource[] => {
    const metaPath = path.join(getSourceDir(username), 'sources.json')
    if (!fs.existsSync(metaPath)) return []
    try {
        const value = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        if (!Array.isArray(value)) throw new Error(`Invalid source metadata for ${username}`)
        return value
    } catch (error: any) {
        throw new Error(`Source metadata is unavailable for ${username}: ${error?.message || error}`)
    }
}

const writeFileAtomic = (filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
        const fd = fs.openSync(tempPath, 'wx', 0o600)
        try {
            fs.writeFileSync(fd, content, 'utf-8')
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        fs.renameSync(tempPath, filePath)
        if (process.platform !== 'win32') {
            const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY)
            try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
        }
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
}

const writeSources = (username: string, sources: StoredSource[]) => {
    const sourcesDir = getSourceDir(username)
    fs.mkdirSync(sourcesDir, { recursive: true })
    atomicWriteJsonSync(path.join(sourcesDir, 'sources.json'), sources, { mode: 0o600 })
}

export const listOwnedSourcesForAdmin = (username: string) => {
    const owner = assertUsername(username)
    return readSources(owner).map(source => ({
        id: source.id,
        name: source.name,
        version: source.version,
        enabled: source.enabled,
        supportedSources: [...source.supportedSources],
        enabledSources: getEnabledSourcePlatforms(owner, owner, source.id, source.supportedSources),
    }))
}

export interface AdminOwnedSourceState {
    username: string
    sources: Array<{
        metadata: StoredSource
        content: string
        enabledSources: string[]
        sharedUsers: string[]
    }>
    order: string[]
}

export const getAdminOwnedSourceState = (username: string): AdminOwnedSourceState => {
    const owner = assertUsername(username)
    const sourceDir = getSourceDir(owner)
    const sources = readSources(owner).map(metadata => {
        const scriptPath = path.join(sourceDir, metadata.id)
        if (!fs.existsSync(scriptPath)) throw new Error(`Source script not found: ${metadata.id}`)
        return {
            metadata: { ...metadata, supportedSources: [...metadata.supportedSources] },
            content: fs.readFileSync(scriptPath, 'utf8'),
            enabledSources: getEnabledSourcePlatforms(owner, owner, metadata.id, metadata.supportedSources),
            sharedUsers: getSharedUsers(owner, metadata.id),
        }
    })
    const sourceIds = new Set(sources.map(item => item.metadata.id))
    const orderPath = path.join(sourceDir, 'order.json')
    let order = sources.map(item => item.metadata.id)
    if (fs.existsSync(orderPath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(orderPath, 'utf8'))
        if (!Array.isArray(parsed) || parsed.some(id => typeof id !== 'string' || !sourceIds.has(id))) {
            throw new Error(`Source order is invalid for ${owner}`)
        }
        order = [...new Set(parsed), ...order.filter(id => !(parsed as string[]).includes(id))] as string[]
    }
    return { username: owner, sources, order }
}

const canonicalState = (state: AdminOwnedSourceState) => ({
    username: state.username,
    order: state.order,
    sources: state.sources.map(item => ({
        metadata: Object.fromEntries(Object.entries(item.metadata).sort(([a], [b]) => a.localeCompare(b))),
        content: item.content,
        enabledSources: item.enabledSources,
        sharedUsers: item.sharedUsers,
    })),
})

export const hashAdminOwnedSourceState = (state: AdminOwnedSourceState) => crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalState(state)))
    .digest('hex')

export const restoreAdminOwnedSourceState = async (state: AdminOwnedSourceState) => {
    const owner = assertUsername(state.username)
    const sourceDir = getSourceDir(owner)
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 })
    const previous = readSources(owner)
    const nextIds = new Set(state.sources.map(item => item.metadata.id))
    for (const item of state.sources) {
        if (!item.metadata.id || path.basename(item.metadata.id) !== item.metadata.id) throw new Error('Invalid source ID in state')
        if (!Array.isArray(item.metadata.supportedSources) || !item.metadata.supportedSources.length) throw new Error(`Invalid source metadata: ${item.metadata.id}`)
        if (!item.content || Buffer.byteLength(item.content, 'utf8') > MAX_SOURCE_SCRIPT_BYTES) throw new Error(`Invalid source script: ${item.metadata.id}`)
        writeFileAtomic(path.join(sourceDir, item.metadata.id), item.content)
    }
    for (const source of previous) {
        if (nextIds.has(source.id)) continue
        const scriptPath = path.join(sourceDir, source.id)
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
        removeSourcePlatformPreferences(owner, source.id)
    }
    writeSources(owner, state.sources.map(item => ({ ...item.metadata, supportedSources: [...item.metadata.supportedSources] })))
    if (state.order.length !== nextIds.size || state.order.some(id => !nextIds.has(id))) throw new Error('Invalid source order in state')
    atomicWriteJsonSync(path.join(sourceDir, 'order.json'), state.order, { mode: 0o600 })

    for (const item of state.sources) {
        setEnabledSourcePlatforms(owner, owner, item.metadata.id, item.enabledSources, item.metadata.supportedSources)
    }
    const retainedShares = readSourceShares().filter(share => share.owner !== owner)
    const restoredShares = state.sources.flatMap(item => item.sharedUsers.length
        ? [{ owner, sourceId: item.metadata.id, targetUsers: item.sharedUsers, sharedAt: new Date().toISOString() }]
        : [])
    writeSourceShares([...retainedShares, ...restoredShares])
    await initUserApis(owner)
    const restored = getAdminOwnedSourceState(owner)
    // sharedAt is intentionally not part of the state/hash; ownership, target
    // users, order, metadata, scripts and platform choices are exact.
    if (hashAdminOwnedSourceState(restored) !== hashAdminOwnedSourceState(state)) {
        throw new Error(`Source state verification failed for ${owner}`)
    }
    return restored
}

export const syncOwnedSourcesForAdmin = async (
    fromUsername: string,
    rawTargetUsers: unknown,
    rawMode: unknown,
    rawSourceIds?: unknown,
) => {
    const owner = assertUsername(fromUsername)
    if (!Array.isArray(rawTargetUsers) || rawTargetUsers.length === 0) throw new Error('At least one target user is required')
    const mode = rawMode === 'overwrite' ? 'overwrite' : rawMode === 'append' ? 'append' : null
    if (!mode) throw new Error('mode must be append or overwrite')
    const targetUsers = [...new Set(rawTargetUsers.map(target => assertUsername(String(target))))].filter(target => target !== owner)
    if (!targetUsers.length) throw new Error('At least one different target user is required')

    const allSources = readSources(owner)
    const selectedIds = rawSourceIds == null
        ? allSources.map(source => source.id)
        : Array.isArray(rawSourceIds)
            ? [...new Set(rawSourceIds.map(id => String(id || '').trim()).filter(Boolean))]
            : []
    if (!selectedIds.length) throw new Error('At least one source is required')
    const selectedSources = selectedIds.map(id => {
        const source = allSources.find(item => item.id === id)
        if (!source) throw new Error(`Source not found: ${id}`)
        const scriptPath = path.join(getSourceDir(owner), source.id)
        if (!fs.existsSync(scriptPath)) throw new Error(`Source script not found: ${source.id}`)
        return {
            source: { ...source, supportedSources: [...source.supportedSources] },
            content: fs.readFileSync(scriptPath, 'utf-8'),
            enabledSources: getEnabledSourcePlatforms(owner, owner, source.id, source.supportedSources),
        }
    })

    const results = []
    for (const targetUser of targetUsers) {
        const targetDir = getSourceDir(targetUser)
        const previous = readSources(targetUser)
        const next = previous.map(source => ({ ...source, supportedSources: [...source.supportedSources] }))
        const copied: string[] = []
        const overwritten: string[] = []
        const skipped: string[] = []

        for (const selected of selectedSources) {
            const existingIndex = next.findIndex(source => source.id === selected.source.id)
            if (existingIndex >= 0 && mode === 'append') {
                skipped.push(selected.source.id)
                continue
            }
            const targetSource: StoredSource = {
                ...selected.source,
                supportedSources: [...selected.source.supportedSources],
                uploadTime: new Date().toISOString(),
            }
            writeFileAtomic(path.join(targetDir, targetSource.id), selected.content)
            if (existingIndex >= 0) {
                next.splice(existingIndex, 1, targetSource)
                removeSourceShare(targetUser, targetSource.id)
                overwritten.push(targetSource.id)
            } else {
                next.push(targetSource)
                copied.push(targetSource.id)
            }
            setEnabledSourcePlatforms(
                targetUser,
                targetUser,
                targetSource.id,
                selected.enabledSources,
                targetSource.supportedSources,
            )
        }

        writeSources(targetUser, next)
        const orderPath = path.join(targetDir, 'order.json')
        writeFileAtomic(orderPath, JSON.stringify(next.map(source => source.id), null, 2))
        await initUserApis(targetUser)
        results.push({ targetUser, copied, overwritten, skipped, total: next.length })
    }
    return { fromUser: owner, mode, results }
}

export const exportOwnedSourcesForSync = (username: string): AccountSyncSource[] => {
    const owner = assertUsername(username)
    const sourceDir = getSourceDir(owner)
    return readSources(owner).flatMap(source => {
        const scriptPath = path.join(sourceDir, source.id)
        if (!fs.existsSync(scriptPath)) return []
        const content = fs.readFileSync(scriptPath, 'utf-8')
        return [{
            id: source.id,
            name: source.name,
            version: source.version,
            author: source.author,
            description: source.description,
            homepage: source.homepage,
            supportedSources: source.supportedSources,
            enabledSources: getEnabledSourcePlatforms(owner, owner, source.id, source.supportedSources),
            sourceUrl: source.sourceUrl,
            content,
        }]
    })
}

export const normalizeAccountSyncSources = (values: unknown): AccountSyncSource[] => {
    if (values == null) return []
    if (!Array.isArray(values)) throw new Error('sources must be an array')

    const normalized: AccountSyncSource[] = []
    const ids = new Set<string>()
    for (const value of values as AccountSyncSource[]) {
        if (!value || typeof value !== 'object') throw new Error('Invalid source snapshot')
        const rawId = value.id || value.name
        if (typeof rawId !== 'string' || !rawId.trim()) throw new Error('Source id is required')
        const id = generateId(rawId.toLowerCase().endsWith('.js') ? rawId.slice(0, -3) : rawId, value.id)
        const content = typeof value.content === 'string' ? value.content : ''
        if (!content || Buffer.byteLength(content, 'utf-8') > 2 * 1024 * 1024) {
            throw new Error(`Invalid source content: ${value.name || id}`)
        }
        const supportedSources = Array.from(new Set((Array.isArray(value.supportedSources) ? value.supportedSources : [])
            .filter(item => typeof item === 'string')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean)))
        if (!supportedSources.length) throw new Error(`Source has no supported platforms: ${value.name || id}`)

        if (ids.has(id)) throw new Error(`Duplicate source: ${value.name || id}`)
        ids.add(id)
        const enabledSources = Array.from(new Set((Array.isArray(value.enabledSources) ? value.enabledSources : supportedSources)
            .filter(item => typeof item === 'string')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean)))
        const supportedSet = new Set(supportedSources)
        const unsupported = enabledSources.find(source => !supportedSet.has(source))
        if (unsupported) throw new Error(`Unsupported platform: ${unsupported}`)

        normalized.push({
            id,
            name: String(value.name || id),
            version: value.version || '1.0.0',
            author: String(value.author || 'Unknown'),
            description: String(value.description || ''),
            homepage: String(value.homepage || ''),
            supportedSources,
            enabledSources,
            sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : undefined,
            content,
        })
    }
    return normalized
}

export const restoreOwnedSourcesFromSync = async (username: string, values: AccountSyncSource[]) => {
    const owner = assertUsername(username)
    const normalized = normalizeAccountSyncSources(values)
    const sourceDir = getSourceDir(owner)
    const previous = readSources(owner)
    if (!previous.length && !normalized.length) return 0
    fs.mkdirSync(sourceDir, { recursive: true })

    const restored: StoredSource[] = []
    const scripts = new Map<string, string>()
    const selectedPlatforms = new Map<string, string[]>()
    for (const value of normalized) {
        scripts.set(value.id, value.content)
        selectedPlatforms.set(value.id, value.enabledSources)
        const source: StoredSource = {
            id: value.id,
            name: value.name,
            version: value.version,
            author: value.author,
            description: value.description,
            homepage: value.homepage,
            size: Buffer.byteLength(value.content, 'utf-8'),
            supportedSources: value.supportedSources,
            enabled: false,
            uploadTime: new Date().toISOString(),
            sourceUrl: value.sourceUrl,
            allowUnsafeVM: false,
            requireUnsafe: false,
        }
        restored.push(source)
    }

    for (const [id, content] of scripts) fs.writeFileSync(path.join(sourceDir, id), content, 'utf-8')
    for (const source of previous) {
        if (restored.some(item => item.id === source.id)) continue
        const scriptPath = path.join(sourceDir, source.id)
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
        removeSourceShare(owner, source.id)
        removeSourcePlatformPreferences(owner, source.id)
    }

    writeSources(owner, restored)
    writeFileAtomic(path.join(sourceDir, 'order.json'), JSON.stringify(restored.map(source => source.id), null, 2))
    for (const source of restored) {
        setEnabledSourcePlatforms(owner, owner, source.id, selectedPlatforms.get(source.id) || source.supportedSources, source.supportedSources)
    }
    await initUserApis(owner)
    return restored.length
}

const generateId = (name?: string, fallbackFilename?: string): string => {
    let input = name || fallbackFilename || 'source'
    try { input = decodeURIComponent(input) } catch { }
    let base = path.basename(input)
    if (base.toLowerCase().endsWith('.js')) base = base.slice(0, -3)
    const clean = base.replace(/[\\/:*?"<>|]/g, '_').trim()
    return `${clean || 'source'}.js`
}

const getScriptInfo = async (scriptContent: string, allowUnsafeVM = false) => {
    const metadata = extractMetadata(scriptContent)
    let supportedSources: string[] = []
    let requireUnsafe = false
    let error = ''
    try {
        const result = await loadUserApi({
            id: 'temp_analysis',
            script: scriptContent,
            enabled: false,
            allowUnsafeVM,
            ...metadata,
            owner: 'temp',
        } as any, false)
        if (result.success && result.apiInstance?.info?.sources) {
            supportedSources = Object.keys(result.apiInstance.info.sources)
        } else {
            requireUnsafe = !!result.requireUnsafe
            error = result.error || 'Failed to initialize source'
        }
    } catch (err: any) {
        error = err.message || String(err)
        console.warn('[CustomSource] Failed to analyze source:', error)
    }
    return { metadata, supportedSources, requireUnsafe, error }
}

const authorizeUnsafeSource = (
    req: IncomingMessage,
    res: ServerResponse,
    requireUnsafe: boolean,
    allowUnsafeVM: boolean,
) => {
    if (!requireUnsafe && !allowUnsafeVM) return true
    if (requireUnsafe && !allowUnsafeVM) {
        sendJson(res, 200, {
            success: false,
            requireUnsafe: true,
            message: 'This source requires unsafe VM mode. Confirm before continuing.',
        })
        return false
    }
    if (!isAdministratorRequest(req)) {
        sendJson(res, 403, { success: false, error: 'Unsafe VM scripts require administrator authorization.' })
        return false
    }
    if (!global.lx.config['system.allowUnsafeVM']) {
        sendJson(res, 200, {
            success: false,
            disabledVM: true,
            error: 'VM_DISABLED',
            message: 'Unsafe VM mode is disabled by the server administrator.',
        })
        return false
    }
    return true
}

const authorizeAdmin = (req: IncomingMessage, res: ServerResponse) => {
    if (isAdministratorRequest(req)) return true
    sendJson(res, 403, { success: false, error: 'Administrator authorization required.' })
    return false
}

const isAdministratorRequest = (req: IncomingMessage) => {
    const auth = getActiveAuthService()
    const token = getBearerToken(req.headers.authorization)
    if (token && auth?.verifyAccessToken(token, 'admin')) return true
    return Boolean(
        auth?.allowLegacyAdminHeader &&
        global.lx.config['frontend.password'] &&
        req.headers['x-frontend-auth'] === global.lx.config['frontend.password'],
    )
}

const saveSource = async (
    req: IncomingMessage,
    res: ServerResponse,
    username: string,
    filename: string,
    content: string,
    allowUnsafeVM: boolean,
    sourceUrl?: string,
) => {
    if (!content || typeof content !== 'string') throw new Error('Invalid script content')
    const owner = assertUsername(username)
    const safeInfo = await getScriptInfo(content)
    const requireUnsafe = safeInfo.requireUnsafe
    if (!authorizeUnsafeSource(req, res, requireUnsafe, allowUnsafeVM)) return
    const scriptInfo = requireUnsafe ? await getScriptInfo(content, true) : safeInfo
    if (scriptInfo.supportedSources.length === 0) {
        throw new Error(scriptInfo.error || 'The script did not register any music sources')
    }
    const { metadata, supportedSources } = scriptInfo

    const sourcesDir = getSourceDir(owner)
    fs.mkdirSync(sourcesDir, { recursive: true })
    const id = generateId(metadata.name, filename)
    const sources = readSources(owner)
    if (sources.some(source => source.id === id)) {
        throw new Error(`Source "${metadata.name || filename}" already exists`)
    }

    fs.writeFileSync(path.join(sourcesDir, id), content, 'utf-8')
    const source: StoredSource = {
        id,
        name: metadata.name || filename,
        version: metadata.version || '1.0.0',
        author: metadata.author || 'Unknown',
        description: metadata.description || '',
        homepage: metadata.homepage || '',
        size: Buffer.byteLength(content, 'utf-8'),
        supportedSources,
        enabled: false,
        uploadTime: new Date().toISOString(),
        sourceUrl,
        allowUnsafeVM: !!requireUnsafe,
        requireUnsafe: !!requireUnsafe,
    }
    sources.push(source)
    writeSources(owner, sources)
    await initUserApis(owner)
    sendJson(res, 200, {
        success: true,
        filename: source.name,
        id,
        metadata,
        supportedSources,
        owner,
        allowUnsafeVM: source.allowUnsafeVM,
    })
}

export const isDisallowedSourceImportAddress = (rawAddress: string): boolean => {
    const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
    const mappedV4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    if (mappedV4) return isDisallowedSourceImportAddress(mappedV4)
    if (net.isIP(address) === 6) {
        return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || /^fe[89ab]/.test(address)
    }
    if (net.isIP(address) !== 4) return true
    const [a, b, c] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
}

const resolvePublicSourceAddresses = async (hostname: string) => {
    const normalizedHostname = hostname.replace(/^\[|\]$/g, '')
    const literalFamily = net.isIP(normalizedHostname)
    const addresses = literalFamily
        ? [{ address: normalizedHostname, family: literalFamily }]
        : await dns.promises.lookup(normalizedHostname, { all: true, verbatim: true })
    if (!addresses.length || addresses.some(item => isDisallowedSourceImportAddress(item.address))) {
        throw new Error('Source URL must resolve only to public network addresses')
    }
    return addresses
}

export const downloadSourceScript = async (targetUrl: string, depth = 0): Promise<string> => {
    if (depth > 5) throw new Error('Too many redirects')
    const parsedUrl = new URL(targetUrl)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Only HTTP and HTTPS URLs are supported')
    }
    if (parsedUrl.username || parsedUrl.password) throw new Error('Source URL credentials are not allowed')
    const addresses = await resolvePublicSourceAddresses(parsedUrl.hostname)
    const protocol = parsedUrl.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
        const request = protocol.get(parsedUrl, {
            // Pin the connection to an address validated above. Re-resolving in
            // the HTTP client would reopen a DNS-rebinding window.
            lookup: ((...args: any[]) => {
                const callback = args[args.length - 1]
                const options = args[1]
                if (options?.all) callback(null, addresses)
                else callback(null, addresses[0].address, addresses[0].family)
            }) as any,
        }, (response: any) => {
            const statusCode = Number(response.statusCode || 0)
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume()
                resolve(downloadSourceScript(new URL(response.headers.location, parsedUrl).toString(), depth + 1))
                return
            }
            if (statusCode !== 200) {
                response.resume()
                reject(new Error(`Failed to download: status code ${statusCode}`))
                return
            }
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_SOURCE_SCRIPT_BYTES) {
                    request.destroy(new Error('Source script exceeds the 2 MiB limit'))
                    return
                }
                chunks.push(Buffer.from(chunk))
            })
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
            response.on('error', reject)
        })
        request.setTimeout(SOURCE_IMPORT_TIMEOUT_MS, () => request.destroy(new Error('Source import timed out')))
        request.on('error', reject)
    })
}

export async function handleValidate(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        assertUsername(username)
        const { script, allowUnsafeVM } = JSON.parse(await readBody(req))
        if (!script || typeof script !== 'string') throw new Error('Invalid script content')
        const safeInfo = await getScriptInfo(script)
        if (safeInfo.requireUnsafe && !allowUnsafeVM) {
            sendJson(res, 200, {
                valid: false,
                error: safeInfo.error,
                requireUnsafe: true,
                disabledVM: !global.lx.config['system.allowUnsafeVM'],
                metadata: safeInfo.metadata,
            })
            return
        }
        if (safeInfo.requireUnsafe && !authorizeUnsafeSource(req, res, true, true)) return
        const scriptInfo = safeInfo.requireUnsafe ? await getScriptInfo(script, true) : safeInfo
        if (scriptInfo.supportedSources.length === 0) {
            throw new Error(scriptInfo.error || 'The script did not register any music sources')
        }
        sendJson(res, 200, {
            valid: true,
            metadata: scriptInfo.metadata,
            sources: scriptInfo.supportedSources,
            sourcesCount: scriptInfo.supportedSources.length,
        })
    } catch (error: any) {
        sendJson(res, 400, { valid: false, error: error.message })
    }
}

export async function handleUpload(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const { filename, content, allowUnsafeVM } = JSON.parse(await readBody(req))
        await saveSource(req, res, username, filename || 'source.js', content, !!allowUnsafeVM)
    } catch (error: any) {
        console.error('[CustomSource] Upload error:', error)
        sendJson(res, 500, { success: false, error: error.message })
    }
}

export async function handleImport(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const { url, filename, allowUnsafeVM } = JSON.parse(await readBody(req))
        if (!url || typeof url !== 'string') throw new Error('Invalid source URL')
        const content = await downloadSourceScript(url)
        await saveSource(req, res, username, filename || path.basename(new URL(url).pathname) || 'source.js', content, !!allowUnsafeVM, url)
    } catch (error: any) {
        console.error('[CustomSource] Import error:', error)
        sendJson(res, 500, { success: false, error: error.message })
    }
}

export async function handleList(_req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const owner = assertUsername(username)
        const shares = readSourceShares()
        const ownSourceList = readSources(owner)
        const ownSourceIds = new Set(ownSourceList.map(source => source.id))
        const ownSources = ownSourceList.map(source => {
            const sharedUsers = getSharedUsers(owner, source.id)
            const status = getApiStatus(owner, source.id)
            return {
                ...source,
                enabledSources: getEnabledSourcePlatforms(owner, owner, source.id, source.supportedSources),
                owner,
                shared: false,
                readOnly: false,
                sharedUsers,
                sharedToAll: sharedUsers.includes('*'),
                ...(status ? { status: status.status, error: status.error } : {}),
            }
        })
        const sharedSources = shares
            .filter(share => share.owner !== owner && (share.targetUsers.includes('*') || share.targetUsers.includes(owner)))
            .flatMap(share => {
                if (ownSourceIds.has(share.sourceId)) return []
                const source = readSources(share.owner).find(item => item.id === share.sourceId)
                if (!source) return []
                const status = getApiStatus(share.owner, source.id)
                return [{
                    ...source,
                    enabledSources: getEnabledSourcePlatforms(owner, share.owner, source.id, source.supportedSources),
                    owner: share.owner,
                    shared: true,
                    readOnly: true,
                    sharedBy: share.owner,
                    sharedUsers: [],
                    sharedToAll: share.targetUsers.includes('*'),
                    ...(status ? { status: status.status, error: status.error } : {}),
                }]
            })
        const sources = [...ownSources, ...sharedSources]
        const orderPath = path.join(getSourceDir(owner), 'order.json')
        let order: string[] = []
        if (fs.existsSync(orderPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                if (Array.isArray(parsed)) order = parsed
            } catch { }
        }
        const orderMap = new Map(order.map((id, index) => [id, index]))
        sources.sort((a, b) => {
            if (a.shared !== b.shared) return a.shared ? 1 : -1
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
            return (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        })
        sendJson(res, 200, sources)
    } catch (error: any) {
        sendJson(res, 400, { success: false, error: error.message })
    }
}

export async function handleShare(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        if (!authorizeAdmin(req, res)) return
        const owner = assertUsername(username)
        const { id, sourceId, targetUsers } = JSON.parse(await readBody(req))
        const targetId = id || sourceId
        const source = readSources(owner).find(item => item.id === targetId)
        if (!source) throw new Error('Source not found')
        if (!source.enabled) throw new Error('Enable the source before sharing it.')
        const share = setSourceShare(owner, targetId, targetUsers)
        sendJson(res, 200, { success: true, ...share })
    } catch (error: any) {
        console.error('[CustomSource] Share error:', error)
        sendJson(res, 400, { success: false, error: error.message })
    }
}

export async function handleUnshare(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        if (!authorizeAdmin(req, res)) return
        const owner = assertUsername(username)
        const { id, sourceId } = JSON.parse(await readBody(req))
        const targetId = id || sourceId
        if (!targetId || !readSources(owner).some(source => source.id === targetId)) {
            throw new Error('Source not found')
        }
        removeSourceShare(owner, targetId)
        sendJson(res, 200, { success: true })
    } catch (error: any) {
        console.error('[CustomSource] Unshare error:', error)
        sendJson(res, 400, { success: false, error: error.message })
    }
}

export async function handleSharedUsers(req: IncomingMessage, res: ServerResponse, _username: string) {
    try {
        if (!authorizeAdmin(req, res)) return
        sendJson(res, 200, {
            success: true,
            users: global.lx.config.users.map(user => ({ name: normalizeUsername(user.name) })),
        })
    } catch (error: any) {
        sendJson(res, 400, { success: false, error: error.message })
    }
}

export async function handleToggle(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const owner = assertUsername(username)
        const { id, sourceId, enabled, allowUnsafeVM } = JSON.parse(await readBody(req))
        const targetId = id || sourceId
        const sources = readSources(owner)
        const target = sources.find(source => source.id === targetId)
        if (!target) throw new Error('Source not found')

        const oldEnabled = target.enabled
        const oldAllowUnsafeVM = target.allowUnsafeVM
        const nextEnabled = enabled !== undefined ? !!enabled : !target.enabled
        if (nextEnabled && target.requireUnsafe && !target.allowUnsafeVM) {
            if (!authorizeUnsafeSource(req, res, true, allowUnsafeVM === true)) return
        }
        if (nextEnabled && target.allowUnsafeVM && !global.lx.config['system.allowUnsafeVM']) {
            sendJson(res, 200, {
                success: false,
                disabledVM: true,
                error: 'VM_DISABLED',
                message: 'Unsafe VM mode is disabled by the server administrator.',
            })
            return
        }
        if (allowUnsafeVM === true) target.allowUnsafeVM = true
        target.enabled = nextEnabled
        writeSources(owner, sources)
        await initUserApis(owner)

        if (target.enabled) {
            const status = getApiStatus(owner, targetId)
            const requiresUnsafe = !allowUnsafeVM && !oldAllowUnsafeVM && status?.status === 'failed' && !!status.error && (
                status.error === 'REQUIRE_UNSAFE_VM' || status.error.includes('timeout')
            )
            if (requiresUnsafe) {
                target.enabled = oldEnabled
                target.allowUnsafeVM = oldAllowUnsafeVM
                writeSources(owner, sources)
                await initUserApis(owner)
                sendJson(res, 200, {
                    success: false,
                    requireUnsafe: true,
                    disabledVM: !global.lx.config['system.allowUnsafeVM'],
                    message: 'This source requires unsafe VM mode. Confirm before continuing.',
                })
                return
            }
        }
        sendJson(res, 200, { success: true, enabled: target.enabled })
    } catch (error: any) {
        console.error('[CustomSource] Toggle error:', error)
        sendJson(res, 500, { success: false, error: error.message })
    }
}

export async function handlePlatforms(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const currentUser = assertUsername(username)
        const { id, sourceId, owner, enabledSources } = JSON.parse(await readBody(req))
        const targetId = id || sourceId
        const sourceOwner = owner ? assertUsername(owner) : currentUser
        const sources = readSources(sourceOwner)
        const target = sources.find(source => source.id === targetId)
        if (!target) throw new Error('Source not found')
        if (sourceOwner !== currentUser && !isSourceSharedWithUser(sourceOwner, targetId, currentUser)) {
            throw new Error('Source is not shared with this user')
        }

        const selected = setEnabledSourcePlatforms(
            currentUser,
            sourceOwner,
            targetId,
            enabledSources,
            target.supportedSources,
        )
        sendJson(res, 200, { success: true, enabledSources: selected })
    } catch (error: any) {
        console.error('[CustomSource] Platform preference error:', error)
        sendJson(res, 400, { success: false, error: error.message })
    }
}

export async function handleReorder(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const owner = assertUsername(username)
        const { sourceIds } = JSON.parse(await readBody(req))
        if (!Array.isArray(sourceIds)) throw new Error('sourceIds must be an array')
        const sources = readSources(owner)
        const sourceMap = new Map(sources.map(source => [source.id, source]))
        const ordered: StoredSource[] = []
        for (const id of sourceIds) {
            const source = sourceMap.get(id)
            if (!source) continue
            ordered.push(source)
            sourceMap.delete(id)
        }
        ordered.push(...sourceMap.values())
        writeSources(owner, ordered)
        writeFileAtomic(path.join(getSourceDir(owner), 'order.json'), JSON.stringify(ordered.map(source => source.id), null, 2))
        await initUserApis(owner)
        sendJson(res, 200, { success: true })
    } catch (error: any) {
        console.error('[CustomSource] Reorder error:', error)
        sendJson(res, 500, { success: false, error: error.message })
    }
}

export async function handleDelete(req: IncomingMessage, res: ServerResponse, username: string) {
    try {
        const owner = assertUsername(username)
        const { id, sourceId } = JSON.parse(await readBody(req))
        const targetId = id || sourceId
        const sources = readSources(owner)
        if (!sources.some(source => source.id === targetId)) throw new Error('Source not found')
        const scriptPath = path.join(getSourceDir(owner), targetId)
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
        writeSources(owner, sources.filter(source => source.id !== targetId))
        removeSourceShare(owner, targetId)
        removeSourcePlatformPreferences(owner, targetId)
        const orderPath = path.join(getSourceDir(owner), 'order.json')
        if (fs.existsSync(orderPath)) {
            try {
                const order = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                if (Array.isArray(order)) {
                    writeFileAtomic(orderPath, JSON.stringify(order.filter(id => id !== targetId), null, 2))
                }
            } catch { }
        }
        await initUserApis(owner)
        sendJson(res, 200, { success: true })
    } catch (error: any) {
        console.error('[CustomSource] Delete error:', error)
        sendJson(res, 500, { success: false, error: error.message })
    }
}
