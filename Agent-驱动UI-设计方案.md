# Agent 驱动的界面 · 设计方案

> 一套让 Agent 控制界面、且界面与 Agent 核心彻底解耦的架构。
> 目标:支持未来开发多款界面(含电影级动画 UI),core 零改动即可换皮。
>
> 项目:Alice · 起草:Yuanda + Claude Opus 4.8 · 2026-06-23

---

## 一、核心思想:UI 是 Agent 状态的纯投影

命令式的 UI 控制(agent 喊"挂载这个 / 更新那个 / 关掉它")是一切复杂度的根源:
两端都要存状态、要对齐、agent 得记住元素 ID、要管生命周期、要处理淘汰策略。
命令式系统必然走向这种复杂度。

换一个根本视角:

> **Agent 不"操作"界面。Agent 只维护一份「场景状态」,界面是这份状态永远忠实的投影。**
>
> **`UI = f(state)`**

Agent 是导演,它只描述「此刻舞台上应该有什么」。
怎么把这份描述渲染成像素、怎么从上一帧过渡到下一帧,**全部是渲染端的职责**。
Agent 一个像素、一个 DOM 节点、一行动画代码都不碰。

这一个原则,把两件事**同时**白送给我们:

- **多款 UI**:状态是 UI 无关的纯数据。任何渲染端都能投影同一份状态。
  换 UI = 换一个投影函数,core 零改动。
- **电影级动画**:渲染端同时握有「上一帧状态」与「下一帧状态」,
  能自行计算两者之间的过渡(FLIP、共享元素转场、错峰入场)。
  电影级转场的本质就是「在两个状态间插值」——只有渲染端同时知道这两个状态时才可能做到。
  命令式的 `update` 永远做不好这件事。

**检验标准(贯穿全文的北极星):**

> core 里搜不到任何 CSS / 动画 / 像素 / DOM 的字眼;
> UI 里搜不到任何业务逻辑。
> 两端只通过「场景状态 + 用户意图」对话。

---

## 二、协议:两条信道

不要命令动词。只有两个方向。

### ① 状态下行(core → UI)

Agent 拥有的场景,以整份快照或增量补丁的形式下发。

**快照(snapshot):**

```jsonc
{
  "v": 1,
  "type": "scene",
  "rev": 42,                       // 单调递增的版本号
  "surfaces": [
    {
      "id": "weather-bj",          // 稳定身份 → 渲染端靠它在帧间追踪同一元素、做过渡动画
      "kind": "weather",           // 渲染端词汇表里的一种
      "data": {                    // 语义内容(纯数据,无样式)
        "city": "北京",
        "temp": 18,
        "condition": "晴",
        "forecast": [{ "day": "明天", "low": 12, "high": 22, "condition": "多云" }]
      },
      "intent": "inform",          // 语义重要性,不是像素:ambient | inform | confront
      "focus": false               // 是否当前焦点
    }
  ]
}
```

**增量补丁(patch,省 token,可选):**

```jsonc
{
  "v": 1,
  "type": "scene.patch",
  "rev": 43,                       // 应用本补丁后的新版本
  "base": 42,                      // 本补丁所基于的版本
  "ops": [
    { "op": "upsert", "surface": { "id": "weather-bj", "kind": "weather", "data": { ... } } },
    { "op": "remove", "id": "old-card" }
  ]
}
```

`rev` / `base` 让渲染端能发现自己漏了补丁(收到的 `base` ≠ 本地 `rev`),
漏了就请求一次全量快照。

> **断线重连 = 重发快照,状态永远不可能漂移。**
> 这是命令式架构永远拿不到的鲁棒性。

### ② 意图上行(UI → core)

用户做了**有语义**的事。

```jsonc
{
  "v": 1,
  "type": "intent",
  "surface": "choice-1",           // 来自哪个 surface
  "name": "select",                // 意图名(由 surface 的 kind 定义其词汇)
  "data": { "value": "option-a" },
  "ts": 1719100000000
}
```

只有**有意义的用户意图**才上行(点了选项、提交了表单、确认了决策)。
「停留了 5 秒」「关掉了卡片」这类生命周期信号**可以上报但只作为上下文,绝不是触发器**。
Jarvis 不会因为 Tony 关掉一个窗口就跳出来问"还需要吗"。

### ③ 握手与心跳

```jsonc
{ "v": 1, "type": "hello", "shell": "cinematic", "caps": ["scene", "patch"] }  // UI → core,声明自己是谁、支持什么
{ "v": 1, "type": "welcome", "rev": 42 }                                       // core → UI,附当前版本
{ "v": 1, "type": "resync" }                                                   // UI → core,请求全量快照
{ "v": 1, "type": "ping" } / { "v": 1, "type": "pong" }                        // 保活
```

