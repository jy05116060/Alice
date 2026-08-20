#!/usr/bin/env node
// Headless 一次性模式（阶段 6）：把一条任务交进爱丽丝**真实的那一轮处理链**，
// 拿到回答、打印、退出。给脚本与定时任务用。
//
//   node src/headless.js "帮我看看这个项目用了什么测试框架"
//
// 设计要点：
//   - 默认跑在**全新会话**（临时 user dir）：不碰用户正在聊的那条对话，
//     也不把整段历史拖进上下文。LLM 凭据与安全档位会拷过去，所以权限行为与本体一致。
//   - 复用真实管线而不是另写一套：headless 只是在 index.js 的 main() 里走了另一条分支，
//     工具、注入、识别器、审计、Turn Trace 全都是同一套。另写一套必然慢慢跑偏。
//   - 没有 UI 连着：需要人参与的工具（审批卡 / ask_user_question / exit_plan_mode 评审）
//     会如实报「不可用」，而不是挂到超时。这是 headless 应有的语义——脚本里没有人可问。
import {
  EXIT,
  HEADLESS_ENV,
  HELP_TEXT,
  defaultSessionDir,
  parseHeadlessArgs,
  prepareHeadlessSession,
} from './runtime/headless-session.js'

export { parseHeadlessArgs, prepareHeadlessSession, parseTimeout, HELP_TEXT, EXIT, HEADLESS_ENV } from './runtime/headless-session.js'

async function main() {
  let options
  try {
    options = parseHeadlessArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`headless: ${error.message}`)
    return EXIT.BAD_ARGS
  }

  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return EXIT.ANSWERED
  }
  if (!options.task) {
    console.error('headless: no task given. Pass it as the first argument, or see --help.')
    return EXIT.BAD_ARGS
  }

  // 会话目录：默认临时新建；--keep-session 直接用真实 user dir（会写进真实对话）
  let sessionDir = null
  if (!options.keepSession) {
    sessionDir = options.sessionDir || defaultSessionDir()
    const prepared = prepareHeadlessSession({
      sourceUserDir: process.env.ALICE_USER_DIR || process.cwd(),
      sessionDir,
    })
    sessionDir = prepared.sessionDir
    console.log(`[headless] fresh session: ${sessionDir}`)
    if (prepared.carried.length > 0) console.log(`[headless] carried over: ${prepared.carried.join(', ')}`)
    if (prepared.missing.includes('config.json')) {
      console.error('[headless] no config.json in the source user dir — there is no model credential to use.')
      console.error('[headless] run the app once to configure a provider, or pass --keep-session.')
      return EXIT.BAD_ARGS
    }
  }

  // 环境变量必须在 import index.js **之前**设好：paths.js 是在导入期读取它们的。
  // 关键的一条是 ALICE_USER_DIR —— DB、配置、沙盒全都挂在它下面。
  // 只准备目录却不把它指过去，就会「复制了一份配置到临时目录，然后照样写真实库」：
  // 看起来一切正常，实际整个全新会话是假的。冒烟测试里就是靠「新会话居然恢复了
  // 上一轮的线索」发现的。
  if (sessionDir) {
    process.env.ALICE_USER_DIR = sessionDir
    process.env[HEADLESS_ENV.SESSION_DIR] = sessionDir
  }
  process.env[HEADLESS_ENV.MODE] = '1'
  process.env[HEADLESS_ENV.TASK] = options.task
  process.env[HEADLESS_ENV.TIMEOUT] = String(options.timeoutMs)
  process.env[HEADLESS_ENV.JSON] = options.json ? '1' : '0'

  // index.js 在导入时就会调 main()，headless 分支在那里接手并自己决定退出码，
  // 所以这里不需要（也不应该）再 await 任何东西。
  await import('./index.js')
}

main().then((code) => {
  if (typeof code === 'number') process.exit(code)
}).catch((error) => {
  console.error(`[headless] fatal: ${error?.stack || error?.message || error}`)
  process.exit(EXIT.RUN_FAILED)
})
