// 话题漂移 · 活 app 全新话题 20 轮（避开被历史测试污染的话题，测"新建线索数"）
// 三话题：阳台种菜 / 周末露营 / 学做面包。提问式，禁 media_mode/exec_command。
const BASE = 'http://127.0.0.1:3721'
const MYID = 'ID:DRIFTTEST2'
const FORBID = ['media_mode', 'exec_command']

const TURNS = [
  '我想在家里阳台种点菜，有什么好上手的',          // 1 建话题·种菜
  '那种不太占地方的品种适合吗',                    // 2 那种
  '这个浇水大概多久一次',                          // 3 这个
  '它们需要晒多少太阳',                            // 4 裸指代它们
  '那这些到底会不会招虫子',                        // 5 这些
  '换个事，周末想找个地方露营你有推荐吗',          // 6 真切换·露营
  '它一般要提前订营位吗',                          // 7 裸指代它
  '帐篷那种双人的够用不',                          // 8 那种
  '对了现在几点了',                                // 9 叶子
  '刚说的那个露营地开车多久能到',                  // 10 刚说/那个
  '回到阳台种菜那事，冬天还能种吗',                // 11 精确回指·种菜
  '我还想学着自己做面包',                          // 12 真切换·面包
  '开头那步揉面有什么讲究',                        // 13 那步
  '那个发酵的温度大概多少合适',                    // 14 那个发酵
  '这个方子你觉得新手能行吗',                      // 15 这个方子
  '那种欧式面包你会配什么吃',                      // 16 那种
  '说回种菜那个，用什么土比较好',                  // 17 精确回指·种菜
  '那个露营的事，需要带些什么装备',                // 18 精确回指·露营
  '这个整体安排下来你觉得怎么样',                  // 19 裸指代
  '行了就先这样，谢谢你',                          // 20 收尾叶子
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
    if (rep) reply = String(rep.content || '').replace(/\s+/g, ' ').slice(0, 60)
    if (ft && (Date.now() - gotAt > 16000)) break
    await sleep(1500)
  }
  return { ft, reply }
}

console.log('— 全新话题 20 轮（种菜/露营/面包，测新建线索数）—\n')
for (const t of TURNS) {
  process.stdout.write(`发送：${t}\n`)
  await sendMsg(t)
  const { ft, reply } = await waitTurn(t)
  console.log(`   ft=[${ft || '空'}]  回复≈${reply || '(异步)'}\n`)
  await sleep(700)
}
console.log('全部发送完成。')
