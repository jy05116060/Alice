/**
 * system-status.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 「电脑动态」面板的实时系统指标采集。
 *
 * 与 system-info.js 的分工：
 *   system-info.js  —— 启动时扫一次，静态环境（OS/CPU 型号/内存总量/路径），落盘 system-info.json
 *   system-status.js —— 运行期高频轮询，动态负载（CPU 占用/内存已用/磁盘余量/电池/进程榜）
 *
 * 设计要点：
 *   1. 快指标（CPU/内存/磁盘/运行时长/网络）全部走 Node 内置 API，同步、无子进程，单次 < 20ms。
 *   2. 慢指标（电池、进程榜）必须起 PowerShell，走后台异步刷新 + 陈旧值兜底，
 *      绝不阻塞请求线程；首次调用返回 null 并标 stale，下一轮轮询即补齐。
 *   3. 快指标带 1.5s 节流缓存，面板 2s 轮询不会把 CPU 打满。
 *   4. 任何一项采集失败都降级为 null，不抛错、不拖垮整个快照。
 */

import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// ─── 缓存与节流 ──────────────────────────────────────────────────────────────

const FAST_TTL_MS = 1500      // 快指标节流窗口
const BATTERY_TTL_MS = 30000  // 电池后台刷新间隔
const PROC_TTL_MS = 15000     // 进程榜后台刷新间隔
const PS_TIMEOUT_MS = 8000    // 单次 PowerShell 超时

let _cache = null
let _cacheAt = 0
let _inflight = null

// CPU 占用率靠两次采样求差，模块加载即取第一帧
let _prevCpu = readCpuTimes()
let _prevCpuAt = Date.now()

const _battery = { pct: null, charging: null, at: 0, busy: false }
const _procs = { list: null, at: 0, busy: false }

// ─── 小工具 ──────────────────────────────────────────────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function pct(used, total) {
  if (!total || total <= 0) return null
  return round1((used / total) * 100)
}

function toGB(bytes) {
  return round2(bytes / 1024 ** 3)
}

function runPS(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        const raw = String(stdout || '').trim()
        if (!raw || raw === 'null') return resolve(null)
        try { resolve(JSON.parse(raw)) } catch { resolve(null) }
      },
    )
  })
}

// ─── CPU ─────────────────────────────────────────────────────────────────────

function readCpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times || {}
    const idle = (t.idle || 0) + (t.iowait || 0)
    const total = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + idle
    return { idle, total }
  })
}

/**
 * 用两帧 cpu times 求区间占用率。
 * 窗口过短（<120ms）时差值噪声太大，返回 null 让前端沿用上一次的值。
 */
function sampleCpu() {
  const cur = readCpuTimes()
  const now = Date.now()
  const elapsed = now - _prevCpuAt
  const prev = _prevCpu
  _prevCpu = cur
  _prevCpuAt = now

  if (elapsed < 120 || !prev || prev.length !== cur.length) {
    return { usage: null, perCore: [], elapsedMs: elapsed }
  }

  let idleDelta = 0
  let totalDelta = 0
  const perCore = []
  for (let i = 0; i < cur.length; i++) {
    const id = cur[i].idle - prev[i].idle
    const td = cur[i].total - prev[i].total
    idleDelta += id
    totalDelta += td
    perCore.push(td > 0 ? round1((1 - id / td) * 100) : 0)
  }

  const usage = totalDelta > 0 ? round1((1 - idleDelta / totalDelta) * 100) : null
  return { usage, perCore, elapsedMs: elapsed }
}

// ─── 磁盘 ────────────────────────────────────────────────────────────────────

function statfsOf(target) {
  try {
    if (typeof fs.statfsSync !== 'function') return null
    const st = fs.statfsSync(target)
    const bsize = st.bsize || st.frsize || 0
    const total = (st.blocks || 0) * bsize
    const free = (st.bavail || 0) * bsize
    if (!total) return null
    return { total, free, used: total - free }
  } catch {
    return null
  }
}

/** Windows：扫 A:~Z: 盘符根目录，存在且能 statfs 的才算一个卷 */
function listWindowsVolumes() {
  const out = []
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    let ok = false
    try { ok = fs.existsSync(root) } catch { ok = false }
    if (!ok) continue
    const st = statfsOf(root)
    if (!st) continue
    out.push({
      mount: `${letter}:`,
      label: `${letter}: 盘`,
      totalBytes: st.total,
      freeBytes: st.free,
      usedBytes: st.used,
      totalGB: toGB(st.total),
      freeGB: toGB(st.free),
      usedGB: toGB(st.used),
      usedPct: pct(st.used, st.total),
    })
  }
  return out
}

