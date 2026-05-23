/**
 * lib/retry.js — 指数退避重试
 *
 * 解决 P1：14 个脚本此前 0 重试，任何瞬时超时都直接变成永久数据空洞。
 * 用法：
 *   const { result, retries } = await withRetry(() => page.goto(url, {...}));
 *   全部失败则抛出最后一次错误（带 .retriesExhausted），调用方可据此标记“待重试”。
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {Function} fn  async (attempt:number) => result
 * @param {object} options
 *   tries       最多尝试次数（默认 3）
 *   baseMs      初始退避（默认 2000）
 *   maxMs       退避上限（默认 30000）
 *   factor      退避倍率（默认 2）
 *   jitter      是否加 ±30% 抖动（默认 true）
 *   onRetry     (err, nextAttempt, delayMs) => void 重试前回调
 *   shouldRetry (err, attempt) => boolean 返回 false 立即放弃（如 4xx 不重试）
 * @returns {Promise<{result:any, retries:number}>}
 */
async function withRetry(fn, options = {}) {
  const {
    tries = 3,
    baseMs = 2000,
    maxMs = 30000,
    factor = 2,
    jitter = true,
    onRetry = null,
    shouldRetry = null,
  } = options;

  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, retries: attempt };
    } catch (err) {
      lastErr = err;
      if (shouldRetry && !shouldRetry(err, attempt)) break;
      if (attempt < tries - 1) {
        let delay = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
        if (jitter) delay = Math.round(delay * (0.7 + Math.random() * 0.6));
        if (onRetry) { try { onRetry(err, attempt + 2, delay); } catch (_) {} }
        await sleep(delay);
      }
    }
  }
  const e = lastErr || new Error('withRetry: 全部尝试失败');
  e.retriesExhausted = tries;
  throw e;
}

module.exports = { withRetry, sleep };
