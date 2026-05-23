/**
 * 万维 AHCI 外文刊点评批量爬取
 * 用法: node scrape-ahci-reviews.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { safeWrite } = require('./lib/backup');
const config = require('./lib/config');

const SOURCE = path.join(__dirname, 'src', 'foreign.source.js');
const OUTPUT = path.join(__dirname, 'ahci-reviews.json');

// AHCI 艺术相关分类
const CATS = [
  { tid: 879, name: '艺术' },
  { tid: 882, name: '考古' },
  { tid: 883, name: '文化研究' },
];

const rand = (min, max) => Math.floor(Math.random() * (max - min) + min);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => sleep(rand(ms * 0.7, ms * 1.3));

async function main() {
  const foreignJournals = require(SOURCE);
  const nameIndex = {};
  foreignJournals.forEach(j => {
    nameIndex[j.name.toLowerCase()] = j;
    if (j.issn) nameIndex[j.issn.replace(/-/g, '')] = j;
  });

  let progress = {};
  if (fs.existsSync(OUTPUT)) {
    progress = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
  }

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, 'chrome-profile'),
    { headless: false, channel: 'chrome', viewport: { width: 1200, height: 800 }, locale: 'zh-CN', slowMo: 100 }
  );

  const page = await context.newPage();

  for (const cat of CATS) {
    console.log('\n=== ' + cat.name + ' (tid=' + cat.tid + ') ===');

    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `http://www.eshukan.com/sci/scidplist.aspx?tid=${cat.tid}&jtype=795&page=${pageNum}`;
      console.log('Page ' + pageNum + ': ' + url);

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await jitter(2000);

        // Scroll down to load reviews
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await jitter(1500);
      } catch (e) {
        console.log('  Load error: ' + e.message);
        break;
      }

      // Extract review entries
      const entries = await page.evaluate(() => {
        const items = [];
        const nameLinks = document.querySelectorAll('a[href*="jid="]');
        const seen = new Set();

        for (const a of nameLinks) {
          const jidMatch = (a.href || '').match(/jid=(\d+)/);
          if (!jidMatch) continue;
          const jid = jidMatch[1];
          if (seen.has(jid)) continue;

          const text = a.textContent.trim();
          // Only match journal names (not navigation/纠错 links)
          if (text.length > 3 && !text.includes('http') && !text.includes('采用') && !text.includes('系统')) {
            seen.add(jid);
            // Get nearby review data
            const parent = a.closest('div') || a.parentElement;
            const context = parent ? parent.textContent.trim().substring(0, 500) : '';

            // Extract review count, ratings etc from context
            const reviewMatch = context.match(/(\d+)\s*人点评/);
            const ratingMatch = context.match(/评分[：:]\s*(\d+\.?\d*)/);

            items.push({
              jid,
              name: text,
              reviewCount: reviewMatch ? parseInt(reviewMatch[1]) : 0,
              rating: ratingMatch ? parseFloat(ratingMatch[1]) : null
            });
          }
        }
        return items;
      });

      if (entries.length === 0) {
        hasMore = false;
        console.log('  No more entries');
        break;
      }

      console.log('  Found ' + entries.length + ' journals');

      // Match to our database
      for (const entry of entries) {
        // Try to match by name
        let matched = null;
        const entryLower = entry.name.toLowerCase();

        for (const [key, j] of Object.entries(nameIndex)) {
          if (typeof key !== 'string') continue;
          // Check if journal name contains entry name or vice versa
          if (key.length > 5 && entryLower.length > 5) {
            if (key.includes(entryLower.substring(0, 6)) || entryLower.includes(key.substring(0, 6))) {
              matched = j;
              break;
            }
          }
        }

        if (matched) {
          const key = matched.id;
          if (!progress[key]) {
            progress[key] = {
              id: matched.id,
              name: matched.name,
              wanweiId: matched.wanweiId,
              reviewJid: entry.jid,
              reviewCount: entry.reviewCount,
              rating: entry.rating
            };
            console.log('  ✓ ' + matched.name + ' (jid=' + entry.jid + ', reviews=' + entry.reviewCount + ')');
          }
        } else {
          // Store unmatched for later
          const key = 'unmatched_' + entry.jid;
          if (!progress[key]) {
            progress[key] = { jid: entry.jid, name: entry.name, reviewCount: entry.reviewCount };
            console.log('  ? ' + entry.name + ' (jid=' + entry.jid + ')');
          }
        }
      }

      // Save progress
      safeWrite(OUTPUT, JSON.stringify(progress, null, 2), { backupDir: config.paths.backups, keep: 2 });

      // Check if there's a next page
      const hasNext = await page.evaluate(() => {
        return document.querySelector('a[href*="page="]') !== null;
      });

      if (!hasNext) {
        hasMore = false;
      } else {
        pageNum++;
        await jitter(rand(1000, 3000));
      }
    }
  }

  // Summary
  const matched = Object.values(progress).filter(v => v.id).length;
  const unmatched = Object.values(progress).filter(v => v.jid && !v.id).length;
  console.log('\n=== Done ===');
  console.log('Matched: ' + matched);
  console.log('Unmatched: ' + unmatched);

  safeWrite(OUTPUT, JSON.stringify(progress, null, 2), { backupDir: config.paths.backups, keep: 2 });
  await context.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
