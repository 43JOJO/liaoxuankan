/**
 * scrape-cnki.js — 知网批量抓取（合并 batch-scrape / batch-mini / batch-update）
 *
 * 用法:
 *   node scrape-cnki.js                         # 预设 all：全量中文刊
 *   node scrape-cnki.js --filter mini           # 预设 mini：读 journals.mini.js，小批次
 *   node scrape-cnki.js --filter update --only 文艺研究   # 只更新指定刊
 *   node scrape-cnki.js --resume                # 断点续传
 *   覆盖参数: --source <preset|路径> --issues N --batch-size N --rest <分钟>
 *
 * 抓取核心逻辑与原 batch-scrape 一致；改动点：
 *   - 写盘：saveSource → backup.writeDbModule（原子写+备份+空数组拒写）
 *   - 验证码：PowerShell 弹窗 → anti-bot.waitForUnblock / alertHuman（跨平台、无 shell 注入）
 *   - 取页：page.goto 包 withRetry（指数退避）
 *   - 断点：统一 lib/checkpoint
 */
const { chromium } = require('playwright');
const config = require('./lib/config');
const { writeDbModule } = require('./lib/backup');
const { withRetry, sleep } = require('./lib/retry');
const checkpoint = require('./lib/checkpoint');
const antibot = require('./lib/anti-bot');

// ---------- 参数解析 ----------
const ARGS = process.argv.slice(2);
function argVal(name, def) {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : def;
}
const RESUME = ARGS.includes('--resume');
const FILTER = argVal('--filter', 'all');
const ONLY = argVal('--only', null);

const PRESETS = {
  all:    { source: config.paths.journalsSource, ckName: 'cnki-all',    batch: 25, restMin: 5, issues: 3 },
  mini:   { source: config.paths.journalsMini,   ckName: 'cnki-mini',   batch: 4,  restMin: 1, issues: 3 },
  update: { source: config.paths.journalsSource, ckName: 'cnki-update', batch: 25, restMin: 5, issues: 1 },
};
const preset = PRESETS[FILTER] || PRESETS.all;

const SOURCE_PATH = (() => {
  const s = argVal('--source', null);
  if (!s) return preset.source;
  return PRESETS[s] ? PRESETS[s].source : require('path').resolve(s);
})();
const CK_NAME = preset.ckName;
const BATCH_SIZE = parseInt(argVal('--batch-size', preset.batch), 10);
const ISSUES_PER_JOURNAL = parseInt(argVal('--issues', preset.issues), 10);
const REST_MS = parseFloat(argVal('--rest', preset.restMin)) * 60 * 1000;
const ARTICLES_PER_ISSUE = 999;

const rand = (min, max) => Math.floor(Math.random() * (max - min) + min);
const jitter = ms => sleep(rand(ms * 0.7, ms * 1.3));

function loadSource() {
  delete require.cache[require.resolve(SOURCE_PATH)];
  return require(SOURCE_PATH);
}
function saveSource(journals) {
  // 原子写 + 自动备份 + 空数组拒写（替换原裸 writeFileSync）
  writeDbModule(SOURCE_PATH, 'journalDatabase', journals, { backupDir: config.paths.backups });
}

function selectCandidates(journals) {
  if (FILTER === 'update') {
    if (!ONLY) { console.error('update 模式需要 --only <刊名>'); process.exit(1); }
    return journals.filter(j => j.name === ONLY);
  }
  if (FILTER === 'mini') return journals.filter(j => /[一-鿿]/.test(j.name));
  return journals.filter(j => /[一-鿿]/.test(j.name) && j.name.length > 2);
}

