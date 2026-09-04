import assert from 'node:assert/strict'
import test from 'node:test'
import { ListDataManage } from '../src/modules/list/listDataManage'

const historical = {
  defaultList: [],
  loveList: [],
  userList: [
    { id: 'duplicate', name: 'First card', locationUpdateTime: 1, list: [{ id: 1001, source: 'wy', name: 'song', singer: 'artist' }] },
    { id: 'duplicate', name: 'Second card', locationUpdateTime: 1, coverSongId: 1001, list: [{ id: 1001, source: 'wy', name: 'song', singer: 'artist' }] },
  ],
} as any

test('only the repair rollback path may restore a historical duplicate snapshot', async () => {
  const manage = new ListDataManage({
    getSnapshotInfo: async () => ({ latest: null }),
  } as any)
  await manage.initPromise

  await assert.rejects(manage.listDataOverwrite(historical), (error: any) => error?.code === 'duplicate_playlist_id')
  await manage.listDataOverwrite(historical, { allowHistoricalDuplicates: true })
  const restored = await manage.getListData()
  assert.equal(restored.userList.length, 2)
  assert.deepEqual(restored.userList.map(item => item.name), ['First card', 'Second card'])
  assert.deepEqual(restored.userList.map(item => item.list.map(song => song.id)), [[1001], [1001]])
})
