// avatar-3d.js — 头像挂件（第五版：全量宠物动作 + 与爱丽丝运行时状态联动）
//
// 框体不变：挂件整块绝对定位铺满 .voice-canvas-card，不往卡片里加任何占位节点，
// 卡片尺寸仍由原来的 #voice-canvas 决定；切换按钮和气泡都在挂件内部绝对定位。
// 原位上的白色点云球只做视觉隐藏（opacity:0 + pointer-events:none），仍留在 DOM 里，
// voice-core 的渲染循环和它的 click→开麦 监听都没动过。
//
// 两种模式（同一时间只显示一个）：pet（宠物，默认）/ helmet（爱丽丝 3D 头盔）。
//
// 宠物动作体系完全按官方 dsh-pet 的 config.jsonc 实现（素材：PC2005-cloud/dsh-pet）：
//   · idle 待机池 / turn 转向池 / clicks 点击回应池
//   · workStatus 六档工作状态（0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error）
//     —— 由爱丽丝真实的 SSE 事件驱动（stream_start / tool_call / tool_audit / response / error）
//   · balance 六档余额（按已用百分比分档），数据取自爱丽丝 /quota
//   · whisper 碎碎念（周期随机）
//   · categories 随机动作分类池（小动作/玩耍/吃什么/时节/文字，带权重）
//
// 依赖：./vendor/three/three.module.js、./vendor/three/loaders/GLTFLoader.js
// 素材：./assets/model.glb（Alice 的 model.glb）
//       ./assets/pet/<动作名>.webm（官方全套，中文文件名，HTTP 上按 UTF-8 %-编码取）

import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/loaders/GLTFLoader.js';

const MODEL_URL = new URL('./assets/model.glb', import.meta.url).href;
const PET_BASE = new URL('./assets/pet/', import.meta.url).href;

// ── 动作池（与官方 config.jsonc 一致）────────────────────────────────────────
const ANIM = {
  idle: ['待机呼吸休闲'],
  turn: ['东张西望'],
  clicks: [
    '点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气',
    '点击回应-挠痒咯咯笑', '点击回应-元气挥手',
  ],
  // 工作状态六档，索引即档位（勿在中间插入）
  workStatus: [
    '工作状态-思考冒泡',     // 0 thinking
    '工作状态-忙碌点按',     // 1 working
    '工作状态-清点归档',     // 2 result
    '工作状态-原地踱步张望', // 3 waiting
    '工作状态-雀跃庆祝',     // 4 success
    '工作状态-垂头叹气冒汗', // 5 error
  ],
  balance: [
    '余额-钱袋满溢', '余额-金袋叮当', '余额-钱袋如常',
    '余额-数金皱眉', '余额-袋空如洗', '余额-分文不剩',
  ],
  whisper: ['碎碎念-擦桌碎碎念', '碎碎念-发呆碎碎念', '碎碎念-对屏碎碎念'],
  // 官方 moves 池（螃蟹走路要靠横移才像，给它配了 CSS 位移动画）
  moves: ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'],
  // 拖拽反馈（官方 animations.drag）
  drag: '被鼠标拖拽悬空反馈',
  categories: [
    { id: '小动作', weight: 20, actions: [
      '悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩', '哈欠连天',
      '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳', '小幅度原地360度旋转展示',
      '偷吃零食被抓住', '用鲸鱼尾巴拍打地面', '打瞌睡被惊醒', '照镜子', '整体换装试色',
      '轻快记录', '写代码', '摇扇纳凉', '晨间刷牙',
    ] },
    { id: '玩耍', weight: 20, actions: [
      '原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效', '原地跳跃抓碎头顶物品',
      '玩游戏气急败坏', '玩水枪', '小提琴演奏', '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞',
      '可爱宅舞', '吹气球', '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术',
      '抽陀螺', '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马',
      '三球抛接', '踢毽子', '下五子棋', '荡秋千',
    ] },
    { id: '吃什么', weight: 16, actions: [
      '吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐', '吃冰淇淋融化',
      '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅',
    ] },
    { id: '时节', weight: 14, actions: [
      '被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕', '吃青团',
      '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧', '舞狮头', '讨糖南瓜灯',
      '插茱萸赏菊', '放河灯', '萌化小幽灵', '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子',
    ] },
    { id: '文字', weight: 10, actions: ['是啊，吃什么', '深度思考碎碎念'] },
  ],
};

// 官方 workStatusTexts：六档气泡文案，播放时随机抽一句
const WORK_TEXTS = [
  ['正在认真想下一步呢', '让我整理一下思路~', '正在梳理接下来要做什么'],
  ['正在处理任务呢', '这一步正在进行中哦', '正在继续干活呢，别打扰我~'],
  ['这一步处理好啦，接着看下一步', '搞定一步，继续看看哦~'],
  ['需要你确认一下呢', '这里要等你看一下哦', '轮到你来决定啦，等你~'],
  ['这一轮搞定啦，真棒！', '任务完成咯，可以摸鱼啦~'],
  ['这一步好像没跑通呢', '刚才的操作遇到点问题哦', '这里卡了一下，再等等你呢'],
];

const WORK_NAME = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];
const IDLE_NAME = ANIM.idle[0];

