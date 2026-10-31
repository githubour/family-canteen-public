#!/usr/bin/env node
/**
 * 无 sqlite3 命令行时的一致性快照兜底：用 Node 内置的 node:sqlite 做 VACUUM INTO。
 *
 * 用法：node sqlite-snapshot.cjs <数据库路径> <快照目标路径>
 *
 * 为什么不是 cp：WAL 模式下主库文件可能只是个空壳（数据在 -wal 里），直接拷贝得到的是残缺副本。
 * 为什么不用 node -e 内联：目标路径得拼进 SQL 字符串，内联写法在 shell 引号里极易出错，
 * 这里单独成文件，顺便把「单引号转义」这件事写清楚。
 */
const { DatabaseSync } = require('node:sqlite');

const [, , dbPath, target] = process.argv;
if (!dbPath || !target) {
  console.error('用法：node sqlite-snapshot.cjs <数据库路径> <快照目标路径>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
// 目标路径必须包成单引号字符串：双引号在 SQLite 里是「标识符」，
// 写成 VACUUM INTO "x.db" 会被当成列名，报 no such column。
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

console.log(`[sqlite-snapshot] 已生成 ${target}`);
