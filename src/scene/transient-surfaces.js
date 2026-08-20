import { sceneStore } from './scene-store.js'

export const WEATHER_SURFACE_TTL_MS = 20 * 1000

const timers = new Map()

export function scheduleSceneSurfaceRemoval(id, { kind = null, ttlMs = WEATHER_SURFACE_TTL_MS } = {}) {
  if (!id || typeof id !== 'string') return
  cancelSceneSurfaceRemoval(id)
  const timer = setTimeout(() => {
    timers.delete(id)
    const current = sceneStore.get(id)
    if (!current) return
    if (kind && current.kind !== kind) return
    sceneStore.set(id, null)
  }, ttlMs)
  if (typeof timer.unref === 'function') timer.unref()
  timers.set(id, timer)
}

export function cancelSceneSurfaceRemoval(id) {
  const timer = timers.get(id)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(id)
}
