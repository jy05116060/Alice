// SceneStore 单元测试 —— 纯逻辑,无 DB / WS 依赖,可直接 `node src/scene/test-scene-store.js`。
// 验证:rev 单调、幂等、upsert/remove、快照排序、manifest、订阅广播的 op 形态。

import { SceneStore } from './scene-store.js'

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

// 1) 初始状态
{
  const s = new SceneStore()
  ok('初始 rev=0', s.rev === 0)
  ok('初始快照空', s.snapshot().surfaces.length === 0)
}

// 2) upsert 递增 rev、广播 upsert op
{
  const s = new SceneStore()
  const ops = []
  s.subscribe(e => ops.push(e))
  const changed = s.set('a', { kind: 'text', data: { body: 'hi' } })
  ok('首次 set 返回 changed=true', changed === true)
  ok('rev 递增到 1', s.rev === 1)
  ok('广播一次 upsert', ops.length === 1 && ops[0].op.op === 'upsert')
  ok('广播 op 携带规范化 surface', ops[0].op.surface.id === 'a' && ops[0].op.surface.intent === 'inform')
  ok('未知 intent 被规范成 inform', s.snapshot().surfaces[0].intent === 'inform')
}

// 3) 幂等:相同内容不 bump、不广播
{
  const s = new SceneStore()
  s.set('a', { kind: 'text', data: { body: 'hi' } })
  const ops = []
  s.subscribe(e => ops.push(e))
  const changed = s.set('a', { kind: 'text', data: { body: 'hi' } })
  ok('重复相同内容返回 changed=false', changed === false)
  ok('幂等不 bump rev', s.rev === 1)
  ok('幂等不广播', ops.length === 0)
}

// 4) 内容变化触发更新
{
  const s = new SceneStore()
  s.set('a', { kind: 'text', data: { body: 'hi' } })
  const changed = s.set('a', { kind: 'text', data: { body: 'bye' } })
  ok('内容变化返回 changed=true', changed === true)
  ok('rev 到 2', s.rev === 2)
  ok('内容已更新', s.snapshot().surfaces[0].data.body === 'bye')
  ok('仍只有一个 surface(同 id 替换)', s.snapshot().surfaces.length === 1)
}

// 5) remove
{
  const s = new SceneStore()
  s.set('a', { kind: 'text' })
  const ops = []
  s.subscribe(e => ops.push(e))
  const changed = s.set('a', null)
  ok('remove 返回 changed=true', changed === true)
  ok('remove 后快照空', s.snapshot().surfaces.length === 0)
  ok('广播 remove op', ops.length === 1 && ops[0].op.op === 'remove' && ops[0].op.id === 'a')
  const changed2 = s.set('a', null)
  ok('remove 不存在的 id 返回 false 且不 bump', changed2 === false && s.rev === 2)
}

// 6) 排序:order 升序,无 order 保持插入序
{
  const s = new SceneStore()
  s.set('x', { kind: 'text', order: 2 })
  s.set('y', { kind: 'text', order: 1 })
  s.set('z', { kind: 'text' })   // 无 order → 0
  const ids = s.snapshot().surfaces.map(v => v.id)
  ok('按 order 升序排列(z=0, y=1, x=2)', JSON.stringify(ids) === JSON.stringify(['z', 'y', 'x']))
}

// 7) manifest:只暴露 id/kind/intent/focus,不含 data
{
  const s = new SceneStore()
  s.set('a', { kind: 'choice', data: { prompt: '出门吗?', options: [] }, intent: 'confront', focus: true })
  const m = s.manifest()
  ok('manifest 长度 1', m.length === 1)
  ok('manifest 含 id/kind/intent/focus', m[0].id === 'a' && m[0].kind === 'choice' && m[0].intent === 'confront' && m[0].focus === true)
  ok('manifest 不含 data', !('data' in m[0]))
}

// 8) 非法输入
{
  const s = new SceneStore()
  let threw = false
  try { s.set('', { kind: 'text' }) } catch { threw = true }
  ok('空 id 抛错', threw)
  let threw2 = false
  try { s.set('a', { data: {} }) } catch { threw2 = true }
  ok('缺 kind 抛错', threw2)
}

console.log(`\nSceneStore: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
