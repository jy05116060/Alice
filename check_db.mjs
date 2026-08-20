import Database from 'better-sqlite3';
const db = new Database('data/jarvis.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (const t of tables) {
  const count = db.prepare(`SELECT COUNT(*) as n FROM "${t.name}"`).get();
  console.log(`${t.name}: ${count.n} rows`);
}

// 看一下 conversations / memories 的样本
for (const tname of ['conversations', 'memories', 'entities', 'config']) {
  if (tables.find(t => t.name === tname)) {
    const rows = db.prepare(`SELECT * FROM "${tname}" LIMIT 3`).all();
    console.log('\n--- ' + tname + ' sample ---');
    console.log(JSON.stringify(rows, null, 2));
  }
}
db.close();
