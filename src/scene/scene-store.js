// SceneStore —— Agent 驱动 UI 的唯一真相源。
//
// 持有当前场景(surfaces + 单调递增的 rev),通过幂等的 set(id, surface|null) 变更。
// 本模块与传输无关:变更通过订阅者回调向外广播,由传输层(scene-server.js)转成协议消息。
// 协议见仓库根目录 SCENE-PROTOCOL.md;理念见桌面《Agent-驱动UI-设计方案.md》。

const ALLOWED_INTENTS = new Set(['ambient', 'inform', 'confront'])

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

// 规范化一个 surface,丢弃非法/未知形态,保证下发给 shell 的始终合法。
// 字段顺序固定,便于下面 jsonEqual 做幂等判定。
function normalizeSurface(id, input) {
  const surface = { id, kind: String(input.kind) }
  surface.data = isPlainObject(input.data) ? input.data : {}
  surface.intent = ALLOWED_INTENTS.has(input.intent) ? input.intent : 'inform'
  if (input.focus === true) surface.focus = true
  if (typeof input.order === 'number') surface.order = input.order
  return surface
}

// 仅针对 JSON 安全数据的相等判定,用于幂等(内容没变就不 bump rev、不广播)。
// 判错只会导致多发一次冗余 patch(shell 端 morph 等值数据 = 无操作),不影响正确性。
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export class SceneStore {
  constructor() {
    this.surfaces = new Map()   // id -> 规范化后的 surface,保留插入顺序
    this.rev = 0                // 单调递增版本号,初始 0
    this.listeners = new Set()
  }

  // 订阅场景变更。回调收到 { rev, op },op 形如:
  //   { op: 'upsert', surface }  |  { op: 'remove', id }  |  { op: 'clear' }
  // 返回取消订阅的函数。
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _emit(op) {
    for (const fn of this.listeners) {
      try { fn({ rev: this.rev, op }) } catch { /* 单个订阅者出错不影响其他 */ }
    }
  }

  // 幂等 upsert / remove。返回是否真的发生了变化。
  //   set(id, null)        移除该 surface
  //   set(id, { kind, ... }) 插入或整体替换
  set(id, input) {
    if (!id || typeof id !== 'string') throw new Error('scene.set: id 必须是非空字符串')

    // 置空 = 移除
    if (input == null) {
      if (!this.surfaces.has(id)) return false   // 无变化,不 bump
      this.surfaces.delete(id)
      this.rev += 1
      this._emit({ op: 'remove', id })
      return true
    }

    if (!input.kind || typeof input.kind !== 'string') {
      throw new Error('scene.set: surface 必须含字符串 kind')
    }
    const next = normalizeSurface(id, input)
    const prev = this.surfaces.get(id)
    if (prev && jsonEqual(prev, next)) return false   // 幂等:内容无变化

    this.surfaces.set(id, next)
    this.rev += 1
    this._emit({ op: 'upsert', surface: next })
    return true
  }

  // 读取单个 surface 的规范化副本(只读;不存在返回 null)。
  // 供 core 侧需要回查 surface 携带数据时使用(如安全确认把待应用变更存在 data.pending)。
  get(id) {
    return this.surfaces.get(id) || null
  }

  // 当前全量快照(协议 §3.1 的 scene 消息体)。
  snapshot() {
    return { v: 1, type: 'scene', rev: this.rev, surfaces: this._orderedSurfaces() }
  }

  // 按 order 升序排列(无 order 视为 0),order 相同保持插入序(稳定)。
  _orderedSurfaces() {
    return [...this.surfaces.values()]
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const oa = typeof a.s.order === 'number' ? a.s.order : 0
        const ob = typeof b.s.order === 'number' ? b.s.order : 0
        return oa !== ob ? oa - ob : a.i - b.i
      })
      .map(x => x.s)
  }

  // 紧凑清单,供回注 Agent 上下文(设计方案 §四;SCENE-PROTOCOL 规范级小节待补)。
  // 只给 id/kind/intent/focus —— 让 Agent 知道"屏上有什么",但碰不到像素。
  manifest() {
    return this._orderedSurfaces().map(s => ({
      id: s.id,
      kind: s.kind,
      intent: s.intent || 'inform',
      focus: !!s.focus,
    }))
  }

  // 清空全部 surface(广播为一次全量快照,见 scene-server)。
  clear() {
    if (this.surfaces.size === 0) return false
    this.surfaces.clear()
    this.rev += 1
    this._emit({ op: 'clear' })
    return true
  }
}

// 进程级单例:工具与传输层共享同一份真相源。
export const sceneStore = new SceneStore()
