import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AuthService, AuthServiceError } from '../src/server/authService'

test('auth service migrates passwords, rotates refresh tokens, and persists revocation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-auth-'))
  const key = crypto.randomBytes(32).toString('base64')
  try {
    const auth = new AuthService(directory, key)
    await auth.initialize({ users: [{ name: 'alice', password: 'oldweak' }], adminPassword: 'admin-old-weak' })
    const adminSession = await auth.loginAdmin('admin-old-weak', '127.0.0.1')
    assert.ok(adminSession?.accessToken)
    assert.equal(auth.verifyAccessToken(adminSession!.accessToken, 'admin')?.username, 'admin')
    assert.equal(auth.verifyMigrationCompleteness(['alice']), true)
    const session = await auth.loginUser('alice', 'oldweak', '127.0.0.1')
    assert.ok(session?.accessToken)
    assert.equal(auth.verifyAccessToken(session!.accessToken, 'user')?.username, 'alice')
    assert.equal(auth.verifyCompatibilityPassword('alice', 'oldweak'), true)
    assert.equal(auth.verifySubsonicToken('alice', crypto.createHash('md5').update('oldweaksalt').digest('hex'), 'salt'), true)

    const rotated = await auth.rotateRefreshToken(session!.refreshToken)
    assert.ok(rotated?.accessToken)
    assert.equal(auth.verifyAccessToken(session!.accessToken), null)
    await auth.logoutToken(rotated!.accessToken)

    const beforePasswordChange = await auth.loginUser('alice', 'oldweak', '127.0.0.1')
    await auth.setPassword('alice', 'user', 'new-password')
    assert.equal(auth.verifyAccessToken(beforePasswordChange!.accessToken), null)
    assert.equal(await auth.loginUser('alice', 'oldweak', '127.0.0.1'), null)
    assert.equal((await auth.loginUser('alice', 'new-password', '127.0.0.1'))?.username, 'alice')

    const restarted = new AuthService(directory, key)
    await restarted.initialize({ users: [{ name: 'alice' }], adminPassword: undefined })
    assert.equal(restarted.verifyAccessToken(rotated!.accessToken), null)
    assert.equal((await restarted.loginUser('alice', 'new-password', '127.0.0.1'))?.username, 'alice')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('API tokens persist only a digest and plaintext is returned once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-api-token-'))
  const key = crypto.randomBytes(32).toString('base64')
  try {
    const auth = new AuthService(directory, key)
    await auth.initialize({ users: [{ name: 'alice', password: 'password1' }], adminPassword: 'administrator1' })
    const created = await auth.createApiToken('alice', { name: 'phone', expiresAt: null })
    assert.equal(auth.verifyApiToken(created.token), 'alice')
    const persisted = fs.readFileSync(path.join(directory, 'auth', 'api-tokens.json'), 'utf8')
    assert.equal(persisted.includes(created.token), false)
    assert.equal(auth.listApiTokens('alice').tokens[0].tokenMasked.includes('...'), true)
    await auth.setApiTokenAuthEnabled('alice', false)
    assert.equal(auth.verifyApiToken(created.token), null)
    await auth.setApiTokenAuthEnabled('alice', true)
    assert.equal(await auth.removeApiToken('alice', created.metadata.id), true)
    assert.equal(auth.verifyApiToken(created.token), null)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('missing master key stops new authentication work without deleting legacy input', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-auth-missing-'))
  try {
    const auth = new AuthService(directory, '')
    const initialized = await auth.initialize({ users: [{ name: 'alice', password: 'legacy' }], adminPassword: 'legacy-admin' })
    assert.equal(initialized.migrated, false)
    assert.throws(() => auth.getSigningSecret(), (error: any) => error instanceof AuthServiceError && error.code === 'auth_master_key_missing')
    assert.equal(fs.existsSync(path.join(directory, 'auth', 'credentials.json')), false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