async function main() {
  const journals = loadSource();
  const candidates = selectCandidates(journals);

  const ck = checkpoint.openCheckpoint(CK_NAME);
  const completed = RESUME ? (ck.state.completed || 0) : 0;
  if (!RESUME) checkpoint.resetCheckpoint(CK_NAME);

  const toProcess = candidates.slice(completed);
  if (toProcess.length === 0) { console.log('Done'); return; }
  console.log('模式=' + FILTER + ' issues=' + ISSUES_PER_JOURNAL + ' 待处理=' + toProcess.length);

  const context = await chromium.launchPersistentContext(
    config.profileDir('cnki'),
    { headless: false, channel: 'chrome', viewport: config.browser.viewport, locale: config.browser.locale, slowMo: 200 }
  );
  await context.addInitScript(config.stealthInit);

  let batchCount = 0;
  let errorStreak = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const j = toProcess[i];
    const idx = completed + i + 1;
    console.log('[' + idx + '/' + journals.length + '] ' + j.name + ' (' + j.cnkiCode + ')');

    try {
      const result = await scrapeJournal(context, j);
      mergeResult(j, result);
      console.log('  OK cols=' + result.columns.length + ' kw=' + result.articles.length);
      errorStreak = 0;
    } catch (e) {
      console.log('  ERR ' + e.message);
      errorStreak++;
      if (errorStreak >= 5) { console.log('Too many errors, stopping'); break; }
    }

    ck.set({ completed: idx, lastJournal: j.name, lastTime: new Date().toISOString() }).save();

    if ((idx - completed) % 5 === 0) { saveSource(journals); console.log('  [saved]'); }

    batchCount++;
    if (batchCount >= BATCH_SIZE && i < toProcess.length - 1) {
      console.log('--- Batch done, resting ' + (REST_MS / 60000) + 'min ---');
      saveSource(journals);
      const restStart = Date.now();
      while (Date.now() - restStart < REST_MS) { await sleep(60000); process.stdout.write('.'); }
      console.log('\nResuming...');
      batchCount = 0;
    }

    if (i < toProcess.length - 1) await jitter(rand(15000, 30000));
  }

  saveSource(journals);
  ck.set({ finished: true }).save();
  await context.close();

  // 第 11 项：抓取完成后提示构建（source → product）
  console.log('\nDone. 运行 `node build.js` 把 source 同步到线上 product 文件。');
}

