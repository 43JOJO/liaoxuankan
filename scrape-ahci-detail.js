/**
 * 万维 AHCI 外文刊详情页批量爬取 — 提取基本信息
 * 用法: node scrape-ahci-detail.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const { writeDbModule, fieldMerge } = require('./lib/backup');
const { withRetry } = require('./lib/retry');
const { isBlocked } = require('./lib/anti-bot');

const SOURCE = config.paths.foreignSource;
const CHECKPOINT = path.join(__dirname, 'ahci-detail-progress.json');

async function main() {
  const journals = require(SOURCE).filter(j => j.wanweiId);
  console.log('Journals with wanweiId: ' + journals.length);

  let progress = {};
  if (fs.existsSync(CHECKPOINT)) {
    progress = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf-8'));
  }

  const todo = journals.filter(j => !progress[j.id]);
  if (todo.length === 0) { console.log('All done'); return; }
  console.log('To process: ' + todo.length);

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, 'chrome-profile'),
    { headless: false, channel: 'chrome', viewport: { width: 1200, height: 800 }, locale: 'zh-CN', slowMo: 100 }
  );

  const page = await context.newPage();
  let count = 0;

  for (const j of todo) {
    count++;
    const url = `http://www.eshukan.com/sci/scidisplayj.aspx?jid=${j.wanweiId}`;
    console.log(`[${count}/${todo.length}] ${j.name} (jid=${j.wanweiId})`);

    try {
      await withRetry(() => page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }), { tries: 3, baseMs: 2000 });
      await new Promise(r => setTimeout(r, 2000));
      if (await isBlocked(page)) { console.log('  被拦截，跳过'); progress[j.id] = { error: 'blocked' }; continue; }

      const info = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          reviewCycle: extract(text, /审稿周期[：:]\s*(.+?)(?=\n)/),
          reviewTime: extract(text, /审稿时间[：:]\s*(.+?)(?=\n)/),
          frequency: extract(text, /出版周期[：:]\s*(.+?)(?=\n)/) || extract(text, /刊期[：:]\s*(.+?)(?=\n)/),
          submissionMethod: extract(text, /投稿方式[：:]\s*(.+?)(?=\n)/),
          pageFee: extract(text, /版面费[：:]\s*(.+?)(?=\n)/) || extract(text, /费用[：:]\s*(.+?)(?=\n)/),
        };
        function extract(text, regex) {
          const m = text.match(regex);
          return m ? m[1].trim().substring(0, 100) : null;
        }
      });

      progress[j.id] = { ...info, scrapedAt: new Date().toISOString() };
      console.log('  freq=' + info.frequency + ' method=' + info.submissionMethod + ' cycle=' + info.reviewCycle);

    } catch (e) {
      console.log('  ERR: ' + e.message);
      progress[j.id] = { error: e.message };
    }

    if (count % 10 === 0) {
      fs.writeFileSync(CHECKPOINT, JSON.stringify(progress, null, 2), 'utf-8');
      // Merge back
      mergeResults(progress);
      console.log('  [saved + merged]');
    }

    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
  }

  fs.writeFileSync(CHECKPOINT, JSON.stringify(progress, null, 2), 'utf-8');
  mergeResults(progress);

  await context.close();
  console.log('\nDone. Processed ' + count + ' journals.');
}

function mergeResults(progress) {
  const journals = require(SOURCE);
  for (const j of journals) {
    const info = progress[j.id];
    if (!info || info.error) continue;
    // Only update if we got real data and current is empty/待核实
    if (info.frequency && (j.frequency === '待核实' || !j.frequency)) j.frequency = info.frequency;
    if (info.submissionMethod && !j.submissionMethod) j.submissionMethod = info.submissionMethod;
    if (info.pageFee && (j.pageFee === '待核实' || !j.pageFee)) j.pageFee = info.pageFee;
    if (info.reviewCycle && (j.reviewCycle === '待核实' || !j.reviewCycle || j.reviewCycle.includes('待核实'))) {
      j.reviewCycle = info.reviewCycle;
    }
    if (info.reviewTime && (!j.reviewCycle || j.reviewCycle.includes('待核实'))) {
      j.reviewCycle = info.reviewTime;
    }
  }
  writeDbModule(SOURCE, 'foreignJournalDatabase', journals, { backupDir: config.paths.backups });
}

main().catch(e => { console.error(e.message); process.exit(1); });
