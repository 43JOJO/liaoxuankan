/**
 * lib/config.js — 集中所有硬编码（路径 / UA / viewport / 延迟 / checkpoint 命名）
 *
 * 设计原则：
 *   - 路径全部相对项目根（lib 的上一级）解析，不写死 D:\…，换机器/换盘符无需改代码
 *   - chrome profile 按用途分目录，避免多脚本并行抢同一个 profile 造成锁死
 *   - checkpoint 文件名统一规则：checkpoints/<name>.checkpoint.json
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const p = (...segs) => path.join(ROOT, ...segs);

module.exports = {
  ROOT,

  paths: {
    root: ROOT,
    src: p('src'),
    journalsSource: p('src', 'journals.source.js'),
    foreignSource: p('src', 'foreign.source.js'),
    journalsMini: p('src', 'journals.mini.js'),
    // 线上加载的产物文件（index.html 加载的是这两个，build.js 负责 source→product）
    journalsProduct: p('journals.js'),
    foreignProduct: p('foreign.js'),
    checkpoints: p('checkpoints'),
    backups: p('backups'),
    chromeProfileBase: p('chrome-profile'),
  },

  // 按脚本/用途隔离 profile，规避 launchPersistentContext 互锁
  profileDir(name = 'default') {
    return path.join(this.paths.chromeProfileBase, name);
  },

  // 统一 checkpoint 文件名规则
  checkpointPath(name) {
    return path.join(this.paths.checkpoints, String(name) + '.checkpoint.json');
  },

  browser: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 },
    locale: 'zh-CN',
    launchArgs: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-features=TranslateUI',
    ],
  },

  // 反检测初始化脚本（传给 context.addInitScript；运行在浏览器上下文，勿引用 Node 变量）
  stealthInit() {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  },

  // 各站点请求间隔 [min, max] 毫秒
  delays: {
    cnki: [10000, 20000],
    eshukan: [5000, 10000],
    wanwei: [3000, 5000],
    httpPolite: [1000, 3000],
    batchRestMs: 5 * 60 * 1000, // 批次间休息
  },

  // newContext / launchPersistentContext 通用参数
  contextOptions(extra = {}) {
    return {
      userAgent: this.browser.userAgent,
      viewport: this.browser.viewport,
      locale: this.browser.locale,
      ignoreHTTPSErrors: true,
      ...extra,
    };
  },
};
