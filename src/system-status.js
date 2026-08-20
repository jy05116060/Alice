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
 *   1. 快指标（CPU/内存/磁盘/运行时长/网卡地址）全部走 Node 内置 API，同步、无子进程，单次 < 20ms。
 *   2. 慢指标（电池、进程榜、硬件温度、网络吞吐）必须起 PowerShell / 读 /proc，走后台异步刷新 + 陈旧值兜底，
 *      绝不阻塞请求线程；首次调用返回 null 并标 stale/pending，下一轮轮询即补齐。
 *   3. 快指标带 1.5s 节流缓存，面板 2s 轮询不会把 CPU 打满。
 *   4. 任何一项采集失败都降级为 null，不抛错、不拖垮整个快照；取不到的项如实标 available=false，
 *      绝不编造数字（温度只有 ACPI 热区 + NVIDIA GPU 两路，CPU 逐核温度需另装监控驱动）。
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
const THERMAL_TTL_MS = 10000  // 硬件温度后台刷新间隔（温度变化慢，10s 足够）
const NETSPEED_TTL_MS = 2000  // 网络吞吐采样间隔（要算差值；PowerShell 起一次约 1s，实际刷新约 3~4s）
const PS_TIMEOUT_MS = 8000    // 单次 PowerShell 超时

let _cache = null
let _cacheAt = 0
let _inflight = null

// CPU 占用率靠两次采样求差，模块加载即取第一帧
let _prevCpu = readCpuTimes()
let _prevCpuAt = Date.now()

const _battery = { pct: null, charging: null, at: 0, busy: false }
const _procs = { list: null, at: 0, busy: false }
const _thermal = { acpi: [], gpu: [], ok: null, at: 0, busy: false }
const _netspeed = { prev: null, rxBps: null, txBps: null, windowMs: null, activeAdapter: null, at: 0, busy: false }

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
  // 先强制 PowerShell 以 UTF-8 输出：否则中文（网卡名「以太网」、进程名等）在 Windows 上
  // 会按 GBK 写出，被 Node 按 UTF-8 解码成乱码。
  const wrapped = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' + script
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', wrapped],
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

// ─── 硬件温度（后台异步） ────────────────────────────────────────────────────
//
// 真值来源只有两路，取不到就如实留空，不编数字：
//   · CPU/主板热区 —— Windows ACPI（root/WMI: MSAcpi_ThermalZoneTemperature），Linux 读 hwmon sysfs
//   · 独显温度     —— NVIDIA nvidia-smi
// 逐核 CPU 温度需要内核态监控驱动（LibreHardwareMonitor 之类），本机未安装，故不提供。

