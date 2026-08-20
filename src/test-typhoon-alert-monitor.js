import assert from 'node:assert/strict'
import { normalizeTyphoonAlerts } from './typhoon-alert-monitor.js'

const alerts = normalizeTyphoonAlerts({ alerts: [
  { id: '1', title: '广东省台风橙色预警', level: '橙色', region: '广东省', publishedAt: '2026-07-11T10:00:00Z' },
  { id: '2', title: '普通大风蓝色预警', level: '蓝色', region: '广东省' },
] })
assert.equal(alerts.length, 1)
assert.equal(alerts[0].id, '1')
console.log('typhoon alert monitor tests passed')
