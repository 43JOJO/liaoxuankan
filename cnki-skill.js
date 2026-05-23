/**
 * CNKI 期刊信息查询脚本 (Playwright 浏览器自动化版)
 *
 * 用法:
 *   node cnki-skill.js SJYS
 *   node cnki-skill.js WYYJ YSBJ
 *   node cnki-skill.js --headed SJYS
 *   node cnki-skill.js --homepage SJYS    (先访问知网首页建 session)
 *
 * 功能:
 *   - 使用 Playwright 真实 Chromium 浏览器抓取知网期刊页面
 *   - 反检测: 隐藏 webdriver 标记、模拟真实 viewport、随机延迟
 *   - 提取期刊级别 / 栏目 / 年发文量 / 最新期刊发文量
 *   - 每本期刊间隔 10-20 秒, 防止被知网封禁
 */

const path = require('path');
const { chromium } = require('playwright');

const JOURNALS_FILE = path.join(__dirname, 'journals.js');
const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const SKIP_HOMEPAGE = ARGS.includes('--no-homepage');
const HOMEPAGE_FIRST = ARGS.includes('--homepage');
const TARGET_CODES = ARGS.filter(a => !a.startsWith('--'));
const MAX_ISSUES = 5;
const MIN_DELAY = 10000;
const MAX_DELAY = 20000;
const PAGE_TIMEOUT = 40000;

/**
 * 从 HTML 中提取纯文本, 去掉 script / style / 标签
 */
