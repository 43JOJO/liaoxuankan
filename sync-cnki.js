/**
 * 知网期刊数据同步脚本 v2
 *
 * 用法:
 *   node sync-cnki.js               # 同步所有有 cnkiCode 的期刊
 *   node sync-cnki.js --dry-run     # 预览变更（不写文件）
 *   node sync-cnki.js MSDG YSBJ     # 只同步指定期刊代码
 *
 * 原理:
 *   访问 https://navi.cnki.net/knavi/journal/<CODE>
 *   解析服务端渲染的 HTML，提取年发文量、IF、刊期等字段
 *   自动计算每期发文量 = 年发文量 ÷ 年出刊期数
 *   更新 journals.js 并备份旧文件
 *
 * 建议: 每月运行一次，保持数据新鲜
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('./lib/config');
const { safeWrite } = require('./lib/backup');
const { withRetry } = require('./lib/retry');
const { isBlockedHtml } = require('./lib/anti-bot');

const JOURNALS_FILE = config.paths.journalsProduct;
const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_CODES = process.argv.slice(2).filter(a => !a.startsWith('--'));

// ========== HTTP 请求 ==========
function fetchHTML(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('重定向过多'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchHTML(new URL(res.headers.location, url).href, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ========== 数据解析 ==========
function parseCNKIPage(html) {
  const info = {};

  // 复合影响因子
  let m = html.match(/复合影响因子[：:]\s*([\d.]+)/);
  if (m) info.impactFactor = parseFloat(m[1]);

  // 综合影响因子
  m = html.match(/综合影响因子[：:]\s*([\d.]+)/);
  if (m) info.comprehensiveIF = parseFloat(m[1]);

  // 出版周期
  m = html.match(/出版周期[：:]\s*(.+?)[<\n]/);
  if (m) {
    const raw = m[1].trim();
    if (raw.includes('旬')) info.frequency = '旬刊';
    else if (raw.includes('半月')) info.frequency = '半月刊';
    else if (raw.includes('月')) info.frequency = '月刊';
    else if (raw.includes('双月')) info.frequency = '双月刊';
    else if (raw.includes('季')) info.frequency = '季刊';
    else info.frequency = raw;
  }

  // 主办单位
  m = html.match(/主办单位[：:]\s*(.+?)[<\n]/);
  if (m) info.publisher = m[1].trim().replace(/<[^>]+>/g, '');

  // ISSN
  m = html.match(/ISSN[：:]\s*([\d-]+)/);
  if (m) info.issn = m[1].trim();

  // CN
  m = html.match(/CN[：:]\s*([\d-]+[A-Z/]+)/);
  if (m) info.cn = m[1].trim();

  // 创刊时间
  m = html.match(/创刊时间[：:]\s*(\d{4})/);
  if (m) info.foundedYear = parseInt(m[1]);

  // 总文献量
  m = html.match(/总文献量[：:]\s*([\d,]+)/);
  if (m) info.totalArticles = parseInt(m[1].replace(/,/g, ''));

  // ===== 年发文量：从发表年度统计提取 =====
  // CNKI页面通常包含近几年的发表年度统计表格
  // 格式: 2024(289) 或 2024 289
  info.yearlyArticles = {};
  const yearRegex = /(\d{4})\s*[\(（年]?\s*(\d+)\s*篇?[\)）]?/g;
  while ((m = yearRegex.exec(html)) !== null) {
    const year = parseInt(m[1]);
    const count = parseInt(m[2]);
    if (year >= 2020 && year <= 2026 && count > 5 && count < 5000) {
      info.yearlyArticles[year] = count;
    }
  }

  // 备选：从表格行提取
  if (Object.keys(info.yearlyArticles).length === 0) {
    const tableRegex = /<td[^>]*>(\d{4})<\/td>\s*<td[^>]*>(\d+)<\/td>/gi;
    while ((m = tableRegex.exec(html)) !== null) {
      const year = parseInt(m[1]);
      const count = parseInt(m[2]);
      if (year >= 2020 && year <= 2026 && count > 5 && count < 5000) {
        info.yearlyArticles[year] = count;
      }
    }
  }

  return info;
}

// ========== 应用更新（只更新可靠字段） ==========
function applyUpdate(journal, cnkiInfo) {
  const changes = [];

  // 影响因子（知网复合IF）
  if (cnkiInfo.impactFactor && cnkiInfo.impactFactor > 0) {
    const old = journal.impactFactor;
    if (!old || Math.abs(old - cnkiInfo.impactFactor) > 0.01) {
      changes.push(`IF: ${old || '?'} → ${cnkiInfo.impactFactor}`);
      journal.impactFactor = Math.round(cnkiInfo.impactFactor * 100) / 100;
    }
  }

  // 出刊周期
  if (cnkiInfo.frequency && cnkiInfo.frequency !== journal.frequency) {
    changes.push(`刊期: ${journal.frequency || '?'} → ${cnkiInfo.frequency}`);
    journal.frequency = cnkiInfo.frequency;
  }

  // ISSN/CN 补全
  if (cnkiInfo.issn && !journal.issn) { journal.issn = cnkiInfo.issn; changes.push(`ISSN补全`); }
  if (cnkiInfo.cn && !journal.cn) { journal.cn = cnkiInfo.cn; changes.push(`CN补全`); }
  // 主办单位
  if (cnkiInfo.publisher && (!journal.notes || !journal.notes.includes(cnkiInfo.publisher.substring(0,4)))) {
    // 不覆盖已有notes, 仅记录
  }

  if (changes.length > 0) {
    journal.source = '知网同步';
    journal.lastUpdated = new Date().toISOString().slice(0, 7);
  }

  return changes;
}

// ========== 主流程 ==========
async function main() {
  console.log('╔════════════════════════════╗');
  console.log('║  知网期刊数据同步工具 v2  ║');
  console.log('╚════════════════════════════╝\n');

  // 使用 require 加载（journals.js 有 module.exports）
  const src = fs.readFileSync(JOURNALS_FILE, 'utf8');
  let journals;
  try {
    journals = require(JOURNALS_FILE);
  } catch (e) {
    console.error('解析失败:', e.message);
    return;
  }

  console.log(`期刊总数: ${journals.length}`);

  // 筛选目标期刊
  let targets = journals.filter(j => j.cnkiCode);
  if (TARGET_CODES.length > 0) {
    targets = targets.filter(j => TARGET_CODES.includes(j.cnkiCode));
  }
  console.log(`有知网代码: ${journals.filter(j => j.cnkiCode).length} 本`);
  console.log(`本次同步: ${targets.length} 本\n`);

  if (targets.length === 0) { console.log('没有需要同步的期刊'); return; }

  let updated = 0, totalChanges = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    const pct = `[${i+1}/${targets.length}]`;
    process.stdout.write(`${pct} ${j.name} (${j.cnkiCode}) ... `);

    try {
      // CNKI 新版优先 /detail；旧 /journal/<code> 作为回退
      const urls = [
        `https://navi.cnki.net/knavi/journals/${j.cnkiCode}/detail`,
        `https://navi.cnki.net/knavi/journal/${j.cnkiCode}`,
      ];
      let html = '';
      for (const url of urls) {
        ({ result: html } = await withRetry(() => fetchHTML(url), { tries: 3, baseMs: 1500 }));
        if (html && !isBlockedHtml(html)) break;
      }

      // 命中验证码/拦截页 → 不写数据，标记待重试
      if (isBlockedHtml(html)) {
        console.log('✗ 被拦截(验证码/异常页)，跳过不写');
        failed++;
        continue;
      }

      const info = parseCNKIPage(html);
      if (Object.keys(info).length === 0) {
        console.log('未获取到有效数据');
        failed++;
        continue;
      }

      const changes = applyUpdate(j, info);
      if (changes.length > 0) {
        console.log(`✓ ${changes.length}处变更`);
        changes.forEach(c => console.log(`    ${c}`));
        updated++;
        totalChanges += changes.length;
      } else {
        console.log('✓ 数据一致');
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
      failed++;
    }

    // 请求间隔 1-3秒，防止被封
    if (i < targets.length - 1) {
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }
  }

  // 汇总
  console.log(`\n════════════════════════════`);
  console.log(`完成: ${updated} 本更新, ${totalChanges} 处变更, ${failed} 本失败`);
  console.log(`════════════════════════════\n`);

  // 写入（序列化整个数组并替换文件中对应部分）
  if (!DRY_RUN && updated > 0) {
    const startIdx = src.indexOf('const journalDatabase = [');
    const endIdx = src.lastIndexOf('];');
    const prefix = src.slice(0, startIdx);
    const suffix = src.slice(endIdx);
    const newContent = prefix + generateJS(journals) + suffix;
    const { backup } = safeWrite(JOURNALS_FILE, newContent, { backupDir: config.paths.backups });
    console.log('已写入 → journals.js' + (backup ? ' [备份 ' + path.basename(backup) + ']' : '') + '\n');
    console.log('验证: node --check journals.js');
  } else if (DRY_RUN) {
    console.log('(dry-run 模式，未修改文件)');
  }
  // sync-cnki 直接写 product，无需 build；若同时维护 source，请另跑 node build.js
}

// ========== 序列化 ==========
function generateJS(arr) {
  const lines = ['\nconst journalDatabase = ['];
  arr.forEach((j, i) => {
    lines.push('  {');
    const keys = Object.keys(j);
    keys.forEach((k, ki) => {
      const v = j[k];
      if (v === undefined) return;
      const comma = ki < keys.length - 1 ? ',' : '';
      if (Array.isArray(v)) {
        lines.push(`    ${k}: [${v.map(x => `"${x}"`).join(', ')}]${comma}`);
      } else if (v === null) {
        lines.push(`    ${k}: null${comma}`);
      } else if (typeof v === 'number') {
        lines.push(`    ${k}: ${v}${comma}`);
      } else if (typeof v === 'boolean') {
        lines.push(`    ${k}: ${v}${comma}`);
      } else {
        lines.push(`    ${k}: "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${comma}`);
      }
    });
    lines.push(i < arr.length - 1 ? '  },' : '  }');
  });
  lines.push('];\n');
  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
