// SSH 远程机器托管 —— loopback 隧道。
//
// 把远端只监听 127.0.0.1 的 dsh web 通过 SSH 通道映到本地。
//
// 为什么必须自建隧道而不是「让远端监听 0.0.0.0」：
// 远端 web 带 token 鉴权但走明文 HTTP。把它暴露到网络上，等于把 token
// 放在任何能抓包的人手里。隧道让流量始终在 SSH 加密通道内，
// 且**只在本地回环监听**——这台机器上的其他进程能访问，网络上的不能。

import http from 'http'
import net from 'net'
import { injectCookieHead, shouldInjectCookie, TUNNEL_HEAD_CAP } from './ssh-core.js'

/**
 * 一条隧道连接：把本地 socket 的首个请求头注入 cookie，再透传给远端通道。
 *
 * 逐点复刻的语义：
 *  - 只有**首包**需要改写；`injected` 置位后原样转发（含 WebSocket 升级后的帧）。
 *  - 请求头可能跨多个 TCP 分片，所以要缓冲到 `\r\n\r\n` 出现为止。
 *  - 缓冲**超上限还没等到头尾** → 视为异常流量，fail-open：原样发出去，
 *    不再尝试注入（宁可丢鉴权也不能把连接卡死）。
 *  - 头按 **latin1** 编解码：HTTP 头理论上可能是任意字节，latin1 是
 *    字节保真的（utf8 会把非 ASCII 头字节改写成多字节，长度对不上）。
 *  - `\r\n\r\n` 本身留在 `rest` 里，和改写后的头拼接后一起写。
 *  - 背压双向传递：`channel.write()` 返回 false 就 pause 本地 socket，
 *    `drain` 再 resume。缺了这层，大响应会在内存里堆成无界缓冲。
 *
 * @param {net.Socket} socket 本地连接
 * @param {object} channel ssh2 的 Channel
 * @param {string|undefined} cookie 拿不到 cookie 时退化为纯管道
 */
export function pipeChannelWithCookie(socket, channel, cookie) {
  const buffered = []
  let bufferedLength = 0
  let injected = false

  const writeToChannel = (data) => {
    if (!channel.write(data)) socket.pause()
  }

  socket.on('data', (chunk) => {
    if (injected || cookie === undefined) {
      injected = true
      writeToChannel(chunk)
      return
    }
    buffered.push(chunk)
    bufferedLength += chunk.length
    const whole = Buffer.concat(buffered)
    const headEnd = whole.indexOf('\r\n\r\n')
    if (headEnd === -1) {
      if (bufferedLength > TUNNEL_HEAD_CAP) {
        injected = true
        writeToChannel(whole)
      }
      return
    }
    injected = true
    const head = whole.subarray(0, headEnd).toString('latin1')
    const rest = whole.subarray(headEnd)
    // 头部本身超限 → fail-open，不注入，原样透传。
    if (!shouldInjectCookie(head)) {
      writeToChannel(whole)
      return
    }
    writeToChannel(Buffer.concat([
      Buffer.from(injectCookieHead(head, cookie), 'latin1'),
      rest,
    ]))
  })

  socket.on('end', () => channel.end())
  socket.on('error', () => { try { socket.destroy() } catch {} })
  channel.on('drain', () => socket.resume())
  channel.on('end', () => socket.end())
  channel.on('error', () => { try { socket.destroy() } catch {} })
  channel.pipe(socket)
}

/**
 * 建一条本地隧道服务器。**恒定绑 127.0.0.1**——写 0.0.0.0 就等于
 * 把远端 web 连同 token 暴露给整个局域网，这是本模块存在意义的反面。
 *
 * @returns {Promise<{port:number, baseUrl:string, server:net.Server, close():Promise<void>}>}
 */
export async function startTunnel({ openChannel, cookie, host = '127.0.0.1' } = {}) {
  const server = net.createServer((socket) => {
    Promise.resolve()
      .then(() => openChannel())
      .then((channel) => {
        if (!channel) { socket.destroy(); return }
        pipeChannelWithCookie(socket, channel, cookie)
      })
      .catch(() => { try { socket.destroy() } catch {} })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => { server.removeListener('error', reject); resolve() })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://${host}:${port}/`

  return {
    port,
    baseUrl,
    server,
    close() {
      return new Promise((resolve) => {
        try { server.close(() => resolve()) } catch { resolve() }
        // 已经在跑的连接不该让 close 无限等
        setTimeout(resolve, 200).unref?.()
      })
    },
  }
}

/**
 * 隧道用的本机 HTTP 代理入口（把 `http://127.0.0.1:<port>/...` 转给远端）。
 * 与裸 net 服务器不同，这里要处理真实 HTTP 语义：方法是任意、路径带查询串。
 */
export function createTunnelProxyServer({ baseUrl, cookie, logger = console } = {}) {
  return http.createServer((req, res) => {
    const target = new URL(req.url ?? '/', baseUrl)
    const headers = { ...req.headers }
    if (cookie !== undefined) {
      // 本机代理由我们自己构造请求，直接写头；但仍走同一套「删旧 Cookie」的语义。
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'cookie') delete headers[key]
      }
      headers.cookie = cookie
    }
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      logger.warn?.('[ssh-tunnel] upstream failed:', error?.message || error)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('tunnel upstream failed')
    })
    req.pipe(upstream)
  })
}