function normalizeText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitValues(raw) {
  return raw
    .replace(/[；;。，、,\n\r]+/g, '；')
    .split('；')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * 从知网期刊导航页的 HTML 文本中提取结构化信息
 */
function parseCNKIPage(html) {
  const info = {};
  const text = normalizeText(html);

  function findLabel(pattern) {
    const re = new RegExp(pattern + '[：:\\s]+([^\\n]+)', 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  }

  info.name = findLabel('期刊名称|刊名|杂志名称') || undefined;
  info.engName = findLabel('英文名称') || undefined;
  info.formerName = findLabel('曾用刊名') || undefined;

  const level = findLabel('收录情况|来源类别|期刊级别|刊物级别');
  if (level) info.catalogLevel = level;

  info.sponsor = findLabel('主办单位') || undefined;
  info.supervisor = findLabel('主管单位') || undefined;
  info.issn = findLabel('I{0,1}SSN') || undefined;
  info.cn = findLabel('CN[：:\\s]') || undefined;

  const freq = findLabel('出版周期');
  if (freq) {
    if (/旬/.test(freq)) info.frequency = '旬刊';
    else if (/半月/.test(freq)) info.frequency = '半月刊';
    else if (/双月/.test(freq)) info.frequency = '双月刊';
    else if (/季/.test(freq)) info.frequency = '季刊';
    else if (/月/.test(freq)) info.frequency = '月刊';
    else info.frequency = freq;
  }

  info.startYear = findLabel('创刊时间|创刊年') || undefined;
  info.location = findLabel('出版地') || undefined;
  info.language = findLabel('语种') || undefined;
  info.category = findLabel('专辑名称') || undefined;
  info.subCategory = findLabel('专题名称') || undefined;

  const columns = findLabel('栏目设置|栏目|栏目方向|文章栏目');
  if (columns) info.columns = splitValues(columns);

  // 影响因子
  const ifMatch = text.match(/复合影响因子[：:\s]*([\d.]+)/i);
  if (ifMatch) info.impactFactor = parseFloat(ifMatch[1]);
  const ifMatch2 = text.match(/综合影响因子[：:\s]*([\d.]+)/i);
  if (ifMatch2) info.impactFactorComprehensive = parseFloat(ifMatch2[1]);

  const perIssueMatch = text.match(/每期发文量[：:\s]*([\d.]+)/i);
  if (perIssueMatch) info.perIssue = parseFloat(perIssueMatch[1]);

  const totalMatch = text.match(/总文献量[：:\s]*([\d,]+)/i);
  if (totalMatch) info.totalArticles = parseInt(totalMatch[1].replace(/,/g, ''), 10);

  const totalIssuesMatch = text.match(/总期数[：:\s]*([\d,]+)/i);
  if (totalIssuesMatch) info.totalIssues = parseInt(totalIssuesMatch[1].replace(/,/g, ''), 10);

  // 年发文量 — 两种模式
  info.yearlyArticles = {};
  const yearRegex = /(\d{4})\s*(?:年)?\s*[:：\-]?\s*(\d+)\s*篇/gi;
  let m;
  while ((m = yearRegex.exec(text)) !== null) {
    const year = parseInt(m[1], 10);
    const count = parseInt(m[2], 10);
    if (year >= 2000 && year <= 2035 && count > 0) {
      info.yearlyArticles[year] = count;
    }
  }

  // 从表格提取年发文量(备用)
  if (Object.keys(info.yearlyArticles).length === 0) {
    const tableRegex = /<td[^>]*>(\d{4})<\/td>\s*<td[^>]*>(\d+)<\/td>/gi;
    while ((m = tableRegex.exec(html)) !== null) {
      const year = parseInt(m[1], 10);
      const count = parseInt(m[2], 10);
      if (year >= 2000 && year <= 2035) {
        info.yearlyArticles[year] = count;
      }
    }
  }

  // 最新期发文量
  info.latestIssues = [];
  const issueRegex = /(\d{4})年第?(\d{1,2})期[\s\S]{0,80}?(\d+)\s*篇/gi;
  while ((m = issueRegex.exec(text)) !== null) {
    info.latestIssues.push({ issue: `${m[1]}年第${m[2]}期`, count: parseInt(m[3], 10) });
    if (info.latestIssues.length >= MAX_ISSUES) break;
  }

  return info;
}

/**
 * 输出可读报告
 */
function renderReport(code, journal, info) {
  console.log('══════════════════════════════════════════════════');
  console.log(`期刊: ${info.name || journal.name || code}`);
  console.log(`知网代码: ${code}`);
  if (info.engName) console.log(`英文名: ${info.engName}`);
  if (info.formerName) console.log(`曾用刊名: ${info.formerName}`);
  if (journal.catalogLevel) console.log(`本地级别: ${journal.catalogLevel}`);
  if (info.catalogLevel) console.log(`知网级别: ${info.catalogLevel}`);
  if (info.sponsor) console.log(`主办: ${info.sponsor}`);
  if (info.supervisor) console.log(`主管: ${info.supervisor}`);
  if (info.issn) console.log(`ISSN: ${info.issn}`);
  if (info.cn) console.log(`CN: ${info.cn}`);
  if (journal.frequency) console.log(`本地刊期: ${journal.frequency}`);
  if (info.frequency) console.log(`知网刊期: ${info.frequency}`);
  if (info.startYear) console.log(`创刊: ${info.startYear}`);
  if (info.location) console.log(`出版地: ${info.location}`);
  if (info.category) console.log(`专辑: ${info.category}`);
  if (info.subCategory) console.log(`专题: ${info.subCategory}`);
  if (info.impactFactor) console.log(`复合影响因子: ${info.impactFactor}`);
  if (info.impactFactorComprehensive) console.log(`综合影响因子: ${info.impactFactorComprehensive}`);
  if (info.totalArticles) console.log(`总文献量: ${info.totalArticles}`);
  if (info.totalIssues) console.log(`总期数: ${info.totalIssues}`);
  if (info.perIssue) console.log(`每期发文量: ${info.perIssue}`);

  if (info.columns && info.columns.length) {
    console.log('栏目:', info.columns.join('；'));
  } else {
    console.log('栏目: 未解析到');
  }

  if (info.latestIssues && info.latestIssues.length) {
    console.log('最新期发文量:');
    info.latestIssues.forEach(item => console.log(`  ${item.issue}: ${item.count} 篇`));
  } else {
    console.log('最新期发文量: 未解析到');
  }

  if (info.yearlyArticles && Object.keys(info.yearlyArticles).length) {
    console.log('年发文量:');
    Object.keys(info.yearlyArticles)
      .sort((a, b) => b - a)
      .forEach(year => console.log(`  ${year}: ${info.yearlyArticles[year]} 篇`));
  } else {
    console.log('年发文量: 未解析到');
  }
}

/**
 * 随机延迟
 */
function randomDelay() {
  const ms = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 加载本地期刊数据库(可能因浏览器代码而失败)
 */
function loadLocalDB() {
  try {
    const data = require(JOURNALS_FILE);
    if (Array.isArray(data)) return data;
    // 有些构建产物把数据挂在别的地方
    return null;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('CNKI 信息查询工具 (Playwright 版)');
  console.log('');

  // 确定要查询的目标
  const localDB = loadLocalDB();
  let targets = [];

  if (TARGET_CODES.length > 0) {
    const upperCodes = TARGET_CODES.map(c => c.toUpperCase());
    if (localDB) {
      targets = localDB.filter(item => item.cnkiCode && upperCodes.includes(item.cnkiCode.toUpperCase()));
      const found = targets.map(t => t.cnkiCode.toUpperCase());
      upperCodes.forEach(code => {
        if (!found.includes(code)) {
          targets.push({ name: code, cnkiCode: code });
        }
      });
    } else {
      targets = upperCodes.map(code => ({ name: code, cnkiCode: code }));
    }
  } else if (localDB) {
    targets = localDB.filter(item => item.cnkiCode);
    if (targets.length === 0) {
      console.log('本地数据库无 cnkiCode 字段, 请手动指定知网代码');
      console.log('用法: node cnki-skill.js SJYS WYYJ');
      process.exit(1);
    }
    console.log(`从本地数据库加载 ${targets.length} 本期刊, 即将开始查询...`);
    console.log('(可按 Ctrl+C 中断)');
  } else {
    console.log('本地数据库不可用, 请手动指定知网代码');
    console.log('用法: node cnki-skill.js SJYS WYYJ');
    console.log('示例: node cnki-skill.js SJYS');
    console.log('      node cnki-skill.js --headed SJYS  (显示浏览器窗口)');
    process.exit(1);
  }

  if (targets.length === 0) {
    console.log('未找到可查询的期刊');
    process.exit(1);
  }

  // 启动浏览器
  console.log(`启动 Chromium${HEADED ? ' (有头模式)' : ' (无头模式)'}...`);
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 },
    locale: 'zh-CN',
  });

  // 隐藏 webdriver 标记
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // 补充: 伪装 plugins 和 languages
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  const page = await context.newPage();

  try {
    // 先访问知网首页建立 session
    if (HOMEPAGE_FIRST || !SKIP_HOMEPAGE) {
      process.stdout.write('访问知网首页建立 session... ');
      try {
        await page.goto('https://navi.cnki.net/', {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await page.waitForTimeout(2000 + Math.random() * 2000);
        console.log('完成');
      } catch (err) {
        console.log(`跳过 (${err.message})`);
      }
    }

    // 逐个查询
    for (let i = 0; i < targets.length; i++) {
      const journal = targets[i];
      const code = journal.cnkiCode;

      if (i > 0) {
        const delay = (MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY)) / 1000;
        process.stdout.write(`等待 ${delay.toFixed(1)} 秒... `);
        await randomDelay();
        console.log('继续');
      }

      process.stdout.write(`查询 ${journal.name || code} (${code}) ... `);

      try {
        await page.goto(`https://navi.cnki.net/knavi/journal/${code}`, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_TIMEOUT,
        });

        // 等待页面内容渲染
        await page.waitForTimeout(2000 + Math.random() * 3000);

        const html = await page.content();

        // 检查是否被重定向到首页
        if (html.includes('中国知网') && html.includes('搜索') && !html.includes(code)) {
          console.log('被重定向(疑似反爬)');
          console.log('  建议加 --headed 查看页面实际情况, 或稍后再试');
          continue;
        }

        const info = parseCNKIPage(html);
        console.log('完成');
        renderReport(code, journal, info);
      } catch (err) {
        console.log(`失败: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
    console.log('\n浏览器已关闭');
  }
}

main().catch(err => {
  console.error('运行失败:', err.message);
  process.exit(1);
});
