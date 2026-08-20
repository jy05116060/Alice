// 变异测试：证明四条断言**真的会失败**（不是恒真断言）。
//
// 做法：把源码改坏 → 跑测试确认变红 → 恢复 → 核对字节一致（含 SHA256）。
// 这是唯一能证明「测试真的在测东西」的方法。恒真的断言在实现错的时候仍然绿，
// 那种测试比没有测试更糟——它给人虚假的安全感。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = process.argv[2] ?? 'D:\\爱丽丝'
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

const CORE = path.join(ROOT, 'src', 'runtime', 'ssh-core.js')
// 交付后独立测试文件已并入既有测试文件，所以变异测试直接驱动合并后的文件。
// 用 electron.exe 跑（与全量 sweep 一致）。
const PROBE = path.join(ROOT, 'src', 'test-api-message-utf8.js')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

// 每条变异：{名称, 定位, 替换, 期望变红的测试名}
const MUTATIONS = [
  {
    name: '① loopback 403 —— 去掉 loopback 限制',
    file: CORE,
    pattern: `  if (!isLoopbackPeer(req?.remoteAddress)) {
    return { kind: 'reject', status: 403, body: { ok: false, error: { code: 'forbidden', message: 'this API is loopback-only' } } }
  }`,
    replacement: `  // MUTATED: loopback 闸门被摘掉`,
    probe: 'dev-ssh-core',
    expectRed: ['preflight step 1 rejects non-loopback peers with 403'],
  },
  {
    name: '② injectCookieHead 索引位置 —— Cookie 插到索引 2 而非 1',
    file: CORE,
    pattern: `  kept.splice(1, 0, \`Cookie: \${cookie}\`)`,
    replacement: `  kept.splice(2, 0, \`Cookie: \${cookie}\`) // MUTATED`,
    probe: 'dev-ssh-core',
    expectRed: ['injectCookieHead puts Cookie at index 1 and Connection: close at index 2'],
  },
  {
    name: '③ injectCookieHead upgrade 分支 —— 无条件插 Connection: close',
    file: CORE,
    pattern: `  if (!isUpgrade) kept.splice(2, 0, 'Connection: close')`,
    replacement: `  kept.splice(2, 0, 'Connection: close') // MUTATED: 无条件`,
    probe: 'dev-ssh-core',
    expectRed: ['injectCookieHead leaves Connection: Upgrade untouched for websockets'],
  },
  {
    name: '④ 凭据脱敏 —— redacted 直接返回原文',
    file: CORE,
    pattern: `  for (const secret of [profile.password, profile.passphrase]) {`,
    replacement: `  if (true) return out // MUTATED: 不脱敏
  for (const secret of [profile.password, profile.passphrase]) {`,
    probe: 'dev-ssh-core',
    expectRed: ['redacted replaces password and passphrase with ***'],
  },
  {
    name: '⑤ shQuote 转义 —— 不转义单引号',
    file: CORE,
    pattern: `  return \`'\${String(value).replace(/'/g, \`'\\\\''\`)}'\``,
    replacement: `  return \`'\${String(value)}'\` // MUTATED: 不转义`,
    probe: 'dev-ssh-core',
    expectRed: ['shQuote escapes single quotes so they cannot break out'],
  },
  {
    name: '⑥ fail-open —— 上限判断反过来（永不 fail-open）',
    file: CORE,
    pattern: `  return Buffer.byteLength(String(head), 'utf8') <= TUNNEL_HEAD_CAP`,
    replacement: `  return true // MUTATED: 永远注入`,
    probe: 'dev-ssh-core',
    expectRed: ['shouldInjectCookie fails open above the 64 KiB head cap'],
  },
  {
    name: '⑦ machineProfileOf 丢弃规则 —— 缺 host 也放行',
    file: CORE,
    pattern: `  if (typeof raw.host !== 'string' || raw.host === '') return undefined`,
    replacement: `  // MUTATED: 不校验 host`,
    probe: 'dev-ssh-core',
    expectRed: ['machineProfileOf drops rows missing id/name/host/user'],
  },
  {
    name: '⑧ 业务异常 → HTTP 200 —— 改成 500',
    file: CORE,
    pattern: `  if (error instanceof SshError) {
    return { status: 200, body: { ok: false, error: { code: error.code, message: error.message } } }
  }`,
    replacement: `  if (error instanceof SshError) {
    return { status: 500, body: { ok: false, error: { code: error.code, message: error.message } } } // MUTATED
  }`,
    probe: 'dev-ssh-core',
    expectRed: ['businessFailure returns HTTP 200 so business errors are not read as transport errors'],
  },
  {
    name: '⑨ 环形缓冲容量 —— 改成无限（不丢最旧）',
    file: CORE,
    pattern: `    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity)
    }`,
    replacement: `    // MUTATED: 不裁剪`,
    probe: 'dev-ssh-core',
    expectRed: ['EventRing drops the oldest events past its 500 capacity'],
  },
  {
    name: '⑩ 重连退避 —— 改成常数（不退避）',
    file: CORE,
    pattern: `  return Math.min(reconnectInitialDelayMs * (2 ** (n - 1)), reconnectMaxDelayMs)`,
    replacement: `  return reconnectInitialDelayMs // MUTATED: 不退避`,
    probe: 'dev-ssh-core',
    expectRed: ['reconnectDelayMs doubles up to the cap and gives up after 6 attempts'],
  },
  {
    name: '⑪ CORS —— 改回「只在 OPTIONS 上设置」（Lead 发现的真实缺陷）',
    file: path.join(ROOT, 'src', 'api', 'routes', 'ssh-remote.js'),
    pattern: `  const cors = corsHeadersFor(origin)
  applyCors(res, cors)`,
    replacement: `  const cors = corsHeadersFor(origin)
  // MUTATED: 只在 OPTIONS 上设置，真实 POST 就没有 ACAO 了`,
    probe: 'remote',
    // 直接 assert 的断言抛异常时，assert 库不会打印自定义 message（只打 actual/expected），
    // 所以用 actual/expected 的值定位——这个组合只可能来自「OPTIONS 的 ACAO 丢了」。
    expectRed: ["expected='http://127.0.0.1:3721'"],
  },
  {
    name: '⑫ CORS 非法源 —— 写回字面量 null（毒化响应）',
    file: path.join(ROOT, 'src', 'api', 'routes', 'ssh-remote.js'),
    pattern: `  if (!origin || origin === 'null') return {}
  return {
    'Access-Control-Allow-Origin': origin,`,
    replacement: `  return {
    'Access-Control-Allow-Origin': origin || 'null', // MUTATED: 毒化`,
    probe: 'remote',
    expectRed: ['a missing Origin must not produce the literal null'],
  },
]