// 节奏（秒）
const SUCCESS_HOLD_MS = 4200;   // success / error 这类瞬时档停留时长
const RESULT_HOLD_MS = 2600;
const WAITING_HOLD_MS = 8000;
const ONCE_FALLBACK_MS = 9000;  // 一次性动画没有 ended 事件时的兜底
const SAY_HOLD_MS = 6000;       // 官方状态文案的停留时长
// ── 气泡（对齐 DSH 桌宠的展示态设计）────────────────────────────────────────
// DSH 的桌宠把会话增量归约成一个「展示态」：workStatus 六档 + 工具名→活动分类 +
// 推理文本尾部滚动窗口 + 当前 todo，气泡按这个优先级选文案。这里照同一套实现：
const PET_REASONING_TAIL_WINDOW = 120;  // 推理尾部窗口字符数（与 DSH 同值）
const PET_REASONING_PUSH_MS = 500;      // 推理文本最多 500ms 推一次（与 DSH 同值）
const ACTIVITY_HOLD_MS = 3500;          // 「正在搜索」这类活动文案的停留时长
const BUBBLE_IDLE_HIDE_MS = 5000;       // 全部空闲后再挂多久就隐藏
const RANDOM_IDLE_MIN_MS = 40_000;
const RANDOM_IDLE_MAX_MS = 95_000;
const WHISPER_EVERY_MS = 300_000;   // 官方 eventsRefreshSec.whisper = 300
const BALANCE_EVERY_MS = 1_800_000; // 官方 eventsRefreshSec.balance = 1800

const MODE_KEY = 'alice.avatar.mode';
const MODES = ['pet', 'helmet'];

// ── 头盔相机参数 ─────────────────────────────────────────────────────────────
const FOV = 34;
const FIT_PADDING = 1.5;
const HELMET_LIFT = 0.2;

// ── 宠物视频缓存（LRU，避免 100 段素材全留在内存）─────────────────────────────
const CACHE_MAX = 60;
const petBlobs = new Map(); // 动作名 -> blob URL

let stageEl = null;
let layerEl = null;          // 顶层容器（挂在 body 下，fixed 定位，跟卡片矩形走）
let bootEl = null;
let petEl = null;            // 当前正在显示的那个缓冲（下面两个之一）
let petVideos = [];          // 双缓冲：切换动画时先让隐藏的那个准备好，再瞬间换显示
let activeIndex = -1;
let playSeq = 0;             // 切换世代号（防止并发切换抢同一个缓冲）
let sayEl = null;
let canvasEl = null;
let switchEl = null;
let switchButtons = [];

let renderer = null;
let scene = null;
let camera = null;
let pivot = null;
let clock = null;

let helmetHeight = 1;
let helmetWidth = 1;

let dist = 3;
let shownDist = 0;
// 头盔固定正脸：yaw=0 就是模型正面（实测 yaw=π 是后脑勺）。默认不自转，
// 想手动转就拖动，双击可以在「自转 / 定住」之间切换。
let yaw = 0;
let pitch = 0;
let autoSpin = false;
// 「动态但不转」的三个参数：上下浮动幅度、呼吸缩放幅度、高光流动速度
const HELMET_BOB = 0.014;    // 相对头盔高度的浮动幅度
const HELMET_BREATH = 0.012; // 呼吸缩放的幅度
const LIGHT_SWEEP = 0.34;    // 主光左右扫动的速度（弧度/秒）
let helmetBaseY = 0;
let keyLight = null;
let rimLight = null;
let elapsed = 0;
let dragging = false;
let lastX = 0;
let lastY = 0;
let rafId = 0;
let resizeObserver = null;

let mode = 'pet';

// ── 宠物状态机 ───────────────────────────────────────────────────────────────
let workTier = -1;        // -1 = 不在工作状态；0..5 = 官方档位
let workTimer = null;
let overrideName = null;  // 一次性动画（点击回应 / 随机动作 / 碎碎念 / 余额）
let overrideTimer = null;
let overrideCurrent = null;
let currentAnim = null;
let sayTimer = null;
// 气泡展示态（对应 DSH 桌宠 reducer 投影出来的那几个字段）
let reasoningTail = '';     // 流式推理的尾部窗口
let reasoningPushAt = 0;    // 上次推送时间（500ms 节流）
let taskText = '';          // 当前任务（task_set）
let taskProgress = '';      // 步骤进度，如 2/5
let activityText = '';      // 工具活动分类文案
let activityAt = 0;
let sayOverride = '';       // 官方 workStatusTexts 文案
let sayOverrideAt = 0;
let bubbleHideTimer = null;
let randomTimer = null;
let whisperTimer = null;
let balanceTimer = null;
let lastActivityAt = Date.now();
let eventSource = null;

function resolveSlot() {
  return document.querySelector('.voice-canvas-card');
}

// ── 顶层容器 ─────────────────────────────────────────────────────────────────
// 挂件原本住在左侧面板里，而面板是 position:fixed + z-index:3 的层叠上下文 ——
// 内层 z-index 再高也压不过 z-index 更大的浮层（设置页/模式浮层等）。
// 所以把挂件搬到 body 下的 fixed 顶层容器，矩形实时跟着卡片走：
// 视觉上仍在原位，但永远画在最上面。
function ensureLayer() {
  if (!layerEl) {
    layerEl = document.createElement('div');
    layerEl.id = 'avatar-3d-layer';
  }
  if (layerEl.parentNode !== document.body) document.body.appendChild(layerEl);
  return layerEl;
}

