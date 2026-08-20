// SSH 远程机器托管 —— 远程命令构造与安装矩阵。
//
// 这个文件只做一件事：**把要在远端执行的命令拼出来**。没有 I/O，因此可以完整测试。
// 它值得单独成文件的原因：这里是**注入面**。任何一处忘记 shQuote，
// 一个带引号的 profileName 或机器名就能在远端执行任意命令。

import { shQuote, loginShell, safeProfileName } from './ssh-core.js'

/** 远端安装根目录（相对 $HOME）。 */
export const REMOTE_ROOT = '.dsh-desktop'
/** 远端 web 日志（相对 $HOME）。 */
export const REMOTE_WEB_LOG = '.dsh/dsh-remote-web.log'
/** pid 文件（相对 $HOME）。 */
export const REMOTE_PID_FILE = '.dsh/dsh-remote.pid'

/**
 * Node 官方分发基址，以及**备用镜像**（npmmirror）。
 *
 * 镜像存在的理由：远程机器常常在只能访问国内源的网络里，
 * `nodejs.org` 直连超时是最常见的安装失败原因。DSH 同样带镜像兜底。
 */
export const NODE_BASE_URL = 'https://nodejs.org/dist'
export const NODE_MIRROR_BASE = 'https://npmmirror.com/mirrors/node'

/** 安装矩阵。 */
export const INSTALL_MATRIX = Object.freeze({
  node: 'v22.22.0',
  pnpm: '11.7.0',
  supported: Object.freeze(['linux-x64', 'linux-arm64', 'macos-x64']),
  // 明确不支持：远端 Windows（没有 POSIX shell）、macOS arm64（无对应产物）
  unsupported: Object.freeze(['win32-x64', 'win32-arm64', 'darwin-arm64']),
})

/**
 * 安装脚本退出码。
 *
 * ⚠️ **这些码必须真的被 `exit` 出来**（2026-10-01 修正）。
 * 原先 5 个常量里有 3 个（11/12/13）**只定义、从不发射** ——
 * 常量在、测试还断言了它们的数值，但安装脚本里没有任何一处会返回它们。
 * 那三条错误路径实际上都退回了 `exit 11`（= CHECKSUM_MISMATCH），
 * 于是"缺解压工具"被报成"校验和不匹配"。**这是把一种故障谎报成另一种。**
 *
 * 现已逐条接线：
 *   9  NO_DOWNLOADER       远端既无 curl 也无 wget
 *   10 ALL_SOURCES_FAILED  所有下载源都失败
 *   11 CHECKSUM_MISMATCH   摘要比对不一致（**本脚本暂不做摘要校验，见报告**）
 *   12 NO_UNZIP            远端缺少可用的解压工具（tar/unzip/python3）
 *   13 PNPM_INSTALL_FAILED 远端依赖安装失败（**由上层 install 流程使用**）
 *   14 ARCHIVE_CORRUPT     压缩包下载到了但解压失败（截断/损坏）
 *
 * 说明：11 与 13 在**本函数产出的脚本**里不会被触发 —— 11 需要摘要校验、
 * 13 需要 pnpm 安装阶段，两者都属于完整安装流程的后续步骤。
 * 这里如实标注，而不是留一个假装在用的常量。
 */
export const INSTALL_EXIT = Object.freeze({
  NO_DOWNLOADER: 9,
  ALL_SOURCES_FAILED: 10,
  CHECKSUM_MISMATCH: 11,
  NO_UNZIP: 12,
  PNPM_INSTALL_FAILED: 13,
  ARCHIVE_CORRUPT: 14,
})

/** 把 `uname -s` / `uname -m` 的输出映射到安装矩阵的键。 */
export function remotePlatformKey(unameS, unameM) {
  const os = String(unameS ?? '').trim()
  const arch = String(unameM ?? '').trim()
  if (os === 'Linux' && arch === 'x86_64') return 'linux-x64'
  if (os === 'Linux' && (arch === 'aarch64' || arch === 'arm64')) return 'linux-arm64'
  if (os === 'Darwin' && arch === 'x86_64') return 'macos-x64'
  if (os === 'Darwin' && arch === 'arm64') return 'darwin-arm64'
  if (os === 'Windows' || os.startsWith('MINGW') || os.startsWith('CYGWIN')) return 'win32-x64'
  return 'unknown'
}

