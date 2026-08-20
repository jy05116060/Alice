const AGENT_BROWSER_RE = /(?:我的\s*浏览器)|(?:爱丽丝|小白龙|alice|agent|你(?:自己|自带|的)?|内置|自带).{0,16}(?:浏览器|browser)|(?:浏览器|browser).{0,16}(?:爱丽丝|小白龙|alice|agent|你(?:自己|自带|的)?|内置|自带)/i
const BROWSER_DATA_RE = /(?:浏览器?(?:数据|记录|历史)|历史(?:记录|数据)?|cookies?|cookie|登录(?:态|状态|数据|信息)?|站点数据|网站数据|缓存|profile|browser\s+data|browsing\s+data|site\s+data|login\s+(?:state|data))/i
const DELETE_DATA_RE = /(?:删除|删掉|清除|清掉|清理|清空|抹掉|擦除|重置|delete|clear|erase|wipe|remove)/i
const NEGATED_DELETE_RE = /(?:(?:不要|别|禁止|不准|不可|无需|不用).{0,10}(?:删除|删掉|清除|清掉|清理|清空|抹掉|擦除|重置)|(?:do\s+not|don't|never|must\s+not).{0,18}(?:delete|clear|erase|wipe|remove))/i

export function isExplicitAgentBrowserDataDeletionRequest(text = '') {
  const value = String(text || '').trim()
  return Boolean(
    value
    && !NEGATED_DELETE_RE.test(value)
    && AGENT_BROWSER_RE.test(value)
    && BROWSER_DATA_RE.test(value)
    && DELETE_DATA_RE.test(value)
  )
}

export const __internal = {
  AGENT_BROWSER_RE,
  BROWSER_DATA_RE,
  DELETE_DATA_RE,
  NEGATED_DELETE_RE,
}
