/**
 * 万维书刊网学报补全 — 搜索学院/职院/专科/本科学报
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const XUEBAO = path.join(__dirname, 'src', 'xuebao.source.js');
const OUTPUT = path.join(__dirname, 'eshukan-xuebao-data.json');

const SEARCH_TERMS = [
  '学院学报', '职业', '职业技术学院学报', '专科学报',
  '师专学报', '教育学院学报', '广播电视大学学报',
];

// Province keywords for regional coverage
const PROVINCES = [
  '江苏', '浙江', '广东', '山东', '河南', '四川', '湖北', '湖南',
  '河北', '福建', '安徽', '辽宁', '江西', '陕西', '山西', '黑龙江',
  '吉林', '云南', '贵州', '广西', '甘肃', '内蒙古', '新疆', '海南',
  '宁夏', '青海', '西藏', '北京', '天津', '上海', '重庆',
];

async function searchAllJournals(page, keyword) {
  const allItems = [];
  for (let p = 1; p <= 3; p++) {
    const url = `https://www.eshukan.com/searchresult.aspx?keywords=${encodeURIComponent(keyword)}&etypeid=0&page=${p}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const items = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href*="displayj.aspx?jid="]')].map(a => ({
        name: a.textContent.trim(),
        id: parseInt((a.getAttribute('href').match(/jid=(\d+)/) || [])[1], 10),
      }));
    });

    if (items.length === 0) break;
    allItems.push(...items);
    if (items.length < 15) break; // last page
  }
  return allItems;
}

async function scrapeDetail(page, jid) {
  await page.goto(`https://www.eshukan.com/displayj.aspx?jid=${jid}`, {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
    const text = document.body.innerText;
    const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };

    // Extract publisher for province/type inference
    const publisher = get(/主办单位[：:]\s*([^\n]+)/) || get(/主办[：:]\s*([^\n]+)/) || '';
    const supervisor = get(/主管单位[：:]\s*([^\n]+)/) || get(/主管[：:]\s*([^\n]+)/) || '';

    // Infer province from publisher/supervisor
    let province = '';
    const provNames = ['江苏','浙江','广东','山东','河南','四川','湖北','湖南','河北','福建','安徽','辽宁','江西','陕西','山西','黑龙江','吉林','云南','贵州','广西','甘肃','内蒙古','新疆','海南','宁夏','青海','西藏','北京','天津','上海','重庆'];
    for (const p of provNames) {
      if (publisher.includes(p) || supervisor.includes(p)) { province = p; break; }
    }

    return {
      issn: get(/ISSN[：:\s]*([^\n]+)/)?.replace('ISSN ', ''),
      cn: get(/CN[：:\s]*([^\n]+)/)?.replace('CN ', ''),
      publisher,
      supervisor,
      province,
      frequency: get(/出版周期[：:\s]*([^\n]+)/) || get(/刊期[：:\s]*([^\n]+)/),
      price: get(/定[价價][：:\s]*([^\n]+)/),
      phone: get(/电话[：:\s]*([^\n]+)/),
      email: get(/邮箱[：:\s]*([^\n]+)/),
      website: get(/官网[：:\s]*([^\n]+)/),
    };
  });
}

function inferLevel(name, publisher) {
  // Infer AMI level from university type
  const n = name + publisher;
  // These are rough estimates
  if (/大学.*学报.*哲学社会科学|大学.*学报.*社科/.test(n)) return 'AMI扩展';
  if (/大学.*学报/.test(n) && !/职业|专科|师专/.test(n)) return 'AMI入库';
  if (/师范.*学报|学院.*学报.*哲学社会科学/.test(n)) return 'AMI入库';
  if (/学院.*学报/.test(n) && !/职业|专科/.test(n)) return 'AMI入库';
  if (/职业|专科|职院/.test(n)) return 'AMI职院刊入库';
  return '待核实';
}

function inferType(name) {
  if (/职业|职院/.test(name)) return '职业院校';
  if (/师范/.test(name)) return '师范院校';
  if (/专科|师专/.test(name)) return '专科院校';
  if (/大学/.test(name)) return '大学';
  if (/学院/.test(name)) return '学院';
  return '其他';
}

async function main() {
  // Load existing xuebao names to avoid duplicates
  const existing = require(XUEBAO);
  const existingNorm = new Set(existing.map(x => {
    return x.name.replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/\s+/g,'').substring(0, 20);
  }));

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1536, height: 864 }, locale: 'zh-CN', ignoreHTTPSErrors: true,
  });

  const page = await ctx.newPage();
  const allFound = new Map(); // id → item

  // Search with various terms
  for (const term of SEARCH_TERMS) {
    process.stdout.write(`搜索: ${term} ... `);
    const items = await searchAllJournals(page, term);
    process.stdout.write(`${items.length} 个结果\n`);

    for (const item of items) {
      if (!item.name.includes('学报')) continue;
      if (!/美术|艺术|设计|美学|文化|传媒|新闻|音乐|舞蹈|戏剧|影视|文学|语言|历史|哲学|人文|社科|非遗/.test(item.name) &&
          !/学院|职业|专科|师专|师范|教育/.test(item.name)) continue;
      if (!allFound.has(item.id)) allFound.set(item.id, item);
    }
  }

  console.log(`\n去重后共 ${allFound.size} 本候选学报\n`);

  // Filter out already existing
  const newOnes = [...allFound.values()].filter(item => {
    const norm = item.name.replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/\s+/g,'').substring(0, 20);
    return ![...existingNorm].some(en => norm.includes(en) || en.includes(norm));
  });

  console.log(`需抓取详情: ${newOnes.length} 本\n`);

  // Scrape details
  const newJournals = [];
  for (let i = 0; i < newOnes.length; i++) {
    const item = newOnes[i];
    process.stdout.write(`[${i+1}/${newOnes.length}] ${item.name.substring(0,30)}... `);

    try {
      const detail = await scrapeDetail(page, item.id);

      // Determine domains based on name
      const domains = [];
      const n = item.name;
      if (/美术|艺术|设计|美学/.test(n)) domains.push('美术与书法', '设计学', '艺术学');
      if (/文学|语言/.test(n)) domains.push('中国文学', '外国文学');
      if (/历史/.test(n)) domains.push('历史学');
      if (/哲学/.test(n)) domains.push('哲学');
      if (/文化|传媒|新闻|非遗/.test(n)) domains.push('文化研究', '非遗保护');
      if (/教育/.test(n)) domains.push('教育学');
      if (/社科|人文/.test(n)) domains.push('社会学', '法学');
      if (domains.length === 0) domains.push('综合社科');

      const entry = {
        name: item.name,
        eshukanId: item.id,
        publisher: detail.publisher,
        province: detail.province,
        level: inferLevel(item.name, detail.publisher),
        type: inferType(item.name),
        domains,
        issn: detail.issn,
        frequency: detail.frequency,
        phone: detail.phone,
        email: detail.email,
        website: detail.website,
        source: '万维书刊网',
      };

      newJournals.push(entry);
      console.log(`${detail.province || '?'} ${entry.level}`);
    } catch (err) {
      console.log(`出错: ${err.message}`);
    }

    if (i < newOnes.length - 1) {
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1000));
    }
  }

  await ctx.close();

  // Save
  fs.writeFileSync(OUTPUT, JSON.stringify(newJournals, null, 2), 'utf-8');
  console.log(`\n完成! 新增 ${newJournals.length} 本学报 → ${OUTPUT}`);

  // Show summary
  const levels = {};
  newJournals.forEach(j => { levels[j.level] = (levels[j.level]||0)+1; });
  console.log('级别分布:', JSON.stringify(levels));
  const types = {};
  newJournals.forEach(j => { types[j.type] = (types[j.type]||0)+1; });
  console.log('类型分布:', JSON.stringify(types));
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
