// ui_set —— Agent 驱动 UI 的唯一工具(声明式)。
//
// Agent 不发命令,只声明"某个 surface 此刻应该是什么样"。幂等:同一 id 再调即更新。
// 改动写入 SceneStore(唯一真相源),由 scene-server 广播给已连接 shell。
// 协议见仓库根目录 SCENE-PROTOCOL.md;理念见桌面《Agent-驱动UI-设计方案.md》。

import { sceneStore } from '../../scene/scene-store.js'
import { sceneClientCount } from '../../scene/scene-server.js'
import { cancelSceneSurfaceRemoval, scheduleSceneSurfaceRemoval } from '../../scene/transient-surfaces.js'

export function execUISet({ id, kind, data, intent, focus, order, remove } = {}) {
  if (!id || typeof id !== 'string') {
    return '错误：ui_set 需要一个非空字符串 id(surface 的稳定标识)。'
  }

  // 移除
  if (remove === true) {
    cancelSceneSurfaceRemoval(id)
    const changed = sceneStore.set(id, null)
    return changed ? `已移除 surface "${id}"。` : `surface "${id}" 本就不存在,无变化。`
  }

  if (!kind || typeof kind !== 'string') {
    return '错误：显示/更新 surface 时必须给 kind(渲染端词汇表中的一种,如 text/metric/image/media/choice/weather,或排版原语 stack/row/col)。移除请传 remove=true。'
  }

  try {
    const changed = sceneStore.set(id, { kind, data, intent, focus, order })
    if (kind === 'weather') scheduleSceneSurfaceRemoval(id, { kind: 'weather' })
    const where = sceneClientCount() > 0 ? '' : '(当前没有已连接的界面,状态已记录,界面连上后会自动同步)'
    if (!changed) return `surface "${id}" 内容未变化(幂等,无需重复推送)。${where}`
    return `已设置 surface "${id}"(kind=${kind}${intent ? `, intent=${intent}` : ''})。${where}`
  } catch (e) {
    return `错误：${e.message}`
  }
}
