let loaderPromise = null
let amapPromise = null

export class MapServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MapServiceError'
    this.code = code
  }
}

function loadScript(src) {
  if (loaderPromise) return loaderPromise
  loaderPromise = new Promise((resolve, reject) => {
    if (window.AMapLoader) return resolve(window.AMapLoader)
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve(window.AMapLoader)
    script.onerror = () => reject(new MapServiceError('loader_failed', '高德地图加载器下载失败'))
    document.head.appendChild(script)
  })
  return loaderPromise
}

async function fetchRuntimeConfig(apiRoot) {
  const response = await fetch(`${apiRoot}/map-service/config`, { signal: AbortSignal.timeout(8000) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok) throw new MapServiceError('config_failed', data.error || '地图配置读取失败')
  if (!data.map?.configured || !data.map?.jsKey) {
    throw new MapServiceError('not_configured', '请先在“设置 → 高级功能”中配置地图服务')
  }
  return data.map
}

async function loadAmap(apiRoot) {
  if (amapPromise) return amapPromise
  amapPromise = (async () => {
    const config = await fetchRuntimeConfig(apiRoot)
    window._AMapSecurityConfig = {
      serviceHost: `${apiRoot}${config.servicePath || '/_AMapService'}`,
    }
    const loader = await loadScript('https://webapi.amap.com/loader.js')
    if (!loader?.load) throw new MapServiceError('loader_invalid', '高德地图加载器不可用')
    const AMap = await loader.load({
      key: config.jsKey,
      version: '2.0',
      plugins: ['AMap.Scale', 'AMap.ToolBar', 'AMap.DistrictLayer'],
    })
    return { AMap, config }
  })().catch(err => {
    amapPromise = null
    throw err
  })
  return amapPromise
}

function addCityBoundaryLayer(AMap, map) {
  if (!AMap.DistrictLayer?.Country) return null
  const layer = new AMap.DistrictLayer.Country({
    zIndex: 8,
    zooms: [3, 12],
    SOC: 'CHN',
    depth: 2,
  })
  layer.setStyles({
    'nation-stroke': '#4cc9f0',
    'coastline-stroke': '#4cc9f0',
    'province-stroke': 'rgba(96, 204, 240, 0.72)',
    'city-stroke': 'rgba(122, 190, 218, 0.38)',
    fill: 'rgba(8, 38, 58, 0.12)',
  })
  map.add(layer)
  return layer
}

export async function createMap(container, {
  apiRoot = location.origin,
  center = [121, 25],
  zoom = 5,
  cityBoundaries = true,
  controls = true,
} = {}) {
  if (!container) throw new MapServiceError('container_missing', '地图容器不存在')
  const { AMap, config } = await loadAmap(apiRoot)
  const map = new AMap.Map(container, {
    center,
    zoom,
    zooms: [3, 18],
    viewMode: '2D',
    mapStyle: 'amap://styles/darkblue',
    showLabel: true,
    showIndoorMap: false,
    resizeEnable: true,
  })
  const boundaryLayer = cityBoundaries ? addCityBoundaryLayer(AMap, map) : null
  if (controls) {
    map.addControl(new AMap.Scale({ position: 'LB' }))
    map.addControl(new AMap.ToolBar({ position: 'RT', liteStyle: true }))
  }
  return { AMap, map, boundaryLayer, config }
}

const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323

function outsideChina(lon, lat) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLatitude(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  value += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  value += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return value
}

function transformLongitude(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  value += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  value += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return value
}

export function wgs84ToGcj02(coordinate) {
  const lon = Number(coordinate?.[0])
  const lat = Number(coordinate?.[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (outsideChina(lon, lat)) return [lon, lat]

  let dLat = transformLatitude(lon - 105, lat - 35)
  let dLon = transformLongitude(lon - 105, lat - 35)
  const radLat = lat / 180 * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = dLat * 180 / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  dLon = dLon * 180 / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return [lon + dLon, lat + dLat]
}

export async function convertFromGps(_AMap, coordinates = []) {
  return coordinates
    .map(wgs84ToGcj02)
    .filter(Boolean)
}
