#!/usr/bin/env node
// 机器人音效 付费解锁密码生成器（作者专用，请勿随 App 分发）
//
// 用法：
//   node scripts/gen-fx-password.mjs           # 生成一个当前时间的密码
//   node scripts/gen-fx-password.mjs 5         # 一次生成 5 个
//
// 密码＝20 位数字，格式：秒RR 分RR 时RR 日RR 月RR
//   （UTC 的秒/分/时/日/月 各 2 位，每个后面紧跟 2 位随机 RR）。
// 用户拿到后 1 小时内填入设置页即可永久解锁该设备。
// 编码规则必须与 src/ui/brain-ui/tts-fx.js 的校验逻辑保持一致。

const pad2 = (n) => String(n).padStart(2, '0')
const rr = () => pad2(Math.floor(Math.random() * 100)) // 2 位随机

function encodeFxPassword(date = new Date()) {
  const parts = [
    date.getUTCSeconds(),
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
  ]
  return parts.map((v) => pad2(v) + rr()).join('') // 秒RR分RR时RR日RR月RR，20 位
}

const count = Math.max(1, parseInt(process.argv[2], 10) || 1)
const now = new Date()
console.log(`当前时间(本地): ${now.toLocaleString()}`)
console.log(`有效期: 生成后 1 小时内填入有效\n`)
for (let i = 0; i < count; i++) {
  console.log(encodeFxPassword())
}
