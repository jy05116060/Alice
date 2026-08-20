import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('db-media-library', async () => {
  const media = await import('./db/repositories/media-library.js')

  media.upsertMediaHistory({ kind: 'video', url: 'https://example.com/watch/1', title: 'First', videoId: '1' })
  media.upsertMediaHistory({ kind: 'video', url: 'https://example.com/watch/1', title: 'Updated', platform: 'web' })
  assert.equal(media.getMediaHistory().length, 1)
  assert.equal(media.getMediaHistory()[0].title, 'Updated')

  const track = media.upsertMusicTrack({ title: 'Blue Sky', artist: 'Test Artist', filePath: 'C:/music/blue.mp3', lrc: 'old' })
  assert.equal(media.getMusicTrack(track.id).title, 'Blue Sky')
  assert.equal(media.searchMusicLibrary('Blue Artist')[0].id, track.id)
  assert.equal(media.listMusicLibrary()[0].id, track.id)
  media.updateMusicLrc(track.id, 'new')
  assert.equal(media.getMusicTrack(track.id).lrc, 'new')
  media.deleteMusicTrack(track.id)
  assert.equal(media.getMusicTrack(track.id), undefined)
})
