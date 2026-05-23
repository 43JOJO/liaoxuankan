/**
 * 万维书刊网第二轮搜索 — 针对首轮未匹配的期刊
 * 策略:
 *   1. 取源文件名去除括号后缀做搜索
 *   2. 搜索无结果时尝试用核心关键词搜索
 *   3. 匹配到后抓取基本信息和点评
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA = path.join(__dirname, 'eshukan-data.json');
const PROGRESS = path.join(__dirname, 'eshukan-unmatched-progress.json');
const SOURCE = path.join(__dirname, 'src', 'journals.source.js');

const DELAY = [4000, 8000];

function delay() {
  const ms = DELAY[0] + Math.random() * (DELAY[1] - DELAY[0]);
  return new Promise(r => setTimeout(r, ms));
}

const { normalize, stripBrackets, scoreName } = require('./lib/name-match');

const nameMatch = (a, b) => scoreName(a, b, { allowIncludes: true });

async function searchJournal(page, journalName) {
  const url = `https://www.eshukan.com/searchresult.aspx?keywords=${encodeURIComponent(journalName)}&etypeid=0`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

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
    return links.slice(0, 8);
  });

  if (items.length === 0) return null;

  const scored = items.map(i => ({ item: i, s: nameMatch(i.name, journalName) }));
  scored.sort((a, b) => b.s - a.s);

  // More lenient threshold: 30 instead of 0
  return scored.length > 0 && scored[0].s >= 30 ? scored[0].item : null;
}

async function scrapeBasicInfo(page, jid) {
  await page.goto(`https://www.eshukan.com/displayj.aspx?jid=${jid}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
    const text = document.body.innerText;
    const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };

    return {
      issn: get(/ISSN[：:\s]*([^\n]+)/),
      cn: get(/CN[：:\s]*([^\n]+)/),
      impactFactor: get(/复合影响因子[：:\s]*([^\n]+)/) || get(/影响因子[：:\s]*([^\n]+)/),
      comprehensiveIF: get(/综合影响因子[：:\s]*([^\n]+)/),
      frequency: get(/出版周期[：:\s]*([^\n]+)/) || get(/刊期[：:\s]*([^\n]+)/),
      price: get(/定[价價][：:\s]*([^\n]+)/),
      publisher: get(/主办单位[：:\s]*([^\n]+)/) || get(/主办[：:\s]*([^\n]+)/),
      supervisor: get(/主管单位[：:\s]*([^\n]+)/) || get(/主管[：:\s]*([^\n]+)/),
      address: get(/地址[：:\s]*([^\n]+)/),
      phone: get(/电话[：:\s]*([^\n]+)/),
      email: get(/邮箱[：:\s]*([^\n]+)/),
      website: get(/官网[：:\s]*([^\n]+)/),
      postCode: get(/邮发代号[：:\s]*([^\n]+)/),
      pageFeeFromName: '',
    };
  });
}

async function scrapeReviews(page, jid) {
  await page.goto(`https://www.eshukan.com/jdianping.aspx?jid=${jid}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
    const text = document.body.innerText;
    const results = [];

    const datePattern = /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/g;
    const segments = [];
    let lastIdx = 0, m;
    while ((m = datePattern.exec(text)) !== null) {
      if (m.index > lastIdx) {
        segments.push({ date: m[0], text: text.substring(lastIdx, m.index) });
      }
      lastIdx = m.index + m[0].length;
    }

    for (const seg of segments) {
      if (seg.text.length < 30) continue;
      const t = seg.text;
      const get = (re) => { const m2 = t.match(re); return m2 ? m2[1].trim() : null; };

      const r = {
        date: seg.date,
        reviewTime: get(/审稿时间[：:]\s*([^\n]+)/),
        accepted: get(/是否录用[：:]\s*([^\n]+)/),
        degree: get(/我的学历[：:]\s*([^\n]+)/),
        title: get(/我的职称[：:]\s*([^\n]+)/),
        topic: get(/投稿主题[：:]\s*([^\n]+)/),
        funding: get(/有无课题[：:]\s*([^\n]+)/),
        hasReply: get(/有无回复[：:]\s*([^\n]+)/),
        difficulty: get(/投稿难度[：:]\s*([^\n]+)/),
        pubSchedule: get(/发表排期[：:]\s*([^\n]+)/),
        content: get(/我的点评[：:]\s*([\s\S]+)/),
      };

      if (r.content && r.content.length > 500) r.content = r.content.substring(0, 500);
      if (r.reviewTime || r.content || r.accepted) results.push(r);
    }
    return results;
  });
}

async function main() {
  const sourceJournals = require(SOURCE);
  const data = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const matchedNames = new Set(data.journals.map(j => {
    const sb = stripBrackets(normalize(j.name));
    return sb;
  }));

  // Find unmatched: must not have any matched name that overlaps
  // Strict matching: only consider matched if names share significant overlap
  // (not just substring containment, which caused bug where "中国美术" was skipped
  // because "中国美术馆" was in the matched set)
  const unmatched = sourceJournals.filter(sj => {
    const sb = stripBrackets(normalize(sj.name));
    return ![...matchedNames].some(mn => {
      if (mn === sb) return true;
      // Only treat as already-matched if one is prefix of the other AND lengths are close
      const minLen = Math.min(mn.length, sb.length);
      const maxLen = Math.max(mn.length, sb.length);
      return (mn.startsWith(sb) || sb.startsWith(mn)) && minLen / maxLen >= 0.8;
    });
  });

  console.log(`源文件: ${sourceJournals.length} 本`);
  console.log(`已匹配: ${data.journals.length} 本`);
  console.log(`未匹配: ${unmatched.length} 本\n`);

  if (unmatched.length === 0) { console.log('全部匹配完毕!'); return; }

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1536, height: 864 }, locale: 'zh-CN', ignoreHTTPSErrors: true,
  });

  let found = 0, notFound = 0;
  const newlyMatched = [];

  try {
    for (let i = 0; i < unmatched.length; i++) {
      const sj = unmatched[i];
      const searchNames = [sj.name, stripBrackets(sj.name)];
      // Try search with just the core name (first 4-8 chars of base name)
      const base = stripBrackets(sj.name);
      if (base.length > 6) searchNames.push(base.substring(0, 6));
      if (base.length > 4) searchNames.push(base.substring(0, 4));

      let match = null;
      const page = await ctx.newPage();

      try {
        for (const sname of [...new Set(searchNames)]) {
          match = await searchJournal(page, sname);
          if (match) break;
        }

        if (match) {
          process.stdout.write(`  [${i + 1}/${unmatched.length}] ${sj.name.substring(0, 30)}... → ${match.name.substring(0, 30)}... `);

          // Get basic info + reviews
          const basicInfo = await scrapeBasicInfo(page, match.id);
          const reviews = await scrapeReviews(page, match.id);

          const entry = {
            eshukanId: match.id,
            name: match.name,
            reviews,
            reviewStats: { reviewTime: null, difficulty: null, pubCycle: null },
            basicInfo,
            reviewCount: reviews.length,
          };

          newlyMatched.push(entry);
          data.journals.push(entry);
          data.matchedJournals++;
          data.journalsScraped++;
          found++;
          console.log(`${reviews.length}条点评 ✅`);
        } else {
          process.stdout.write(`  [${i + 1}/${unmatched.length}] ${sj.name.substring(0, 40)}... 未找到 ❌\n`);
          notFound++;
        }
      } catch (err) {
        console.log(`出错: ${err.message}`);
        notFound++;
      } finally {
        await page.close();
      }

      // Save progress
      data.scrapedAt = new Date().toISOString();
      fs.writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf-8');
      fs.writeFileSync(PROGRESS, JSON.stringify({ matched: data.matchedJournals, unmatched: unmatched.length - found - notFound, lastIndex: i, newlyMatched: newlyMatched.length }, null, 2), 'utf-8');

      if (i < unmatched.length - 1) await delay();
    }
  } finally {
    await ctx.close();
  }

  console.log(`\n✅ 完成! 新匹配 ${found} 本, 未找到 ${notFound} 本`);
  console.log(`万维书刊网总计: ${data.journals.length} 本`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
