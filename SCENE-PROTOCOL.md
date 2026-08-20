# SCENE PROTOCOL · v1

> Agent 驱动界面的规范契约。core 与任意 UI shell 之间唯一的约定。
> 实现两端时以本文为准;设计理念见桌面《Agent-驱动UI-设计方案.md》。
>
> 项目:Alice · v1 草案 · 2026-06-23
>
> 关键词 **必须 / 不得 / 应当 / 可以** 表示规范强度(对应 RFC 2119 的 MUST / MUST NOT / SHOULD / MAY)。

---

## 0. 一句话模型

> core 持有一份 **scene(场景状态)** 作为唯一真相源;
> UI shell 是这份 scene 的**纯投影**;
> 用户交互以 **intent** 回流。
>
> core 不发命令,只声明状态。`UI = f(scene)`。

---

## 1. 传输与信封

### 1.1 传输

- 默认传输为 **WebSocket**,文本帧,payload 为 UTF-8 JSON。
- 协议本身与传输无关:任何能可靠传递有序 JSON 消息、且支持双向的信道都可承载(便于未来接原生 shell / IPC)。
- 一条 WebSocket 连接服务**一个** shell 实例。

### 1.2 信封

每条消息**必须**是一个 JSON 对象,且**必须**含:

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | 协议主版本。本文为 `1`。收到未知 `v` 的消息**必须**忽略。 |
| `type` | string | 消息类型,见 §3 消息目录。 |

未识别的 `type`**必须**被忽略(向前兼容)。
未识别的**字段必须**被忽略,**不得**报错(向前兼容)。

---

## 2. 能力协商(握手)

连接建立后:

1. shell **必须**首先发送 `hello`,声明身份与能力。
2. core **必须**回以 `welcome`,附当前 scene 版本 `rev`。
3. core **应当**紧接着下发一份全量 `scene` 快照,使 shell 与真相源对齐。

shell 在收到首份 `scene` 之前**不得**假定屏幕状态。

```jsonc
// shell → core
{ "v": 1, "type": "hello", "shell": "cinematic", "shellVersion": "0.1.0", "caps": ["scene", "patch"] }

// core → shell
{ "v": 1, "type": "welcome", "rev": 0, "serverVersion": "2.1.x" }
```

### 2.1 caps(能力)

`caps` 是字符串数组,声明 shell 支持的可选能力。core **应当**据此裁剪下发内容。

| cap | 含义 | 缺省 |
|---|---|---|
| `scene` | 能接收全量快照 | **必备**(所有 shell 必须支持) |
| `patch` | 能接收增量补丁 `scene.patch` | 可选;不声明则 core 只发全量 `scene` |

> 未来扩展(如 `stage`、`audio`、`gesture`)在此追加,不破坏 v1。

---

## 3. 消息目录

### 3.1 `scene` —— 全量快照(core → shell)

下发**完整**场景。收到后 shell **必须**令屏幕完全等于该 scene(多出的 surface 移除,缺失的补上)。

```jsonc
{
  "v": 1,
  "type": "scene",
  "rev": 42,                 // 见 §4 版本语义
  "surfaces": [ Surface, ... ]   // 见 §5;顺序即「排序意图」,见 §5.2
}
```

发送时机:握手后首帧、shell 请求 `resync` 后、或 core 选择以全量替代补丁时。

### 3.2 `scene.patch` —— 增量补丁(core → shell)

仅在 shell 声明了 `patch` 能力时下发。

```jsonc
{
  "v": 1,
  "type": "scene.patch",
  "rev": 43,                 // 应用本补丁后场景的新版本
  "base": 42,                // 本补丁所基于的版本
  "ops": [ Op, ... ]
}
```

`Op` 为下列之一:

```jsonc
{ "op": "upsert", "surface": Surface }   // 按 id 插入或整体替换该 surface
{ "op": "remove", "id": "weather-bj" }   // 按 id 移除
```

补丁应用规则:

- `upsert`:若 `id` 已存在则**整体替换**(不做字段级深合并;data 是不可分割的整体),否则插入。
- `remove`:移除指定 `id`;若不存在则忽略。
- **间隙检测**:shell 收到补丁时,若 `base` ≠ 本地当前 `rev`,说明漏帧,**必须**丢弃该补丁并发送 `resync`(§3.3),等待全量 `scene`。
- 成功应用后,shell 本地 `rev` **必须**更新为补丁的 `rev`。

