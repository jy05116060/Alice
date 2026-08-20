import assert from 'node:assert/strict'
import { consumeTyphoonPanelOpenEvent, getTyphoonPanelState, noteTyphoonPanelViewed, parseTyphoonDetail, parseTyphoonList, setTyphoonPanelState } from './typhoon.js'

const list = parseTyphoonList({ typhoonList: [
  [1, 'BAVI', '巴威', '2609', '2609', null, '', 'start'],
  [2, 'SECOND', '测试台风', '2610', '2610', null, '', 'start'],
  [3, 'OLD', '旧台风', '2608', '2608', null, '', 'stop'],
] })
assert.deepEqual(list, [
  { id: '1', status: 'start', name: '巴威' },
  { id: '2', status: 'start', name: '测试台风' },
])

const detail = parseTyphoonDetail({ typhoon: [1, 'BAVI', '巴威', 2609, 2609, null, '', 'start', [
  [11, '202607010000', 1782864000000, 'TY', 130.2, 20.1, 960, 35, 'WNW', 18, [['30KTS', 200, 180, 160, 200]], { BABJ: [[12, '202607010000', 128, 21, 950, 40, 'BABJ', 'STY']] }, ['202607010800', '2026年07月01日08时00分']],
]] })
assert.equal(detail.name, '巴威')
assert.equal(detail.current.levelLabel, '台风')
assert.equal(detail.current.time, '2026-07-01 00:00')
assert.equal(detail.current.windCircles[0].northeastKm, 200)
assert.equal(detail.forecasts[0].levelLabel, '强台风')

const opened = setTyphoonPanelState({ active: true, source: 'test-open' })
assert.equal(opened.active, true)
assert.equal(opened.justOpened, true)
assert.equal(opened.contextActive, true)
const openedAt = opened.openedAt
const viewed = noteTyphoonPanelViewed()
assert.equal(viewed.openedAt, openedAt, '数据浏览不应伪造新的打开时间')
const duplicateOpen = setTyphoonPanelState({ active: true, source: 'test-duplicate' })
assert.equal(duplicateOpen.openedAt, openedAt, '重复 active 上报不应伪造新的打开事件')
assert.equal(duplicateOpen.justOpened, true, 'Agent 确认前应保留一次打开事件')
assert.equal(consumeTyphoonPanelOpenEvent()?.openedAt, openedAt)
assert.equal(getTyphoonPanelState().justOpened, false, 'Agent 确认后不应继续报告刚刚打开')
assert.equal(consumeTyphoonPanelOpenEvent(), null, '打开事件只能消费一次')
const closed = setTyphoonPanelState({ active: false, source: 'test-close' })
assert.equal(closed.active, false)
assert.equal(closed.justOpened, false)
assert.equal(closed.contextActive, false)
assert.equal(closed.contextTtlSeconds, 0)
console.log('typhoon parser tests passed')
