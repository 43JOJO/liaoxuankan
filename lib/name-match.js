/**
 * lib/name-match.js — 统一刊名匹配（合并 4 份分叉实现）
 *
 * 此前 scrape-eshukan / rescrape-skipped / rescrape-unmatched / scrape-wanweixueshu
 * 各有一套 normalize/nameMatch/score，且行为不一致（有的禁用 includes、有的保留），
 * 导致同一本期刊在不同脚本里匹配结果不同。此处统一为单一实现，差异用参数表达。
 */

function normalize(s) {
  return String(s || '')
    .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
    .replace(/[：:]/g, ':').replace(/[，,]/g, ',')
    .replace(/[—–-]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

function stripBrackets(s) {
  return normalize(s).replace(/\([^)]*\)/g, '').trim();
}

/**
 * 两个刊名的相似度评分 0–100
 * options.allowIncludes: 是否允许“包含”式弱匹配（默认 true，但权重低）
 */
function scoreName(a, b, options = {}) {
  const allowIncludes = options.allowIncludes !== false;
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;

  const sa = stripBrackets(a), sb = stripBrackets(b);
  if (sa && sa === sb) return 90;

  if (sa && sb && (sa.startsWith(sb) || sb.startsWith(sa))) {
    const minLen = Math.min(sa.length, sb.length);
    const maxLen = Math.max(sa.length, sb.length);
    const ratio = maxLen ? minLen / maxLen : 0;
    if (minLen >= 4) return Math.round(70 + 15 * ratio); // 70–85，越接近越高
    return 50;
  }

  if (allowIncludes && sa && sb && (sa.includes(sb) || sb.includes(sa))) {
    const minLen = Math.min(sa.length, sb.length);
    return minLen >= 4 ? 60 : 30;
  }

  return 0;
}

/**
 * 在候选集中找最佳匹配
 * @param {string} target 目标刊名
 * @param {Array<string|object>} candidates 候选（字符串或带 name 字段的对象）
 * @param {object} options
 *   minScore        默认 50
 *   shortLen        短名阈值（默认 3）：名字越短越易误配，需更高分
 *   shortMinScore   短名时的最低分（默认 70）
 *   allowIncludes   是否允许包含式弱匹配（默认 true）
 *   nameKey         对象取名字段（默认 'name'）
 *   limit           >0 时额外返回 ranked 前 N 名
 * @returns {{matched: object|null, score: number, ranked?: Array}}
 */
function matchJournalName(target, candidates, options = {}) {
  const {
    minScore = 50,
    shortLen = 3,
    shortMinScore = 70,
    allowIncludes = true,
    nameKey = 'name',
    limit = 0,
  } = options;

  const list = (candidates || [])
    .map(c => (typeof c === 'string' ? { [nameKey]: c } : c))
    .filter(c => c && c[nameKey]);

  const scored = list
    .map(c => ({ candidate: c, score: scoreName(c[nameKey], target, { allowIncludes }) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const targetLen = normalize(target).length;
  const effMin = targetLen <= shortLen ? Math.max(minScore, shortMinScore) : minScore;

  const best = scored[0];
  const matched = best && best.score >= effMin ? best : null;

  const out = { matched: matched ? matched.candidate : null, score: matched ? matched.score : 0 };
  if (limit > 0) out.ranked = scored.slice(0, limit);
  return out;
}

module.exports = { normalize, stripBrackets, scoreName, matchJournalName };