// 有效缩放：爱丽丝给 <html> 设了 zoom（实测 1.1）。getBoundingClientRect() 给的是
// 缩放后的视口坐标，而 fixed 容器的 left/width 还要再被 zoom 乘一次 —— 不折算的话
// 整个挂件会比卡片大 10% 并偏移，宠物气泡会正好被顶到框外（这就是「被遮挡」的根因）。
function effectiveZoom() {
  let z = 1;
  let el = document.body;
  while (el) {
    const v = parseFloat(getComputedStyle(el).zoom);
    if (Number.isFinite(v) && v > 0) z *= v;
    el = el.parentElement;
  }
  return z > 0 ? z : 1;
}

function syncLayerRect() {
  if (!layerEl || !stageEl) return;
  const card = resolveSlot();
  const mediaMode = document.body.classList.contains('video-mode')
    || document.body.classList.contains('aivideo-mode');
  // 视频面板切换时语音框可能短暂被重挂载；保留当前宠物层，
  // 等下一轮同步拿到新卡片矩形，避免宠物先出现后消失。
  if (!card || !card.isConnected) {
    if (mediaMode) return;
    layerEl.style.display = 'none';
    return;
  }

  const rect = card.getBoundingClientRect();
  const style = getComputedStyle(card);
  const hidden = style.display === 'none'
    || style.visibility === 'hidden'
    || Number(style.opacity) === 0
    || rect.width < 8 || rect.height < 8
    || rect.bottom < -40 || rect.top > window.innerHeight + 40
    || rect.right < -40 || rect.left > window.innerWidth + 40;

  // 视频模式切换后语音框会经历一帧布局过渡；保留上一帧的宠物层，
  // 不要把这次临时的零尺寸/不可见状态升级成 display:none。
  if (hidden) {
    if (mediaMode) return;
    layerEl.style.display = 'none';
    return;
  }

  const zoom = effectiveZoom();
  if (layerEl.style.display !== 'block') layerEl.style.display = 'block';
  layerEl.style.left = `${Math.round(rect.left / zoom)}px`;
  layerEl.style.top = `${Math.round(rect.top / zoom)}px`;
  layerEl.style.width = `${Math.round(rect.width / zoom)}px`;
  layerEl.style.height = `${Math.round(rect.height / zoom)}px`;
  // 圆角跟着卡片，视觉上仍像嵌在卡片里
  stageEl.style.borderRadius = style.borderRadius || '18px';
  resizeRenderer();
}

function petUrl(name) {
  return PET_BASE + encodeURIComponent(name) + '.webm';
}

// 取素材字节并转成 blob URL：静态服务历史上把 .webm 当 text/plain，
// 直接给 <video src> 会被拒播，自己指定 video/webm 最稳。
async function petSource(name) {
  if (petBlobs.has(name)) {
    const v = petBlobs.get(name);
    petBlobs.delete(name);
    petBlobs.set(name, v); // 触碰一下，LRU 保活
    return v;
  }
  let url = petUrl(name);
  try {
    const res = await fetch(url);
    if (res.ok) {
      const bytes = await res.arrayBuffer();
      url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    }
  } catch (_) { /* 退回原始 URL */ }
  petBlobs.set(name, url);
  trimCache(name);
  return url;
}

function trimCache(keepName) {
  while (petBlobs.size > CACHE_MAX) {
    const oldest = petBlobs.keys().next().value;
    if (oldest === keepName || oldest === currentAnim) break;
    const url = petBlobs.get(oldest);
    petBlobs.delete(oldest);
    if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
  }
}

