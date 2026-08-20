// Headless 一次性模式的参数解析与会话准备（阶段 6）。
//
// 单独成模块是为了能直接测：参数解析、会话目录准备、配置拷贝都是纯逻辑/文件操作，
// 而真正的「跑一轮」要拉起整个应用，测试里不该做（也无法离线做）。
//
// 「全新会话」为什么是**临时 user dir + 拷贝 LLM 配置**，而不是直接复用真实库：
//   1. 脚本/定时任务不该把内容写进用户正在聊的那条对话里——那会污染历史，
//      也会让用户在自己的时间线里突然看到一段不是自己说的话。
//   2. 复用真实库意味着每一轮都要带着整段历史进上下文：贵、慢，而且结果不可复现。
//   而路径层（paths.js）把 DB 与 config.json 都放在 user dir 下，所以「换目录」同时
//   带走了凭据。因此必须把凭据单独搬过去——否则新会话里没有 API key，什么都跑不了。
// 安全档位（security.*）随之一起拷：headless 应当和本体的权限行为一致，
// 而不是因为「换了个目录」就悄悄变成另一套。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HEADLESS_ENV = Object.freeze({
  MODE: 'ALICE_HEADLESS',
  TASK: 'ALICE_HEADLESS_TASK',
  TIMEOUT: 'ALICE_HEADLESS_TIMEOUT_MS',
  JSON: 'ALICE_HEADLESS_JSON',
  SESSION_DIR: 'ALICE_HEADLESS_SESSION_DIR',
})

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// 从真实 user dir 搬进新会话的文件/目录。刻意列成白名单：
// 清单之外的东西（历史 DB、媒体、缓存、种子）**不搬**，那才是「全新会话」的含义。
const CARRY_OVER_ENTRIES = [
  'config.json',            // 供应商 / 模型 / key / 安全档位
  'llm',                    // 多供应商与多模型配置
  'mcp-servers.json',       // 外部工具连接
  'api-capability-slots.json',
  'voice',                  // 语音渠道配置（有就带上，没有就算了）
]

export class HeadlessArgError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HeadlessArgError'
    this.code = 'BAD_ARGS'
  }
}

/**
 * 解析 argv（不含 node 与脚本路径）。
 * 支持：`"任务文本"`（位置参数，可多个，空格拼接）、`--task "..."`、`--keep-session`、
 * `--json`、`--timeout <秒或毫秒>`、`--session-dir <dir>`、`--help`。
 * 任务里以 `-` 开头的词会被当成未知选项报错——而不是悄悄当成任务文本的一部分，
 * 否则 `--json` 拼错成 `--jsoon` 就会变成「模型被要求处理 --jsoon」这种莫名结果。
 */
export function parseHeadlessArgs(argv = []) {
  const options = {
    task: '',
    keepSession: false,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionDir: null,
    help: false,
  }
  const taskParts = []
  const unknown = []

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '')
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--keep-session') { options.keepSession = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--task') {
      const value = argv[++i]
      if (value === undefined) throw new HeadlessArgError('--task needs a value')
      taskParts.push(String(value))
      continue
    }
    if (arg === '--timeout') {
      const value = argv[++i]
      if (value === undefined) throw new HeadlessArgError('--timeout needs a value')
      options.timeoutMs = parseTimeout(value)
      continue
    }
    if (arg === '--session-dir') {
      const value = argv[++i]
      if (value === undefined) throw new HeadlessArgError('--session-dir needs a value')
      options.sessionDir = String(value)
      continue
    }
    if (arg.startsWith('--')) { unknown.push(arg); continue }
    taskParts.push(arg)
  }

  if (unknown.length > 0) {
    throw new HeadlessArgError(`unknown option(s): ${unknown.join(', ')} (try --help)`)
  }
  options.task = taskParts.join(' ').trim()
  return options
}