`caps` 让 core 知道对端 shell 的能力。不同 shell 可声明不同能力,
core 据此决定下发什么——为未来的原生 shell / 弱渲染端留出空间。

---

## 三、Agent 的工具面:一个动词

不要 4 个命令动词。Agent 只需要一个心智概念——
**声明某个 surface 此刻应该是什么样:**

```
ui.set(id, { kind, data, intent, focus })   // 幂等 upsert:第一次是"显示",再调就是"更新"——同一个动作
ui.set(id, null)                              // 置空 = 移除
```

- `show` 与 `update` 因为**幂等**而合并为同一调用。
- Agent 永远在回答「现在屏幕上应该有什么」,而不是「我该发什么命令」。
- Agent 描述的是 **`intent`(语义重要性)**,不是 placement / size(像素)。

> `intent` 是 Agent 与 UI 之间最关键的抽象边界:
> Agent 说「这件事用户必须停下来看(confront)」,
> 至于把它表现成居中弹窗、还是全屏电影级 takeover,是渲染端的艺术选择。
> 耦合在这里被彻底切断。

`intent` 取值语义:

| intent | 含义 | 渲染端可能的表现(由 UI 自定) |
|---|---|---|
| `ambient` | 环境氛围信息,看完即过 | 角落微妙淡入、呼吸感、低饱和 |
| `inform` | 一般信息卡片 | 常规入场、停留 |
| `confront` | 用户必须停下来看 / 做决策 | 背景退后、全屏聚焦、镜头推进 |

---

## 四、闭环:Agent 看得见什么

Agent 每一轮都是无状态的——它声明了 scene,但下一轮并不"记得"屏上现在摆着什么
(尤其当上下文被压缩,之前的 `ui.set` 调用会被摘掉)。所以要把场景**紧凑地投影回 Agent 的上下文**。

但这里有一条不能破的红线,它决定了到底注入什么:

> **注入「舞台上现在有哪些东西」,绝不注入「它们长什么样」。**
> 语义场景可以回灌;渲染 / 像素状态(位置、尺寸、动画进度、用户拖到哪)绝不回灌——
> 那是渲染端的私有领域。Agent 一旦看见像素,解耦就破了。

回注的是一份**紧凑清单(manifest)**,从唯一真相源 SceneStore 直接派生,因此永远准确、几乎免费:

```
当前界面上的卡片:
- weather-bj  (weather)  「北京 18° 晴」     ambient
- choice-1    (choice)   「现在出门吗?」     confront  ← 焦点
```

只给 `id` + `kind` + **一行摘要** + 重要性,**不给完整 data**(那是 Agent 自己写进去的,回灌纯属浪费 token)。

它解决三件 Agent 没法自己推断的事:

1. **按 id 引用更新**:用户说"换成明天的天气",Agent 得知道那张卡 id 是 `weather-bj`。
2. **主动清场**:Agent 判断话题过了、要撤掉某张卡——前提是它知道卡还在。
3. **画面密度感**:别堆到 8 张 surface,要有"屏幕多满"的感知才懂克制。

注意它**不是**为了"防止重复显示"——那个靠 `ui.set` 幂等就解决了(重复 set 同一份 data,core 判无变化、不广播)。

与「用户意图(intent)」区分开:**manifest 回答"现在有什么"(背景状态),intent 回答"用户刚做了什么"(触发器)。**
两者都进 prompt,语义不同。这套"提前查好、直接注入、不让模型主动去读"的做法,正是本项目 ACI(预判注入)理念的同一打法。

---

## 五、渲染端:一个纯投影 + 一张词汇表

每个 UI shell 只实现一件事:把场景状态投影成画面,并让帧间变化好看。

```js
class Shell {
  applyScene(nextScene) {
    const prev = this.current
    // 对 prev → next 做 diff,对每个 surface:
    //   新增          → kind.enter(el)             入场动画
    //   消失          → kind.exit(el)              出场动画
    //   仍在但 data 变 → kind.morph(el, prev, next) 原地过渡 / 插值
    this.current = nextScene
  }
}
```

`kind` 是一张注册表:`weather`、`image`、`choice`、`media`……
每一种都是渲染端**手工精心打磨**的组件,自带 `enter / exit / morph` 三段动画。

> 这就是「电影级」品质的落脚点——
> 动画是设计师调出来的,不是 LLM 临时拼的。

### 长尾内容怎么办,又不让 Agent 写代码?

给一组**排版原语** kind:`text`、`image`、`metric`、`row`、`col`、`stack`。
Agent 用这些组合出没预设过的内容,就像在用一套设计系统拼积木,而不是写 HTML/CSS。