/** macOS / Linux：根卷 + /proc/mounts 里的真实块设备挂载点 */
function listPosixVolumes() {
  const out = []
  const seen = new Set()

  const push = (mount, label) => {
    if (seen.has(mount)) return
    const st = statfsOf(mount)
    if (!st) return
    seen.add(mount)
    out.push({
      mount,
      label: label || mount,
      totalBytes: st.total,
      freeBytes: st.free,
      usedBytes: st.used,
      totalGB: toGB(st.total),
      freeGB: toGB(st.free),
      usedGB: toGB(st.used),
      usedPct: pct(st.used, st.total),
    })
  }

  push('/', '根目录')
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n')
    for (const line of mounts) {
      const [dev, mp] = line.split(/\s+/)
      if (!dev || !mp) continue
      if (!/^\/dev\//.test(dev)) continue
      if (/^\/(proc|sys|dev|run|snap)/.test(mp)) continue
      push(mp.replace(/\\040/g, ' '), mp)
    }
  } catch { /* 非 Linux 或无权限，忽略 */ }
  return out
}

function listVolumes() {
  try {
    return IS_WIN ? listWindowsVolumes() : listPosixVolumes()
  } catch {
    return []
  }
}

// ─── 电池（后台异步） ────────────────────────────────────────────────────────

function readBatteryOnce() {
  if (IS_WIN) {
    // BatteryStatus: 1=放电 2=AC满电 3=满充 4=低电 6=充电中 7=充电高 8=充电低 9=充电危险
    return runPS(
      '$b=Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1;'
      + 'if($b){[PSCustomObject]@{pct=$b.EstimatedChargeRemaining;st=$b.BatteryStatus}|ConvertTo-Json -Compress}else{\'null\'}',
    ).then((b) => {
      if (!b || b.pct == null) return null
      return { pct: Number(b.pct), charging: [2, 3, 6, 7, 8, 9].includes(Number(b.st)) }
    })
  }
  if (IS_MAC) {
    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'batt'], { timeout: PS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null)
        const m = String(stdout || '').match(/(\d+)%;\s*(charging|discharging|finishing charge|charged|not charging|AC attached)/i)
        if (!m) return resolve(null)
        resolve({ pct: parseInt(m[1], 10), charging: !/^(discharging|not charging)$/i.test(m[2]) })
      })
    })
  }
  // Linux：直接读 sysfs，无需子进程
  return Promise.resolve().then(() => {
    try {
      const dir = '/sys/class/power_supply'
      const bat = fs.readdirSync(dir).find((e) => /^BAT/i.test(e))
      if (!bat) return null
      const p = parseInt(fs.readFileSync(`${dir}/${bat}/capacity`, 'utf8').trim(), 10)
      const s = fs.readFileSync(`${dir}/${bat}/status`, 'utf8').trim()
      if (Number.isNaN(p)) return null
      return { pct: p, charging: !/^Discharging$/i.test(s) }
    } catch { return null }
  })
}

/** 返回当前（可能陈旧的）电池值；过期则触发后台刷新，不阻塞调用方 */
function batterySnapshot(now) {
  if (!_battery.busy && now - _battery.at > BATTERY_TTL_MS) {
    _battery.busy = true
    readBatteryOnce()
      .then((r) => {
        if (r) { _battery.pct = r.pct; _battery.charging = r.charging }
      })
      .catch(() => {})
      .finally(() => { _battery.at = Date.now(); _battery.busy = false })
  }
  return {
    pct: _battery.pct,
    charging: _battery.charging,
    available: _battery.pct != null,
    pending: _battery.at === 0,
  }
}

// ─── 进程榜（后台异步） ──────────────────────────────────────────────────────