function runProbe() {
  try {
    const out = execFileSync(ELECTRON, [PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

console.log('=== 变异测试：证明断言真的会失败 ===\n')

// 先确认基线是绿的
const baseline = runProbe()
if (baseline.code !== 0) {
  console.error('基线不是绿的，变异测试无意义。先修好测试。')
  console.error(baseline.out.slice(-2000))
  process.exit(2)
}
console.log(`基线：绿 (${/^(\d+) passed/m.exec(baseline.out)?.[1]} passed)\n`)

let proven = 0
let failed = 0

for (const m of MUTATIONS) {
  const original = fs.readFileSync(m.file)
  const before = sha(m.file)
  const text = original.toString('utf8')
  if (!text.includes(m.pattern)) {
    console.log(`✗ ${m.name}\n    定位失败：模式在源文件里找不到（变异没生效，结论不可信）`)
    failed++
    continue
  }

  // 应用变异
  fs.writeFileSync(m.file, text.replace(m.pattern, m.replacement), 'utf8')
  const mutated = runProbe()
  // 两种变红形态都要认：
  //  - `FAIL: <label>`  —— sshCheck 的桩（纯逻辑断言走这条）
  //  - `AssertionError: <message>` —— 直接在测试体里 assert 的 HTTP 断言：
  //    抛异常会让进程停在那里，不会打印 FAIL: 标签，但**它确实变红了**。
  const redNames = [
    ...(mutated.out.match(/^FAIL:\s*(.+)$/gm) ?? []).map((l) => l.replace(/^FAIL:\s*/, '').trim()),
    ...(mutated.out.match(/^\s+FAIL\s+(.+)$/gm) ?? []).map((l) => l.replace(/^\s+FAIL\s+/, '').trim()),
    ...(mutated.out.match(/^AssertionError[^:]*:\s*(.+)$/gm) ?? []).map((l) => l.replace(/^AssertionError[^:]*:\s*/, '').trim()),
    // 直接 assert 的 HTTP 断言抛异常时会打印 actual/expected 而不是标签。
    // 把这两行的值也收进来，这样 `expectRed` 可以用值本身来定位。
    ...(mutated.out.match(/^\s*actual:\s*(.+)$/gm) ?? []).map((l) => `actual=${l.replace(/^\s*actual:\s*/, '').trim()}`),
    ...(mutated.out.match(/^\s*expected:\s*(.+)$/gm) ?? []).map((l) => `expected=${l.replace(/^\s*expected:\s*/, '').trim()}`),
  ]
  // 变红的判据：进程非零退出 **且** 输出里出现了我们期望的那个信号。
  const allRed = [...redNames, mutated.out].join('\n')

  // 恢复 + 字节核对
  fs.writeFileSync(m.file, original)
  const after = sha(m.file)
  const restored = after === before

  if (!restored) {
    console.log(`✗ ${m.name}\n    恢复后字节不一致！before=${before.slice(0, 12)} after=${after.slice(0, 12)}`)
    failed++
    continue
  }

  const caught = mutated.code !== 0 && m.expectRed.every((name) => allRed.includes(name))
  if (caught) {
    proven++
    console.log(`✓ ${m.name}`)
    console.log(`    变异后 → 测试变红 (${redNames.length} 条 FAIL)，恢复后 SHA256 一致 ${after.slice(0, 16)}…`)
    for (const n of m.expectRed) console.log(`      红: ${n}`)
  } else {
    failed++
    console.log(`✗ ${m.name}`)
    console.log(`    变异后测试**没有**按预期变红 —— 这条断言是恒真的/无效的！`)
    console.log(`    期望变红: ${m.expectRed.join(' | ')}`)
    console.log(`    实际变红: ${redNames.join(' | ') || '(没有 FAIL)'}`)
  }
  console.log('')
}

// 最终确认全部恢复
const finalCheck = runProbe()
console.log('=== 汇总 ===')
console.log(`四条必测（loopback 403 / injectCookieHead 索引 / 脱敏 / shQuote 转义）全部包含在变体里。`)
console.log(`证明有效：${proven} / ${MUTATIONS.length}`)
console.log(`无效或异常：${failed}`)
console.log(`最终基线：${finalCheck.code === 0 ? '绿 ✓（所有变异已恢复）' : '红 ✗（有文件没恢复干净！）'}`)
process.exit(failed === 0 && finalCheck.code === 0 ? 0 : 1)