function pick(list) {
  if (!list || !list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function pickCategoryAction() {
  // 移动池单独给 5% 权重（对应官方 animationWeights.move = 5）
  const pool = [...ANIM.categories, { weight: 5, actions: ANIM.moves }];
  const total = pool.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * total;
  for (const c of pool) {
    roll -= c.weight;
    if (roll <= 0) return pick(c.actions);
  }
  return pick(ANIM.categories[0].actions);
}

function allActions() {
  const out = [];
  for (const c of ANIM.categories) out.push(...c.actions);
  out.push(...ANIM.moves, ANIM.drag, ...ANIM.clicks, ...ANIM.whisper, ...ANIM.workStatus, ...ANIM.balance);
  return out;
}

// 工具名 → 活动分类文案（对齐 DSH 的 toolActivityOf 分类：
// searching / editing / testing / commanding / using-tool）
function activityLabelFor(name) {
  const value = String(name || '').toLowerCase();
  if (!value) return '';
  if (value.startsWith('browser_')) return '正在操作浏览器';
  if (/search|grep|find|glob|web|read|fetch|open|recall|memory|knowledge|analyze/.test(value)) return '正在搜索 / 查看资料';
  if (/write|edit|patch|replace|create|move|delete|install|make_dir/.test(value)) return '正在改文件';
  if (/test|check|lint|build|verify|review/.test(value)) return '正在跑验证';
  if (/shell|bash|exec|command|terminal|powershell|pwsh|process/.test(value)) return '正在执行命令';
  if (/voice|tts|speak|music|media|image|video|lyrics/.test(value)) return '正在处理媒体';
  if (/reminder|task|focus|tick|ui_set|scene|rule|subscription/.test(value)) return '正在调整状态';
  return '正在使用工具';
}

// 气泡按优先级选文案：任务 > 思考（推理尾部）> 活动 > 官方状态文案 > 兜底
function bubbleContent() {
  if (taskText) return '任务 · ' + taskText + (taskProgress ? '（' + taskProgress + '）' : '');
  if (workTier === 0 && reasoningTail) return '思考 · ' + reasoningTail;
  if (activityText && Date.now() - activityAt < ACTIVITY_HOLD_MS) return activityText;
  if (sayOverride && Date.now() - sayOverrideAt < SAY_HOLD_MS) return sayOverride;
  if (workTier === 0) return '正在分析';   // DSH 同款兜底：思考阶段还没有推理文本时
  return '';
}

function updateBubble() {
  if (!sayEl) return;
  const text = mode === 'pet' ? bubbleContent() : '';
  if (text) {
    if (sayEl.textContent !== text) sayEl.textContent = text;
    sayEl.dataset.show = '1';
  } else if (sayEl.dataset.show === '1') {
    sayEl.dataset.show = '0';
  }
}

function say(text) {
  if (!text) return;
  sayOverride = String(text);
  sayOverrideAt = Date.now();
  updateBubble();
}

// ── 视频播放（双缓冲，切换不闪）───────────────────────────────────────────────
function activeVideo() {
  return activeIndex >= 0 ? petVideos[activeIndex] : null;
}

function bufferVideo() {
  return petVideos[activeIndex === 0 ? 1 : 0];
}

// 等这一路缓冲真的能出画（canplay / loadeddata）再切，否则会空闪一帧。
// 等待期间旧动作继续播，所以画面是连续的；超时上限放宽到 2.5s，宁可晚一点换，
// 也不要在没帧的时候切过去。
function whenCanPlay(video, timeoutMs = 2500) {
  if (!video) return Promise.resolve();
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('canplay', finish);
      video.removeEventListener('loadeddata', finish);
      video.removeEventListener('playing', finish);
      video.removeEventListener('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener('canplay', finish);
    video.addEventListener('loadeddata', finish);
    video.addEventListener('playing', finish);
    video.addEventListener('error', finish);
    // 隐藏（opacity:0）的元素也要主动催一下解码
    if (video.preload !== 'auto') video.preload = 'auto';
    try { video.load?.(); } catch (_) { /* ignore */ }
  });
}

async function playAnimation(name, { once = false, fallbackMs = ONCE_FALLBACK_MS } = {}) {
  if (!name || !petVideos.length) return;

  // 世代号：切换是异步的（取片段 + 等解码），期间可能又来一次切换请求。
  // 没有这个守卫，两个请求会选中同一个缓冲、把正在显示的那路 src 换掉 → 闪一下。
  const seq = ++playSeq;

  const current = activeVideo();
  const source = await petSource(name);
  if (seq !== playSeq) return;

  if (current && current.dataset.src === source && !once) {
    currentAnim = name;
    current.play().catch(() => {});
    return;
  }

  const next = bufferVideo();
  currentAnim = name;

  if (next.dataset.src !== source) {
    next.dataset.src = source;
    next.src = source;
    next.loop = !once;
    try { next.currentTime = 0; } catch (_) { /* ignore */ }
  } else {
    // 同一路缓冲里复用同一段：只有「播一次」才需要回到片头，
    // 循环动画接着播即可（避免多余的 seek 造成一次抖动）
    next.loop = !once;
    if (once) { try { next.currentTime = 0; } catch (_) { /* ignore */ } }
  }

  await whenCanPlay(next);   // 新缓冲就位后才换显 —— 这一步是「不闪」的关键
  if (seq !== playSeq) return;   // 等待期间来了更新的请求，这一路作废
  if (activeVideo() === next) return;   // 兜底：绝不重设正在显示的那路 src

  next.id = 'avatar-3d-pet';
  next.classList.add('is-active');
  if (current && current !== next) {
    current.removeAttribute('id');
    current.classList.remove('is-active');
    // 备用缓冲不清 src，保留已解码帧。若它装的是待机循环（最常切回来的目标），
    // 就让它继续播着保持解码热；其它片段则暂停省 CPU。
    if (current.dataset.anim !== IDLE_NAME) {
      try { current.pause(); } catch (_) { /* ignore */ }
    }
  }
  activeIndex = petVideos.indexOf(next);
  petEl = next;
  next.dataset.anim = name;

  if (stageEl) {
    if (name === '螃蟹走路') stageEl.dataset.walk = '1';
    else delete stageEl.dataset.walk;
  }

  next.play().catch(() => {});

  if (once) {
    const done = () => {
      if (overrideName !== name) return;
      finishOverride();
    };
    next.onended = done;
    if (overrideTimer) clearTimeout(overrideTimer);
    overrideTimer = setTimeout(done, fallbackMs);
  } else {
    next.onended = null;
  }
  dispatchState();
}

// 一次性动作（点击回应 / 随机动作 / 碎碎念 / 余额）——播完回到当前基准状态
function playOnce(name, { sayText = '', holdMs = 0 } = {}) {
  if (!name) return;
  overrideName = name;
  overrideCurrent = name;
  if (sayText) say(sayText);
  playAnimation(name, { once: true, fallbackMs: holdMs || ONCE_FALLBACK_MS });
}

function finishOverride() {
  overrideName = null;
  overrideCurrent = null;
  if (overrideTimer) { clearTimeout(overrideTimer); overrideTimer = null; }
  applyBaseAnimation();
}

function baseAnimation() {
  if (workTier >= 0) return ANIM.workStatus[workTier];
  return IDLE_NAME;
}

function applyBaseAnimation() {
  if (overrideName) return;
  if (mode !== 'pet') return;
  const next = baseAnimation();
  if (currentAnim === next) return;
  playAnimation(next, { once: false });
}

// ── 工作状态档位 ─────────────────────────────────────────────────────────────
function setWorkTier(tier, { holdMs = 0 } = {}) {
  if (tier < 0 || tier > 5) tier = -1;
  workTier = tier;

  if (workTimer) { clearTimeout(workTimer); workTimer = null; }

  if (tier >= 0) {
    lastActivityAt = Date.now();
    const texts = WORK_TEXTS[tier] || [];
    // 工作状态优先级高于一次性动作
    overrideName = null;
    overrideCurrent = null;
    if (overrideTimer) { clearTimeout(overrideTimer); overrideTimer = null; }
    // 头盔模式下不切宠物视频（省流量），切回宠物时 applyMode 会按当前档位补上
    if (mode === 'pet') playAnimation(ANIM.workStatus[tier], { once: false });
    if (mode === 'pet' && texts.length) say(pick(texts));
    if (holdMs > 0) {
      workTimer = setTimeout(() => { setWorkTier(-1); }, holdMs);
    }
  } else {
    applyBaseAnimation();
  }
  updateBubble();
  dispatchState();
}

function isBusy() {
  return workTier >= 0 || !!overrideName;
}

function scheduleRandom() {
  if (randomTimer) clearTimeout(randomTimer);
  const wait = RANDOM_IDLE_MIN_MS + Math.random() * (RANDOM_IDLE_MAX_MS - RANDOM_IDLE_MIN_MS);
  randomTimer = setTimeout(() => {
    if (mode === 'pet' && !isBusy() && Date.now() - lastActivityAt > RANDOM_IDLE_MIN_MS) {
      playOnce(pickCategoryAction());
    }
    scheduleRandom();
  }, wait);
}

// ── 爱丽丝运行时联动 ─────────────────────────────────────────────────────────
function handleEvent(type, data) {
  switch (type) {
    case 'stream_start':
      reasoningTail = '';                   // 新回合清零（与 DSH 的 turn/start 一致）
      setWorkTier(0);                       // thinking
      break;
    case 'stream_chunk':
      // 逐 token 的推理增量：累积尾部窗口，最多 500ms 推一次气泡（与 DSH 同策略）
      if (data && data.phase === 'reasoning' && typeof data.text === 'string' && data.text) {
        reasoningTail = (reasoningTail + data.text).slice(-PET_REASONING_TAIL_WINDOW);
        const now = Date.now();
        if (now - reasoningPushAt >= PET_REASONING_PUSH_MS) {
          reasoningPushAt = now;
          if (workTier !== 0) setWorkTier(0);
          else updateBubble();
        }
      }
      break;
    case 'stream_end':
      reasoningTail = '';
      break;
    case 'tool_preparing':
    case 'tool_call':
    case 'tool_executing':
      activityText = activityLabelFor(data && (data.name || data.tool));
      activityAt = Date.now();
      setWorkTier(1);                       // working
      break;
    case 'tool_audit': {
      const failed = data && (data.ok === false || data.status === 'error' || data.status === 'denied');
      activityText = activityLabelFor(data && (data.tool || data.name)) || activityText;
      activityAt = Date.now();
      setWorkTier(failed ? 5 : 2, { holdMs: failed ? SUCCESS_HOLD_MS : RESULT_HOLD_MS });
      break;
    }
    case 'task_set':
      taskText = String((data && (data.task || data.description)) || '').trim();
      taskProgress = '';
      updateBubble();
      break;
    case 'task_step_updated':
      if (data && data.progress) taskProgress = String(data.progress);
      updateBubble();
      break;
    case 'task_cleared':
      taskText = '';
      taskProgress = '';
      updateBubble();
      break;
    case 'response':
      setWorkTier(4, { holdMs: SUCCESS_HOLD_MS });   // success
      break;
    case 'error':
    case 'message_dropped':
    case 'protocol_violation':
      setWorkTier(5, { holdMs: SUCCESS_HOLD_MS });   // error
      break;
    case 'message_in':
      // 新消息进来：先看一眼（转向动画），随后 SSE 的 stream_start 会接管
      if (!isBusy()) playOnce(pick(ANIM.turn), { holdMs: 2600 });
      break;
    case 'message_requeued':
      setWorkTier(3, { holdMs: WAITING_HOLD_MS });   // waiting（排队等重试）
      break;
    case 'processing_preempted':
      setWorkTier(3, { holdMs: WAITING_HOLD_MS });
      break;
    default:
      break;
  }
}

function connectEvents() {
  if (typeof EventSource === 'undefined') return;
  try {
    const cid = 'avatar-3d-' + Math.random().toString(36).slice(2, 10);
    eventSource = new EventSource('/events?client_id=' + cid);
    eventSource.onmessage = (e) => {
      let payload = null;
      try { payload = JSON.parse(e.data); } catch (_) { return; }
      if (!payload || !payload.type) return;
      handleEvent(payload.type, payload.data || {});
    };
    eventSource.onerror = () => { /* 浏览器自动重连 */ };
  } catch (_) { /* ignore */ }
}

// 备用信号：app.js 在 LLM 调用期间给 body 加 .model-thinking
function watchBodyClass() {
  try {
    const check = () => {
      const thinking = document.body.classList.contains('model-thinking');
      if (thinking && workTier === -1) setWorkTier(0);
      else if (!thinking && workTier === 0) setWorkTier(-1);
    };
    new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    check();
  } catch (_) { /* ignore */ }
}

async function refreshBalanceTier() {
  try {
    const res = await fetch('/quota');
    if (!res.ok) return;
    const q = await res.json();
    // /quota 的 ratio 是带百分号的字符串（"12.3%"），也可能是 0~1 的小数，两种都认
    const raw = q?.ratio;
    const p = typeof raw === 'string'
      ? parseFloat(raw)
      : (Number.isFinite(Number(raw)) ? Number(raw) * 100 : NaN);
    if (!Number.isFinite(p)) return;
    const used = Math.max(0, Math.min(100, p));
    const index = used >= 100 ? 5 : Math.floor(used / 20);
    playOnce(ANIM.balance[index]);
  } catch (_) { /* ignore */ }
}

// ── DOM ──────────────────────────────────────────────────────────────────────
function buildStage() {
  const stage = document.createElement('div');
  stage.id = 'avatar-3d-stage';

  const boot = document.createElement('div');
  boot.id = 'avatar-3d-boot';
  boot.textContent = 'loading…';
  stage.appendChild(boot);

  const sw = document.createElement('div');
  sw.id = 'avatar-3d-switch';
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', '切换头像显示');
  const buttons = MODES.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m;
    b.textContent = m === 'pet' ? '宠物' : '头盔';
    b.setAttribute('aria-pressed', 'false');
    sw.appendChild(b);
    return b;
  });
  stage.appendChild(sw);

  const sayBox = document.createElement('div');
  sayBox.id = 'avatar-3d-say';
  sayBox.dataset.show = '0';
  // 气泡不放在 stage 里 —— stage 有 overflow:hidden（要裁掉宠物素材的透明边），
  // 气泡放进去会被圆角/边缘裁掉，所以它在挂载时挂到不裁剪的顶层容器上。

  return { stage, boot, sw, buttons, sayBox };
}