function readProcessesOnce() {
  if (IS_WIN) {
    return runPS(
      'Get-Process | Where-Object { $_.WS -gt 0 } | Sort-Object WS -Descending | Select-Object -First 8 '
      + 'Name, Id, @{n=\'memMB\';e={[math]::Round($_.WS/1MB,1)}}, @{n=\'cpuSec\';e={if($_.CPU){[math]::Round($_.CPU,1)}else{0}}} '
      + '| ConvertTo-Json -Compress',
    ).then((rows) => {
      if (!rows) return null
      const arr = Array.isArray(rows) ? rows : [rows]
      return arr.map((r) => ({
        name: String(r.Name || ''),
        pid: Number(r.Id) || null,
        memMB: Number(r.memMB) || 0,
        cpuSec: Number(r.cpuSec) || 0,
      }))
    })
  }
  // macOS / Linux：ps 一把梭
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'rss=,pid=,comm='], { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      const rows = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => {
          const m = l.match(/^(\d+)\s+(\d+)\s+(.+)$/)
          if (!m) return null
          return { name: m[3].split('/').pop(), pid: Number(m[2]), memMB: round1(Number(m[1]) / 1024), cpuSec: 0 }
        })
        .filter(Boolean)
      rows.sort((a, b) => b.memMB - a.memMB)
      resolve(rows.slice(0, 8))
    })
  })
}

function processSnapshot(now) {
  if (!_procs.busy && now - _procs.at > PROC_TTL_MS) {
    _procs.busy = true
    readProcessesOnce()
      .then((r) => { if (r) _procs.list = r })
      .catch(() => {})
      .finally(() => { _procs.at = Date.now(); _procs.busy = false })
  }
  return { list: _procs.list, pending: _procs.at === 0 }
}

// ─── 网络 ────────────────────────────────────────────────────────────────────

function networkSnapshot() {
  let localIp = null
  const ifaces = []
  try {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of (addrs || [])) {
        if (a.family === 'IPv4' && !a.internal) {
          if (!localIp) localIp = a.address
          ifaces.push({ name, address: a.address, mac: a.mac })
        }
      }
    }
  } catch { /* 忽略 */ }
  return { localIp, interfaces: ifaces }
}

// ─── 快指标汇总（同步） ──────────────────────────────────────────────────────

function collectFast(now) {
  const cpu = sampleCpu()
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const volumes = listVolumes()
  const net = networkSnapshot()

  // 应用自身占用：面板上「爱丽丝吃了多少」这一格
  let self = null
  try {
    const mu = process.memoryUsage()
    self = {
      pid: process.pid,
      rssMB: round1(mu.rss / 1024 ** 2),
      heapUsedMB: round1(mu.heapUsed / 1024 ** 2),
      uptimeSec: Math.round(process.uptime()),
    }
  } catch { self = null }

  return {
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      username: (() => { try { return os.userInfo().username } catch { return null } })(),
      nodeVersion: process.versions?.node || null,
      electronVersion: process.versions?.electron || null,
    },
    cpu: {
      model: cpus[0]?.model?.trim() || 'unknown',
      cores: cpus.length,
      usagePct: cpu.usage,
      perCore: cpu.perCore,
      sampleWindowMs: cpu.elapsedMs,
      loadavg: (os.loadavg() || []).map(round2),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      totalGB: toGB(totalMem),
      freeGB: toGB(freeMem),
      usedGB: toGB(usedMem),
      usedPct: pct(usedMem, totalMem),
    },
    disks: volumes,
    uptimeSec: Math.round(os.uptime()),
    network: net,
    self,
    sampledAt: new Date(now).toISOString(),
  }
}

// ─── 对外接口 ────────────────────────────────────────────────────────────────

/**
 * 取一份系统状态快照。
 * 快指标带 1.5s 节流；电池与进程榜走后台刷新，返回的可能是上一轮的陈旧值。
 * @param {{force?: boolean}} [opts] force=true 跳过节流缓存
 */
export async function getSystemStatus({ force = false } = {}) {
  const now = Date.now()
  if (!force && _cache && now - _cacheAt < FAST_TTL_MS) return _cache
  if (_inflight) return _inflight

  // 注意：构建过程是同步的（无 await），所以不能在 IIFE 内部用 finally 清 _inflight——
  // 那样 finally 会在赋值语句之前执行，随后 _inflight 被赋成已完成的 promise 并永久卡住，
  // 导致后续 force 取样一直返回同一份旧快照。改为在外层 await 之后清理。
  const pending = (async () => {
    const ts = Date.now()
    const fast = collectFast(ts)
    const battery = batterySnapshot(ts)
    const processes = processSnapshot(ts)
    const snap = { ...fast, battery, processes, collectedAt: new Date(ts).toISOString() }
    _cache = snap
    _cacheAt = Date.now()
    return snap
  })()

  _inflight = pending
  try {
    return await pending
  } finally {
    if (_inflight === pending) _inflight = null
  }
}

/** 预热：应用启动或面板首次打开时调用，让电池/进程榜提前进缓存 */
export function primeSystemStatus() {
  const now = Date.now()
  batterySnapshot(now)
  processSnapshot(now)
}