/**
 * `--timeout` 收「秒」或「90000ms」/`2m`。
 * 裸数字的判定阈值是 **1000**：小于 1000 按秒读，否则按毫秒读。
 * 为什么不是「小于 100 按秒」：人写 `--timeout 180` 想表达的是 180 秒（3 分钟），
 * 而按毫秒读会得到 180ms——比下限还小，直接报错，于是这个选项变成了地雷。
 * 反正下限就是 1000ms，「小于 1000 的毫秒值」本来也不合法，按秒读不损失任何表达力。
 */
export function parseTimeout(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/)
  if (!m) throw new HeadlessArgError(`--timeout must be a number, optionally with ms/s/m: got "${value}"`)
  const n = Number(m[1])
  const unit = m[2] || (n < 1000 ? 's' : 'ms')
  const ms = unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n
  if (!Number.isFinite(ms) || ms < 1000) throw new HeadlessArgError('--timeout must be at least 1000 ms')
  return Math.round(ms)
}

export const HELP_TEXT = `Run one task through Alice and print the answer, then exit.

Usage:
  node src/headless.js "your task"            run in a fresh throwaway session
  node src/headless.js --task "your task"     same, when the task starts with a dash
  node src/headless.js "task" --json          print a JSON envelope instead of plain text

Options:
  --task <text>         the task (equivalent to passing it positionally)
  --json                machine-readable output: { ok, answer, session_dir, duration_ms }
  --timeout <n>         give up after n ms. A bare number below 1000 is read as seconds
                        (so 180 means 180s). Suffixes ms/s/m also work. Default ${DEFAULT_TIMEOUT_MS}
  --session-dir <dir>   use this directory for the throwaway session (default: a temp dir)
  --keep-session        reuse the real session (real conversation database) instead of a fresh one
  -h, --help            this text

Notes:
  - A fresh session is the default: the run does not touch your real conversation, and no history
    is carried in. Model credentials and the security preset ARE copied over, so the run behaves
    like the app; everything else (history, media, caches) is deliberately absent.
  - There is no UI attached, so tools needing a human (approval prompts, ask_user_question,
    exit_plan_mode review) report that they are unavailable instead of hanging.
  - Exit codes: 0 answered, 1 model/run error, 2 bad arguments or no task, 3 timed out.
`

/**
 * 准备一次性会话目录：拷白名单里的配置进去，其余留空。
 * @returns {{sessionDir: string, created: boolean, carried: string[], missing: string[]}}
 */
export function prepareHeadlessSession({ sourceUserDir, sessionDir }) {
  if (!sessionDir) throw new HeadlessArgError('sessionDir is required')
  const target = path.resolve(sessionDir)
  const created = !fs.existsSync(target)
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(path.join(target, 'data'), { recursive: true })

  const carried = []
  const missing = []
  const source = sourceUserDir ? path.resolve(sourceUserDir) : null
  if (!source || !fs.existsSync(source)) {
    return { sessionDir: target, created, carried, missing: [...CARRY_OVER_ENTRIES] }
  }

  for (const entry of CARRY_OVER_ENTRIES) {
    const from = path.join(source, entry)
    const to = path.join(target, entry)
    if (!fs.existsSync(from)) { missing.push(entry); continue }
    try {
      // 已存在就跳过：同一个 --session-dir 重复用时不覆盖用户在里面改过的配置
      if (fs.existsSync(to)) continue
      fs.cpSync(from, to, { recursive: true })
      carried.push(entry)
    } catch {
      missing.push(entry)
    }
  }
  return { sessionDir: target, created, carried, missing }
}

/**
 * 默认会话目录：用 `mkdtempSync` 而不是拼时间戳。
 * 时间戳到毫秒，两次并发调用（脚本里 for 循环同时起两个）会撞同一个目录，
 * 而后来的那个会把前一个的会话配置**覆盖掉**——这种串台极难排查。
 * mkdtempSync 由内核保证唯一，顺带把目录建好。
 */
export function defaultSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alice-headless-'))
}

/** 退出码约定（脚本靠它判断发生了什么，不靠解析文案）。 */
export const EXIT = Object.freeze({
  ANSWERED: 0,
  RUN_FAILED: 1,
  BAD_ARGS: 2,
  TIMED_OUT: 3,
})
