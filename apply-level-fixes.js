/**
 * apply-level-fixes.js — 应用级别校准（10 本，已人工确认）
 * 依据：官方 CSSCI 2025-2026 + 北核2023（catalog.json）+ 人工核实
 * 用法：node apply-level-fixes.js [path/to/journals.source.js]   默认 src/journals.source.js
 * 安全：按 刊名+ISSN 双重定位，只改 catalogLevel，safeWrite 自动备份；改前打印 diff，找不到/多匹配则跳过并告警。
 */
const fs = require('fs');
const path = require('path');

// 优先用 lib/backup 的 safeWrite；找不到则内置一个等价实现
let safeWrite;
try { ({ safeWrite } = require('./lib/backup')); }
catch (_) {
  safeWrite = (fp, content, opt={}) => {
    const bdir = opt.backupDir || path.dirname(fp);
    if (fs.existsSync(fp)) {
      if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, {recursive:true});
      const ts = new Date().toISOString().replace(/[:.]/g,'-');
      fs.copyFileSync(fp, path.join(bdir, path.basename(fp)+'.bak.'+ts));
    }
    const tmp = fp+'.tmp'; fs.writeFileSync(tmp, content); fs.renameSync(tmp, fp);
  };
}

// 10 本确认清单：刊名 / 期望原级别(用于校验，防误改) / 目标级别 / ISSN(辅助定位，可空)
const FIXES = [
  { name: '民间文化论坛',            from: 'AMI扩展',      to: 'CSSCI扩展版', issn: '1008-7214' },
  { name: '艺术探索',                from: 'AMI扩展',      to: 'CSSCI扩展版', issn: '' },
  { name: '文艺评论',                from: 'AMI扩展',      to: 'CSSCI扩展版', issn: '' },
  { name: '艺术工作',                from: 'AMI入库',      to: 'CSSCI扩展版', issn: '' },
  { name: '艺术传播研究',            from: 'AMI扩展',      to: 'CSSCI扩展版', issn: '' },
  { name: '中国文学批评',            from: 'CSSCI扩展版',  to: 'CSSCI来源刊', issn: '' },
  { name: '西藏大学学报(社会科学版)', from: 'CSSCI扩展版',  to: 'CSSCI来源刊', issn: '' },
  { name: '吉首大学学报(社会科学版)', from: 'CSSCI扩展版',  to: 'CSSCI来源刊', issn: '' },
  { name: '青海民族研究',            from: 'CSSCI来源刊',  to: 'CSSCI扩展版', issn: '' }, // 降级（官方）
  { name: '电影新作',                from: 'CSSCI扩展版',  to: '北大核心',    issn: '' }, // 降级（官方）
];

const DB_PATH = process.argv[2] || path.join('src','journals.source.js');
const norm = s => String(s||'').replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/\s+/g,'').trim();

delete require.cache[require.resolve(path.resolve(DB_PATH))];
const db = require(path.resolve(DB_PATH));
const arr = Array.isArray(db) ? db : (db.journalDatabase || []);

let applied=0, skipped=0;
const log=[];
for (const fix of FIXES) {
  // 精确定位：刊名归一化相等；若给了 ISSN 再校验 ISSN
  let cands = arr.filter(j => norm(j.name) === norm(fix.name));
  if (cands.length === 0) { log.push(`⚠ 跳过 [${fix.name}]：库中未找到`); skipped++; continue; }
  if (cands.length > 1 && fix.issn) cands = cands.filter(j => (j.issn||'').includes(fix.issn));
  if (cands.length !== 1) { log.push(`⚠ 跳过 [${fix.name}]：匹配到 ${cands.length} 本，需人工确认`); skipped++; continue; }
  const j = cands[0];
  if (j.catalogLevel === fix.to) { log.push(`· 已是目标级别 [${fix.name}] = ${fix.to}，跳过`); skipped++; continue; }
  // 软校验原级别（不一致只警告、仍改，因为库可能已被动过）
  const warn = j.catalogLevel !== fix.from ? `（注意：当前是"${j.catalogLevel}"，与预期原级别"${fix.from}"不符）` : '';
  log.push(`✓ ${fix.name}: ${j.catalogLevel} → ${fix.to} ${warn}`);
  j.catalogLevel = fix.to;
  applied++;
}

console.log('级别校准应用结果：');
log.forEach(l=>console.log('  '+l));
console.log(`\n应用 ${applied} 本，跳过 ${skipped} 本。`);

if (applied>0 && !process.argv.includes('--dry-run')) {
  const header='const journalDatabase = ';
  const footer='\n\nif (typeof module !== "undefined" && module.exports) { module.exports = journalDatabase; }\n';
  safeWrite(DB_PATH, header+JSON.stringify(arr,null,2)+';'+footer, {backupDir:'backups'});
  console.log(`已写入 ${DB_PATH}（已备份）。下一步：node build.js 同步 product。`);
} else if (process.argv.includes('--dry-run')) {
  console.log('(--dry-run：未写文件)');
}
