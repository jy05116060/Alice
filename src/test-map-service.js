import assert from 'node:assert/strict'
import { getMapServiceSettings } from './map-service.js'
import { buildAmapProxyTarget } from './api/routes/map.js'
import { wgs84ToGcj02 } from './ui/brain-ui/map-service.js'

const settings = getMapServiceSettings()
assert.equal(settings.provider, 'amap')
assert.equal(typeof settings.configured, 'boolean')
assert.equal(typeof settings.keyConfigured, 'boolean')
assert.equal(typeof settings.securityConfigured, 'boolean')

const restTarget = buildAmapProxyTarget(
  new URL('http://localhost/_AMapService/v3/config/district?keywords=中国'),
  'secret-code',
)
assert.equal(restTarget.origin, 'https://restapi.amap.com')
assert.equal(restTarget.pathname, '/v3/config/district')
assert.equal(restTarget.searchParams.get('jscode'), 'secret-code')

const styleTarget = buildAmapProxyTarget(
  new URL('http://localhost/_AMapService/v4/map/styles?styleid=dark'),
  'secret-code',
)
assert.equal(styleTarget.origin, 'https://webapi.amap.com')
assert.equal(styleTarget.pathname, '/v4/map/styles')
assert.equal(styleTarget.searchParams.get('jscode'), 'secret-code')
assert.throws(
  () => buildAmapProxyTarget(new URL('http://localhost/_AMapService/https://example.com/steal'), 'secret-code'),
  /invalid_amap_proxy_path/,
)

const beijing = wgs84ToGcj02([116.397128, 39.916527])
assert.ok(Math.abs(beijing[0] - 116.40337) < 0.0001)
assert.ok(Math.abs(beijing[1] - 39.91793) < 0.0001)
assert.deepEqual(wgs84ToGcj02([139.6917, 35.6895]), [139.6917, 35.6895])
assert.equal(wgs84ToGcj02(['bad', 20]), null)
console.log('map service tests passed')