function readThermalOnce() {
  if (IS_WIN) {
    const script = `
$out=[ordered]@{acpi=@();gpu=@()}
try{
  $z=Get-CimInstance -Namespace 'root/WMI' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
  foreach($t in @($z)){
    if($t.CurrentTemperature -eq $null){continue}
    $c=[math]::Round(($t.CurrentTemperature/10)-273.15,1)
    if($c -gt -20 -and $c -lt 150){$out.acpi+=[PSCustomObject]@{zone=$t.InstanceName;celsius=$c}}
  }
}catch{}
try{
  $exe=$null
  $cmd=Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if($cmd){$exe=$cmd.Source}
  elseif(Test-Path 'C:\\Windows\\System32\\nvidia-smi.exe'){$exe='C:\\Windows\\System32\\nvidia-smi.exe'}
  if($exe){
    $lines=& $exe --query-gpu=name,temperature.gpu --format=csv,noheader,nounits 2>$null
    foreach($l in @($lines)){
      if(-not $l){continue}
      $p=$l -split ','
      if($p.Count -ge 2){
        $v=0.0
        if([double]::TryParse($p[1].Trim(),[ref]$v)){
          $out.gpu+=[PSCustomObject]@{name=$p[0].Trim();celsius=[math]::Round($v,1)}
        }
      }
    }
  }
}catch{}
$out|ConvertTo-Json -Compress -Depth 4
`
    return runPS(script).then((r) => {
      if (!r) return null
      const acpi = (Array.isArray(r.acpi) ? r.acpi : (r.acpi ? [r.acpi] : []))
        .map((z) => ({ zone: String(z.zone || ''), celsius: Number(z.celsius) }))
        .filter((z) => Number.isFinite(z.celsius))
      const gpu = (Array.isArray(r.gpu) ? r.gpu : (r.gpu ? [r.gpu] : []))
        .map((g) => ({ name: String(g.name || ''), celsius: Number(g.celsius) }))
        .filter((g) => Number.isFinite(g.celsius))
      return { acpi, gpu }
    })
  }

  if (IS_MAC) {
    // macOS 无特权温度源（powermetrics 需 sudo），如实返回 null
    return Promise.resolve(null)
  }

  // Linux：读 /sys/class/hwmon/*/temp*_input，微摄氏度 → 摄氏度
  return Promise.resolve().then(() => {
    const out = { acpi: [], gpu: [] }
    try {
      const base = '/sys/class/hwmon'
      for (const entry of fs.readdirSync(base)) {
        const dir = `${base}/${entry}`
        let name = entry
        try { name = fs.readFileSync(`${dir}/name`, 'utf8').trim() || entry } catch { /* 忽略 */ }
        let files = []
        try { files = fs.readdirSync(dir) } catch { continue }
        for (const f of files) {
          if (!/^temp\d+_input$/.test(f)) continue
          const raw = parseFloat(fs.readFileSync(`${dir}/${f}`, 'utf8').trim())
          if (!Number.isFinite(raw)) continue
          const celsius = round1(raw / 1000)
          if (celsius < -20 || celsius > 150) continue
          if (/nvidia|amdgpu|radeon/i.test(name)) out.gpu.push({ name: `${name} ${f}`, celsius })
          else out.acpi.push({ zone: `${name} ${f}`, celsius })
        }
      }
    } catch { /* 无 hwmon 或无权限，忽略 */ }
    return out
  })
}

/** 返回当前（可能陈旧的）温度；过期则触发后台刷新，不阻塞调用方 */
function thermalSnapshot(now) {
  if (!_thermal.busy && now - _thermal.at > THERMAL_TTL_MS) {
    _thermal.busy = true
    readThermalOnce()
      .then((r) => {
        if (r) {
          _thermal.acpi = r.acpi
          _thermal.gpu = r.gpu
          _thermal.ok = r.acpi.length > 0 || r.gpu.length > 0
        } else {
          _thermal.ok = false
        }
      })
      .catch(() => { _thermal.ok = false })
      .finally(() => { _thermal.at = Date.now(); _thermal.busy = false })
  }

  const acpi = Array.isArray(_thermal.acpi) ? _thermal.acpi : []
  const gpu = Array.isArray(_thermal.gpu) ? _thermal.gpu : []
  const cpuCelsius = acpi.length ? Math.max(...acpi.map((z) => z.celsius)) : null
  const gpuCelsius = gpu.length ? Math.max(...gpu.map((g) => g.celsius)) : null

  return {
    available: cpuCelsius != null || gpuCelsius != null,
    pending: _thermal.at === 0,
    cpuCelsius,
    cpuZone: acpi.length ? acpi.map((z) => z.zone).join(' / ') : null,
    gpuCelsius,
    gpuName: gpu.length ? gpu[0].name : null,
    zones: acpi,
    gpus: gpu,
    note: 'CPU 温度取 ACPI 热区读数；逐核温度需另装监控驱动（LibreHardwareMonitor 类）',
    sampledAt: _thermal.at ? new Date(_thermal.at).toISOString() : null,
  }
}

// ─── 网络吞吐（后台异步，差值法） ────────────────────────────────────────────
//
// 网卡累计字节数做差 → 每秒速率。首帧只建立基线（返回 null 并标 pending），
// 第二帧起才有真实速度，这是差值法的固有代价，如实标注、不假装有数。

