/**
 * 补抓 eshukan 期刊点评（jdianping.aspx）
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const INPUT = path.join(__dirname, 'eshukan-data.json');
const BACKUP = path.join(__dirname, 'eshukan-data.json.bak_reviews');

async function main() {
  const data = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  const journals = data.journals || [];
  console.log(`加载 ${journals.length} 本期刊\n`);

  fs.writeFileSync(BACKUP, JSON.stringify(data, null, 2), 'utf-8');

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1536, height: 864 }, locale: 'zh-CN', ignoreHTTPSErrors: true,
  });

  let totalReviews = 0;

  try {
    for (let i = 0; i < journals.length; i++) {
      const j = journals[i];
      if (!j.eshukanId) continue;

      process.stdout.write(`  [${i + 1}/${journals.length}] ${j.name.substring(0, 30)}... `);

      const page = await ctx.newPage();
      try {
        await page.goto(`https://www.eshukan.com/jdianping.aspx?jid=${j.eshukanId}`, {
          waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForTimeout(2000);

        const reviews = await page.evaluate(() => {
          document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
          const body = document.body.innerText;

          const results = [];
          // 每条点评以"进行点评"标识结束，以日期或用户名开始
          const entries = body.split(/在\s+\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+进行点评/);
          // 也可以按"我的点评："分割
          const parts = body.split(/我的点评[：:]/);

          // 更好的方法：按日期模式分割
          const datePattern = /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/g;
          const segments = [];
          let lastIdx = 0;
          let m;
          while ((m = datePattern.exec(body)) !== null) {
            if (m.index > lastIdx) {
              segments.push({ date: m[0], text: body.substring(lastIdx, m.index + m[0].length) });
            }
            lastIdx = m.index + m[0].length;
          }

          // 从每个segment提取字段
          for (const seg of segments) {
            const text = seg.text;
            if (text.length < 30) continue;

            const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };

            const review = {
              date: seg.date,
              reviewTime: get(/审稿时间[：:]\s*([^\n]+)/),
              accepted: get(/是否录用[：:]\s*([^\n]+)/),
              degree: get(/我的学历[：:]\s*([^\n]+)/),
              title: get(/我的职称[：:]\s*([^\n]+)/),
              topic: get(/投稿主题[：:]\s*([^\n]+)/),
              funding: get(/有无课题[：:]\s*([^\n]+)/),
              hasReply: get(/有无回复[：:]\s*([^\n]+)/),
              plagiarism: get(/查重要求[：:]\s*([^\n]+)/),
              difficulty: get(/投稿难度[：:]\s*([^\n]+)/),
              pubSchedule: get(/发表排期[：:]\s*([^\n]+)/),
              authorReq: get(/该刊可发[：:]\s*([^\n]+)/),
              content: get(/我的点评[：:]\s*([\s\S]+?)(?:\s*$)/),
            };

            // Clean null/empty values
            Object.keys(review).forEach(k => {
              if (review[k] === '—' || review[k] === '-' || review[k] === '暂无') review[k] = null;
            });

            if (review.reviewTime || review.content || review.accepted) {
              // Clean content (remove replies from other users)
              if (review.content) {
                const replyIdx = review.content.search(/\S+\s*[>＞]\s*\S+\s*[于在]\s*\d{4}/);
                if (replyIdx > 0) review.content = review.content.substring(0, replyIdx).trim();
                // Limit length
                if (review.content.length > 500) review.content = review.content.substring(0, 500);
              }
              results.push(review);
            }
          }

          return results;
        });

        j.reviews = reviews;
        totalReviews += reviews.length;
        console.log(`${reviews.length}条点评`);

      } catch (err) {
        console.log(`出错: ${err.message}`);
      } finally {
        await page.close();
      }

      // Save progress
      data.scrapedAt = new Date().toISOString();
      fs.writeFileSync(INPUT, JSON.stringify(data, null, 2), 'utf-8');

      // 间隔
      if (i < journals.length - 1) {
        const ms = 2000 + Math.random() * 2000;
        await new Promise(r => setTimeout(r, ms));
      }
    }
  } finally {
    await ctx.close();
  }

  console.log(`\n✅ 完成! 共 ${totalReviews} 条点评`);
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
