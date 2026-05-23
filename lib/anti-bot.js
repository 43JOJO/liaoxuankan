/**
 * lib/anti-bot.js — 页面健康检查 + 跨平台人工提醒
 *
 * 解决 P1：
 *   - isBlocked(page)：检测验证码页/正文过短/标题含“安全验证”等，命中→调用方跳过并标记待重试
 *   - isBlockedHtml(html)：纯 HTTP 抓取（sync-cnki）用，传 HTML 字符串
 *   - alertHuman(msg)：跨平台提醒（红色 + \x07 响铃），替代只在 Windows 有效的 PowerShell 弹窗
 *   - waitForUnblock(page)：轮询等待人工解验证码（跨平台）
 */

const BLOCK_MARKERS = [
  '安全验证', '向右滑动', '请完成验证', '滑动验证', '人机验证', '验证码',
  'captcha', 'verify', 'unusual traffic', 'just a moment', 'access denied',
];

async function getPageSignals(page) {
  let text = '', title = '', url = '';
  try { url = page.url(); } catch (_) {}
  try { title = await page.title(); } catch (_) {}
  try { text = await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch (_) {}
  return { text: text || '', title: title || '', url: url || '' };
}

function evaluateBlock({ text, title, url }, options = {}) {
  const minLen = options.minLen != null ? options.minLen : 300;
  const hay = ((title || '') + '\n' + (text || '')).toLowerCase();
  const hit = BLOCK_MARKERS.find(m => hay.includes(m.toLowerCase()));
  if (hit) return { blocked: true, reason: 'marker:' + hit };
  if (/\/verify|\/captcha|\/seccheck|\/sec\b/i.test(url || '')) return { blocked: true, reason: 'url' };
  if ((text || '').trim().length < minLen) return { blocked: true, reason: 'short-body:' + (text || '').trim().length };
  return { blocked: false, reason: null };
}

async function inspectBlock(page, options = {}) {
  return evaluateBlock(await getPageSignals(page), options);
}

async function isBlocked(page, options = {}) {
  return (await inspectBlock(page, options)).blocked;
}

// 纯 HTTP：去标签后按同一规则判断（sync-cnki 用）
function isBlockedHtml(html, options = {}) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return evaluateBlock({ text, title: '', url: '' }, options).blocked;
}

function alertHuman(msg) {
  const RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m', BELL = '\x07';
  process.stderr.write(BELL + RED + BOLD + '\n⚠ 需要人工处理: ' + String(msg) + RESET + '\n');
}

// 轮询等待人工解验证码；返回是否解除
async function waitForUnblock(page, options = {}) {
  const { timeoutMs = 120000, pollMs = 5000, message = '请去浏览器窗口完成验证（拖滑块）' } = options;
  if (!(await isBlocked(page, options))) return true;
  alertHuman(message);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    if (!(await isBlocked(page, options))) { process.stderr.write(' 已解除\n'); return true; }
    process.stderr.write('.');
  }
  process.stderr.write(' 超时\n');
  return false;
}

module.exports = {
  BLOCK_MARKERS,
  getPageSignals,
  evaluateBlock,
  inspectBlock,
  isBlocked,
  isBlockedHtml,
  alertHuman,
  waitForUnblock,
};
