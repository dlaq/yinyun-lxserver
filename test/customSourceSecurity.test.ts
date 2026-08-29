import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('custom source URL imports reject private, loopback, link-local, and reserved addresses', async () => {
  const root = path.join(os.tmpdir(), 'yinyun-custom-source-security')
  fs.mkdirSync(root, { recursive: true })
  global.lx = {
    dataPath: root,
    userPath: path.join(root, 'users'),
    config: { users: [] },
  } as any
  const { downloadSourceScript, isDisallowedSourceImportAddress } = await import('../src/server/customSourceHandlers')
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.25.104', '169.254.169.254',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
  ]) assert.equal(isDisallowedSourceImportAddress(address), true, address)
  assert.equal(isDisallowedSourceImportAddress('1.1.1.1'), false)
  assert.equal(isDisallowedSourceImportAddress('2606:4700:4700::1111'), false)

  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    res.end('module.exports = {}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const serverAddress = server.address()
  assert.ok(serverAddress && typeof serverAddress !== 'string')
  try {
    await assert.rejects(downloadSourceScript(`http://127.0.0.1:${serverAddress.port}/source.js`), /public network addresses/)
    await assert.rejects(downloadSourceScript(`http://[::1]:${serverAddress.port}/source.js`), /public network addresses/)
    assert.equal(requests, 0)
    await assert.rejects(downloadSourceScript(`http://user:secret@127.0.0.1:${serverAddress.port}/source.js`), /credentials are not allowed/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