export function isSupportedPlatform(key) {
  return INSTALL_MATRIX.supported.includes(key)
}

/** `REMOTE_PLATFORM_UNSUPPORTED` 的判定与文案。 */
export function platformUnsupportedMessage(key) {
  return `REMOTE_PLATFORM_UNSUPPORTED: ${key} is not supported (supported: ${INSTALL_MATRIX.supported.join(', ')})`
}

/** 探测远端平台：`uname -srm` 一次拿全。 */
export function platformProbeCommand() {
  return loginShell('uname -srm')
}

/**
 * 远端 dsh 入口探测：先看 zip 布局，再看 npm 布局，按此优先级。
 * 打绝对路径（`$HOME` 已展开），无则什么都不打。
 */
export function dshEntryProbeCommand() {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `if [ -f "$ROOT/dependencies/dsh/node_modules/dsh/bin/dsh.js" ]; then printf '%s\\n' "$ROOT/dependencies/dsh/node_modules/dsh/bin/dsh.js"`,
    'elif [ -f "$ROOT/dependencies/dsh/bin/dsh.js" ]; then printf \'%s\\n\' "$ROOT/dependencies/dsh/bin/dsh.js"',
    'fi',
    'true',
  ].join('\n')
}

/** 远端三件套（对应 DSH 的 `checkMissingCommand`）。 */
export const REMOTE_COMPONENTS = Object.freeze(['node', 'dsh', 'pnpm'])

/**
 * 探测远端**缺哪些组件**（对应 DSH 的 `checkMissingCommand`）。
 *
 * ⚠️ 这个探测是**必须的**（2026-10-01 补）。DSH 的安装流程是：
 * ```
 *   探平台 → 查缺失组件 → 缺就装 / 不缺就跳过 → 启动
 * ```
 * 而爱丽丝原先**整段跳过了"安装"这一步**：`machine.install` 只调 `startCommandFor`，
 * 于是接口名为 install，实际只做 start。
 *
 * 输出：每行一个缺失组件名；全都在则无输出。这样上层既能"缺什么装什么"，
 * 也能在全都就绪时**跳过**安装（避免每次 install 都重新下载几百 MB）。
 */
export function checkMissingCommand() {
  const root = `$HOME/${REMOTE_ROOT}`
  return [
    `ROOT="${root}"`,
    'MISSING=""',
    `[ -x "$ROOT/runtime/bin/node" ] || MISSING="$MISSING node"`,
    `[ -f "$ROOT/dependencies/dsh/node_modules/dsh/bin/dsh.js" ] || [ -f "$ROOT/dependencies/dsh/bin/dsh.js" ] || MISSING="$MISSING dsh"`,
    // pnpm 既可能在 runtime/bin 下，也可能是 node 自带的 corepack shim——
    // 只在两处都找不到时才算缺，否则会把"其实能用"的机器误判成待安装。
    `if [ ! -x "$ROOT/runtime/bin/pnpm" ] && [ ! -x "$ROOT/runtime/bin/pnpm.cjs" ]; then MISSING="$MISSING pnpm"; fi`,
    'if [ -n "$MISSING" ]; then printf "%s\\n" "$MISSING" | tr " " "\\n" | grep -v "^$"; fi',
    'true',
  ].join('\n')
}

/** 解析 `checkMissingCommand` 的输出：白名单过滤，未知词不认。 */
export function parseMissingComponents(stdout) {
  const known = new Set(REMOTE_COMPONENTS)
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => known.has(line))
}

/**
 * 启动令牌查找：远端把带 token 的 URL 打进了 web 日志。
 * 取**最后一个**匹配（重启过的实例会追加新行，最新的才是活的）。
 */
export function launchTokenCommand() {
  return `grep -oE 'token=[A-Za-z0-9._~-]+' "$HOME/${REMOTE_WEB_LOG}" 2>/dev/null | tail -n 1 | cut -d= -f2`
}

