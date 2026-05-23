/**
 * 万维详情页重抓 — 仅更新 basicInfo + reviewStats（正则修复后）
 * 用法: node rescrape-details.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./lib/config');
const { safeWrite, fieldMerge } = require('./lib/backup');
const { withRetry } = require('./lib/retry');
const { isBlocked } = require('./lib/anti-bot');

const INPUT = path.join(__dirname, 'wanweixueshu-art-data.json');

// 验证码等待
async function waitForCaptcha(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    if (!url.includes('/verify') && !title.includes('验证')) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error('找不到数据文件:', INPUT);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  const journals = data.journals || [];
  console.log(`加载 ${journals.length} 本期刊\n`);

  // safeWrite 每次写入自动滚动备份，不再需要一次性全量备份
  const userDataDir = path.join(__dirname, 'chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=TranslateUI'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1536, height: 864 },
    locale: 'zh-CN',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  let updated = 0;
  let errors = 0;

  try {
    for (let i = 0; i < journals.length; i++) {
      const j = journals[i];
      if (!j.wanweiId) continue;

      process.stdout.write(`  [${i + 1}/${journals.length}] ${j.name.substring(0, 30)}... `);

      const page = await context.newPage();
      try {
        await withRetry(() => page.goto(`https://wanweixueshu.com/journal/detail/${j.wanweiId}`, {
          waitUntil: 'domcontentloaded', timeout: 30000,
        }), { tries: 3, baseMs: 2000 });

        const passed = await waitForCaptcha(page);
        if (!passed) {
          console.log('验证码超时');
          errors++;
          await page.close();
          continue;
        }
        await page.waitForTimeout(1000);

        // 重新提取 basicInfo + reviewStats
        const extracted = await page.evaluate(() => {
          const body = document.body.innerText;
          const get = (re) => { const m = body.match(re); return m ? m[1].trim() : null; };

          const basicInfo = {
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

          const stats = {};
          const reviewTime = body.match(/审稿时间[：:]\s*([^\n]+)/);
          if (reviewTime) stats.reviewTime = reviewTime[1].trim();
          const difficulty = body.match(/投稿难度[：:]\s*([^\n]+)/);
          if (difficulty) stats.difficulty = difficulty[1].trim();
          const pubCycle = body.match(/见刊周期[：:]\s*([^\n]+)/);
          if (pubCycle) stats.pubCycle = pubCycle[1].trim();

          return { basicInfo, reviewStats: stats };
        });

        // 命中验证码 → 不写，避免用空数据冲掉好数据
        if (await isBlocked(page)) { console.log('被拦截，跳过不写'); errors++; await page.close(); continue; }

        // 字段级合并：仅当抓到的字段非空才覆盖（解析失败不再 null 冲掉既有好数据）
        const oldPageFee = j.basicInfo?.pageFee;
        const oldFreq = j.basicInfo?.frequency;
        j.basicInfo = fieldMerge(j.basicInfo || {}, extracted.basicInfo);
        j.reviewStats = fieldMerge(j.reviewStats || {}, extracted.reviewStats);

        const changes = [];
        if (extracted.basicInfo.pageFee) changes.push('版面费');
        if (extracted.basicInfo.frequency) changes.push('出刊日期');
        if (extracted.reviewStats.reviewTime) changes.push('审稿时间');

        if (changes.length > 0) {
          updated++;
          console.log(changes.join(','));
        } else {
          console.log('无新数据');
        }

      } catch (err) {
        console.log('出错: ' + err.message);
        errors++;
      } finally {
        await page.close();
      }

      // 每本都保存（首次写入前已有 .bak 备份；safeWrite 原子写防写一半损坏）
      data.scrapedAt = new Date().toISOString();
      safeWrite(INPUT, JSON.stringify(data, null, 2), { backupDir: config.paths.backups, keep: 3 });

      // 间隔 3-5 秒
      if (i < journals.length - 1) {
        const ms = 3000 + Math.random() * 2000;
        await new Promise(r => setTimeout(r, ms));
      }
    }
  } finally {
    await context.close();
  }

  console.log(`\n✅ 完成! 更新 ${updated} 本, 错误 ${errors} 本`);
  console.log(`数据已保存: ${INPUT}`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
