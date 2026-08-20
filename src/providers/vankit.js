import fs from 'fs'
import path from 'path'
import { BaseProvider } from './base.js'
import { recordDailyUsage, getDailyUsage } from '../quota.js'
import { SANDBOX_ROOT } from '../capabilities/sandbox.js'

/**
 * VANKIT API（以及任何「OpenAI 兼容的图像生成端点」）Provider
 *
 * 为什么需要它：爱丽丝原本的生图能力**只挂在 MiniMax 上**（`minimax.js` 的
 * `#image()` 打 `/image_generation`，model 固定 `image-01`）。用户手上的中转站
 * （VANKIT：`https://sub.vankit.top`）提供的是 OpenAI 风格的
 * `POST /v1/images/generations`，爱丽丝没有任何代码路径能调它，于是「有 key、
 * 端点也通、就是生不了图」。
 *
 * 与 MiniMax 的两处关键差异（都实测过）：
 *   1. 返回的是 `data[].b64_json`（base64 内联），**不是** `image_urls`（远程 URL）。
 *      所以这里必须自己落盘，再把本地文件路径当作 url 交出去 —— 否则上层拿到的
 *      "url" 会是一串几百 KB 的 base64，既没法当地址打开，也会把事件和日志撑爆。
 *   2. 参数名不同：`size`（如 `1024x1024`）而不是 `aspect_ratio`、`response_format`。
 *
 * 诚实边界：
 *   - 这里的 `models` 列表**不做校验**。中转站的 `/v1/models` 常常只列出它愿意公开的
 *     一部分（VANKIT 就只列了 4 个画图模型，而实际可用的对话模型远多于此），
 *     拿它当白名单会把能用的模型挡在外面。所以模型名交给上游判断，上游报错就如实抛出。
 *   - 中转站的鉴权/配额语义不透明（`is not supported by any configured account in this
 *     group` 这类提示只有站点自己知道含义），因此配额只在**本地**按调用次数记，
 *     不代表上游的真实额度。
 */

const DAILY_LIMITS = {
  image: 50,
}

// 宽高比 → 像素尺寸。VANKIT 的 gpt-image-* 接受 `1024x1024` 这类具体尺寸，
// 而爱丽丝的工具层传的是 `1:1` / `16:9` 这种比例（MiniMax 的接口正好吃比例）。
// 这张表就是两种约定之间的转换，取两侧都常见的档位。
const SIZE_BY_RATIO = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '4:3': '1024x768',
  '3:4': '768x1024',
  '9:16': '1024x1536',
}

export class VankitProvider extends BaseProvider {
  constructor({ apiKey, baseURL = 'https://sub.vankit.top', model = 'gpt-image-2.5' }) {
    super({
      name: 'vankit',
      apiKey,
      // baseURL 允许用户指向任意 OpenAI 兼容端点。存进配置时可能带尾斜杠，
      // 拼 `/v1/images/generations` 会出现 `//v1` —— 有些网关会 404。
      baseURL: String(baseURL || '').replace(/\/+$/, ''),
    })
    this.model = model
  }

  canDo(capability) {
    // 只声明 image。对话能力由 settings 里的渠道配置负责，两条线互不干扰 ——
    // 这也是「切渠道」与「生图」在爱丽丝架构里本来就分开的直接后果。
    return capability === 'image'
  }

  async call(capability, params) {
    if (capability !== 'image') {
      throw new Error(`VankitProvider: 不支持的能力 "${capability}"`)
    }
    return this.#image(params)
  }

  getQuotaStatus() {
    const used = getDailyUsage('image')
    const limit = DAILY_LIMITS.image
    return {
      image: { used, limit, ratio: ((used / limit) * 100).toFixed(1) + '%' },
    }
  }

  async #image({ prompt, aspect_ratio = '1:1', n = 1 }) {
    if (!prompt) throw new Error('image: 缺少 prompt 参数')
    if (!this.apiKey) throw new Error('image: VANKIT 未配置 API Key')

    const count = Math.min(Math.max(Math.floor(n) || 1, 1), 4)
    const size = SIZE_BY_RATIO[aspect_ratio] || SIZE_BY_RATIO['1:1']

    const data = await this.request('/v1/images/generations', {
      model: this.model,
      prompt,
      n: count,
      size,
      // 显式要 b64：部分中转站默认返回远程 URL，而它们的 URL 往往有有效期；
      // 拿 base64 自己落盘，产物的生命周期就由本地决定。
      response_format: 'b64_json',
    })

    const items = Array.isArray(data?.data) ? data.data : []
    if (!items.length) throw new Error('image: 响应中没有图片数据')

    const urls = []
    for (const item of items) {
      // 两条都接：有的网关即使要了 b64_json 也回 url（或反过来）。
      if (item?.b64_json) {
        urls.push(this.#saveBase64(item.b64_json))
      } else if (item?.url) {
        urls.push(item.url)
      }
    }
    if (!urls.length) throw new Error('image: 响应中没有可用的图片（既无 b64_json 也无 url）')

    recordDailyUsage('image', urls.length)
    return { urls, model: this.model, via: this.name, size }
  }

  /**
   * 把 base64 图片写进 sandbox，返回可用的本地路径。
   *
   * 返回 `file:///...` 而不是裸路径：上层的 `urls` 会被当作链接渲染/打开，
   * 裸 Windows 路径（`D:\...`）在浏览器里会被当成相对地址。用 file:// 之后
   * 前端点开就是本地图片。
   */
  #saveBase64(b64) {
    const cleaned = String(b64).replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(cleaned, 'base64')
    if (!buffer.length) throw new Error('image: b64_json 解码后为空')

    // 从文件头判扩展名（不信任响应里的字段，只看真实字节）
    const ext = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'png'
      : buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpg' : 'bin'

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fname = `image_${ts}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    const resolved = path.resolve(SANDBOX_ROOT, 'images', fname)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, buffer)
    return `file:///${resolved.replace(/\\/g, '/')}`
  }
}