> 设计取舍:`upsert` 替换整个 surface,而非字段级 diff。这让协议无歧义、shell 实现简单;
> 真正的"原地过渡动画"由 shell 在 `morph(prev, next)` 里基于前后两份 data 自行计算(见 §7),
> 与补丁粒度无关。

### 3.3 `resync` —— 请求全量(shell → core)

```jsonc
{ "v": 1, "type": "resync", "reason": "gap" }   // reason ∈ "gap" | "init" | "error"
```

core 收到后**必须**尽快回以一份全量 `scene`。

### 3.4 `intent` —— 用户意图(shell → core)

用户做出**有语义**的交互时发送。

```jsonc
{
  "v": 1,
  "type": "intent",
  "surface": "choice-1",      // 触发意图的 surface id;无归属时可为 null
  "name": "select",           // 意图名,词汇由该 surface 的 kind 定义(见 §6)
  "data": { "value": "a" },   // 意图载荷,结构由 kind + name 定义;无则 {}
  "ts": 1719100000000         // shell 本地毫秒时间戳
}
```

约束:

- **只有有意义的用户意图才上行**(点选项、提交表单、确认决策)。
- 生命周期信号(出现、停留、被关闭)**可以**上报为 `intent`(如 `name: "dismiss"`),
  但 core **必须**仅将其视为上下文,**不得**当作必须响应的触发器。
- shell **不得**在组件内部"等待用户操作再做业务";组件只负责显示与上报,决策永远在 Agent。

### 3.5 `ping` / `pong` —— 保活(双向)

```jsonc
{ "v": 1, "type": "ping" }
{ "v": 1, "type": "pong" }
```

任一端**可以**发 `ping`,对端**应当**回 `pong`。用于探活与重连判定。

---

## 4. 版本语义(rev)

- `rev` 是 core 维护的、随每次 scene 变更**单调递增**的整数。初始为 `0`。
- 每次 `ui.set` 导致 scene 真实变化,core **必须**令 `rev += 1`。
- 无变化的 `ui.set`(幂等重复)**不应当**改变 `rev`,也**不应当**下发消息。
- shell 始终记录本地已应用的 `rev`,用于 §3.2 的间隙检测。

> `rev` 是整个协议鲁棒性的支点:任何不确定状态,shell 都能靠 `resync` 回到与真相源一致,
> 漂移在数学上不可能发生。

---

## 5. Surface(场景单元)

### 5.1 结构

```jsonc
{
  "id": "weather-bj",     // 必填。稳定身份;shell 靠它在帧间追踪同一元素做过渡动画
  "kind": "weather",      // 必填。渲染端词汇表中的一种,见 §6
  "data": { ... },        // 必填。语义内容,纯数据;结构由 kind 定义。无内容用 {}
  "intent": "inform",     // 选填。语义重要性:ambient | inform | confront。缺省 inform
  "focus": false,         // 选填。是否当前焦点;同一时刻最多一个 surface 为 true。缺省 false
  "order": 0,             // 选填。排序权重,见 §5.2。缺省按数组顺序
  "data_rev": 7           // 选填。data 的内容版本号,便于 shell 判断是否需 morph。缺省不提供
}
```

字段约束:

- `id`:**必须**全局唯一且在该 surface 生命周期内稳定。**不得**复用已移除的 id 表示无关内容。
- `kind`:shell 不认识的 `kind`**应当**降级为占位渲染或忽略,**不得**崩溃。
- `data`:**必须**为可 JSON 序列化的纯数据(string / number / boolean / array / 普通 object)。
  **不得**含函数、Date 对象、循环引用;时间用 ISO 8601 字符串。
- `intent`:见 §5.3。
- `focus`:同一 scene 中为 `true` 的 surface **不应当**超过一个。

### 5.2 顺序

- `scene.surfaces` 数组的**顺序即语义顺序**(从主到次 / 从先到后)。
- 若提供 `order`(数值),shell **应当**按 `order` 升序排列,`order` 相同则按数组顺序。
- 顺序只是「意图」,具体落到屏幕哪个位置由 shell 结合 `intent` 决定。

### 5.3 intent 词汇

`intent` 表达**语义重要性**,不表达像素 / 位置 / 尺寸。shell 自行映射到呈现。

| intent | 含义 | shell 可能的表现(自定,仅示意) |
|---|---|---|
| `ambient` | 环境氛围,看完即过 | 角落微妙淡入、低饱和、呼吸感、不抢焦点 |
| `inform`(缺省) | 一般信息 | 常规入场、停留、可读 |
| `confront` | 用户必须停下来看 / 决策 | 背景退后、聚焦居中 / 全屏、镜头推进 |

