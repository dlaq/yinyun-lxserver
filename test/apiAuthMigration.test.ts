import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('native API login uses persisted AuthService sessions after plaintext migration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinyun-api-auth-migration-'))
  const dataPath = path.join(root, 'data')
  fs.mkdirSync(path.join(dataPath, 'users'), { recursive: true })
  global.lx = {
    dataPath,
    userPath: path.join(dataPath, 'users'),
    logPath: path.join(root, 'logs'),
    staticPath: path.join(root, 'public'),
    config: {
      users: [{ name: 'alice', password: '' }],
      maxSnapshotNum: 10,
      'list.addMusicLocationType': 'bottom',
      'player.path': '/music',
      'frontend.password': '',
      'subsonic.enable': false,
    } as LX.Config,
    saveConfig: () => {},
  }

  const { AuthService } = await import('../src/server/authService')
  const { createApiV1Handler } = await import('../src/server/apiV1')
  const auth = new AuthService(dataPath, crypto.randomBytes(32).toString('base64'))
  await auth.initialize({ users: [{ name: 'alice', password: 'correct horse battery staple' }] })
  let observedLoginIp = ''

  const handler = createApiV1Handler({
    serverVersion: 'test',
    getAuthSecret: () => auth.getSigningSecret(),
    getUsers: () => global.lx.config.users,
    loginUserSession: (username, password, ip) => {
      observedLoginIp = ip
      return auth.loginUser(username, password, ip)
    },
    refreshUserSession: token => auth.rotateRefreshToken(token),
    logoutUserSession: token => auth.logoutToken(token),
    verifyUserAccessToken: token => auth.verifyAccessToken(token, 'user'),
    isAdminUser: () => false,
    musicSdk: {},
    normalizeSongInfo: value => value,
    resolveSong: async () => null,
    isSourceSupported: () => false,
    getLoadedSources: () => [],
    getLibrary: async () => [],
    saveLibrary: async () => {},
    getLeaderboardBoards: async () => [],
    getLeaderboardList: async () => [],
  })
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url || '/', 'http://127.0.0.1')).then(handled => {
      if (!handled) { res.writeHead(404); res.end() }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const loginResponse = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
      body: JSON.stringify({ username: 'ALICE', password: 'correct horse battery staple' }),
    })
    assert.equal(loginResponse.status, 200)
    const login = (await loginResponse.json() as any).data
    assert.equal(login.username, 'alice')
    assert.equal(typeof login.accessToken, 'string')
    assert.equal(typeof login.refreshToken, 'string')
    assert.match(observedLoginIp, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/)
    assert.notEqual(observedLoginIp, '203.0.113.55')

    const me = await fetch(`${origin}/api/v1/auth/me`, { headers: { authorization: `Bearer ${login.accessToken}` } })
    assert.equal(me.status, 200)
    assert.equal((await me.json() as any).data.username, 'alice')

    const refresh = await fetch(`${origin}/api/v1/auth/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: login.refreshToken }),
    })
    assert.equal(refresh.status, 200)
    const rotated = (await refresh.json() as any).data
    assert.notEqual(rotated.accessToken, login.accessToken)
    assert.equal((await fetch(`${origin}/api/v1/auth/me`, { headers: { authorization: `Bearer ${login.accessToken}` } })).status, 401)

    assert.equal((await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${rotated.accessToken}` },
    })).status, 200)
    assert.equal((await fetch(`${origin}/api/v1/auth/me`, { headers: { authorization: `Bearer ${rotated.accessToken}` } })).status, 401)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