/**
 * 远程实例的启动命令。
 *
 * 关键不变量（每一条都有理由）：
 *  - **双层子 shell + `&`**：让 exec 通道立刻结算。单层 `&` 不够——外层 shell
 *    仍会等内层退出，于是 exec 挂到远端进程结束才返回。
 *  - `--host 127.0.0.1`：远端只监听回环，不对外暴露端口（隧道才是唯一入口）。
 *  - `--no-open`：远端没有浏览器，调用它只会报错。
 *  - 端口**传两次**（`DSH_WEB_PORT` 环境变量 + `--port`）：两条路径读的变量不同，
 *    只给一个会在某些版本里落到默认端口。
 *  - pid 写 `$HOME/.dsh/dsh-remote.pid`，供后续停止/查活。
 *  - stdin `/dev/null`：否则远端进程会继承 SSH 通道，EOF 时序不可控。
 *  - **刻意不用 `nohup`**：macOS 上 `nohup` 会让子进程被系统特殊对待，
 *    反而在会话结束时被杀。重定向 + 子 shell 已经足够脱离。
 *  - 所有插入值经 `shQuote`。
 */
export function startCommandFor(profile, { dshBin } = {}) {
  // 用户显式给了启动命令：尊重它，只补「脱离 + 重定向 + stdin /dev/null」。
  if (typeof profile.startCommand === 'string' && profile.startCommand !== '') {
    return `mkdir -p "$HOME/.dsh" && ( ${profile.startCommand} >>"$HOME/${REMOTE_WEB_LOG}" 2>&1 < /dev/null & ) &`
  }
  const node = `$HOME/${REMOTE_ROOT}/runtime/bin/node`
  const entry = dshBin ?? `$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/dsh/bin/dsh.js`
  const profileName = safeProfileName(profile.profileName)
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `NODE=${node}`,
    `DSH_BIN=${entry}`,
    'LOG_DIR="$HOME/.dsh"',
    `LOG="$LOG_DIR/dsh-remote-web.log"`,
    // 三件套不齐就直接报错，别启动一个必然失败的进程
    'if [ ! -x "$NODE" ] || [ ! -f "$DSH_BIN" ]; then echo "REMOTE_NOT_INSTALLED: 远端三件套未安装完整"; exit 1; fi',
    'mkdir -p "$LOG_DIR"',
    `export PATH="$ROOT/runtime/bin:$PATH"`,
    `export DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 DSH_WEB_PORT=${Number(profile.remotePort)}`,
    // 取「档案名」而不是 `profile.name`：机器记录里档案名的字段是 `profileName`
    // （见上面 `safeProfileName(profile.profileName)`），`name` 是**机器显示名**、常常缺省。
    // DSH 原版这里写的是 `profile.name`，缺省时 `shQuote(undefined)` 会产出**字面量
    // `'undefined'`**，远端 `sessionRole()` 只判 `origin === ''`，于是把字符串 "undefined"
    // 当成合法 origin 记下来。本移植刻意修正为档案名（两者都缺时回落 `safeProfileName`
    // 的默认值 `remote`），避免把 'undefined' 泄漏进远端会话标识。
    `export DSH_REMOTE_SESSION_ORIGIN=${shQuote(profileName)}`,
    `( sh -c 'echo $$ > "$1/.dsh-remote.pid"; exec "$2" "$3" --profile "$5" --host 127.0.0.1 --port "$4" --no-open' dsh-remote "$LOG_DIR" "$NODE" "$DSH_BIN" ${Number(profile.remotePort)} ${profileName} </dev/null >>"$LOG" 2>&1 & )`,
    `echo "远端实例已拉起（档案: ${profileName}, 日志: $LOG）"`,
  ].join('\n')
}

/** 停止远端实例：读 pid 文件，杀掉，清文件。 */
export function stopCommandFor() {
  return [
    'P="$HOME/.dsh/dsh-remote.pid"',
    'if [ -f "$P" ]; then kill "$(cat "$P")" 2>/dev/null; rm -f "$P"; echo stopped; else echo "no pid file"; fi',
  ].join('\n')
}

/** 健康检查：远端 web 是否已经在监听。 */
export function healthCommandFor(remotePort) {
  return `curl -fsS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${Number(remotePort)}/' 2>/dev/null || true`
}

/** 读远端版本：`dsh --version`。 */
export function versionCommandFor(profile, { dshBin } = {}) {
  const entry = dshBin ?? `$HOME/${REMOTE_ROOT}/dependencies/dsh/node_modules/dsh/bin/dsh.js`
  const node = `$HOME/${REMOTE_ROOT}/runtime/bin/node`
  return `[ -x "${node}" ] && PATH="$HOME/${REMOTE_ROOT}/runtime/bin:$PATH" "${node}" "${entry}" --version 2>/dev/null || true`
}