function hideBoot() {
  if (bootEl) { bootEl.remove(); bootEl = null; }
}

// 环境贴图：没有它，头盔的金属材质会渲染成一团黑
function buildEnvironment(targetRenderer) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0.0, '#eaf3fd');
  g.addColorStop(0.42, '#a3bad0');
  g.addColorStop(0.52, '#2b3846');
  g.addColorStop(1.0, '#070b11');
  ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath(); ctx.ellipse(72, 30, 30, 17, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(148, 198, 255, 0.8)';
  ctx.beginPath(); ctx.ellipse(190, 42, 22, 13, 0, 0, Math.PI * 2); ctx.fill();

  const texture = new THREE.CanvasTexture(c);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(targetRenderer);
  const env = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();
  texture.dispose();
  return env;
}

function setupScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.setClearAlpha(0);

  canvasEl = renderer.domElement;
  stageEl.insertBefore(canvasEl, switchEl);

  scene = new THREE.Scene();
  scene.environment = buildEnvironment(renderer);
  scene.add(new THREE.HemisphereLight(0xc6e0ff, 0x0b111a, 1.6));
  keyLight = new THREE.DirectionalLight(0xffffff, 2.2); keyLight.position.set(2.5, 4, 3.5); scene.add(keyLight);
  rimLight = new THREE.DirectionalLight(0x63b6ff, 1.7); rimLight.position.set(-3.5, 0.6, -2.5); scene.add(rimLight);
  const fill = new THREE.DirectionalLight(0x8fc0ff, 0.75); fill.position.set(-2, 2.5, -3); scene.add(fill);

  camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 5000);
  camera.position.set(0, 0, 3);
  pivot = new THREE.Group();
  scene.add(pivot);
  clock = new THREE.Clock();
  resizeRenderer();
}

