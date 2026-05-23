/**
 * 万维学术网爬虫 — 艺术类期刊点评数据采集
 *
 * 用法:
 *   node scrape-wanweixueshu.js                        # 抓前5本做演示
 *   node scrape-wanweixueshu.js --all                  # 按关键词全量发现+抓取
 *   node scrape-wanweixueshu.js --match-existing       # 从源文件读取期刊名，逐本匹配抓取
 *   node scrape-wanweixueshu.js --resume               # 从上次中断处续传
 *   node scrape-wanweixueshu.js --headed               # 有头模式调试
 *
 * --match-existing 策略:
 *   1. 读取 src/journals.source.js，提取所有期刊名称
 *   2. 逐本在万维搜索，取第一个匹配结果
 *   3. 抓取详情页（基本信息 + 点评 + 栏目）
 *   4. 每本间隔 8-15 秒防反爬，支持断点续传
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUTPUT = path.join(__dirname, 'wanweixueshu-art-data.json');
const PROGRESS = path.join(__dirname, 'wanweixueshu-progress.json');
const SOURCE = path.join(__dirname, 'src', 'journals.source.js');
const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const ALL = ARGS.includes('--all');
const MATCH_EXISTING = ARGS.includes('--match-existing');
const RESUME = ARGS.includes('--resume');

const ART_KEYWORDS = [
  '艺术', '美术', '设计', '书法', '工艺',
  '非遗', '民俗', '文艺', '美学', '民间',
  '绘画', '雕塑', '装饰', '摄影', '动画',
  '陶瓷', '染织', '视觉', '服装', '包装',
];

const DELAY_PAGE = [3000, 6000];
const DELAY_JOURNAL = [8000, 15000];
const MAX_LIST_PAGES = ALL ? 10 : 1;
const MAX_JOURNALS = ALL ? 500 : 5;

function delay(minMax) {
  const ms = minMax[0] + Math.random() * (minMax[1] - minMax[0]);
  return new Promise(r => setTimeout(r, ms));
}

// ==================== Phase 1: 期刊发现（关键词搜索模式） ====================

async function scrapeJournalList(context, keyword) {
  const page = await context.newPage();
  const journals = [];

  try {
    const searchUrl = `https://wanweixueshu.com/search?gid=3226&keyword=${encodeURIComponent(keyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    for (let p = 1; p <= MAX_LIST_PAGES; p++) {
      if (p > 1) {
        const pageUrl = `https://wanweixueshu.com/search?gid=3226&keyword=${encodeURIComponent(keyword)}&p=${p}`;
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      }

      const items = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href*="/journal/detail/"]').forEach(a => {
          const text = (a.textContent || '').trim();
          const href = a.getAttribute('href');
          const match = href.match(/\/journal\/detail\/(\d+)/);
          if (text && text.length >= 2 && text.length <= 50 &&
              !text.startsWith('[') && !/^\d/.test(text) && match) {
            links.push({ name: text, id: parseInt(match[1], 10), url: href });
          }
        });
        return links;
      });

      if (items.length === 0) break;
      journals.push(...items);

      const hasNext = await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const a of links) {
          const t = a.textContent.trim();
          if ((t === '›' || t === '»' || t === '>' || t === '下一页') && !a.closest('.disabled')) {
            return true;
          }
        }
        return false;
      });
      if (!hasNext) break;

      await delay(DELAY_PAGE);
    }
  } finally {
    await page.close();
  }

  return journals;
}

// ==================== 验证码等待 ====================

async function waitForCaptcha(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    if (!url.includes('/verify') && !title.includes('验证')) return true;
    await page.waitForTimeout(1500);
  }
  return false; // 超时
}

// ==================== Phase 1b: 按期刊名搜索匹配 ====================

async function searchJournalByName(page, journalName) {
  const searchUrl = `https://wanweixueshu.com/search?gid=3226&keyword=${encodeURIComponent(journalName)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const passed = await waitForCaptcha(page);
  if (!passed) {
    throw new Error('验证码等待超时');
  }
  await page.waitForTimeout(1000);

  const items = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href*="/journal/detail/"]').forEach(a => {
      const text = (a.textContent || '').trim();
      const href = a.getAttribute('href');
      const match = href.match(/\/journal\/detail\/(\d+)/);
      if (text && text.length >= 2 && text.length <= 50 &&
          !text.startsWith('[') && !/^\d/.test(text) && match) {
        links.push({ name: text, id: parseInt(match[1], 10), url: href });
      }
    });
    return links.slice(0, 3); // 最多取前3个候选
  });

  if (items.length === 0) return null;

  // 评分制匹配：按相似度打分，选最高分
  const normalize = s => s.replace(/[（(][^)）]*[)）]/g, '').replace(/\s+/g, '').trim();
  const normName = normalize(journalName);

  function score(item) {
    const name = item.name;
    const normItem = normalize(name);

    // 完全一致
    if (name === journalName) return 100;
    // 标准化后完全一致
    if (normItem === normName) return 90;
    // 搜索词开头匹配（"文艺研究"匹配"文艺研究（不收版面费）"）
    if (normItem.startsWith(normName)) return 85;
    // 搜索词包含在名称中
    if (name.includes(journalName) || normItem.includes(normName)) {
      // 长度越接近分数越高，避免"西部文艺研究"优先于"文艺研究(xxx)"
      const lenDiff = Math.abs(name.length - journalName.length);
      return 70 - Math.min(lenDiff, 30);
    }
    // 名称包含在搜索词中
    if (journalName.includes(name) || normName.includes(normItem)) {
      return 60;
    }
    // 模糊匹配
    if (normItem.includes(normName) || normName.includes(normItem)) {
      return 40;
    }
    return 0;
  }

  const scored = items.map(i => ({ item: i, s: score(i) })).filter(x => x.s > 0);
  scored.sort((a, b) => b.s - a.s);

  return scored.length > 0 ? scored[0].item : null;
}

// ==================== Phase 2: 抓取详情 ====================

async function scrapeJournalDetail(context, journal) {
  const page = await context.newPage();
  const data = {
    wanweiId: journal.id,
    name: journal.name,
    reviews: [],
    reviewStats: {},
    columns: [],
    authorRatio: {},
    instRatio: {},
    basicInfo: {},
  };

  try {
    await page.goto(`https://wanweixueshu.com/journal/detail/${journal.id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const passed = await waitForCaptcha(page);
    if (!passed) {
      data._error = '验证码等待超时';
      return data;
    }
    await page.waitForTimeout(1500);

    // 提取基本信息
    data.basicInfo = await page.evaluate(() => {
      const body = document.body.innerText;
      const get = (re) => { const m = body.match(re); return m ? m[1].trim() : null; };

      return {
        name: get(/期刊名称[：:]\s*([^\n]+)/),
        issn: get(/国际刊号[：:]\s*(ISSN\s*[\d\-X]+)/) || get(/ISSN[：:\s]*([\d\-X]+)/i),
        cn: get(/国内刊号[：:]\s*(CN\s*[\d\-X\/]+)/) || get(/CN[：:\s]*([\d\-X\/]+)/i),
        impactFactor: get(/复合影响因子[：:]\s*([\d.]+)/) || get(/复合因子[：:]\s*([\d.]+)/),
        comprehensiveIF: get(/综合因子[：:]\s*([\d.]+)/),
        frequency: get(/出刊日期[：:]\s*([^\n]+)/),
        level: body.match(/(?:C刊|CSSCI|北核|AMI权威|AMI核心|AMI扩展|RCCSE[^，,\n]*)/)?.[0] || null,
        pageFee: get(/版面费[用均]?[：:]\s*([^\n]+)/),
        reviewFee: get(/审\s*稿\s*费[：:]\s*([^\n]+)/),
        authorRequirement: get(/本刊可发[：:]\s*([^\n]+)/),
        subjectCategory: get(/学科分类[：:]\s*([^\n]+)/),
      };
    });

    // 提取审稿时间统计
    data.reviewStats = await page.evaluate(() => {
      const body = document.body.innerText;
      const stats = {};
      const reviewTime = body.match(/审稿时间[：:]\s*([^\n]+)/);
      if (reviewTime) stats.reviewTime = reviewTime[1].trim();
      const difficulty = body.match(/投稿难度[：:]\s*([^\n]+)/);
      if (difficulty) stats.difficulty = difficulty[1].trim();
      const pubCycle = body.match(/见刊周期[：:]\s*([^\n]+)/);
      if (pubCycle) stats.pubCycle = pubCycle[1].trim();
      return stats;
    });

    // 提取栏目频次
    data.columns = await page.evaluate(() => {
      const cols = [];
      const freqDivs = document.querySelectorAll('[class*=frequency_lan], [class*=frequency]');
      freqDivs.forEach(div => {
        const text = (div.textContent || '').trim();
        const re = /(.+?)(\d+\.?\d*)%\s*期?\s*平?均?发文量\s*(\d+)\s*篇/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          cols.push({
            name: m[1].trim(),
            frequency: parseFloat(m[2]),
            avgArticles: parseInt(m[3]),
          });
        }
      });
      return cols;
    });

    // 提取一作占比
    data.authorRatio = await page.evaluate(() => {
      const body = document.body.innerText;
      const ratio = {};
      const summaryMatch = body.match(/有基金\s*([\d.]+)%/);
      if (summaryMatch) ratio.withFunding = parseFloat(summaryMatch[1]);
      return ratio;
    });

    // 提取用户点评
    data.reviews = await page.evaluate(() => {
      const reviews = [];
      const panel = document.querySelector('[class*=tab-panel], [class*=tab-dp]');
      if (!panel) return reviews;
      const text = (panel.textContent || '').trim();
      if (!text) return reviews;

      const parts = text.split(/(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/);
      let current = parts[0] || '';
      for (let i = 1; i < parts.length; i += 2) {
        const date = parts[i] || '';
        const bodyText = parts[i + 1] || '';
        const full = (current + date + bodyText).trim();

        const get = (re) => { const m = full.match(re); return m ? m[1].trim() : null; };

        const review = {
          reviewTime: get(/审稿时间[：:]\s*(.+?)(?:是否录用|我的学历|有无|查重|发表|版面|稿件|投稿|该刊|\n|$)/),
          accepted: get(/是否录用[：:]\s*(.+?)(?:有无课题|我的学历|有无回复|查重|发表|版面|稿件|投稿|该刊|\n|$)/),
          degree: get(/我的学历[：:]\s*(.+?)(?:我的职称|有无课题|查重|版面|稿件|投稿|该刊|\n|$)/),
          title: get(/我的职称[：:]\s*(.+?)(?:有无课题|有无回复|查重|版面|稿件|投稿|该刊|\n|$)/),
          topic: get(/投稿主题[：:]\s*(.+?)(?:审稿时间|是否录用|我的学历|版面|稿件|\n|$)/),
          difficulty: get(/投稿难度[：:]\s*(.+?)(?:审稿时间|是否录用|我的学历|版面|稿件|\n|$)/),
          pageFee: get(/版面费用[：:]\s*(.+?)(?:稿[件费]|我的|投稿|该刊|\n|$)/),
          funding: get(/有无课题[：:]\s*(.+?)(?:有无回复|查重|版面|稿件|投稿|该刊|\n|$)/),
          hasReply: get(/有无回复[：:]\s*(.+?)(?:查重|版面|稿件|投稿|该刊|我的学历|\n|$)/),
          pubSchedule: get(/发表排期[：:]\s*(.+?)(?:查重|有无|版面|稿件|投稿|该刊|\n|$)/),
          content: get(/我的点评[：:]\s*(.+)/),
          date: date.trim(),
        };

        Object.keys(review).forEach(k => {
          if (!review[k] || review[k] === '--请选择--') review[k] = null;
        });

        if (review.reviewTime || review.content) reviews.push(review);
        current = '';
      }
      return reviews;
    });

  } catch (err) {
    data._error = err.message;
  } finally {
    await page.close();
  }

  return data;
}

// ==================== 保存/续传辅助 ====================

function loadProgress() {
  if (fs.existsSync(PROGRESS)) {
    return JSON.parse(fs.readFileSync(PROGRESS, 'utf-8'));
  }
  return null;
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS, JSON.stringify(data, null, 2), 'utf-8');
}

function loadExistingOutput() {
  if (fs.existsSync(OUTPUT)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
    } catch (e) { /* corrupt, ignore */ }
  }
  return null;
}