> **明确砍掉:agent 注入 HTML/JS 代码的能力(inline-template / inline-script)。**
> 那是唯一把 core 绑死在浏览器上的脏耦合,也是动画质量上不去的根源。
> 砍掉它,shell 才能是任意技术栈(Web / 原生 Swift / …)。

---

## 六、为什么动画"自动"就电影级了

把上面几条合起来,转场是**免费**的:

- 渲染端握有 prev + next 两帧 → 能做**共享元素转场**:
  同一个 `id` 的 surface 从角落放大到中央,而不是"旧的淡出 + 新的淡入"。
- `intent` 字段直接驱动动画的"戏剧强度":
  `ambient` = 微妙呼吸式淡入;`confront` = 背景退后、全屏聚焦、镜头感推进。
- Agent 改一次状态,shell 负责让这次改变好看。
  导演喊"换景",production 负责运镜。

---

## 七、模块边界

```
┌─────────────────────────────────────────────────────────┐
│  Agent Core(完全不知道 UI 长什么样)                       │
│                                                           │
│   ui.set(id, surface|null)  ──┐                           │
│                               ▼                           │
│   SceneStore  ── 唯一真相源:持有当前 scene + rev          │
│        │  发快照 / 补丁                ▲ 收意图            │
└────────┼──────────────────────────────┼──────────────────┘
         │   WebSocket(JSON 消息)        │
┌────────▼──────────────────────────────┼──────────────────┐
│  UI Shell(任意技术栈,可有多款)        │                  │
│                                        │                  │
│   transport ── applyScene(scene) ── kind 注册表           │
│                     │                                     │
│              电影级渲染器 / enter·exit·morph 动画          │
│                     │                                     │
│              用户交互 ── 转成 intent ──────────────────────┘
└───────────────────────────────────────────────────────────┘
```

- **core 侧**只认 `scene` 状态和 `intent` 事件,与渲染技术无关。
- **shell 侧**只认协议消息,与业务逻辑无关。
- 多款 UI = 多个 shell,共享同一份协议与同一个 SceneStore。
- SceneStore 另派生一份**紧凑 manifest** 回注 Agent 上下文(见 §四),让 Agent 始终知道"屏上有什么"而碰不到像素。

---

## 八、落地计划

新分支(建议名 `feature/cinematic-ui`)要做的,是实现**第一个这样的 shell**。
建议顺序:

1. **协议先行**:把本文第二节的两条信道 + surface schema 定死成一份 `SCENE-PROTOCOL.md`。
   这是地基,UI 无关,零风险。
2. **core 侧**:
   - `SceneStore`:持有当前场景(唯一真相源)、维护 `rev`、生成 snapshot/patch。
   - `ui.set` 工具:改 SceneStore;改完通过现有 WebSocket 推快照 / 补丁。
   - manifest 派生:从 SceneStore 生成紧凑清单,注入 Agent 每轮上下文(见 §四)。
   - core 改动很小,且不破坏现有逻辑。
3. **UI 侧(分支主体)**:
   - WS 客户端:连接、重连、`resync`、收 scene / 发 intent。
   - `applyScene`:diff + 调度 enter/exit/morph。
   - kind 注册表 + 先做 4~5 个惊艳的 kind + 一套排版原语,每个打磨好三段动画。
4. **重连即恢复**:断线重连 = 发 `resync` → 收全量快照,状态自动对齐。

---

## 九、与旧 ACUI 的关键差异(给未来的自己)

| 维度 | 旧 ACUI(命令式) | 本方案(声明式) |
|---|---|---|
| 心智模型 | agent 发命令:show/update/hide/patch | agent 维护状态:set 一个 surface |
| 真相源 | 两端各存一份,需对齐 | 仅 core 一份,UI 是纯投影 |
| 动词数量 | 4+ | 1(幂等 set,置空即删) |
| 动画 | update 无法插值,转场生硬 | 渲染端握有前后两帧,转场免费且电影级 |
| 重连 | 状态可能漂移 | 重发快照,不可能漂移 |
| Agent 表达 | placement / size(像素) | intent(语义重要性) |
| Agent 对屏幕的感知 | 靠翻对话历史,压缩后即失明 | 紧凑 manifest 从真相源派生回注,永远准确 |
| 代码注入 | inline-template / inline-script(绑死浏览器) | 砍掉;长尾用排版原语组合 |
| 多款 UI | 协议与渲染混在一起,难复用 | 协议/SceneStore 共享,shell 可换皮 |

---

*一句话原则:导演只管换景,运镜交给 production。*
