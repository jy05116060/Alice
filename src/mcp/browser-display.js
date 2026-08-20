import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

export const BROWSER_DISPLAY_CARD = 'card'
export const BROWSER_DISPLAY_WINDOW = 'window'

const EXPLICIT_CARD_MODE_RE = /(?:你的浏览器|小\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口|卡片)|卡片浏览器|浏览器卡片|卡片模式|缩略(?:卡片|窗口|模式)?|行动日志.{0,8}(?:窗口|卡片)|后台浏览|静默浏览|不打开窗口|不(?:要|用|使用|打开).{0,10}(?:大\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口)|外部窗口|外部大窗口)|compact\s+browser|small\s+browser|browser\s+card)/i
const CARD_MODE_RE = /^(?:帮我|请)?(?:搜|搜索|查|查询|检索|看看)|(?:上网|网上|联网).{0,8}(?:搜|搜索|查|查询|看看)|(?:搜|搜索|查|查询|检索|了解|看看|读取|阅读|总结|概括|摘要).{0,18}(?:网页|网站|网上|互联网|资料|信息|内容|文章|新闻|结果|官网|文档|天气|价格|汇率|赛程|比分)|(?:百度|谷歌|bing|google).{0,12}(?:搜|搜索|查)|(?:web\s*search|search|look\s*up|find|read|summari[sz]e).{0,20}(?:web|online|internet|website|webpage|page|article|news|docs?)/i
const FACT_LOOKUP_RE = /(?:谁是|是谁|是什么(?:人|公司|组织|项目|产品|软件|东西)?|是做什么的|做什么的|(?:人物|公司|产品|项目)?(?:简介|资料|背景|经历|生平|履历))|^(?:请)?(?:介绍|讲讲|科普|了解)(?:一下|下)?[\s“"'‘’]*[\p{L}\p{N}]/iu
const WINDOW_MODE_RE = /(?:我的浏览器|大\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口)|外部(?:大\s*(?:一\s*点\s*)?(?:的\s*)?)?(?:浏览器|窗口)|完整浏览器|可见浏览器|我来操作|我自己操作|让我操作|手动操作|展示给我|(?:打开|切到|显示|展示).{0,12}(?:给我看|让我看))|(?:登录|登入|注册|扫码|填写|填入|输入框|点击|点一下|回复|发表评论|评论一下|写评论|发帖|发布|提交|上传|下载|拖动|悬停|验证码|支付|购买|下单|看视频|观看视频|播放视频).{0,18}(?:网页|网站|页面|按钮|链接|菜单|标签|表单|账号|内容|评论|帖子)?|(?:browser\s+window|visible\s+browser|log\s*in|sign\s*in|fill\s+(?:in\s+)?(?:a\s+)?form|click|reply|(?:write|leave|post)\s+(?:a\s+)?comment|post|publish|submit|upload|download|drag|hover|captcha|checkout)/i
const EXPLICIT_WINDOW_MODE_RE = /(?:我的浏览器|大\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口)|外部(?:大\s*(?:一\s*点\s*)?(?:的\s*)?)?(?:浏览器|窗口)|完整浏览器|可见浏览器|browser\s+window|visible\s+browser|large\s+(?:browser|window))/i
const DISPLAY_MODE_REQUEST_RE = /(?:(?:切换|切到|切回|换成|改成|调成|显示为|变成|放到|回到|使用|用|打开).{0,16}(?:你的浏览器|我的浏览器|小\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口|卡片)|大\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口)|浏览器卡片|卡片浏览器|外部浏览器|外部窗口)|(?:你的浏览器|我的浏览器|小\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口|卡片)|大\s*(?:一\s*点\s*)?(?:的\s*)?(?:浏览器|窗口)|浏览器卡片|卡片浏览器|外部浏览器|外部窗口).{0,12}(?:打开|显示|切换|模式|一下|吧))|(?:(?:switch|change|use|open).{0,16}(?:browser|webpage).{0,12}(?:card|compact|small|window|large))/i
const SYSTEM_BROWSER_INTENT_RE = /(?:(?:我(?:的)?\s*)?电脑\s*(?:上|里)?\s*(?:安装\s*)?(?:的\s*)?浏览器|电脑浏览器|系统\s*(?:默认\s*)?浏览器|默认浏览器|system\s+browser|default\s+browser)/i
const SYSTEM_BROWSER_REQUEST_RE = /(?:(?:使用|用|打开|交给|放到).{0,18}(?:(?:我(?:的)?\s*)?电脑\s*(?:上|里)?\s*(?:安装\s*)?(?:的\s*)?浏览器|电脑浏览器|系统\s*(?:默认\s*)?浏览器|默认浏览器)|(?:(?:我(?:的)?\s*)?电脑\s*(?:上|里)?\s*(?:安装\s*)?(?:的\s*)?浏览器|电脑浏览器|系统\s*(?:默认\s*)?浏览器|默认浏览器).{0,12}(?:打开|访问|搜索|看|播放))|(?:(?:use|open\s+in).{0,16}(?:the\s+)?(?:system|default)\s+browser)/i
const SYSTEM_BROWSER_NEGATION_RE = /(?:不要|别|不用|不使用|无需|不想|拒绝).{0,10}(?:(?:我(?:的)?\s*)?电脑\s*(?:上|里)?\s*(?:安装\s*)?(?:的\s*)?浏览器|电脑浏览器|系统\s*(?:默认\s*)?浏览器|默认浏览器)|(?:do\s+not|don't|avoid).{0,16}(?:system|default)\s+browser/i
// This is a distinct, controllable browser surface. It is intentionally not
// folded into the old card/window presentation choice: card is only a preview
// of the dedicated Chrome page, while window means the user sees real Chrome.
const ALICE_CHROME_INTENT_RE = /(?:(?:爱丽丝|alice|agent).{0,18}(?:专用|独立|dedicated).{0,12}(?:chrome|浏览器)|(?:专用|独立|dedicated).{0,12}(?:chrome|浏览器).{0,18}(?:爱丽丝|alice|agent)|alice\s+(?:dedicated\s+)?chrome)/i
const BROWSER_PREVIEW_FILE_RE = /^brain-ui-preview-\d{13}-\d+\.png$/
let previewSequence = 0

function normalizeBrowserIntentText(text = '') {
  return String(text || '')
    .trim()
    .replace(/^\[[^\]\r\n]+\]\s+\S+\s+\[[^\]\r\n]+\]\s*/, '')
    .trim()
}

