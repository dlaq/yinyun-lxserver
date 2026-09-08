import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

function harness() {
  const nodes = new Map<string, any>()
  const storage = () => {
    const map = new Map<string, string>()
    return { getItem: (key: string) => map.get(key) || null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) }
  }
  const node = (id: string) => {
    if (!nodes.has(id)) {
      let html = '', value = ''
      nodes.set(id, {
        id, dataset: {}, textContent: '', disabled: false, scrolls: 0,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
        setAttribute() {}, removeAttribute() {}, scrollIntoView() { this.scrolls++ },
        get innerHTML() { return html },
        set innerHTML(v: string) { html = v; value = /<option value="([^"]*)"/.exec(v)?.[1] || '' },
        get value() { return value }, set value(v: string) { value = v },
      })
    }
    return nodes.get(id)
  }
  const sandbox = vm.createContext({
    console, URL, URLSearchParams, setInterval: () => 123, clearInterval() {},
    localStorage: storage(), sessionStorage: storage(),
    document: { getElementById: node, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'hidden' },
    window: {}, showError: () => {}, showSuccess: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ data: {} }) }),
  })
  const source = fs.readFileSync('public/js/library-integration.js', 'utf8').replace(
    'window.LibraryIntegration = {',
    'window.LibraryIntegration = { test: { state, loadPlaylists, openImportById, renderImport, renderImportHistory, restoreSavedUserSession },',
  )
  vm.runInContext(source, sandbox)
  const api = sandbox.window.LibraryIntegration
  api.test.state.token = 'test-token'
  api.test.state.username = 'alice'
  return { sandbox, api, state: api.test.state, node }
}
const payload = (data: unknown) => ({ ok: true, json: async () => ({ data }) })

test('refresh preserves both playlist selections including a choice changed during the request', async () => {
  const { api, sandbox, node } = harness()
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  sandbox.fetch = async (url: string) => {
    await delayed
    return payload(url.includes('songloft') ? { playlists: [{ id: '7', name: 'Remote', song_count: 0 }] } : [{ id: 'a', name: 'Local', trackCount: 2 }])
  }
  const pending = api.test.loadPlaylists()
  node('integration-yinyun-playlist').value = 'a'
  node('integration-songloft-playlist').value = '7'
  release()
  await pending
  assert.equal(node('integration-yinyun-playlist').value, 'a')
  assert.equal(node('integration-songloft-playlist').value, '7')
  assert.match(node('integration-songloft-playlist').innerHTML, /0 首/)
})

test('out-of-order import responses cannot reopen an older playlist', async () => {
  const { api, sandbox, state, node } = harness()
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  sandbox.fetch = async (url: string) => {
    if (url.endsWith('/old')) await delayed
    if (url.includes('/import/')) return payload({ importId: url.endsWith('/old') ? 'old' : 'new', name: url, items: [], counts: {} })
    if (url.endsWith('/imports')) return payload({ records: [{ importId: 'new', yinyunPlaylistId: 'new' }, { importId: 'old', yinyunPlaylistId: 'old' }] })
    return payload(url.includes('songloft') ? { playlists: [] } : [{ id: 'new' }, { id: 'old' }])
  }
  const old = api.test.openImportById('old')
  await api.test.openImportById('new')
  release()
  await old
  assert.equal(state.importId, 'new')
  assert.match(node('integration-result-title').textContent, /new$/)
})

test('background rematch preserves checks and never scrolls the page', () => {
  const { api, state, node } = harness()
  const data = { importId: 'a', items: [{ index: 0, status: 'missing', source: { id: 's', title: 'Track' } }], counts: {} }
  api.test.renderImport(data)
  state.selected.add(0)
  const scrolls = node('integration-result-panel').scrolls
  api.test.renderImport(data, { reveal: false })
  assert.ok(state.selected.has(0))
  assert.equal(node('integration-result-panel').scrolls, scrolls)
  api.test.renderImport({ ...data, items: [{ ...data.items[0], source: { id: 'different', title: 'Other' } }] }, { reveal: false })
  assert.equal(state.selected.size, 0, 'indices may not carry a selection onto a different song')
})

test('player integration ignores a different admin tab user session', async () => {
  const { api, sandbox, state } = harness()
  sandbox.localStorage.setItem('lx_sync_user', 'alice')
  sandbox.localStorage.setItem('lx_user_token', 'alice-token')
  sandbox.sessionStorage.setItem('yinyun.integration.username', 'bob')
  sandbox.sessionStorage.setItem('yinyun.integration.access_token', 'bob-token')
  await api.test.restoreSavedUserSession()
  assert.equal(state.username, 'alice')
  assert.equal(state.token, 'alice-token')
})

test('an authoritative empty playlist list removes deleted import history', () => {
  const { api, state, node } = harness()
  state.localPlaylistsLoaded = true
  state.localPlaylists = []
  api.test.renderImportHistory([{ importId: 'deleted', yinyunPlaylistId: 'gone', name: 'Gone' }])
  assert.doesNotMatch(node('integration-import-history').innerHTML, /Gone/)
})

test('leaving the integration panel stops polling even before its CSS active class changes', () => {
  const { api, sandbox, state, node } = harness()
  sandbox.document.visibilityState = 'visible'
  node('view-library-integration').classList.contains = () => true
  api.setActive(true)
  assert.equal(state.timer, 123)
  api.setActive(false)
  assert.equal(state.panelActive, false)
  assert.equal(state.timer, null)
})

test('a response from the previous account cannot update the new account dropdowns', async () => {
  const { api, sandbox, state, node } = harness()
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  sandbox.fetch = async (url: string) => {
    await delayed
    return payload(url.includes('songloft') ? { playlists: [] } : [{ id: 'private', name: 'Old account private playlist' }])
  }
  const pending = api.test.loadPlaylists()
  state.username = 'bob'
  state.token = 'new-account-token'
  release()
  await assert.rejects(pending, (error: any) => error.code === 'STALE_SESSION')
  assert.doesNotMatch(node('integration-yinyun-playlist').innerHTML, /private/)
})