async function scrapeJournal(context, journal) {
  const page = await context.newPage();
  const result = { columns: [], articles: [] };
  const allColumns = new Set();
  const allArticles = [];

  const goto = (url, opts = {}) =>
    withRetry(() => page.goto(url, { waitUntil: 'networkidle', timeout: 20000, ...opts }),
      { tries: 3, baseMs: 3000, onRetry: (e, n) => console.log('  retry goto #' + n + ' (' + e.message + ')') });

  try {
    // 有直链优先用直链（合并自 batch-mini，避免搜索匹配到错误期刊）
    if (journal.detailUrl) {
      await goto(journal.detailUrl);
    } else {
      await goto('https://navi.cnki.net/knavi/journals/search?uniplatform=NZKPT&language=CHS&q=' +
        encodeURIComponent(journal.name) + '&field=TI');
      await jitter(2000);
      const firstHref = await page.evaluate((name) => {
        const links = document.querySelectorAll('a[href*="/detail?p="]');
        for (const a of links) { if (a.textContent.trim().includes(name.substring(0, 3))) return a.href; }
        return '';
      }, journal.name);
      if (firstHref) {
        await goto(firstHref);
      } else if (journal.cnkiCode) {
        await goto('https://navi.cnki.net/knavi/journals/' + journal.cnkiCode + '/detail');
      } else {
        console.log('  搜不到且无code，跳过');
        return result;
      }
    }
    await jitter(3000);

    // 验证码：跨平台提醒 + 轮询人工解（替代 PowerShell 弹窗，去掉 shell 注入）
    if (await antibot.isBlocked(page)) {
      console.log('  CAPTCHA detected, waiting for manual solve...');
      const passed = await antibot.waitForUnblock(page, { timeoutMs: 120000, pollMs: 5000, message: '知网验证码，期刊: ' + journal.name });
      if (!passed) { console.log('  Timeout, skipping'); return result; }
      console.log('  Captcha solved');
    }

    // Click tab
    let tabClicked = false;
    for (const sel of ['text=刊期浏览', '[class*="tab"]:has-text("刊期")', 'a:has-text("刊期浏览")', 'li:has-text("刊期")', 'div[role="tab"]:has-text("刊期")']) {
      try { await page.click(sel, { timeout: 5000 }); tabClicked = true; break; } catch (e) {}
    }
    if (!tabClicked) { console.log('  No tab'); return result; }
    await jitter(3000);

    // 从最新年开始逐层展开，凑够指定期数即停
    const dtEls = await page.$$('dt');
    let issueNums = [];
    for (const dt of dtEls) {
      await dt.click();
      await jitter(500);
      const nums = await page.evaluate(() => {
        const all = [];
        document.querySelectorAll('a').forEach(a => {
          const t = a.textContent.trim();
          if (/^No\.\d{2}$/.test(t)) {
            const m = (a.id || '').match(/(\d{4})(\d{2})/);
            all.push({ text: t, key: m ? m[1] + m[2] : '000000' });
          }
        });
        return all.sort((a, b) => b.key.localeCompare(a.key)).map(x => x.text);
      });
      if (nums.length > 0) issueNums = nums;
      if (issueNums.length >= ISSUES_PER_JOURNAL) break;
    }
    issueNums = issueNums.slice(0, ISSUES_PER_JOURNAL);

    // 不活跃提醒
    if (issueNums.length > 0) {
      const latestId = await page.evaluate((t) => {
        const a = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === t);
        return a ? a.id : '';
      }, issueNums[0]);
      const yrMatch = latestId.match(/(\d{4})/);
      if (yrMatch && parseInt(yrMatch[1]) < 2024) console.log('  ⚠️ 最近一期' + yrMatch[1] + '年，期刊可能不活跃');
    }

    if (issueNums.length === 0) { console.log('  No issues'); return result; }

    for (let k = 0; k < Math.min(issueNums.length, ISSUES_PER_JOURNAL); k++) {
      const num = issueNums[k];
      try { await page.click('a:text-is("' + num + '"):visible', { timeout: 10000 }); } catch (e) { continue; }
      await jitter(4000);

      const issueData = await page.evaluate(() => {
        const text = document.body.innerText;
        const lines = text.split('\n').map(l => l.trim());
        let tocIdx = lines.findIndex(l => l === '目录');
        if (tocIdx < 0) tocIdx = 0;
        let firstArticleIdx = lines.length;
        for (let i = tocIdx + 1; i < lines.length; i++) {
          if (/[；;]\s*\d+/.test(lines[i]) && lines[i].length > 10) { firstArticleIdx = i; break; }
        }
        const columns = [];
        const skipSet = new Set(['原版目录浏览', '目录', '下载', '阅读', 'PDF', 'CAJ', '购买知网卡', '充值中心', '我的CNKI', '设为首页', '加入收藏', '帮助', '关于我们', '联系我们', '目录索引', '总目录', '年度总目', '英文摘要', 'Abstract']);
        for (let i = tocIdx + 1; i < Math.min(firstArticleIdx, tocIdx + 60); i++) {
          const line = lines[i];
          if (line.length < 2 || line.length > 16) continue;
          if (skipSet.has(line)) continue;
          if (!/[一-鿿]/.test(line)) continue;
          if (/;\s*$/.test(line)) continue;
          if ((line.match(/[；;]/g) || []).length >= 1) continue;
          if (line.length > 10 && /[：:，。！？、——]/.test(line)) continue;
          if (line.length > 8 && /^(以|论|从|基于|关于|走向|试论|略论|浅析|浅谈)/.test(line)) continue;
          if (/[《》]/.test(line)) continue;
          columns.push(line);
        }
        const articleLinks = [];
        document.querySelectorAll('a').forEach(a => {
          const href = a.href || '';
          const t = a.textContent.trim();
          const hasResearchSignal = /研究|分析|论|探|考|评|述|观|视角|视域|基于|影响|意义|比较|建构|重构|转向|路径|策略|机制/.test(t);
          const hasColon = /[：:——]/.test(t);
          const isArtwork = (
            /作品选登|作品展示|【|】|设计作品|国画作品|油画作品|速写作品|服装设计|建筑速写|综合材料|综合绘画|水墨|丙烯|水彩|工笔|写意|雕塑|陶艺|漆画|版画|插画|海报|景观设计|室内设计|环境设计|视觉传达|产品设计|包装设计|字体设计|标志设计|吉祥物|UI设计|界面设计|文创设计|首饰设计|染织|纤维艺术|摄影|摄像|影像|装置|行为艺术/.test(t) ||
            (t.length < 12 && /\d{4}$/.test(t)) ||
            (!hasResearchSignal && !hasColon && t.length < 14) ||
            (/[一-鿿]{2,3}[、，,\s]/.test(t) && (!hasColon || t.length < 15)) ||
            /^[一-鿿、，,\s]{4,12}$/.test(t) && !hasResearchSignal ||
            (/[一-鿿]{2,4}(大学|学院|研究院|研究所)/.test(t) && !hasResearchSignal)
          );
          const isNonResearch = isArtwork || /补白|编后|卷首|发刊|简讯|动态|书讯|通知|公告|项目简介|项目主持人|课题组|主持人介绍/.test(t);
          if (t.length >= 8 && /[一-鿿]/.test(t) && !isNonResearch && (href.includes('/detail') || href.includes('/article/') || href.includes('kcms2')) && !t.includes('检索') && !t.includes('浏览')) {
            articleLinks.push({ title: t.substring(0, 60), href });
          }
        });
        return { columns: [...new Set(columns)], articleLinks: articleLinks.slice(0, 50) };
      });

      issueData.columns.forEach(c => allColumns.add(c));

      const sample = issueData.articleLinks.slice(0, ARTICLES_PER_ISSUE);
      if (sample.length === 0) process.stdout.write(' (no links) '); else process.stdout.write(' links=' + sample.length + ' ');
      let firstArticle = true;
      for (const link of sample) {
        const artPage = await context.newPage();
        try {
          await withRetry(() => artPage.goto(link.href, { waitUntil: 'networkidle', timeout: 15000 }), { tries: 2, baseMs: 2000 });
          for (let w = 0; w < 10; w++) {
            const has = await artPage.evaluate(() => {
              const lines = document.body.innerText.split('\n');
              for (const l of lines) { const m = l.match(/关键词[：:]\s*\S/); if (m) return true; }
              return false;
            });
            if (has) break;
            await sleep(1000);
          }

          const info = await artPage.evaluate((isFirst) => {
            let keywords = '';
            const metaKw = document.querySelector('meta[name="keywords"], meta[name="citation_keywords"]');
            if (metaKw) keywords = (metaKw.content || metaKw.getAttribute('value') || '').trim();
            if (!keywords) {
              const kwLinks = document.querySelectorAll('a[class*="keyword" i], a[class*="keyrowd" i], a[class*="KeyWord" i]');
              if (kwLinks.length > 0) keywords = [...kwLinks].map(l => l.textContent.trim()).filter(t => t.length >= 2).join('; ');
            }
            if (!keywords) {
              const text = document.body.innerText;
              const m = text.match(/关键词[：:]\s*(.+?)(?=\n)/);
              if (m) keywords = m[1].trim();
            }
            let debug = '';
            if (isFirst && !keywords) {
              const kwLines = [];
              document.body.innerText.split('\n').forEach((l, i) => { if (l.includes('关键')) kwLines.push('L' + i + ':' + l.substring(0, 80)); });
              debug = kwLines.join('|||') || 'no keyword text found';
            }
            const authors = [];
            document.querySelectorAll('a[class*="author" i], a[id*="author" i], [class*="author"] a').forEach(a => {
              const t = a.textContent.trim(); if (t.length >= 2) authors.push(t);
            });
            let affiliations = '';
            const orgEls = document.querySelectorAll('[class*="org" i], [class*="affiliation" i], [id*="org"], [id*="affiliation"]');
            orgEls.forEach(el => { const t = el.textContent.trim(); if (t.length > 4) affiliations += t + ' | '; });
            if (!affiliations) {
              const m = document.body.innerText.match(/(?:单位|机构|作者单位)[：:]\s*(.+?)(?=\n\s*(?:摘要|关键词|基金|中图|DOI|$))/);
              if (m) affiliations = m[1].trim().substring(0, 300);
            }
            const fundMatch = document.body.innerText.match(/基金(?:项目)?[：:]\s*(.+)/);
            return { keywords, authors, affiliations: affiliations.substring(0, 200), hasFund: !!fundMatch, debug };
          }, firstArticle);

          if (firstArticle && info.debug) process.stdout.write(' [kw_debug:' + info.debug + '] ');
          firstArticle = false;

          if (info.keywords) {
            if (allArticles.length === 0) process.stdout.write(' K');
            allArticles.push({
              title: link.title.substring(0, 40),
              keywords: info.keywords,
              authors: info.authors.slice(0, 6),
              affiliations: info.affiliations,
              hasFund: info.hasFund,
            });
          }
        } catch (e) { process.stdout.write('!'); }
        await artPage.close();
      }
      await jitter(rand(500, 1500));
    }

    result.columns = [...allColumns];
    result.articles = allArticles;
    result.scrapedAt = new Date().toISOString();
  } finally {
    await page.close();
  }
  return result;
}

function mergeResult(journal, result) {
  if (result.columns.length > 0) {
    const existing = journal.columns || [];
    journal.columns = [...new Set([...existing, ...result.columns])];
  }
  if (result.articles.length > 0) {
    journal.cnkiArticles = journal.cnkiArticles || [];
    journal.cnkiArticles.push(...result.articles);
    const allKw = result.articles.flatMap(a => a.keywords.split(';').map(k => k.trim()).filter(Boolean));
    const existingKw = journal.keywords || [];
    journal.keywords = [...new Set([...existingKw, ...allKw])].slice(0, 80);
  }
  if (result.scrapedAt) journal.lastCnkiScrape = result.scrapedAt;
}

main().catch(e => { console.error(e.message); process.exit(1); });
