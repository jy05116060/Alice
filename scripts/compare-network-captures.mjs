import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { compareCaptures } = require('../electron/network-audit-utils.cjs')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`)
    options[name] = value
    index += 1
  }
  if (!options.chrome || !options.alice) {
    throw new Error('usage: --chrome <baseline.har|json> --alice <alice.json|har> [--baseline-label <label>] [--output <report.md>] [--json-output <comparison.json>]')
  }
  return options
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read ${filename}: ${error.message}`)
  }
}

function code(value) {
  if (value == null) return '—'
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  return `\`${rendered.replaceAll('|', '\\|').replaceAll('`', '\\`')}\``
}

function compactList(values, limit = 12) {
  if (!values?.length) return '无'
  const visible = values.slice(0, limit).map(value => code(value)).join('、')
  return values.length > limit ? `${visible}，另有 ${values.length - limit} 项` : visible
}

function renderComparisonReport(comparison, { chromeFile, aliceFile, baselineLabel = '普通 Chrome' }) {
  const chrome = comparison.chrome
  const alice = comparison.alice
  const differences = comparison.differences
  const riskRows = comparison.riskSignals.map(item => (
    `| ${item.level} | ${item.fact ? '事实' : '推断'} | ${item.signal} |`
  )).join('\n')
  const endpointOnlyChrome = differences.materialEndpointsOnlyInChrome
  const endpointOnlyAlice = differences.materialEndpointsOnlyInAlice
  const normalizedNoiseCount = differences.normalizedEndpointNoise.chrome.length
    + differences.normalizedEndpointNoise.alice.length

  return `# ${baselineLabel}与爱丽丝 Electron/Playwright 网络请求对比

## 执行摘要

本报告由脱敏比较工具生成。${baselineLabel}样本包含 ${chrome.requests} 个请求，爱丽丝样本包含 ${alice.requests} 个请求。风险信号仅表示当前证据支持的可区分性；没有发现信号不等于平台无法通过未采集的请求正文、前端脚本或服务端关联数据识别自动化。

## 采集条件

| 项目 | ${baselineLabel} | 爱丽丝 |
| --- | --- | --- |
| 输入文件 | ${code(path.basename(chromeFile))} | ${code(path.basename(aliceFile))} |
| 格式/来源 | ${code(chrome.source)} | ${code(alice.source)} |
| 请求数 | ${chrome.requests} | ${alice.requests} |
| 缓存命中 | disk=${chrome.cache.disk}, SW=${chrome.cache.serviceWorker}, prefetch=${chrome.cache.prefetch} | disk=${alice.cache.disk}, SW=${alice.cache.serviceWorker}, prefetch=${alice.cache.prefetch} |

采集文件在内存中读取，并在写出比较结果前再次脱敏。URL 查询值、动态路径段、Cookie、Authorization、Token、签名、账号标识候选值及 Payload 原文均不写入报告或比较 JSON。

## 可确认事实

- ${baselineLabel} User-Agent：${compactList(chrome.fingerprintHeaders.userAgent)}
- 爱丽丝 User-Agent：${compactList(alice.fingerprintHeaders.userAgent)}
- ${baselineLabel} sec-ch-ua：${compactList(chrome.fingerprintHeaders.secChUa)}
- 爱丽丝 sec-ch-ua：${compactList(alice.fingerprintHeaders.secChUa)}
- ${baselineLabel} 协议分布：${code(chrome.protocols)}
- 爱丽丝协议分布：${code(alice.protocols)}
- ${baselineLabel} Cookie 请求头出现于 ${chrome.cookies.requestHeaderPresent} 个请求；爱丽丝为 ${alice.cookies.requestHeaderPresent} 个。
- 基线 HAR 中 hasUserGesture 通常不可用；本表中的 ${code(differences.hasUserGesture.chrome)} 应结合格式限制解释。

## 请求差异表

| 比较项 | ${baselineLabel} | 爱丽丝 | 解释边界 |
| --- | --- | --- | --- |
| 独有归一化端点数 | ${endpointOnlyChrome.length} | ${endpointOnlyAlice.length} | 推荐流、广告、实验和缓存可制造随机差异 |
| 已归为噪声的端点差异 | ${differences.normalizedEndpointNoise.chrome.length} | ${differences.normalizedEndpointNoise.alice.length} | 共 ${normalizedNoiseCount} 项，不进入高风险结论 |
| 独有请求头字段 | ${compactList(differences.requestHeadersOnlyInChrome)} | ${compactList(differences.requestHeadersOnlyInAlice)} | 字段集合差异是事实，成因需结合端点逐项判断 |
| Accept-Language | ${compactList(chrome.fingerprintHeaders.acceptLanguage)} | ${compactList(alice.fingerprintHeaders.acceptLanguage)} | 值不同可形成稳定分组特征 |
| sec-ch-ua-platform | ${compactList(chrome.fingerprintHeaders.secChUaPlatform)} | ${compactList(alice.fingerprintHeaders.secChUaPlatform)} | 应与 UA、实际平台一致 |
| Origin | ${compactList(chrome.diagnosticHeaders.origin)} | ${compactList(alice.diagnosticHeaders.origin)} | 已对 URL 查询值和动态路径脱敏 |
| Referer | ${compactList(chrome.diagnosticHeaders.referer)} | ${compactList(alice.diagnosticHeaders.referer)} | 已对 URL 查询值和动态路径脱敏 |
| sec-fetch-* | ${compactList([chrome.diagnosticHeaders['sec-fetch-site'], chrome.diagnosticHeaders['sec-fetch-mode'], chrome.diagnosticHeaders['sec-fetch-dest']].flat())} | ${compactList([alice.diagnosticHeaders['sec-fetch-site'], alice.diagnosticHeaders['sec-fetch-mode'], alice.diagnosticHeaders['sec-fetch-dest']].flat())} | 比较字段存在性与安全值 |
| URL query 字段名 | ${compactList(chrome.queryParameterNames)} | ${compactList(alice.queryParameterNames)} | query 值已丢弃，仅保留字段名和元数据 |
| 连接复用 | ${chrome.transport.reusedConnections} reused / ${chrome.transport.newConnections} new | ${alice.transport.reusedConnections} reused / ${alice.transport.newConnections} new | HAR/CDP 暴露程度不同，不能直接等价于线上连接 |
| TLS 协议 | ${code(chrome.transport.tlsProtocols)} | ${code(alice.transport.tlsProtocols)} | 仅记录 CDP/HAR 可见元数据，不是 TLS 指纹 |
| 请求间隔中位数 | ${code(chrome.timeline.interRequestGapMs.median)} ms | ${code(alice.timeline.interRequestGapMs.median)} ms | 包含页面自动请求，不能单独代表人工节奏 |
| 首个 hasUserGesture 请求 | ${code(chrome.timeline.firstUserGestureRequestMs)} ms | ${code(alice.timeline.firstUserGestureRequestMs)} ms | HAR 侧通常缺失，且并非所有交互请求都会携带该标记 |

${baselineLabel}独有端点：${compactList(endpointOnlyChrome)}

爱丽丝独有端点：${compactList(endpointOnlyAlice)}

已归一化的推荐/广告/实验/缓存敏感端点噪声：${compactList([
    ...differences.normalizedEndpointNoise.chrome,
    ...differences.normalizedEndpointNoise.alice,
  ].map(item => `${item.kind}:${item.endpoint}`))}

请求头顺序只来自 HAR 数组或 CDP 对象枚举；它不是最终 HTTP/2/HTTP/3 线序，不能据此确认 Header 在线顺序差异。

## 风险信号（极高到低）

| 等级 | 证据性质 | 信号 |
| --- | --- | --- |
${riskRows}

## 事实与推断

- “字段值/字段集合/端点/状态/协议在两份样本中不同”是当前样本事实。
- “该差异由 Electron、Playwright 或 CDP 导致”通常是推断；只有显式 Electron 品牌、webdriver=true 或可复现实验才能提高归因强度。
- CDP 本身通常不会自动给业务请求增加“CDP”请求头。平台更可能组合 UA/Client Hints、JS 环境、交互事件、时序和账号侧风险信号。
- 由于正文被主动丢弃，无法确认 navigator.webdriver 是否被业务脚本上报，也无法直接区分 fill() 与逐键输入产生的正文级遥测。

## 采集工具自身污染

- 爱丽丝记录器附加 Electron debugger、启用 Network 域，并在开始/结束各执行一次只读页面环境表达式；不启用 Fetch、路由、代理、缓存禁用或请求重放。
- 打开 DevTools 会改变焦点、可见性和窗口尺寸，也可能使 Electron debugger 断开，因此不可与快捷键记录器同时使用。
- 人工基线浏览器的开发工具打开状态本身也可能改变 viewport、缓存和页面 focus；两侧应统一开发工具停靠方式与缓存设置。
- HAR 与原生 CDP JSON 的字段覆盖不同，这是工具差异，不应误判为浏览器差异。

## 合规整改建议

1. 保持只读诊断，禁止发布、评论、点赞、关注、私信、上传和挑战/验证码自动化。
2. 将平台访问改为明确用户触发；需要输入时优先让用户人工逐键操作，不把随机轨迹或伪装属性作为整改手段。
3. 对 UA/Client Hints、语言、可见性和 viewport 的不一致先做产品兼容性修复；不要隐藏 webdriver 或伪装 Electron。
4. 将诊断记录器保持为开发或显式环境变量启用，设置短保留期，并只共享脱敏后的比较结果。
5. 对“极高/高”信号做最小变量复测；至少重复三轮，交换采集顺序并统一登录态、缓存、网络和只读步骤。

## 限制

${comparison.limitations.map(item => `- ${item}`).join('\n')}
`
}

function writeAtomic(filename, content) {
  const resolved = path.resolve(filename)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const temporary = `${resolved}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, resolved)
  return resolved
}

export function runComparison(options) {
  const chromeFile = path.resolve(options.chrome)
  const aliceFile = path.resolve(options.alice)
  const comparison = compareCaptures(readJson(chromeFile), readJson(aliceFile))
  const report = renderComparisonReport(comparison, {
    chromeFile,
    aliceFile,
    baselineLabel: options['baseline-label'] || '普通 Chrome',
  })
  const outputs = {}
  if (options.output) outputs.report = writeAtomic(options.output, report)
  if (options['json-output']) {
    outputs.json = writeAtomic(options['json-output'], `${JSON.stringify(comparison, null, 2)}\n`)
  }
  if (!options.output && !options['json-output']) process.stdout.write(report)
  return { comparison, outputs, report }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const result = runComparison(parseArgs(process.argv.slice(2)))
    for (const [kind, filename] of Object.entries(result.outputs)) {
      console.log(`${kind}: ${filename}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

export { parseArgs, renderComparisonReport }