function resizeRenderer() {
  if (!renderer || !stageEl || !camera) return;
  const w = Math.max(1, stageEl.clientWidth);
  const h = Math.max(1, stageEl.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitCamera();
}

function fitCamera() {
  if (!camera || !helmetHeight) return;
  const vFov = (FOV * Math.PI) / 180;
  const vDist = (helmetHeight / 2) / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const hDist = (helmetWidth / 2) / Math.tan(hFov / 2);
  dist = Math.max(vDist, hDist) * FIT_PADDING;
}

function loadHelmet() {
  new GLTFLoader().load(MODEL_URL, (gltf) => {
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    root.position.sub(center);
    pivot.add(root);
    helmetHeight = size.y || 1;
    helmetWidth = Math.max(size.x, size.z) || 1;
    helmetBaseY = helmetHeight * HELMET_LIFT;
    pivot.position.y = helmetBaseY;
    fitCamera();
    shownDist = dist;
    if (gltf.animations && gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(gltf.animations[0]).play();
    }
    hideBoot();
  }, undefined, (err) => {
    if (bootEl) bootEl.textContent = 'helmet 加载失败';
    console.warn('[avatar-3d] helmet load failed:', err);
  });
}

function attachPet() {
  petVideos = [0, 1].map((slot) => {
    const video = document.createElement('video');
    video.className = 'avatar-3d-pet';
    video.dataset.buf = String(slot);
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('aria-label', '宠物');

    video.addEventListener('click', (e) => {
      e.stopPropagation();
      playOnce(pick(ANIM.clicks));
    });
    video.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      playOnce(pickCategoryAction());
    });
    // 拖拽反馈：真的拖动了（>6px）才播官方「被鼠标拖拽悬空反馈」，避免和单击打架
    let dragFrom = null;
    let dragFired = false;
    video.addEventListener('pointerdown', (e) => {
      dragFrom = { x: e.clientX, y: e.clientY };
      dragFired = false;
    });
    video.addEventListener('pointermove', (e) => {
      if (!dragFrom || dragFired) return;
      if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) < 6) return;
      dragFired = true;
      playOnce(ANIM.drag, { holdMs: 1600 });
    });
    const endDrag = () => { dragFrom = null; };
    video.addEventListener('pointerup', endDrag);
    video.addEventListener('pointercancel', endDrag);
    video.addEventListener('pointerleave', endDrag);
    video.addEventListener('error', () => {
      console.warn('[avatar-3d] pet video error:', video.error && video.error.code);
    });

    stageEl.insertBefore(video, switchEl);
    return video;
  });
}