export function inferBrowserDisplayMode(text = '', { autonomous = false } = {}) {
  const value = normalizeBrowserIntentText(text)
  // An explicit compact-view request is a presentation choice, not a guess
  // about task complexity. Honor it before generic interaction words or a
  // negated phrase such as "不要使用外部大窗口" can match WINDOW_MODE_RE.
  if (EXPLICIT_CARD_MODE_RE.test(value)) return BROWSER_DISPLAY_CARD
  if (ALICE_CHROME_INTENT_RE.test(value)) return BROWSER_DISPLAY_WINDOW
  if (WINDOW_MODE_RE.test(value)) return BROWSER_DISPLAY_WINDOW
  if (autonomous || CARD_MODE_RE.test(value) || FACT_LOOKUP_RE.test(value)) return BROWSER_DISPLAY_CARD
  return BROWSER_DISPLAY_CARD
}

export function isExplicitBrowserDisplayModeIntent(text = '') {
  const value = normalizeBrowserIntentText(text)
  return EXPLICIT_CARD_MODE_RE.test(value) || EXPLICIT_WINDOW_MODE_RE.test(value)
}

export function isExplicitBrowserDisplayModeRequest(text = '') {
  const value = normalizeBrowserIntentText(text)
  return DISPLAY_MODE_REQUEST_RE.test(value)
}

export function isSystemBrowserIntent(text = '') {
  const value = normalizeBrowserIntentText(text)
  return !SYSTEM_BROWSER_NEGATION_RE.test(value) && SYSTEM_BROWSER_INTENT_RE.test(value)
}

export function isSystemBrowserRequest(text = '') {
  const value = normalizeBrowserIntentText(text)
  return !SYSTEM_BROWSER_NEGATION_RE.test(value) && SYSTEM_BROWSER_REQUEST_RE.test(value)
}

export function inferBrowserSurface(text = '', options = {}) {
  if (isSystemBrowserIntent(text)) return 'system'
  if (ALICE_CHROME_INTENT_RE.test(normalizeBrowserIntentText(text))) return 'chrome'
  return inferBrowserDisplayMode(text, options)
}

export function isCardBrowserDisplayMode(value) {
  return String(value || '').trim().toLowerCase() === BROWSER_DISPLAY_CARD
}

export function browserPreviewDirectory() {
  return path.join(paths.sandboxDir, 'browser-output', 'reader')
}

export function createBrowserPreviewFilename(now = Date.now()) {
  previewSequence = (previewSequence + 1) % 1_000_000
  return `brain-ui-preview-${Number(now) || Date.now()}-${previewSequence}.png`
}

export function resolveBrowserPreviewFile(filename) {
  const raw = String(filename || '')
  const name = path.basename(raw)
  if (raw !== name) return ''
  if (!BROWSER_PREVIEW_FILE_RE.test(name)) return ''
  return path.join(browserPreviewDirectory(), name)
}

export function pruneBrowserPreviewFiles({ keep = 6 } = {}) {
  const directory = browserPreviewDirectory()
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  const files = entries
    .filter(entry => entry.isFile() && BROWSER_PREVIEW_FILE_RE.test(entry.name))
    .map(entry => {
      const filePath = path.join(directory, entry.name)
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(filePath).mtimeMs } catch {}
      return { filePath, mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const stale of files.slice(Math.max(1, Number(keep) || 6))) {
    try { fs.unlinkSync(stale.filePath) } catch {}
  }
}

export const __internal = {
  BROWSER_PREVIEW_FILE_RE,
  CARD_MODE_RE,
  DISPLAY_MODE_REQUEST_RE,
  EXPLICIT_CARD_MODE_RE,
  EXPLICIT_WINDOW_MODE_RE,
  FACT_LOOKUP_RE,
  WINDOW_MODE_RE,
  ALICE_CHROME_INTENT_RE,
  SYSTEM_BROWSER_INTENT_RE,
  SYSTEM_BROWSER_NEGATION_RE,
  SYSTEM_BROWSER_REQUEST_RE,
  normalizeBrowserIntentText,
}
