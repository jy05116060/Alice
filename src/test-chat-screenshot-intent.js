// Chat screenshot auto-attach intent tests.
//
// Run: node src/test-chat-screenshot-intent.js

import { shouldAttachSystemScreenshot } from './ui/brain-ui/chat.js'

let failed = 0
function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    failed++
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

assert(!shouldAttachSystemScreenshot('这个正则只要出现截图两个字就触发吗'),
  'plain mention of 截图 does not auto-attach a screenshot')

assert(!shouldAttachSystemScreenshot('截图这个词会触发吗'),
  'meta mention of the screenshot keyword does not auto-attach')

assert(!shouldAttachSystemScreenshot('系统截图里有什么'),
  'explicit system screenshot wording still does not auto-attach')

assert(!shouldAttachSystemScreenshot('帮我看这张图'),
  'image deixis does not auto-attach a system screenshot')

assert(!shouldAttachSystemScreenshot('帮我看图 ![pasted image](/media/chat/example.png)'),
  'existing inline image still does not cause system screenshot attachment')

if (failed === 0) {
  console.log('\nAll chat screenshot intent tests passed.')
}
