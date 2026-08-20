// 话题漂移 · 2.1.426 止血版权威验证 · 全新陌生话题（养猫/游泳/修自行车，绝无历史污染）
const BASE = 'http://127.0.0.1:3721'
const MYID = 'ID:DRIFTTEST3'
const FORBID = ['media_mode', 'exec_command']
const TURNS = [
  '我刚养了只猫，给它选猫砂有什么讲究',        // 1 建·养猫
  '那种膨润土的好还是豆腐的好',                // 2 那种
  '这个大概多久换一次',                        // 3 这个
  '它一天大概要用多少',                        // 4 裸指代它
  '那这些会不会很占地方',                      // 5 这些
  '换个事，我想学游泳，换气一直学不会',        // 6 真切换·游泳
  '它是不是要先练憋气',                        // 7 裸指代它
  '蛙泳和自由泳哪个更好上手',                  // 8 续
  '对了现在几点了',                            // 9 叶子
  '刚说的那个换气节奏怎么练',                  // 10 刚说/那个
  '回到养猫那事，猫砂盆放哪合适',              // 11 回指·养猫
  '我自行车链条老掉，想自己修',                // 12 真切换·修车
  '开头那步要先把变速调好吗',                  // 13 那步
  '那个链条的松紧怎么判断',                    // 14 那个链条
  '这个我自己弄得了吗',                        // 15 这个
  '那种快拆工具有必要买吗',                    // 16 那种
  '说回养猫那个，猫老抓沙发怎么办',            // 17 回指·养猫
  '那个游泳的事，要不要买个泳镜',              // 18 回指·游泳
  '这个整体弄下来你觉得怎么样',                // 19 裸指代
  '行了就这样，谢谢你',                        // 20 收尾叶子
]
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function getJson(p) { const r = await fetch(BASE + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json() }
async function sendMsg(text) {
  const r = await fetch(BASE + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_id: MYID, content: text, channel: 'API', forbidden_tools: FORBID }) })
  if (!r.ok) throw new Error('send ' + r.status); return r.json()
}
async function waitTurn(text, { maxMs = 80000 } = {}) {
  const t0 = Date.now(); let ft = '', gotAt = 0, reply = ''
  while (Date.now() - t0 < maxMs) {
    let rows = []; try { rows = await getJson('/conversations?limit=150') } catch {}
    if (!Array.isArray(rows)) rows = []
    const mine = rows.filter(r => r.from_id === MYID && r.content === text).pop()
    if (mine && mine.focus_topic && !ft) { ft = mine.focus_topic; gotAt = Date.now() }
    const rep = rows.filter(r => r.role === 'jarvis' && r.to_id === MYID).pop()
    if (rep) reply = String(rep.content || '').replace(/\s+/g, ' ').slice(0, 50)
    if (ft && (Date.now() - gotAt > 15000)) break
    await sleep(1500)
  }
  return { ft, reply }
}
console.log('— 2.1.426 全新话题验证（养猫/游泳/修车）—\n')
for (const t of TURNS) {
  process.stdout.write(`发送：${t}\n`)
  await sendMsg(t)
  const { ft, reply } = await waitTurn(t)
  console.log(`   ft=[${ft || '空'}] 回复≈${reply || '(异步)'}\n`)
  await sleep(700)
}
console.log('全部发送完成。')
