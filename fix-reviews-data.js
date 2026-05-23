/**
 * 数据质量修复脚本 — 修复点评脏数据 & 去重 realAuthorProfile
 * 用法: node fix-reviews-data.js
 */
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'src', 'journals.source.js');
const BACKUP = path.join(__dirname, 'src', 'journals.source.js.bak_fix');

// ==================== 点评清洁 ====================

function cleanReviewContent(r) {
  if (!r.content) return;

  let c = r.content;

  // 以最后一个句号/问号/感叹号为界，之后如有用户名痕迹则截断
  const lastPunct = Math.max(
    c.lastIndexOf('。'),
    c.lastIndexOf('？'),
    c.lastIndexOf('！'),
    c.lastIndexOf('?'),
    c.lastIndexOf('!')
  );
  if (lastPunct > 0 && lastPunct > c.length * 0.5) {
    const tail = c.substring(lastPunct + 1);
    // 如果尾部包含"先生/女士/同学/老师/用户"等称呼 + "在/于" → 截掉
    if (/[先师老同用网].{0,3}[生在户学友师者名]\s*[在于在]/.test(tail) ||
        /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(tail) ||
        tail.length > 40) {
      c = c.substring(0, lastPunct + 1);
    }
  }

  // 清除尾部残留的用户名+于/在
  c = c.replace(/\n{1,3}[一-龥a-zA-Z0-9]{1,10}\s*[在于在]\s*(\d{4}[\/\-])?\s*$/gm, '');
  c = c.replace(/\n{1,2}默认表情\s*$/g, '');
  c = c.replace(/在\s+\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*进行点评\s*$/g, '');
  c = c.replace(/\n{1,2}\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*$/g, '');

  c = c.trim();
  if (c.length > 600) c = c.substring(0, 600);

  r.content = c || null;
}

function cleanReviewField(val) {
  if (!val || typeof val !== 'string') return val;
  // Clean embedded field labels and garbled text
  let v = val;
  // Remove embedded next-field content (labels like 审稿时间, 是否录用, etc.)
  const labels = ['审稿时间', '是否录用', '我的学历', '我的职称', '有无课题',
    '有无回复', '查重要求', '版面费用', '投稿主题', '投稿难度', '发表排期',
    '我的点评', '稿件字数', '该刊可发', '默认表情'];
  for (const label of labels) {
    const idx = v.indexOf(label);
    if (idx > 0) v = v.substring(0, idx);
  }
  // Trim to reasonable length
  if (v.length > 40) v = v.substring(0, 40);
  v = v.trim();
  return v || null;
}

function cleanAllReviews(reviews) {
  if (!reviews || !Array.isArray(reviews)) return [];
  return reviews.map(r => {
    // Clean each field
    const cleaned = { ...r };
    cleaned.degree = cleanReviewField(cleaned.degree);
    cleaned.title = cleanReviewField(cleaned.title);
    cleaned.topic = cleanReviewField(cleaned.topic);
    cleaned.difficulty = cleanReviewField(cleaned.difficulty);
    cleaned.funding = cleanReviewField(cleaned.funding);
    cleaned.hasReply = cleanReviewField(cleaned.hasReply);
    cleaned.pubSchedule = cleanReviewField(cleaned.pubSchedule);
    cleaned.reviewTime = cleanReviewField(cleaned.reviewTime);
    cleaned.accepted = cleanReviewField(cleaned.accepted);
    cleanReviewContent(cleaned);
    return cleaned;
  }).filter(r => r.reviewTime || r.content || r.accepted);
}

// ==================== realAuthorProfile 重构 ====================

function buildAuthorProfile(reviews) {
  if (!reviews || reviews.length < 2) return null;

  const parts = [];

  // 1. 学历分布
  const degreeMap = {};
  const titleMap = {};
  reviews.forEach(r => {
    if (r.degree) {
      const d = r.degree.replace(/[^一-龥]/g, '').replace(/我的学历/g, '').trim();
      if (d.length <= 8) degreeMap[d] = (degreeMap[d] || 0) + 1;
    }
    if (r.title) {
      const t = r.title.replace(/[^一-龥]/g, '').replace(/我的职称/g, '').trim();
      if (t.length <= 8) titleMap[t] = (titleMap[t] || 0) + 1;
    }
  });

  // Sort by count desc
  const degSorted = Object.entries(degreeMap).sort((a, b) => b[1] - a[1]);
  const titleSorted = Object.entries(titleMap).sort((a, b) => b[1] - a[1]);

  if (degSorted.length > 0) {
    parts.push('投稿人学历: ' + degSorted.map(([d, c]) => `${d}(${c}人)`).join('、'));
  }
  if (titleSorted.length > 0) {
    parts.push('职称分布: ' + titleSorted.map(([t, c]) => `${t}(${c}人)`).join('、'));
  }

  // 2. 录用率 (at least 3 reviews to be meaningful)
  if (reviews.length >= 3) {
    const accepted = reviews.filter(r => r.accepted && (r.accepted.includes('录用') || r.accepted.includes('接收'))).length;
    const rate = Math.round((accepted / reviews.length) * 100);
    if (rate === 0) {
      parts.push('万维书刊网点名录用率极低(<5%)');
    } else {
      parts.push(`万维书刊网点名录用率约${rate}%`);
    }
  }

  // 3. 审稿周期
  const times = [];
  reviews.forEach(r => {
    if (r.reviewTime) {
      const m = r.reviewTime.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        const n = parseInt(m[1]);
        if (n > 0 && n < 365) {
          if (r.reviewTime.includes('天')) times.push(n);
          else if (r.reviewTime.includes('周')) times.push(Math.round(n * 7));
          else if (r.reviewTime.includes('月')) times.push(n * 30);
        }
      }
    }
  });
  if (times.length >= 2) {
    times.sort((a, b) => a - b);
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    parts.push(`万维书刊网点名审稿周期均约${avg}天`);
  }

  // 4. 版面费
  const feeReviews = reviews.filter(r => r.pageFee).length;
  if (feeReviews > 0) {
    const freeCount = reviews.filter(r => r.pageFee && (r.pageFee.includes('不收') || r.pageFee.includes('免费') || r.pageFee === '0')).length;
    if (freeCount >= feeReviews / 2) parts.push('多数点评反映不收版面费');
  }

  return parts.length > 0 ? parts.join('；') + '。' : null;
}

