/**
 * 修复被 substring bug 误跳过的期刊
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { normalize, stripBrackets, scoreName } = require('./lib/name-match');

const DATA = path.join(__dirname, 'eshukan-data.json');
const SOURCE = path.join(__dirname, 'src', 'journals.source.js');

// 此文件历史上禁用 includes 弱匹配，保持该行为：
const nameMatch = (a, b) => scoreName(a, b, { allowIncludes: false });

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
      if (text && text.length >= 2 && m) links.push({ name: text, id: parseInt(m[1]), url: href });
    });
    return links.slice(0, 8);
  });

  if (items.length === 0) return null;

  const scored = items.map(i => ({ item: i, s: nameMatch(i.name, journalName) }));
  scored.sort((a, b) => b.s - a.s);
  // Higher threshold for short names to avoid false matches like "美术"→"美术报"
  const minScore = journalName.length <= 3 ? 70 : 50;
  return scored[0].s >= minScore ? scored[0].item : null;
}

async function scrapeBasicInfo(page, jid) {
  await page.goto(`https://www.eshukan.com/displayj.aspx?jid=${jid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  return await page.evaluate(() => {
    document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
    const text = document.body.innerText;
    const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
    return {
      issn: get(/ISSN[：:\s]*([^\n]+)/), cn: get(/CN[：:\s]*([^\n]+)/),
      impactFactor: get(/复合影响因子[：:\s]*([^\n]+)/) || get(/影响因子[：:\s]*([^\n]+)/),
      comprehensiveIF: get(/综合影响因子[：:\s]*([^\n]+)/),
      frequency: get(/出版周期[：:\s]*([^\n]+)/) || get(/刊期[：:\s]*([^\n]+)/),
      price: get(/定[价價][：:\s]*([^\n]+)/),
      publisher: get(/主办单位[：:\s]*([^\n]+)/) || get(/主办[：:\s]*([^\n]+)/),
      supervisor: get(/主管单位[：:\s]*([^\n]+)/) || get(/主管[：:\s]*([^\n]+)/),
      address: get(/地址[：:\s]*([^\n]+)/), phone: get(/电话[：:\s]*([^\n]+)/),
      email: get(/邮箱[：:\s]*([^\n]+)/), website: get(/官网[：:\s]*([^\n]+)/),
      postCode: get(/邮发代号[：:\s]*([^\n]+)/), pageFeeFromName: '',
    };
  });
}

async function scrapeReviews(page, jid) {
  await page.goto(`https://www.eshukan.com/jdianping.aspx?jid=${jid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  return await page.evaluate(() => {
    document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
    const text = document.body.innerText;
    const results = [];
    const datePattern = /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/g;
    const segments = [];
    let lastIdx = 0, m;
    while ((m = datePattern.exec(text)) !== null) {
      if (m.index > lastIdx) segments.push({ date: m[0], text: text.substring(lastIdx, m.index) });
      lastIdx = m.index + m[0].length;
    }
    for (const seg of segments) {
      if (seg.text.length < 30) continue;
      const t = seg.text;
      const get = (re) => { const m2 = t.match(re); return m2 ? m2[1].trim() : null; };
      const r = {
        date: seg.date, reviewTime: get(/审稿时间[：:]\s*([^\n]+)/),
        accepted: get(/是否录用[：:]\s*([^\n]+)/), degree: get(/我的学历[：:]\s*([^\n]+)/),
        title: get(/我的职称[：:]\s*([^\n]+)/), topic: get(/投稿主题[：:]\s*([^\n]+)/),
        funding: get(/有无课题[：:]\s*([^\n]+)/), hasReply: get(/有无回复[：:]\s*([^\n]+)/),
        difficulty: get(/投稿难度[：:]\s*([^\n]+)/), pubSchedule: get(/发表排期[：:]\s*([^\n]+)/),
        content: get(/我的点评[：:]\s*([\s\S]+)/),
      };
      if (r.content && r.content.length > 500) r.content = r.content.substring(0, 500);
      if (r.reviewTime || r.content || r.accepted) results.push(r);
    }
    return results;
  });
}

async function main() {
  const source = require(SOURCE);
  const data = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const matchedNames = new Set(data.journals.map(j => stripBrackets(normalize(j.name))));

  // Find truly unmatched with fixed logic
  function trulyMatched(sn) {
    const sb = stripBrackets(normalize(sn));
    for (const mn of matchedNames) {
      if (mn === sb) return true;
      const minLen = Math.min(mn.length, sb.length);
      const maxLen = Math.max(mn.length, sb.length);
      if ((mn.startsWith(sb) || sb.startsWith(mn)) && minLen / maxLen >= 0.8) return true;
    }
    return false;
  }

  const trulyUnmatched = source.filter(sj => !trulyMatched(sj.name));
  console.log(`源文件: ${source.length}, 已匹配: ${data.journals.length}, 真正未匹配: ${trulyUnmatched.length}\n`);

  if (trulyUnmatched.length === 0) { console.log('全部已匹配!'); return; }

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1536, height: 864 }, locale: 'zh-CN', ignoreHTTPSErrors: true,
  });

  let found = 0, notFound = 0;

  try {
    for (let i = 0; i < trulyUnmatched.length; i++) {
      const sj = trulyUnmatched[i];
      const page = await ctx.newPage();
      try {
        const match = await searchJournal(page, sj.name);
        if (match) {
          process.stdout.write(`[${i+1}/${trulyUnmatched.length}] ${sj.name.substring(0,30)}... → ${match.name.substring(0,30)}... `);
          const bi = await scrapeBasicInfo(page, match.id);
          const reviews = await scrapeReviews(page, match.id);
          data.journals.push({ eshukanId: match.id, name: match.name, reviews,
            reviewStats: { reviewTime: null, difficulty: null, pubCycle: null }, basicInfo: bi, reviewCount: reviews.length });
          found++; data.matchedJournals = data.journals.length; data.journalsScraped++;
          console.log(`${reviews.length}条 ✅`);
        } else {
          process.stdout.write(`[${i+1}/${trulyUnmatched.length}] ${sj.name.substring(0,40)}... 未找到 ❌\n`);
          notFound++;
        }
      } catch (err) { console.log(`出错: ${err.message}`); notFound++; }
      finally { await page.close(); }

      data.scrapedAt = new Date().toISOString();
      fs.writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf-8');
      if (i < trulyUnmatched.length - 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    }
  } finally { await ctx.close(); }

  console.log(`\n完成! 新匹配 ${found}, 未找到 ${notFound}, 总计 ${data.journals.length}`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
