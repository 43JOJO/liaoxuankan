/**
 * 万维书刊网(eshukan.com)爬虫 — 匹配现有期刊库并抓取详情
 *
 * 用法:
 *   node scrape-eshukan.js --match-existing  # 从源文件读取期刊名，逐本搜索匹配抓取
 *   node scrape-eshukan.js --resume           # 从上次中断处续传
 *   node scrape-eshukan.js --match-existing --resume
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { normalize, stripBrackets, matchJournalName } = require('./lib/name-match');
const { safeWrite } = require('./lib/backup');
const { withRetry } = require('./lib/retry');
const { isBlocked } = require('./lib/anti-bot');
const config = require('./lib/config');

const OUTPUT = path.join(__dirname, 'eshukan-data.json');
const PROGRESS = path.join(__dirname, 'eshukan-progress.json');
const SOURCE = path.join(__dirname, 'src', 'journals.source.js');
const ARGS = process.argv.slice(2);
const MATCH_EXISTING = ARGS.includes('--match-existing');
const RESUME = ARGS.includes('--resume');

const DELAY_JOURNAL = [5000, 10000]; // eshukan 比较友好,5-10秒间隔

function delay(minMax) {
  const ms = minMax[0] + Math.random() * (minMax[1] - minMax[0]);
  return new Promise(r => setTimeout(r, ms));
}

// ==================== 名称标准化 ====================

// normalize/stripBrackets 已由 lib/name-match 提供

// ==================== 搜索匹配 ====================

async function searchJournalByName(page, journalName) {
  const searchUrl = `https://www.eshukan.com/searchresult.aspx?keywords=${encodeURIComponent(journalName)}&etypeid=0`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const items = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href*="displayj.aspx?jid="]').forEach(a => {
      const text = (a.textContent || '').trim();
      const href = a.getAttribute('href');
      const m = href.match(/jid=(\d+)/);
      if (text && text.length >= 2 && text.length <= 60 && m) {
        links.push({ name: text, id: parseInt(m[1], 10), url: href });
      }
    });
    return links.slice(0, 5);
  });

  if (items.length === 0) return null;

  // 使用统一刊名匹配（lib/name-match）
  const result = matchJournalName(journalName, items, { minScore: 40, nameKey: 'name' });
  return result.matched || null;
}

// ==================== 抓取详情 ====================

async function scrapeDetail(context, journal) {
  const page = await context.newPage();
  const data = {
    eshukanId: journal.id,
    name: journal.name,
    reviews: [],
    reviewStats: {},
    basicInfo: {},
  };

  try {
    await page.goto(`https://www.eshukan.com/displayj.aspx?jid=${journal.id}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // 获取清洗后的正文
    const cleanText = await page.evaluate(() => {
      document.querySelectorAll('script, style, noscript').forEach(e => e.remove());
      return document.body.innerText;
    });

    // 从"期刊封面"或"期刊名称"开始（但 review 检查用全文）
    let mainText = cleanText;
    const startMarkers = ['期刊封面', '期刊名称', '您的位置：'];
    for (const m of startMarkers) {
      const idx = cleanText.indexOf(m);
      if (idx > 0) { mainText = cleanText.substring(idx); break; }
    }

    const get = (re) => { const m = mainText.match(re); return m ? m[1].trim() : null; };

    // 基本信息
    data.basicInfo = {
      name: get(/期刊名称[：:]\s*([^\n]+)/),
      issn: get(/国际标准刊号[：:]\s*([^\n]+)/) || get(/国际刊号[：:]\s*([^\n]+)/) || get(/ISSN[：:\s]*([\d\-X]+)/i),
      cn: get(/国内统一刊号[：:]\s*([^\n]+)/) || get(/国内刊号[：:]\s*([^\n]+)/) || get(/CN[：:\s]*([\d\-X\/]+)/i),
      impactFactor: get(/复合影响因子[：:]\s*([\d.]+)/),
      comprehensiveIF: get(/综合影响因子[：:]\s*([\d.]+)/),
      frequency: get(/出版周期[：:]\s*([^\n]+)/) || get(/出刊日期[：:]\s*([^\n]+)/) || get(/(?:月刊|双月刊|季刊|半月刊|旬刊|周刊)/),
      price: get(/定价[：:]\s*([^\n]+)/),
      publisher: get(/主办单位[：:]\s*([^\n]+)/),
      supervisor: get(/主管部门[：:]\s*([^\n]+)/),
      address: get(/地址[：:]\s*([^\n]+)/),
      phone: get(/电话[：:]\s*([^\n]+)/),
      email: get(/刊内邮箱[：:]\s*([^\n]+)/) || get(/邮箱[：:]\s*([^\n]+)/),
      website: get(/网址[：:]\s*([^\n]+)/),
      postCode: get(/邮发代码[：:]\s*([^\n]+)/),
      // 版面费信息从期刊名中提取（如"不收版面费审稿费"）
      pageFeeFromName: (journal.name.match(/(?:不收|免|无)[版审]面?费[审稿费]*(?:审稿费)?/) || [])[0] || null,
    };

    // 审稿统计
    data.reviewStats = {
      reviewTime: get(/审稿时间[：:]\s*([^\n]+)/),
      difficulty: get(/投稿难度[：:]\s*([^\n]+)/),
      pubCycle: get(/见刊周期[：:]\s*([^\n]+)/),
    };

    // 提取用户点评
    data.reviews = await page.evaluate(() => {
      const reviews = [];
      // eshukan 的点评通常在 reviewinfo / dp 相关容器中
      const containers = document.querySelectorAll('[class*=review], [class*=dp], [id*=review], [id*=dp], [class*=pinglun]');
      containers.forEach(c => {
        const text = (c.textContent || '').trim();
        if (text.length > 20) {
          // 尝试按日期分割点评
          const dateRe = /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/g;
          const dates = [...text.matchAll(dateRe)];
          if (dates.length > 0) {
            let lastIdx = 0;
            dates.forEach((d, i) => {
              if (d.index > lastIdx + 10) {
                const piece = text.substring(lastIdx, d.index).trim();
                if (piece.length > 20) reviews.push({ date: d[0], content: piece.substring(0, 500) });
              }
              lastIdx = d.index;
            });
            // 最后一段
            const lastPiece = text.substring(lastIdx).trim();
            if (lastPiece.length > 20) reviews.push({ date: '', content: lastPiece.substring(0, 500) });
          } else if (text.length > 20) {
            reviews.push({ date: '', content: text.substring(0, 500) });
          }
        }
      });
      return reviews.slice(0, 20);
    });

    // 如果上面没抓到，从正文找"点评"区域
    if (data.reviews.length === 0) {
      const reviewIdx = cleanText.indexOf('点评（');
      if (reviewIdx > 0) {
        const reviewSection = cleanText.substring(reviewIdx, reviewIdx + 5000);
        const reviewCountMatch = reviewSection.match(/点评（(\d+)）/);
        data.reviewCount = reviewCountMatch ? parseInt(reviewCountMatch[1]) : 0;
      }
    }

  } catch (err) {
    data._error = err.message;
  } finally {
    await page.close();
  }

  return data;
}

// ==================== 进度管理 ====================

function loadProgress() {
  if (fs.existsSync(PROGRESS)) {
    return JSON.parse(fs.readFileSync(PROGRESS, 'utf-8'));
  }
  return null;
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS, JSON.stringify(data, null, 2), 'utf-8');
}

function loadSourceJournalNames() {
  delete require.cache[require.resolve(SOURCE)];
  return require(SOURCE).map(j => j.name);
}

// ==================== 主流程 ====================

async function main() {
  console.log('万维书刊网(eshukan.com) 期刊数据爬虫 [match-existing模式]');
  console.log('==============================================\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 },
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  try {
    const sourceNames = loadSourceJournalNames();
    console.log(`从 src/journals.source.js 读取到 ${sourceNames.length} 本期刊\n`);

    let existing = RESUME ? loadProgress() : null;
    if (!existing) existing = { journals: [], matched: 0, total: sourceNames.length };

    const scrapedIds = new Set(existing.journals.map(j => j.eshukanId));
    const startIdx = existing.matched;
    let results = existing.journals;
    let matched = existing.matched;

    if (RESUME && startIdx > 0) {
      console.log(`[续传] 从第 ${startIdx + 1}/${sourceNames.length} 本继续...\n`);
    }

    const searchPage = await context.newPage();

    for (let i = startIdx; i < sourceNames.length; i++) {
      const name = sourceNames[i];
      process.stdout.write(`  [${i + 1}/${sourceNames.length}] 搜索 "${name}" ... `);

      try {
        const match = await searchJournalByName(searchPage, name);

        if (match && !scrapedIds.has(match.id)) {
          console.log(`匹配: ${match.name.substring(0, 40)} (jid=${match.id})`);
          matched++;

          process.stdout.write(`      抓取详情 ... `);
          const detail = await scrapeDetail(context, match);
          results.push(detail);

          const reviewCount = detail.reviews.length;
          const pfInfo = detail.basicInfo.impactFactor ? 'IF:' + detail.basicInfo.impactFactor : '';
          console.log(`点评${reviewCount}条 ${pfInfo}`);
          scrapedIds.add(match.id);

        } else if (match) {
          console.log(`已抓过: ${match.name.substring(0, 30)}`);
          matched++;
        } else {
          console.log('未找到匹配');
        }

      } catch (err) {
        console.log(`出错: ${err.message}`);
      }

      saveProgress({ journals: results, matched: i + 1, total: sourceNames.length });

      if (i < sourceNames.length - 1) {
        await delay(DELAY_JOURNAL);
      }
    }

    await searchPage.close();

    // 保存最终结果
    const output = {
      scrapedAt: new Date().toISOString(),
      source: 'eshukan.com',
      totalSourceJournals: sourceNames.length,
      matchedJournals: matched,
      journalsScraped: results.length,
      journals: results,
    };
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');

    const totalReviews = results.reduce((s, r) => s + (r.reviews || []).length, 0);
    console.log(`\n已保存至: ${OUTPUT}`);
    console.log(`共 ${results.length} 本期刊, ${totalReviews} 条点评`);

  } finally {
    await browser.close();
    console.log('浏览器已关闭');
  }
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
