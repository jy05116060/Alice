// 话题漂移 · 活 app 端到端 20 轮测试（提问式话术，禁 media_mode/exec_command，不动桌面）
// 用法：node scripts/test-drift-live.mjs
// 读 focus_topic（/conversations）判断每轮归属，关键看"裸指代不漂 / 精确回指能切回"。
const BASE = 'http://127.0.0.1:3721'
const MYID = 'ID:DRIFTTEST'
const FORBID = ['media_mode', 'exec_command']

// group: 期望归属的组别（ladder/music/write/leaf/follow）。same=应与某轮同线索，switch=应与上一实质轮换线索
const TURNS = [
  { n: 1,  text: '帮我讲讲现在开源大模型天梯榜大概是什么排名', group: 'ladder', expect: '建话题·天梯A' },
  { n: 2,  text: '我更想了解那种盲测投票的榜单是怎么回事', group: 'ladder', expect: '续A' },
  { n: 3,  text: '那个榜单一般多久更新一次', group: 'ladder', expect: '泛指代·续A' },
  { n: 4,  text: '它前三名通常是哪几个模型', group: 'ladder', expect: '裸指代"它"·不漂·A' },
  { n: 5,  text: '那这个排名到底可不可信，有什么争议', group: 'ladder', expect: '指代·A' },
  { n: 6,  text: '换个话题，周杰伦最近有什么新歌', group: 'music', expect: '真切换·音乐B' },
  { n: 7,  text: '他早期专辑你印象最深的是哪张', group: 'music', expect: '裸指代"他"·B' },
  { n: 8,  text: '七里香大概是哪一年发行的来着', group: 'music', expect: '续B' },
  { n: 9,  text: '对了今天广州天气怎么样', group: 'leaf', expect: '叶子·不改焦点(留B)' },
  { n: 10, text: '刚说的那张专辑里你最推荐哪一首', group: 'music', expect: '就近回指·B' },
  { n: 11, text: '回到刚才那个开源天梯榜，DeepSeek 排第几', group: 'ladder', expect: '精确回指(远)·切回A' },
  { n: 12, text: '帮我想一篇讲大模型评测方法的短文提纲', group: 'write', expect: '真切换·写作C' },
  { n: 13, text: '开头那部分从历史背景写起好不好', group: 'write', expect: '泛指代·续C·不冒"开头"伪线索' },
  { n: 14, text: '那个评测的关键指标你建议列哪几个', group: 'write', expect: '精确回指·C' },
  { n: 15, text: '这个提纲你觉得大概写得怎么样了', group: 'write', expect: '指代性进度·C' },
  { n: 16, text: '那篇短文你会给它取个什么标题', group: 'write', expect: '精确回指·C' },
  { n: 17, text: '说回天梯榜那个事，开源和闭源差距大吗', group: 'ladder', expect: '精确回指·A' },
  { n: 18, text: '那个周杰伦的话题，他一共获过几次金曲奖', group: 'music', expect: '精确回指·B' },
  { n: 19, text: '这个整体聊下来你怎么看', group: 'follow', expect: '裸指代·续当前前台' },
  { n: 20, text: '好了今天就聊到这儿，谢谢你', group: 'leaf', expect: '收尾叶子·noop' },
]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function getJson(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

async function sendMsg(text) {
  const res = await fetch(BASE + '/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_id: MYID, content: text, channel: 'API', forbidden_tools: FORBID }),
  })
  if (!res.ok) throw new Error(`POST /message → HTTP ${res.status}`)
  return res.json()
}

// 等本轮归属落定：我这条 user 消息的 focus_topic 变非空；顺带抓到本轮 assistant 回复
async function waitTurn(text, sinceReplyId, { maxMs = 80000 } = {}) {
  const t0 = Date.now()
  let focusTopic = ''
  let reply = ''
  let gotTopicAt = 0
  while (Date.now() - t0 < maxMs) {
    let rows = []
    try { rows = await getJson('/conversations?limit=150') } catch {}
    if (!Array.isArray(rows)) rows = []
    // 我这条 user 消息（内容唯一）
    const mine = rows.filter(r => r.from_id === MYID && r.content === text).pop()
    if (mine && mine.focus_topic && !focusTopic) { focusTopic = mine.focus_topic; gotTopicAt = Date.now() }
    // 本轮新的 assistant 回复（jarvis → 我）
    const rep = rows.filter(r => r.role === 'jarvis' && r.to_id === MYID && r.id > sinceReplyId).pop()
    if (rep) reply = String(rep.content || '').replace(/\s+/g, ' ').slice(0, 80)
    // 拿到焦点且(已有回复 或 拿到焦点后再等 18s 仍无回复) → 收
    if (focusTopic && (reply || Date.now() - gotTopicAt > 18000)) break
    await sleep(1500)
  }
  return { focusTopic, reply }
}