function applyMode() {
  if (!stageEl) return;
  stageEl.dataset.mode = mode;
  if (canvasEl) canvasEl.style.display = mode === 'helmet' ? 'block' : 'none';
  // 宠物的显隐交给 CSS（.avatar-3d-pet.is-active），这里只负责播放/暂停
  const current = activeVideo();
  if (mode === 'pet') {
    applyBaseAnimation();
    if (current) current.play().catch(() => {});
  } else if (current) {
    try { current.pause(); } catch (_) { /* ignore */ }
    if (sayEl) sayEl.dataset.show = '0';
  }
  switchButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  if (mode === 'helmet') { shownDist = dist; startLoop(); } else { stopLoop(); }
  try { localStorage.setItem(MODE_KEY, mode); } catch (_) { /* ignore */ }
}

function setMode(next) {
  if (MODES.indexOf(next) === -1 || next === mode) return;
  mode = next;
  applyMode();
  dispatchState();
}

function bindInteraction(el) {
  el.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.008;
    pitch += (e.clientY - lastY) * 0.008;
    pitch = Math.max(-1.2, Math.min(1.2, pitch));
    lastX = e.clientX; lastY = e.clientY;
  });
  const stop = () => { dragging = false; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.max(0.05, Math.min(dist * (1 + Math.sign(e.deltaY) * 0.08), 5000));
  }, { passive: false });
  el.addEventListener('dblclick', () => { autoSpin = !autoSpin; });
}

function tick() {
  rafId = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;

  if (autoSpin && !dragging) yaw += dt * 0.42;
  pivot.rotation.set(pitch, yaw, 0);

  // 「动态但不转」：模型朝向恒定（yaw/pitch 不动），动的只是浮动、呼吸和光。
  if (!dragging && helmetHeight > 0) {
    pivot.position.y = helmetBaseY + Math.sin(elapsed * 1.05) * helmetHeight * HELMET_BOB;
    pivot.scale.setScalar(1 + Math.sin(elapsed * 0.72) * HELMET_BREATH);
  }
  if (keyLight) {
    keyLight.intensity = 2.2 + Math.sin(elapsed * 0.5) * 0.28;
    keyLight.position.x = 2.5 + Math.sin(elapsed * LIGHT_SWEEP) * 1.1;
  }
  if (rimLight) {
    rimLight.intensity = 1.7 + Math.sin(elapsed * 0.45 + 1.1) * 0.32;
    rimLight.position.x = -3.5 + Math.sin(elapsed * LIGHT_SWEEP * 0.8) * 1.8;
  }

  shownDist += (dist - shownDist) * Math.min(1, dt * 6);
  camera.position.set(0, pivot.position.y * 0.35, shownDist || dist);
  camera.lookAt(0, pivot.position.y * 0.75, 0);
  renderer.render(scene, camera);
}

function startLoop() {
  if (rafId || !renderer) return;
  clock.getDelta();
  tick();
}