// ==================== Main ====================

console.log('加载源文件...');
delete require.cache[require.resolve(SOURCE)];
const journals = require(SOURCE);
console.log(`${journals.length} 本期刊\n`);

// 备份
fs.writeFileSync(BACKUP, fs.readFileSync(SOURCE, 'utf-8'), 'utf-8');
console.log('备份: ' + BACKUP);

let reviewCleaned = 0;
let profileRebuilt = 0;

for (const j of journals) {
  if (j.wanweiReviews && j.wanweiReviews.length > 0) {
    const originalCount = j.wanweiReviews.length;
    j.wanweiReviews = cleanAllReviews(j.wanweiReviews);
    if (j.wanweiReviews.length !== originalCount) {
      reviewCleaned += (originalCount - j.wanweiReviews.length);
    }
  }

  // 完全重建 realAuthorProfile
  const newProfile = buildAuthorProfile(j.wanweiReviews || []);
  if (newProfile) {
    j.realAuthorProfile = newProfile;
    profileRebuilt++;
  } else if (j.realAuthorProfile && j.realAuthorProfile.includes('投稿人学历')) {
    // 有点评但不够重建，保留原有base（去掉叠加部分）
    const base = j.realAuthorProfile.split('。投稿人学历')[0];
    j.realAuthorProfile = base;
  }
}

// 计算 review stats
for (const j of journals) {
  if (j.wanweiReviews && j.wanweiReviews.length > 0) {
    const reviews = j.wanweiReviews;

    // 审稿时间
    const times = [];
    reviews.forEach(r => {
      if (r.reviewTime) {
        const m = r.reviewTime.match(/(\d+(?:\.\d+)?)/);
        if (m) {
          const n = parseInt(m[1]);
          if (n > 0 && n < 365) {
            if (r.reviewTime.includes('天')) times.push(n);
            else if (r.reviewTime.includes('周')) times.push(Math.round(n * 7));
            else if (r.reviewTime.includes('月')) times.push(n * 30);
          }
        }
      }
    });

    const stats = { total: reviews.length };
    if (times.length > 0) {
      times.sort((a, b) => a - b);
      stats.reviewTimeMin = times[0];
      stats.reviewTimeMax = times[times.length - 1];
      stats.reviewTimeAvg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    }

    if (reviews.length >= 3) {
      const accepted = reviews.filter(r => r.accepted && (r.accepted.includes('录用') || r.accepted.includes('接收'))).length;
      stats.acceptanceRate = Math.round((accepted / reviews.length) * 100);
    }

    const difficulties = reviews.filter(r => r.difficulty).map(r => r.difficulty);
    if (difficulties.length > 0) {
      const dist = {};
      difficulties.forEach(d => { dist[d] = (dist[d] || 0) + 1; });
      stats.difficultyDistribution = dist;
    }

    j.wanweiReviewStats = stats;
  }
}

// 清理 source 字段中的重复标记
for (const j of journals) {
  if (j.source) {
    let s = j.source;
    // Remove duplicate 万维书刊网核验
    const parts = s.split(' · ');
    const unique = [...new Set(parts)];
    // Remove 万维学术网核验 (wrong site)
    j.source = unique.filter(p => p !== '万维学术网核验').join(' · ');
  }
}

// 写入
const header = `const journalDatabase = `;
const footer = `\n\nmodule.exports = journalDatabase;\n`;
const newContent = header + JSON.stringify(journals, null, 2) + footer;

fs.writeFileSync(SOURCE, newContent, 'utf-8');

// 验证
delete require.cache[require.resolve(SOURCE)];
const verify = require(SOURCE);
if (!Array.isArray(verify) || verify.length !== journals.length) {
  console.error('验证失败! 从备份恢复...');
  fs.copyFileSync(BACKUP, SOURCE);
  process.exit(1);
}

console.log(`\n✅ 修复完成!`);
console.log(`   cleanedReviews: ${reviewCleaned} 条脏记录移除`);
console.log(`   realAuthorProfile: ${profileRebuilt} 本重建`);
console.log(`   验证通过: ${verify.length} 本期刊`);
console.log(`\n运行 node build.js 重新构建。`);