function readNetCountersOnce() {
  if (IS_WIN) {
    return runPS(
      'Get-NetAdapterStatistics -ErrorAction SilentlyContinue '
      + '| Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress',
    ).then((r) => {
      if (!r) return null
      const arr = Array.isArray(r) ? r : [r]
      return arr.map((a) => ({
        name: String(a.Name || ''),
        rx: Number(a.ReceivedBytes) || 0,
        tx: Number(a.SentBytes) || 0,
      }))
    })
  }
  // Linux：/proc/net/dev（前两行是表头）
  return Promise.resolve().then(() => {
    try {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)
      const out = []
      for (const line of lines) {
        const m = line.match(/^\s*([^:]+):\s*(.+)$/)
        if (!m) continue
        const cols = m[2].trim().split(/\s+/)
        out.push({ name: m[1].trim(), rx: Number(cols[0]) || 0, tx: Number(cols[8]) || 0 })
      }
      return out
    } catch { return null }
  })
}

function netSpeedSnapshot(now) {
  // 节流窗口按「上一帧采样时刻」算，不按上一帧结束时刻——否则读一次要 1s 左右，
  // 实际刷新会被拉长到 5~6s，面板上的速度明显滞后。
  const sincePrev = _netspeed.prev ? now - _netspeed.prev.at : Infinity
  if (!_netspeed.busy && sincePrev > NETSPEED_TTL_MS) {
    _netspeed.busy = true
    readNetCountersOnce()
      .then((rows) => {
        if (!rows || !rows.length) return
        const readAt = Date.now()
        const totals = rows.reduce((acc, r) => ({ rx: acc.rx + r.rx, tx: acc.tx + r.tx }), { rx: 0, tx: 0 })
        const prev = _netspeed.prev
        if (prev) {
          const elapsed = (readAt - prev.at) / 1000
          if (elapsed > 0.2) {
            _netspeed.rxBps = round1(Math.max(0, totals.rx - prev.rx) / elapsed)
            _netspeed.txBps = round1(Math.max(0, totals.tx - prev.tx) / elapsed)
            _netspeed.windowMs = Math.round(elapsed * 1000)
            let best = null
            for (const r of rows) {
              const before = prev.perAdapter[r.name]
              if (!before) continue
              const delta = Math.max(0, (r.rx - before.rx) + (r.tx - before.tx))
              if (!best || delta > best.delta) best = { name: r.name, delta }
            }
            _netspeed.activeAdapter = best ? best.name : null
          }
        }
        _netspeed.prev = {
          at: readAt,
          rx: totals.rx,
          tx: totals.tx,
          perAdapter: rows.reduce((acc, r) => { acc[r.name] = { rx: r.rx, tx: r.tx }; return acc }, {}),
        }
      })
      .catch(() => {})
      .finally(() => { _netspeed.at = Date.now(); _netspeed.busy = false })
  }

  return {
    rxBps: _netspeed.rxBps,
    txBps: _netspeed.txBps,
    speedAvailable: _netspeed.rxBps != null,
    speedPending: _netspeed.rxBps == null,
    speedWindowMs: _netspeed.windowMs,
    activeAdapter: _netspeed.activeAdapter,
    rxTotalBytes: _netspeed.prev ? _netspeed.prev.rx : null,
    txTotalBytes: _netspeed.prev ? _netspeed.prev.tx : null,
  }
}

// ─── 快指标汇总（同步） ──────────────────────────────────────────────────────

function collectFast(now) {
  const cpu = sampleCpu()
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const volumes = listVolumes()
  const net = { ...networkSnapshot(), ...netSpeedSnapshot(now) }

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
    const thermal = thermalSnapshot(ts)
    const snap = { ...fast, battery, processes, thermal, collectedAt: new Date(ts).toISOString() }
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

/** 预热：应用启动或面板首次打开时调用，让电池/进程榜/温度/网速提前进缓存 */
export function primeSystemStatus() {
  const now = Date.now()
  batterySnapshot(now)
  processSnapshot(now)
  thermalSnapshot(now)
  netSpeedSnapshot(now)
}