/**
 * 安装脚本（远端三件套）。**退出码区分失败原因**，便于上层映射成具体提示。
 *
 * ⚠️ 本脚本**不做摘要校验**（DSH 会校验 sha256/sha512 并 exit 11）。
 * 因此这里**不发射 11**——留着它假装在用，等于让"缺解压工具"这类故障
 * 有机会被报成"校验和不匹配"，把用户引向错误的排查方向。
 * `CHECKSUM_MISMATCH(11)` 与 `PNPM_INSTALL_FAILED(13)` 如实保留在常量表里，
 * 供将来接上摘要校验 / pnpm 安装阶段使用，但**本脚本不发射**。
 *
 * 本机没有可用的远端环境，此脚本**未端到端验证**——见报告。
 */
export function installScript({ remotePort = 3080, platform = 'linux-x64' } = {}) {
  const base = `${NODE_BASE_URL}/${INSTALL_MATRIX.node}`
  const nodeAsset = platform === 'macos-x64' ? `node-${INSTALL_MATRIX.node}-darwin-x64.tar.gz`
    : platform === 'linux-arm64' ? `node-${INSTALL_MATRIX.node}-linux-arm64.tar.xz`
      : `node-${INSTALL_MATRIX.node}-linux-x64.tar.xz`
  return [
    'set -e',
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'mkdir -p "$ROOT/runtime" "$ROOT/dependencies/dsh"',
    'cd "$ROOT/runtime"',
    'DL=""',
    'for c in curl wget; do if command -v "$c" >/dev/null 2>&1; then DL="$c"; break; fi; done',
    `if [ -z "$DL" ]; then echo "no downloader"; exit ${INSTALL_EXIT.NO_DOWNLOADER}; fi`,
    `URL="${base}/${nodeAsset}"`,
    // 主源 + 镜像源。原先这里是 `for u in "$URL" "$URL"` —— **同一个 URL 循环两次**，
    // 看着像"多源容错"，实际只是重复请求同一个地址：
    // 主站不可达时两次都失败，而"国内容器常连不上 nodejs.org"正是最常见的场景。
    // 行为上和只写一次毫无区别，却让读者以为有兜底。这是**用一个循环冒充冗余**。
    `MIRROR="${NODE_MIRROR_BASE}/${INSTALL_MATRIX.node}/${nodeAsset}"`,
    'OK=0',
    'for u in "$URL" "$MIRROR"; do',
    '  if [ "$DL" = curl ]; then curl -fsSL "$u" -o node.tar || continue; else wget -qO node.tar "$u" || continue; fi',
    '  OK=1; break',
    'done',
    `if [ "$OK" != 1 ]; then echo "all sources failed"; exit ${INSTALL_EXIT.ALL_SOURCES_FAILED}; fi`,
    // ⚠️ **不可解压必须报 NO_UNZIP(12)，不能报 11**（2026-10-01 修正）。
    // 原先这里是 `tar ... || exit 11` —— 退回 11 是 `CHECKSUM_MISMATCH`。
    // 于是"没有可用的解压工具"会被上层报成"校验和不匹配"，
    // 用户去查网络/镜像，而真正的问题是远端缺 tar。**这是把一种故障谎报成另一种。**
    // 与 DSH 对齐：解压工具缺失 → exit 12（DSH 的 extract_zip 用 12）。
    `if ! command -v tar >/dev/null 2>&1; then echo "REMOTE_INSTALL_NO_UNZIP: 远端缺少 tar，无法解压 Node 运行时包"; exit ${INSTALL_EXIT.NO_UNZIP}; fi`,
    `if [ "${'${node.tar##*.}'}" = xz ]; then tar -xJf node.tar --strip-components=1 || exit ${INSTALL_EXIT.ARCHIVE_CORRUPT};`,
    `else tar -xzf node.tar --strip-components=1 || exit ${INSTALL_EXIT.ARCHIVE_CORRUPT}; fi`,
    'rm -f node.tar',
    'echo "runtime ready"',
  ].join('\n')
}

/** 安装脚本执行包装（经 loginShell 安全引用）。 */
export function installCommandFor(options) {
  return loginShell(installScript(options))
}

/** 所有远程命令统一走 loginShell + shQuote 的入口，便于审计「有没有漏掉引用」。 */
export function buildRemoteCommand(raw) {
  return loginShell(raw)
}

export { shQuote, loginShell, safeProfileName }
