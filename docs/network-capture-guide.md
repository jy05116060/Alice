# Chrome 与爱丽丝网络对比采集说明

本说明只用于用户拥有或已获授权的账号、设备和网络。全程只允许打开页面、查看搜索结果等只读操作；不要发布、评论、点赞、关注、私信、上传，也不要自动处理验证码或风险挑战。

## 1. 采集前固定条件

先选定一条可重复、无敏感业务内容的流程，例如：

1. 打开同一个小红书入口页。
2. 等待页面空闲 5 秒。
3. 点击搜索框。
4. 输入同一个非敏感关键词。
5. 提交搜索并等待结果 10 秒。
6. 只查看一个结果，不进行任何账号写操作。

记录以下条件，并确保两侧尽量一致：日期与时区、网络出口、登录账号、页面 URL、关键词、窗口内容区尺寸、缩放比例、系统语言、是否热缓存、操作顺序。需要登录时，在开始网络记录前由用户本人完成登录；不要把密码或验证码交给自动化。

推荐至少采三组，以便拆分成因：

- A：普通 Chrome，全部人工点击和逐键输入。
- B：爱丽丝 Electron 嵌入页，全部人工点击和逐键输入。
- C：爱丽丝 Electron 嵌入页，使用当前 Playwright 只读流程。若只做两组，使用 A 与实际产生警告时的爱丽丝流程 C。

每组最好重复三轮并交替顺序。不要为了“统一”而清 Cookie、改 UA 或隐藏 webdriver；只需如实记录登录态和缓存状态。

## 2. 启用爱丽丝诊断模式

源码开发运行时诊断能力默认启用。打包版必须在启动前显式设置：

```sh
ALICE_NETWORK_DIAGNOSTICS=1 /path/to/Alice
```

本仓库在 macOS/Linux 可直接开发启动：

```sh
./node_modules/.bin/electron .
```

快捷键：

- `F12`：仍然是爱丽丝主界面的 DevTools。
- `Shift+F12`：打开嵌入网页自己的 detached DevTools。
- macOS `Cmd+Shift+F12` / Windows、Linux `Ctrl+Shift+F12`：开始或停止嵌入网页的脱敏 CDP 网络记录。

记录期间不要打开嵌入页 DevTools；Electron debugger 与 DevTools 可能互相断开。若发生断开，记录器会立即以 `debugger-detached:*` 原因保存已有事件。

## 3. 采集人工浏览器基线

优先使用用户实际日常使用的浏览器，并在报告中写明浏览器和引擎。Safari 与 Electron/Chromium 的结果可用于回答“日常访问是否可区分”，但不能把 WebKit/Chromium 的固有差异全部归因于自动化。

### Safari

1. Safari → 设置 → 高级 → 勾选“显示网页开发者功能”。
2. 打开空白页，按 `Option+Command+I`，选择“网络”；不要启用 Ignore Cache。
3. 清空列表，在 Safari 地址栏中人工输入约定 URL 并回车，完成只读流程。
4. 在“网络”页按 `Command+S` 或点击“导出”，保存 HAR。原始 HAR 只保存在本机，不提交 Git。

### Chrome

1. 用户本人在普通 Chrome 中完成必要登录，然后打开约定的起始页。
2. 打开 Chrome DevTools，选择 detached 独立窗口，进入 Network。
3. 不勾选 Disable cache；两侧都保留各自正常缓存行为。勾选 Preserve log，清空当前请求列表。
4. 在页面窗口中重新加载起始页，执行约定的人工只读流程。输入必须由用户逐键完成。
5. 在 Network 请求列表中右键，导出 HAR。若 Chrome 提供“允许生成含敏感数据的 HAR”选项，保持关闭。
6. 即使 Chrome 标注 HAR 已脱敏，也把原始 HAR 视为敏感文件：只保存在本机，不提交 Git，不通过聊天上传。

Chrome HAR 通常不含 `navigator.webdriver`、精确 `hasUserGesture`、Cookie 分区和完整 TLS 信息。这个字段覆盖差异会在报告中标为采集限制，而不是浏览器差异。

## 4. 采集爱丽丝

1. 用户本人在爱丽丝嵌入页完成必要登录，关闭嵌入页 DevTools。
2. 让嵌入页保持打开；按 `Cmd/Ctrl+Shift+F12` 开始记录。开发终端会出现 `recording embedded page`。
3. 在记录开始后重新加载或只读导航到约定起始页，再执行与 Chrome 相同的流程。
4. A/B/C 中的人工步骤必须由用户亲自操作。C 组仅可使用爱丽丝既有的只读导航、点击、输入、页面查看能力；不要调用任何发布、互动、上传、账号变更或挑战处理工具。
5. 再按一次 `Cmd/Ctrl+Shift+F12` 停止。爱丽丝会弹出保存路径，并可在文件夹中显示文件。

输出文件位于 Electron `userData/network-audits/` 下，文件名类似：

```text
alice-network-2026-07-26T00-00-00-000Z.json
```

文件在写盘前已经脱敏：不含 Cookie、Authorization、Set-Cookie、Token、签名、账号标识候选值、完整请求体或 WebSocket Payload；这些字段只保留名称、存在性、类型、长度、哈希或阻止原因。

## 5. 生成脱敏对比

在仓库根目录运行：

```sh
npm run network-audit:compare -- \
  --chrome "/absolute/path/chrome.har" \
  --alice "/absolute/path/alice-network-....json" \
  --baseline-label "Safari 人工访问" \
  --output "docs/network-request-comparison.md" \
  --json-output "/absolute/private/path/network-request-comparison.data.json"
```

Chrome 基线可省略 `--baseline-label`；使用 Safari 等其他人工浏览器时必须显式标注，避免把引擎差异误写成 Chrome 或自动化差异。命令行参数名 `--chrome` 为兼容旧用法保留，实际接受标准 HAR 基线。

比较器会在内存中读取原始 HAR，并再次执行脱敏和归一化。它会归一化时间起点、CDP request/connection ID、动态路径段、查询值、Cookie/Token/签名值，并把缓存、推荐、广告和随机实验差异保留为需要人工解释的噪声，而不是自动下结论。

不要把 `--json-output` 指向会被提交或公开同步的位置，除非已经检查其内容。原始 HAR 的删除由用户根据自己的保留策略决定；工具不会自动删除输入文件。

## 6. 交回本任务继续分析

完成后只需提供两个本机绝对路径：

```text
Chrome HAR: /absolute/path/chrome.har
爱丽丝 JSON: /absolute/path/alice-network-....json
```

若采了 B、C 两组，则再提供第二个爱丽丝 JSON 路径。无需把文件内容粘贴到聊天中。后续分析会读取本机文件、生成脱敏结果，并更新 `docs/network-request-comparison.md`。
