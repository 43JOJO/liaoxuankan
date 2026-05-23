/**
 * build.js — 构建：source → product（解决“改了 source、线上加载 product”的数据断层）
 *
 * src/journals.source.js  →  journals.js        (const journalDatabase)
 * src/foreign.source.js   →  foreign.js         (const foreignJournalDatabase)
 *
 * 用法：
 *   node build.js
 * 所有抓取脚本完成后应调用本步骤（或提示用户运行），让 app 加载到最新数据。
 */
const path = require('path');
const config = require('./lib/config');
const { writeDbModule } = require('./lib/backup');

const TARGETS = [
  { src: config.paths.journalsSource, out: config.paths.journalsProduct, varName: 'journalDatabase' },
  { src: config.paths.foreignSource, out: config.paths.foreignProduct, varName: 'foreignJournalDatabase' },
];

function buildOne(t) {
  delete require.cache[require.resolve(t.src)];
  const data = require(t.src);
  if (!Array.isArray(data)) throw new Error('源不是数组: ' + t.src);
  if (data.length === 0) throw new Error('源为空，拒绝构建: ' + t.src);
  const { backup } = writeDbModule(t.out, t.varName, data, { backupDir: config.paths.backups });
  console.log(
    '  ✓ ' + path.basename(t.src) + ' → ' + path.basename(t.out) +
    ' (' + data.length + ' 本)' + (backup ? ' [备份 ' + path.basename(backup) + ']' : '')
  );
}

function build() {
  console.log('构建 source → product');
  let ok = 0;
  for (const t of TARGETS) {
    try { buildOne(t); ok++; }
    catch (e) { console.error('  ✗ ' + path.basename(t.src) + ': ' + e.message); }
  }
  console.log('完成: ' + ok + '/' + TARGETS.length);
  return ok === TARGETS.length;
}

if (require.main === module) {
  process.exit(build() ? 0 : 1);
}
module.exports = { build };