function loadSourceJournalNames() {
  delete require.cache[require.resolve(SOURCE)];
  const journals = require(SOURCE);
  return journals.map(j => j.name);
}

// ==================== 主流程 ====================

async function main() {
  const mode = MATCH_EXISTING ? 'match-existing' : ALL ? 'all' : 'demo';
  console.log(`万维学术网 艺术类期刊爬虫 [${mode}模式]`);
  console.log('========================\n');

  const userDataDir = path.join(__dirname, 'chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: !HEADED,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=TranslateUI',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 },
    locale: 'zh-CN',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  try {
    let toScrape = []; // { id, name } pairs to scrape

    // ---- 决定要抓哪些期刊 ----
    if (MATCH_EXISTING) {
      // === match-existing 模式 ===
      console.log('Phase 1: 读取源文件期刊列表，逐本在万维搜索匹配...\n');
      const sourceNames = loadSourceJournalNames();
      console.log(`  从 src/journals.source.js 读取到 ${sourceNames.length} 本期刊\n`);

      // 续传：跳过已抓取的
      let existing = RESUME ? loadProgress() : null;
      if (!existing) existing = { journals: [], matched: 0, total: sourceNames.length };

      const scrapedIds = new Set(existing.journals.map(j => j.wanweiId));
      const startIdx = existing.matched;
      let results = existing.journals;
      let matched = existing.matched;

      if (RESUME && startIdx > 0) {
        console.log(`  [续传] 从第 ${startIdx + 1}/${sourceNames.length} 本继续...\n`);
      }

      // 创建一个复用的搜索页
      const searchPage = await context.newPage();

      for (let i = startIdx; i < sourceNames.length; i++) {
        const name = sourceNames[i];
        process.stdout.write(`  [${i + 1}/${sourceNames.length}] 搜索 "${name}" ... `);

        try {
          const match = await searchJournalByName(searchPage, name);

          if (match && !scrapedIds.has(match.id)) {
            console.log(`匹配: ${match.name} (id=${match.id})`);
            toScrape.push(match);
            matched++;

            // 抓详情
            process.stdout.write(`      抓取详情 ... `);
            const detail = await scrapeJournalDetail(context, match);
            results.push(detail);

            const reviewCount = detail.reviews.length;
            const colCount = detail.columns.length;
            console.log(`点评${reviewCount}条 栏目${colCount}个`);

            scrapedIds.add(match.id);

          } else if (match) {
            console.log(`已抓过: ${match.name}`);
            matched++;
          } else {
            console.log('未找到匹配');
          }

        } catch (err) {
          console.log(`出错: ${err.message}`);
        }

        // 每本都保存进度（支持续传）
        saveProgress({ journals: results, matched: i + 1, total: sourceNames.length });

        if (i < sourceNames.length - 1) {
          await delay(DELAY_JOURNAL);
        }
      }

      await searchPage.close();

    } else {
      // === 关键词发现模式（原有逻辑）===
      console.log('Phase 1: 通过关键词搜索发现艺术类期刊...\n');
      const seen = new Set();
      const allJournals = [];

      for (const kw of ART_KEYWORDS) {
        process.stdout.write(`  搜索 "${kw}" ... `);
        const journals = await scrapeJournalList(context, kw);
        let added = 0;
        journals.forEach(j => {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            allJournals.push(j);
            added++;
          }
        });
        console.log(`找到 ${journals.length} 本, 新增 ${added} 本, 累计 ${allJournals.length} 本`);
        if (allJournals.length >= MAX_JOURNALS && !ALL) break;
        await delay([2000, 4000]);
      }

      console.log(`\n共发现 ${allJournals.length} 本艺术类期刊`);

      const limit = ALL ? allJournals.length : Math.min(MAX_JOURNALS, allJournals.length);
      toScrape = allJournals.slice(0, limit);

      // Phase 2: 抓取详情（续传支持）
      let results = [];
      let startIdx = 0;
      if (RESUME) {
        const existing = loadExistingOutput();
        if (existing && existing.journals) {
          results = existing.journals;
          const scrapedIds = new Set(results.map(j => j.wanweiId));
          startIdx = toScrape.findIndex(j => !scrapedIds.has(j.id));
          if (startIdx < 0) startIdx = toScrape.length;
          console.log(`  [续传] 已抓 ${results.length} 本，从第 ${startIdx + 1} 本继续`);
        }
      }

      console.log(`\nPhase 2: 抓取 ${toScrape.length} 本期刊的详情数据 (从第${startIdx + 1}本开始)...\n`);

      for (let i = startIdx; i < toScrape.length; i++) {
        const j = toScrape[i];
        process.stdout.write(`  [${i + 1}/${toScrape.length}] ${j.name} (id=${j.id}) ... `);

        const detail = await scrapeJournalDetail(context, j);
        results.push(detail);

        const reviewCount = detail.reviews.length;
        const colCount = detail.columns.length;
        console.log(`点评${reviewCount}条 栏目${colCount}个`);

        // 每本都保存（支持续传）
        const output = {
          scrapedAt: new Date().toISOString(),
          totalJournals: allJournals.length,
          journalsScraped: results.length,
          journals: results,
          allJournalIds: allJournals.map(j => ({ id: j.id, name: j.name })),
        };
        fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');

        if (i < toScrape.length - 1) {
          await delay(DELAY_JOURNAL);
        }
      }
    }

    // 保存最终结果
    const output = MATCH_EXISTING
      ? {
          scrapedAt: new Date().toISOString(),
          mode: 'match-existing',
          totalSourceJournals: loadSourceJournalNames().length,
          matchedJournals: (loadProgress() || {}).matched || 0,
          journalsScraped: toScrape.length,
          journals: (loadProgress() || {}).journals || [],
        }
      : {
          scrapedAt: new Date().toISOString(),
          journalsScraped: results.length,
          journals: results,
        };

    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');

    // match-existing 模式完成后清理进度文件
    if (MATCH_EXISTING && fs.existsSync(PROGRESS)) {
      // 保留进度文件以备后用，不删除
    }

    const totalReviews = (output.journals || []).reduce((s, r) => s + (r.reviews || []).length, 0);
    console.log(`\n已保存至: ${OUTPUT}`);
    console.log(`共 ${output.journalsScraped || output.journals.length} 本期刊, ${totalReviews} 条点评`);

  } finally {
    await context.close();
    console.log('浏览器已关闭');
  }
}

main().catch(err => {
  console.error('失败:', err.message);
  process.exit(1);
});
