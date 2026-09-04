import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicIpAddress, RemoteUrlPolicyError, resolvePublicRemoteTarget } from '../src/server/remoteUrlPolicy'

test('remote media policy rejects private, loopback, mapped and reserved addresses', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '100.64.1.1', '169.254.1.1', '172.16.0.1', '192.168.1.1',
    '198.18.0.1', '192.0.2.1', '198.51.100.2', '203.0.113.3', '0.0.0.0', '224.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::c0a8:102', '64:ff9b:1::1',
    '2001:2::1', '2001:10::1', '2001:20::1', '2002:c0a8:0102::1',
    'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1',
  ]) assert.equal(isPublicIpAddress(address), false, address)
  for (const address of ['1.1.1.1', '8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicIpAddress(address), true, address)
  }
})

test('remote media policy validates every DNS result and pins approved lookup answers', async () => {
  await assert.rejects(
    resolvePublicRemoteTarget('http://[::1]/admin'),
    (error: any) => error instanceof RemoteUrlPolicyError && error.code === 'remote_private_address',
  )
  await assert.rejects(
    resolvePublicRemoteTarget('https://mixed.example/audio.flac', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    (error: any) => error instanceof RemoteUrlPolicyError && error.code === 'remote_private_address',
  )
  const target = await resolvePublicRemoteTarget('https://cdn.example/audio.flac', async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])
  const ipv4 = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    target.lookup('ignored.example', { family: 4 }, (error: Error | null, address: string, family: number) => {
      if (error) reject(error)
      else resolve({ address, family })
    })
  })
  assert.deepEqual(ipv4, { address: '1.1.1.1', family: 4 })
  await assert.rejects(resolvePublicRemoteTarget('file:///etc/passwd'), /HTTP/)
  await assert.rejects(resolvePublicRemoteTarget('https://user:pass@example.test/file'), /用户名或密码/)
})
