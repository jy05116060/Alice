/**
 * 测试 memories_au (AFTER UPDATE) trigger 是否正常工作。
 * 验证：更新记忆后，新关键词能被 FTS5 搜到。
 *
 * 用法：node scripts/test-fts-trigger.mjs
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.resolve(__dirname, '../data/jarvis.db')

if (!fs.existsSync(dbPath)) {
  console.error('数据库不存在:', dbPath)
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

const TEST_MEM_ID = 'fact_fts_trigger_test_' + Date.now()
let passed = 0
let failed = 0

function check(label, value) {
  if (value) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.log(`  ❌ ${label}`)
    failed++
  }
}

console.log('\n── FTS5 Trigger 测试 ──\n')

// 1. 插入一条测试记忆
const ts = new Date().toISOString()
const insertResult = db.prepare(`
  INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('fact', '测试关键词_插入阶段_UNIQUE123', '详情内容_插入', '测试标题', TEST_MEM_ID, '[]', '[]', '[]', '[]', null, ts)

const newId = insertResult.lastInsertRowid
console.log(`[1] 插入记忆 id=${newId} mem_id=${TEST_MEM_ID}`)

// 2. 验证 INSERT trigger：能搜到插入阶段的关键词
const afterInsert = db.prepare(`
  SELECT m.* FROM memories m
  JOIN memories_fts ON memories_fts.rowid = m.id
  WHERE memories_fts MATCH 'UNIQUE123'
  LIMIT 5
`).all()
check('INSERT trigger：能搜到 UNIQUE123', afterInsert.some(r => r.id === newId))

// 3. 更新这条记忆，换成完全不同的关键词
db.prepare(`
  UPDATE memories SET content = '测试关键词_更新阶段_UPDATED456', detail = '详情内容_更新', timestamp = ?
  WHERE id = ?
`).run(new Date().toISOString(), newId)
console.log(`\n[2] 更新记忆 id=${newId}，内容换成 UPDATED456`)

// 4. 验证 UPDATE trigger：能搜到新关键词
const afterUpdate_new = db.prepare(`
  SELECT m.* FROM memories m
  JOIN memories_fts ON memories_fts.rowid = m.id
  WHERE memories_fts MATCH 'UPDATED456'
  LIMIT 5
`).all()
check('UPDATE trigger：能搜到新关键词 UPDATED456', afterUpdate_new.some(r => r.id === newId))

// 5. 验证旧关键词不应该再被搜到（FTS 已删除旧条目）
const afterUpdate_old = db.prepare(`
  SELECT m.* FROM memories m
  JOIN memories_fts ON memories_fts.rowid = m.id
  WHERE memories_fts MATCH 'UNIQUE123'
  LIMIT 5
`).all()
check('UPDATE trigger：旧关键词 UNIQUE123 已从索引移除', !afterUpdate_old.some(r => r.id === newId))

// 6. 清理测试数据
db.prepare(`DELETE FROM memories WHERE id = ?`).run(newId)
console.log(`\n[3] 已清理测试数据`)

// 验证 DELETE trigger
const afterDelete = db.prepare(`
  SELECT m.* FROM memories m
  JOIN memories_fts ON memories_fts.rowid = m.id
  WHERE memories_fts MATCH 'UPDATED456'
  LIMIT 5
`).all()
check('DELETE trigger：删除后搜不到', !afterDelete.some(r => r.id === newId))

db.close()

console.log(`\n── 结果：${passed} 通过 / ${failed} 失败 ──\n`)
process.exit(failed > 0 ? 1 : 0)