> core **不得**下发 placement / size / x / y / width / 动画名等呈现细节。
> 这些是 shell 的艺术决定。core 只说"这件事多重要"。

---

## 6. 标准 kind 词汇表(v1)

每个 kind 定义:**用途** · **data schema** · **上行 intent**(该 kind 能发回的意图)。
shell **必须**至少实现「内容 kind」中标注 *核心* 的若干种与全部「排版原语」,
方能渲染 Agent 的长尾组合内容。

> **明确不在 v1 内:agent 注入 HTML / JS / CSS 代码的能力。**
> 没有 inline-template / inline-script。长尾内容通过排版原语组合表达(§6.2)。
> 词汇表不够用时,扩充 kind 词汇表(并升级两端),而不是让 Agent 写代码。

### 6.1 内容 kind

#### `text` *(核心,也是原语)*
- **用途**:一段语义文本块(标题 + 正文 + 可选脚注)。
- **data**:
  ```jsonc
  { "title": "string?", "body": "string", "footnote": "string?" }
  ```
- **上行 intent**:无(纯展示)。

#### `metric` *(核心)*
- **用途**:单个关键数值 + 标签 + 可选趋势。
- **data**:
  ```jsonc
  { "label": "string", "value": "string|number", "unit": "string?", "trend": "up|down|flat?" }
  ```
- **上行 intent**:无。

#### `image` *(核心)*
- **用途**:展示一张图片,内容比描述更直接时使用。
- **data**:
  ```jsonc
  { "url": "string", "title": "string?", "alt": "string?" }
  ```
- **上行 intent**:`dismiss`(用户关闭)。

#### `media` *(核心)*
- **用途**:播放音视频。
- **data**:
  ```jsonc
  { "kind": "video|audio", "url": "string", "title": "string?",
    "poster": "string?", "autoplay": false }
  ```
- **上行 intent**:`ended`(播放结束)、`dismiss`。

#### `choice` *(核心)*
- **用途**:请用户做一次选择 / 确认。
- **data**:
  ```jsonc
  {
    "prompt": "string",
    "options": [ { "value": "string", "label": "string", "tone": "default|primary|danger?" } ]
  }
  ```
- **上行 intent**:`select`,载荷 `{ "value": "<被选项的 value>" }`。

#### `form` *(可选)*
- **用途**:收集结构化输入。
- **data**:
  ```jsonc
  {
    "prompt": "string?",
    "fields": [ { "name": "string", "label": "string",
                  "type": "text|number|select|toggle", "options": ["string"]? } ],
    "submit": "string"
  }
  ```
- **上行 intent**:`submit`,载荷 `{ "fields": { "<name>": <value>, ... } }`。

#### `weather` *(示例领域 kind)*
- **用途**:天气展示。作为「领域专用 kind」的范例。
- **data**:
  ```jsonc
  {
    "city": "string", "temp": 0, "condition": "string",
    "forecast": [ { "day": "string", "low": 0, "high": 0, "condition": "string" } ]?
  }
  ```
- **上行 intent**:无。

#### `progress` *(核心)*
- **用途**:长任务进度。反复用同一 `id` 推进 `value`,shell 原地 morph——进度条平滑推进、百分比翻动、状态变色。最能体现「同一元素在动」。
- **data**:
  ```jsonc
  {
    "label": "string",            // 任务名
    "value": 0,                   // 当前量
    "max": 100,                   // 选填,总量,缺省 100;percent = value/max(夹到 0..100)
    "status": "active|done|error|paused?",  // 选填,缺省 active;满进度推断为 done
    "note": "string?",            // 选填,副文本(ETA / 计数 / 当前步骤)
    "indeterminate": false        // 选填,进度未知 → 不定量滑动条(忽略 value)
  }
  ```
- **上行 intent**:无(纯展示)。

#### `selfcheck` *(领域 kind)*
- **用途**:启动能力自检。单个 surface 走完全程——逐步推进的 `running` 态(扫描动画)morph 到结果 `done` 态(清单 + 总体结论)。
- **data**:
  ```jsonc
  {
    "phase": "running|done",
    // running:
    "step": 1, "total": 3, "name": "string", "icon": "string?",
    // done:
    "results": [ { "name": "string", "status": "ok|error|skipped", "note": "string?" } ],
    "overall": "ok|degraded|error?"   // 缺省由 results 推断
  }
  ```
- **上行 intent**:无。