function lastReplyId(rows) {
  const reps = (rows || []).filter(r => r.role === 'jarvis' && r.to_id === MYID)
  return reps.length ? Math.max(...reps.map(r => r.id)) : 0
}
function tokens(s) { return String(s || '').split(/[\s,，、/]+/).filter(Boolean) }
function shareToken(a, b) { const B = new Set(tokens(b)); return tokens(a).some(t => B.has(t)) }

const results = []
console.log('— 话题漂移活 app 测试 · 20 轮（提问式，禁 media_mode/exec_command）—\n')

let baseRows = []
try { baseRows = await getJson('/conversations?limit=20') } catch {}
if (!Array.isArray(baseRows)) baseRows = []
let sinceReplyId = lastReplyId(baseRows)

for (const turn of TURNS) {
  process.stdout.write(`T${String(turn.n).padStart(2)} 发送：${turn.text}\n`)
  await sendMsg(turn.text)
  const { focusTopic, reply } = await waitTurn(turn.text, sinceReplyId)
  // 更新 sinceReplyId
  try {
    const rows = await getJson('/conversations?limit=20')
    const lid = lastReplyId(Array.isArray(rows) ? rows : []); if (lid > sinceReplyId) sinceReplyId = lid
  } catch {}
  results.push({ ...turn, focusTopic, reply })
  console.log(`     focus_topic = [${focusTopic || '(空)'}]`)
  console.log(`     回复 ≈ ${reply || '(无/异步)'}\n`)
  await sleep(800)
}

// ── 判定 ──
console.log('\n======== 归属汇总 ========')
for (const r of results) {
  console.log(`T${String(r.n).padStart(2)} [${r.group}] ${r.expect}\n        topic=[${r.focusTopic || '空'}]  ← ${r.text}`)
}

const ft = {}; for (const r of results) ft[r.n] = r.focusTopic
let fail = 0
function check(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`); if (!cond) fail++ }

console.log('\n======== 判据 ========')
// 1) 天梯组守住，尤其裸指代"它"那轮不漂
check(shareToken(ft[2], ft[1]), 'T2 续天梯线索(与T1同)')
check(shareToken(ft[3], ft[1]), 'T3 "那个榜单"泛指代续天梯')
check(shareToken(ft[4], ft[1]), 'T4 裸指代"它前三名"不漂·仍天梯【核心】')
check(shareToken(ft[5], ft[1]), 'T5 "这个排名"续天梯')
check(!/浏览|谷歌|网页|网站/.test([ft[3],ft[4],ft[5]].join()), 'T3-5 焦点不含"浏览器/网页"伪话题【核心】')
// 2) 真切换到音乐
check(!shareToken(ft[6], ft[5]), 'T6 换话题→音乐线索(与天梯不同)')
check(shareToken(ft[7], ft[6]), 'T7 裸指代"他"续音乐')
check(shareToken(ft[8], ft[6]), 'T8 续音乐')
// 3) 天气叶子不改焦点
check(shareToken(ft[9], ft[8]), 'T9 天气叶子·焦点未被改走(仍音乐)')
check(shareToken(ft[10], ft[6]), 'T10 就近回指续音乐')
// 4) 精确回指切回较远的天梯
check(shareToken(ft[11], ft[1]), 'T11 "那个开源天梯榜"精确回指·切回天梯【核心】')
// 5) 切到写作，泛指代不冒伪线索
check(!shareToken(ft[12], ft[11]), 'T12 换话题→写作线索')
check(shareToken(ft[13], ft[12]), 'T13 "那部分"泛指代续写作·不冒"开头"伪线索')
check(shareToken(ft[14], ft[12]), 'T14 "那个评测"精确回指·写作')
check(shareToken(ft[16], ft[12]), 'T16 "那篇短文"精确回指·写作')
check(!/网址|链接/.test(ft[14] || ''), 'T14 焦点不含"网址/链接"伪话题')
// 6) 多线索回指来回切
check(shareToken(ft[17], ft[1]), 'T17 "天梯榜那个事"切回天梯')
check(shareToken(ft[18], ft[6]), 'T18 "那个周杰伦话题"切回音乐')
// 7) 实质线索数收敛（天梯/音乐/写作 ≈ 3 簇，不该爆出一堆伪线索）
const distinct = [...new Set(Object.values(ft).filter(Boolean))]
console.log(`\n不同 focus_topic 取值（${distinct.length} 个）：`)
for (const d of distinct) console.log(`  - ${d}`)
check(distinct.length <= 5, `实质线索收敛(不同focus_topic ${distinct.length}≤5，无伪线索泛滥)`)

console.log(fail === 0 ? '\n✅ ALL PASS（无话题漂移）' : `\n❌ ${fail} 项 FAIL`)
process.exit(fail === 0 ? 0 : 1)