function stopLoop() {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

// 给排障/自动化留个只读+少量可控的钩子
function dispatchState() {
  try {
    window.__alicePet = {
      mode,
      workTier,
      work: workTier >= 0 ? WORK_NAME[workTier] : 'idle',
      anim: currentAnim,
      busy: isBusy(),
      total: allActions().length,
      play: (name) => { playOnce(name); return name; },
      setWork: (tier, holdMs) => { setWorkTier(tier, { holdMs }); return tier; },
      setMode,
      // 握手用：把一条 SSE 事件直接喂进联动逻辑（排障/自动化测试）
      feed: (type, data) => { handleEvent(type, data || {}); return sayEl ? sayEl.textContent : ''; },
      bubble: () => (sayEl ? { show: sayEl.dataset.show, text: sayEl.textContent } : null),
      // 只读诊断：排障时看内部状态（不改任何东西）
      probe: () => ({
        currentAnim, overrideName, workTier, mode,
        tier: workTier >= 0 ? WORK_NAME[workTier] : 'idle',
        view: { yaw: Number(yaw.toFixed(4)), pitch: Number(pitch.toFixed(4)), autoSpin },
      }),
      // 调视角用：设定朝向并停掉自转
      setView: (y, p) => { autoSpin = false; yaw = Number(y) || 0; pitch = Number(p) || 0; return { yaw, pitch }; },
    };
  } catch (_) { /* ignore */ }
}

function mountAvatar() {
  if (stageEl) return stageEl;
  const slot = resolveSlot();
  if (!slot) return null;

  const dom = buildStage();
  stageEl = dom.stage;
  bootEl = dom.boot;
  switchEl = dom.sw;
  sayEl = dom.sayBox;
  switchButtons = dom.buttons;
  switchButtons.forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode(b.dataset.mode);
  }));

  // 挂件搬进 body 下的顶层容器；卡片只留一个 host class（用来藏点云球）
  const layer = ensureLayer();
  layer.appendChild(stageEl);
  layer.appendChild(sayEl);      // 气泡放在不裁剪的容器里，避免被圆角和边缘切掉
  slot.classList.add('avatar-3d-host');
  syncLayerRect();

  setupScene();
  bindInteraction(canvasEl);
  attachPet();
  loadHelmet();

  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch (_) { /* ignore */ }
  mode = MODES.indexOf(saved) !== -1 ? saved : 'pet';
  applyMode();

  // 基础循环：待机
  playAnimation(IDLE_NAME, { once: false });

  // 预热常用片段（点击回应 / 工作状态 / 拖拽 / 转向）：切换时只差解码、不差网络，
  // 配合双缓冲就能做到「点了立刻换、不空闪」。
  setTimeout(() => {
    const hot = [IDLE_NAME, ANIM.drag, ...ANIM.turn, ...ANIM.clicks, ...ANIM.workStatus];
    (async () => {
      for (const name of hot) {
        try { await petSource(name); } catch (_) { /* ignore */ }
      }
    })();
  }, 1200);

  scheduleRandom();
  whisperTimer = setInterval(() => {
    if (mode === 'pet' && !isBusy()) playOnce(pick(ANIM.whisper));
  }, WHISPER_EVERY_MS);
  balanceTimer = setInterval(refreshBalanceTier, BALANCE_EVERY_MS);

  connectEvents();
  watchBodyClass();
  dispatchState();

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => syncLayerRect());
    resizeObserver.observe(slot);
  }
  window.addEventListener('resize', syncLayerRect);
  // 左侧面板可滚动，capture 阶段监听才能收到
  window.addEventListener('scroll', syncLayerRect, true);
  window.addEventListener('beforeunload', () => {
    stopLoop();
    if (resizeObserver) resizeObserver.disconnect();
    if (eventSource) { try { eventSource.close(); } catch (_) { /* ignore */ } }
    renderer?.dispose?.();
  });

  return stageEl;
}

// 卡片被整个重建时 class 会丢（点云球就会重新露出来）。这里盯着卡片本身：
// 一旦 .avatar-3d-host 被摘掉就立刻补回来，比 400ms 轮询快得多。
let observedCard = null;
let cardObserver = null;

function watchCard(slot) {
  if (!slot || slot === observedCard) return;
  try { if (cardObserver) cardObserver.disconnect(); } catch (_) { /* ignore */ }
  try {
    cardObserver = new MutationObserver(() => {
      if (!slot.classList.contains('avatar-3d-host')) slot.classList.add('avatar-3d-host');
      forceBallHidden(slot);
    });
    cardObserver.observe(slot, { attributes: true, attributeFilter: ['class'] });
    observedCard = slot;
  } catch (_) { /* ignore */ }
}

// 兜底：class 之外再压一道内联 opacity —— 万一 class 被抹掉，球也不会立刻露出来。
// 只在挂件确实挂上时才压（挂件没挂上时球保持原样，卡片不会变成空的）。
function forceBallHidden(slot) {
  if (!slot || !stageEl) return;
  const ball = slot.querySelector('#voice-canvas');
  if (!ball) return;
  if (ball.style.opacity !== '0') ball.style.opacity = '0';
  if (ball.style.pointerEvents !== 'none') ball.style.pointerEvents = 'none';
}

// app.js 会重建 body，挂件会被摘下来：发现不在就贴回去（元素复用，场景不重建）。
// 同时让顶层容器始终跟着卡片矩形走。
function keepMounted() {
  const slot = resolveSlot();
  if (!slot) {
    if (layerEl) layerEl.style.display = 'none';
    return;
  }
  if (!stageEl) { mountAvatar(); return; }

  const layer = ensureLayer();
  if (stageEl.parentNode !== layer) layer.appendChild(stageEl);
  if (!slot.classList.contains('avatar-3d-host')) slot.classList.add('avatar-3d-host');
  forceBallHidden(slot);
  watchCard(slot);
  syncLayerRect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountAvatar, { once: true });
} else {
  mountAvatar();
}

try {
  new MutationObserver(keepMounted).observe(document.body, { childList: true });
  // 顶层容器的矩形要跟着卡片走：滚动/缩放/面板动画/页面入场缩放都会让它漂，
  // 所以除了 ResizeObserver 和 scroll 监听，再加一个 400ms 的兜底同步；
  // 顺带刷新气泡（活动文案、状态文案都有时效，靠它到期收起）。
  setInterval(() => {
    keepMounted();
    syncLayerRect();
    updateBubble();
  }, 400);
} catch (_) { /* ignore */ }

export { mountAvatar, setMode, playOnce, setWorkTier };