#### `awakening` *(领域 kind)*
- **用途**:可选的觉醒期感知/发现反馈。Agent 可以在认为视觉表达有价值时复用同一 surface 更新内容；它不是必经的逐条探索流程。建议 `intent: ambient`。
- **data**:
  ```jsonc
  { "index": 1, "total": 2, "title": "string", "finding": "string?", "emoji": "string?" }
  ```
- **上行 intent**:无。是否创建、更新或移除由 Agent 根据当前情境判断。

### 6.2 排版原语

供 Agent 组合出未预设的内容,等价于一套设计系统的积木。

#### `stack` / `row` / `col`
- **用途**:容器。`stack` 纵向、`row` 横向、`col` 网格列。
- **data**:
  ```jsonc
  { "children": [ Surface, ... ], "gap": "sm|md|lg?", "align": "start|center|end?" }
  ```
  > 容器的 `children` 是内联的 surface(同样含 id/kind/data),由 shell 递归渲染。
  > 内联 surface 的 `id` 在父容器内**必须**唯一。
- **上行 intent**:透传子级意图(子级的 `surface` 字段仍为子级自身 id)。

> 原语让"长尾内容"无需 Agent 写代码即可表达:
> 一段排版 = 几个 `text` / `metric` / `image` 装进 `stack` / `row`。

---

## 7. 渲染端契约(shell 实现要点)

shell **必须**把 scene 当作纯投影来渲染:

```
applyScene(nextScene):
    prev = current
    diff(prev.surfaces, nextScene.surfaces) 按 id 配对:
        仅在 next 中     → kind.enter(el)              入场
        仅在 prev 中     → kind.exit(el)               出场
        两边都在且 data 变 → kind.morph(el, prevData, nextData)  原地过渡
        两边都在且 data 同 → 不动
    current = nextScene
```

- 每个 kind **应当**实现 `enter` / `exit` / `morph` 三段动画,这是"电影级"质感的落点。
- 同一 `id` 的 surface 在帧间被视为**同一元素** → 可做共享元素转场(从角落放大到中央等)。
- shell **必须**为用户交互生成 `intent` 并上行,**不得**在 shell 内部承担业务决策。
- shell **不得**执行 core 下发的任意代码(协议中也不存在该通道)。
- 关闭按钮、堆叠、淘汰、入出场时机等呈现细节由 shell 自理,**不**进协议。

---

## 8. 错误与恢复

| 情形 | shell 行为 |
|---|---|
| 收到 `v` 不匹配的消息 | 忽略 |
| 收到未知 `type` | 忽略 |
| `scene.patch` 的 `base` ≠ 本地 `rev` | 丢弃补丁,发 `resync`(reason `gap`) |
| 收到无法解析的 JSON | 忽略该帧 |
| `kind` 不认识 | 占位或忽略该 surface,不崩溃 |
| 连接断开 | 重连;重连后重新 `hello`,收到 `welcome` 后若 `rev` 与本地不符则等全量 `scene`(或主动 `resync` reason `init`) |

core 侧:

- `ui.set` 产生的 scene 变更**必须**递增 `rev` 并广播给所有已连接 shell。
- core **应当**对 `ui.set` 做幂等判定:内容无变化则不递增 `rev`、不广播。

---

## 9. 一致性级别(Conformance)

一个合规的 shell **必须**:

1. 握手发 `hello`,正确处理 `welcome`。
2. 支持 `scene` 全量快照,使屏幕完全等于 scene。
3. 维护本地 `rev`;若声明 `patch` 能力,正确做间隙检测与 `resync`。
4. 至少实现 §6.1 中标 *核心* 的 kind 与 §6.2 全部排版原语。
5. 为用户交互正确生成 `intent`。
6. 不执行任何远端代码。

一个合规的 core **必须**:

1. 以 `SceneStore` 为唯一真相源,维护单调 `rev`。
2. 握手回 `welcome` 并下发首帧全量 `scene`。
3. 对 `resync` 回以全量 `scene`。
4. 只下发语义状态(surface + intent 重要性),**不**下发任何呈现细节。
5. 提供幂等的 `ui.set(id, surface|null)` 作为唯一的场景变更入口。

---

## 10. 扩展规则(保持 v1 兼容)

- 新增 `kind`、新增 `intent.name`、新增 `caps`:**向后兼容**,允许在 v1 内追加。
- 新增可选字段:允许;两端**必须**忽略不认识的字段。
- 改变既有字段语义、删除字段、改变消息结构:**破坏性**,**必须**升 `v`。

---

*规范止于此。理念与动机见《Agent-驱动UI-设计方案.md》。*
