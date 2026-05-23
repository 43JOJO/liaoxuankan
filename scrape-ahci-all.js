/**
 * 万维 AHCI 全量期刊列表爬取 — 15个分类
 * 用法: node scrape-ahci-all.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { safeWrite } = require('./lib/backup');
const config = require('./lib/config');

const OUTPUT = path.join(__dirname, 'ahci-all-journals.json');

const CATS = [
  { tid: 809, name: '综合类' },
  { tid: 872, name: '哲学' },
  { tid: 873, name: '宗教' },
  { tid: 874, name: '民俗学' },
  { tid: 875, name: '人文学' },
  { tid: 876, name: '语言学' },
  { tid: 877, name: '文学' },
  { tid: 878, name: '古典文学' },
  { tid: 879, name: '艺术' },
  { tid: 880, name: '亚洲研究' },
  { tid: 881, name: '历史' },
  { tid: 882, name: '考古' },
  { tid: 883, name: '文化研究' },
  { tid: 884, name: '科学的哲学和历史' },
  { tid: 923, name: '已非AHCI期刊' },
];

async function main() {
  let allJournals = {};
  if (fs.existsSync(OUTPUT)) {
    allJournals = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
  }

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, 'chrome-profile'),
    { headless: false, channel: 'chrome', viewport: { width: 1200, height: 800 }, locale: 'zh-CN', slowMo: 100 }
  );

  const page = await context.newPage();

  for (const cat of CATS) {
    const cacheKey = 'cat_' + cat.tid;
    if (allJournals[cacheKey] && allJournals[cacheKey].complete) {
      console.log(cat.name + ': cached (' + allJournals[cacheKey].journals.length + ' journals)');
      continue;
    }

    console.log('\n=== ' + cat.name + ' (tid=' + cat.tid + ') ===');
    const catJournals = [];
    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `http://www.eshukan.com/sci/scidplist.aspx?tid=${cat.tid}&jtype=795&page=${pageNum}`;
      console.log('  Page ' + pageNum);

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.log('  Load err: ' + e.message);
        break;
      }

      const entries = await page.evaluate(() => {
        const items = [];
        const seen = new Set();

        // Find all journal name links with jid
        const allLinks = document.querySelectorAll('a[href*="jid="]');
        for (const a of allLinks) {
          const jidMatch = (a.href || '').match(/jid=(\d+)/);
          if (!jidMatch) continue;
          const jid = jidMatch[1];
          const text = a.textContent.trim();

          // Filter: skip navigation, error reports, system update links
          if (text.length < 3) continue;
          if (/http|采用|系统|电话|知网|官网|投稿/.test(text)) continue;
          if (seen.has(jid)) continue;

          seen.add(jid);

          // Get surrounding context for review count
          const row = a.closest('tr') || a.closest('div') || a.parentElement;
          const ctx = row ? row.textContent.trim() : '';

          // Extract review count
          let reviewCount = 0;
          const rcMatch = ctx.match(/(\d+)\s*人?\s*点评/);
          if (rcMatch) reviewCount = parseInt(rcMatch[1]);

          // Extract rating
          let rating = null;
          const rtMatch = ctx.match(/评分[：:]\s*(\d+\.?\d*)/);
          if (rtMatch) rating = parseFloat(rtMatch[1]);

          // Extract ISSN
          let issn = null;
          const issnMatch = ctx.match(/ISSN[：:\s]*(\d{4}-\d{3}[\dX])/i);
          if (issnMatch) issn = issnMatch[1];

          items.push({ jid, name: text, reviewCount, rating, issn });
        }

        return items;
      });

      if (entries.length === 0) {
        hasMore = false;
        console.log('    No entries, stopping');
        break;
      }

      console.log('    Found ' + entries.length + ' journals');
      catJournals.push(...entries);

      // Check for next page link
      const hasNextPage = await page.evaluate(() => {
        const nextLinks = document.querySelectorAll('a[href*="page="]');
        // Check if there's a link to the next page (not current page)
        const currentUrl = window.location.href;
        const currentPage = (currentUrl.match(/page=(\d+)/) || [])[1] || '1';
        for (const a of nextLinks) {
          const pageMatch = (a.href || '').match(/page=(\d+)/);
          if (pageMatch && parseInt(pageMatch[1]) > parseInt(currentPage)) return true;
        }
        return false;
      });

      hasMore = hasNextPage;
      pageNum++;

      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }

    allJournals[cacheKey] = {
      tid: cat.tid,
      name: cat.name,
      journals: catJournals,
      complete: true
    };

    safeWrite(OUTPUT, JSON.stringify(allJournals, null, 2), { backupDir: config.paths.backups, keep: 2 });
    console.log('  Saved ' + catJournals.length + ' journals for ' + cat.name);
  }

  // Summary
  let total = 0;
  for (const [key, data] of Object.entries(allJournals)) {
    if (data.journals) total += data.journals.length;
    console.log(key + ': ' + (data.journals ? data.journals.length : 0) + ' journals');
  }
  console.log('\nGrand total: ' + total + ' journal entries across all categories');

  await context.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
