/**
 * lib/backup.js — 原子写 + 自动备份 + 字段级合并
 *
 * 解决 P0：
 *   - safeWrite：写前备份(.bak.时间戳)，写临时文件→rename，避免半成品覆盖/写一半被杀
 *   - writeDbModule：拒绝把空数组写回库（一次坏抓不再销毁数据库）
 *   - fieldMerge：仅当 incoming 非空/非占位才覆盖，解析失败不会用 null 冲掉好数据
 */
const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 原子写：临时文件 + fsync + rename（无备份，供 checkpoint 等高频写入复用）
function atomicWrite(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  return filePath;
}

function backupFile(filePath, backupDir) {
  if (!fs.existsSync(filePath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let dest;
  if (backupDir) {
    ensureDir(backupDir);
    dest = path.join(backupDir, path.basename(filePath) + '.bak.' + ts);
  } else {
    dest = filePath + '.bak.' + ts;
  }
  fs.copyFileSync(filePath, dest);
  return dest;
}

function pruneBackups(filePath, backupDir, keep) {
  try {
    const dir = backupDir || path.dirname(filePath);
    const base = path.basename(filePath) + '.bak.';
    const baks = fs.readdirSync(dir).filter(f => f.startsWith(base)).sort();
    while (baks.length > keep) {
      const old = baks.shift();
      fs.unlinkSync(path.join(dir, old));
    }
  } catch (_) { /* 备份清理失败不影响主流程 */ }
}

// 备份 + 原子写；keep 控制保留最近几份备份
function safeWrite(filePath, content, options = {}) {
  const { backupDir = null, keep = 5 } = options;
  const backup = backupFile(filePath, backupDir);
  atomicWrite(filePath, content);
  if (backup) pruneBackups(filePath, backupDir, keep);
  return { filePath, backup };
}

// 视为“空/占位”的值——这些不应覆盖既有数据
const EMPTY_DEFAULT = new Set(['', '待核实', '未公开', '-', '—', '暂无', '不适用', 'null', 'undefined']);
function isEmptyValue(v, skip = EMPTY_DEFAULT) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || skip.has(t);
  }
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// 字段级合并：incoming 仅在“非空”时覆盖 existing
function fieldMerge(existing = {}, incoming = {}, options = {}) {
  const skip = options.skipValues ? new Set(options.skipValues) : EMPTY_DEFAULT;
  const out = { ...existing };
  for (const k of Object.keys(incoming || {})) {
    if (!isEmptyValue(incoming[k], skip)) out[k] = incoming[k];
  }
  return out;
}

// 写 `const <varName> = [...]; module.exports` 模块；空数组默认拒写
function writeDbModule(filePath, varName, arr, options = {}) {
  if (!options.force && Array.isArray(arr) && arr.length === 0) {
    throw new Error('writeDbModule: 拒绝把空数组写入 ' + filePath + '（确需写入请传 {force:true}）');
  }
  const header = 'const ' + varName + ' = ';
  const footer =
    '\n\nif (typeof module !== "undefined" && module.exports) { module.exports = ' +
    varName + '; }\n';
  const content = header + JSON.stringify(arr, null, 2) + ';' + footer;
  return safeWrite(filePath, content, options);
}

module.exports = {
  ensureDir,
  atomicWrite,
  backupFile,
  safeWrite,
  isEmptyValue,
  fieldMerge,
  writeDbModule,
};
