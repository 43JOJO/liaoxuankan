/**
 * 学报补全第二轮 — 按省份搜索
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const XUEBAO = path.join(__dirname, 'src', 'xuebao.source.js');
const OUTPUT = path.join(__dirname, 'eshukan-xuebao-data.json');

const PROVINCES = [
  '河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽','福建',
  '江西','山东','河南','湖北','湖南','广东','广西','四川','贵州',
  '云南','陕西','甘肃','青海','内蒙古','新疆',
];

const cityMap = {
  '安康':'陕西','滁州':'安徽','德州':'山东','怀化':'湖南','黄山':'安徽','韶关':'广东',
  '宿州':'安徽','台州':'浙江','潍坊':'山东','滨州':'山东','菏泽':'山东','济宁':'山东',
  '临沂':'山东','枣庄':'山东','泰安':'山东','聊城':'山东','淄博':'山东',
  '洛阳':'河南','南阳':'河南','安阳':'河南','平顶山':'河南','新乡':'河南','焦作':'河南',
  '荆州':'湖北','黄冈':'湖北','孝感':'湖北','咸宁':'湖北','岳阳':'湖南','衡阳':'湖南',
  '邵阳':'湖南','常德':'湖南','赣州':'江西','景德镇':'江西','宜春':'江西','上饶':'江西',
  '绵阳':'四川','乐山':'四川','宜宾':'四川','南充':'四川','达州':'四川',
  '遵义':'贵州','毕节':'贵州','铜仁':'贵州','玉溪':'云南','曲靖':'云南','大理':'云南',
  '桂林':'广西','梧州':'广西','泉州':'福建','漳州':'福建','龙岩':'福建','莆田':'福建',
  '六安':'安徽','巢湖':'安徽','铜陵':'安徽','湖州':'浙江','嘉兴':'浙江','金华':'浙江',
  '丽水':'浙江','镇江':'江苏','扬州':'江苏','常州':'江苏','南通':'江苏','盐城':'江苏',
  '淮安':'江苏','佳木斯':'黑龙江','齐齐哈尔':'黑龙江','牡丹江':'黑龙江',
  '抚顺':'辽宁','鞍山':'辽宁','营口':'辽宁','锦州':'辽宁','惠州':'广东','肇庆':'广东',
  '汕头':'广东','咸阳':'陕西','宝鸡':'陕西','天水':'甘肃','苏州':'江苏','常州':'江苏',
  '宁波':'浙江','温州':'浙江','淮南':'安徽','漯河':'河南','顺德':'广东','泰州':'江苏',
  '淮北':'安徽','无锡':'江苏','绥化':'黑龙江','辽东':'辽宁','丹东':'辽宁',
  '驻马店':'河南','黄淮':'河南','集宁':'内蒙古','保山':'云南','延边':'吉林',
  '兵团':'新疆','石河子':'新疆','伊犁':'新疆',
};

function inferProvince(name, publisher) {
  for (const [city, prov] of Object.entries(cityMap)) {
    if ((publisher||'').includes(city) || name.includes(city)) return prov;
  }
  return '';
}

function inferLevel(name) {
  if (/大学.*学报.*哲学社会科学|大学.*学报.*社科/.test(name)) return 'AMI扩展';
  if (/大学.*学报/.test(name) && !/职业|专科|师专/.test(name)) return 'AMI入库';
  if (/师范.*学报|学院.*学报.*哲学社会科学/.test(name)) return 'AMI入库';
  if (/学院.*学报/.test(name) && !/职业|专科/.test(name)) return 'AMI入库';
  if (/职业|专科|职院/.test(name)) return 'AMI职院刊入库';
  return '待核实';
}

function inferDomains(name) {
  const d = [];
  if (/美术|艺术|设计|美学/.test(name)) d.push('美术与书法','设计学','艺术学');
  if (/文学|语言|外语/.test(name)) d.push('中国文学','外国文学');
  if (/历史/.test(name)) d.push('历史学');
  if (/哲学/.test(name)) d.push('哲学');
  if (/文化|传媒|新闻|非遗/.test(name)) d.push('文化研究','非遗保护');
  if (/教育/.test(name)) d.push('教育学');
  if (/社科|人文|综合/.test(name)) d.push('综合社科');
  if (d.length === 0) d.push('综合社科');
  return d;
}

async function main() {
  const existing = require(XUEBAO);
  const existingNorm = new Set(existing.map(x =>
    x.name.replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/\s+/g,'').substring(0, 18)
  ));

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1536, height: 864 }, locale: 'zh-CN', ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  const allFound = new Map();

  for (const prov of PROVINCES) {
    const kw = prov + ' 学报';
    process.stdout.write(prov + '... ');

    for (let p = 1; p <= 2; p++) {
      try {
        await page.goto(`https://www.eshukan.com/searchresult.aspx?keywords=${encodeURIComponent(kw)}&etypeid=0&page=${p}`, {
          waitUntil: 'domcontentloaded', timeout: 15000,
        });
        await page.waitForTimeout(1500);

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('a[href*="displayj.aspx?jid="]')].map(a => ({
            name: a.textContent.trim(),
            id: parseInt((a.getAttribute('href').match(/jid=(\d+)/) || [])[1], 10),
          }));
        });

        let added = 0;
        for (const item of items) {
          if (!item.name.includes('学报')) continue;
          if (!allFound.has(item.id)) {
            allFound.set(item.id, { ...item, searchProv: prov });
            added++;
          }
        }
        if (items.length < 10) break;
      } catch (e) { break; }
    }
    process.stdout.write(allFound.size + '本累计\n');
  }

  console.log(`\n去重: ${allFound.size} 本`);

  // Filter new ones
  const newOnes = [...allFound.values()].filter(item => {
    const norm = item.name.replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/\s+/g,'').substring(0, 18);
    return ![...existingNorm].some(en => norm.includes(en) || en.includes(norm));
  });

  console.log(`需抓详情: ${newOnes.length} 本`);

  // Only scrape basic info (fast mode: just publisher from search results won't work)
  // We need to scrape detail pages for publisher/info
  const newJournals = [];
  for (let i = 0; i < newOnes.length; i++) {
    const item = newOnes[i];
    try {
      await page.goto(`https://www.eshukan.com/displayj.aspx?jid=${item.id}`, {
        waitUntil: 'domcontentloaded', timeout: 15000,
      });
      await page.waitForTimeout(1000);

      const detail = await page.evaluate(() => {
        document.querySelectorAll('script,style,noscript').forEach(e => e.remove());
        const text = document.body.innerText;
        const get = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };
        return {
          publisher: get(/主办单位[：:]\s*([^\n]+)/) || get(/主办[：:]\s*([^\n]+)/),
          supervisor: get(/主管单位[：:]\s*([^\n]+)/) || get(/主管[：:]\s*([^\n]+)/),
        };
      });

      const entry = {
        name: item.name,
        eshukanId: item.id,
        publisher: detail.publisher,
        province: inferProvince(item.name, detail.publisher) || item.searchProv,
        level: inferLevel(item.name),
        domains: inferDomains(item.name),
        source: '万维书刊网',
      };
      newJournals.push(entry);
    } catch (e) {}

    if (i < newOnes.length - 1) {
      await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
    }
  }

  await ctx.close();

  fs.writeFileSync(OUTPUT, JSON.stringify(newJournals, null, 2), 'utf-8');
  console.log(`\n新增: ${newJournals.length} 本 → ${OUTPUT}`);

  const levels = {};
  newJournals.forEach(j => { levels[j.level] = (levels[j.level]||0)+1; });
  console.log('级别:', JSON.stringify(levels));
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
