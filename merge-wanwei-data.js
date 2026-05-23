/**
 * 万维书刊网(eshukan)数据 → 源文件合并脚本
 *
 * 用法:
 *   node merge-wanwei-data.js           # 合并（先备份）
 *   node merge-wanwei-data.js --dry-run # 预览变更，不实际写入
 *   node merge-wanwei-data.js --single "文艺研究"  # 只合并指定期刊
 *
 * 功能:
 *   1. 读取 eshukan-data.json 中的抓取数据
 *   2. 按期刊名称模糊匹配 src/journals.source.js 中的条目
 *   3. 更新万维书刊网相关字段，保护评分敏感字段
 *   4. 备份源文件 → src/journals.source.js.bak_eshukan
 */

const fs = require('fs');
const path = require('path');

const WANWEI_DATA = path.join(__dirname, 'eshukan-data.json');
const SOURCE = path.join(__dirname, 'src', 'journals.source.js');
const BACKUP = path.join(__dirname, 'src', 'journals.source.js.bak_eshukan');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const SINGLE = ARGS.includes('--single');
const TARGET_NAME = SINGLE ? ARGS[ARGS.indexOf('--single') + 1] : null;

// ==================== 名称标准化 ====================

function normalizeName(name) {
  return name
    .replace(/[（(]/g, '(')   // 全角括号 → 半角
    .replace(/[）)]/g, ')')
    .replace(/[：:]/g, ':')    // 全角冒号 → 半角
    .replace(/[，,]/g, ',')    // 全角逗号 → 半角
    .replace(/[—-]/g, '-')    // 全角破折号 → 半角
    .replace(/\s+/g, '')      // 去空格
    .trim();
}

function stripBrackets(s) {
  return s.replace(/\([^)]*\)/g, '').trim();
}

function namesMatch(a, b) {
  // a = 万维名, b = 源文件名
  const na = normalizeName(a);
  const nb = normalizeName(b);

  // 1. 标准化后完全一致
  if (na === nb) return 'exact';

  // 2. 去括号后比较（优先于 prefix，避免"文艺研究"被 prefix 匹配而非更精确的 no-brackets）
  const sa = stripBrackets(na);
  const sb = stripBrackets(nb);

  if (sa === sb) return 'no-brackets';
  if (sa.startsWith(sb) || sb.startsWith(sa)) return 'no-brackets-prefix';

  // 3. 源文件名是万维名的前缀（保留括号后缀的情况）
  if (na.startsWith(nb)) return 'prefix';
  if (nb.startsWith(na)) return 'prefix';

  // 4. 不匹配
  return null;
}

// ==================== 点评清理 ====================

function cleanReview(r) {
  const cleaned = { ...r };

  // 清理窜位文本（字段中嵌入的下一个字段标签）
  const fieldLabels = [
    '审稿时间', '是否录用', '我的学历', '我的职称', '有无课题',
    '有无回复', '查重要求', '版面费用', '投稿主题', '投稿难度',
    '发表排期', '我的点评', '稿件字数', '该刊可发',
  ];

  for (const key of ['degree', 'title', 'topic', 'difficulty', 'funding', 'hasReply']) {
    if (cleaned[key]) {
      let val = cleaned[key];
      for (const label of fieldLabels) {
        const idx = val.indexOf(label);
        if (idx > 0) {
          val = val.substring(0, idx);
        }
      }
      // 也清理过长的尾巴（30字以上的字段大概率窜位）
      if (val.length > 30) {
        val = val.substring(0, 30);
      }
      cleaned[key] = val.trim() || null;
    }
  }

  // 清理 content 字段中嵌入的下一条日期或用户回复
  if (cleaned.content) {
    // 截断尾部用户回复痕迹
    const lastPunct = Math.max(
      cleaned.content.lastIndexOf('。'),
      cleaned.content.lastIndexOf('？'),
      cleaned.content.lastIndexOf('！'),
      cleaned.content.lastIndexOf('?'),
      cleaned.content.lastIndexOf('!')
    );
    if (lastPunct > 0 && lastPunct > cleaned.content.length * 0.5) {
      const tail = cleaned.content.substring(lastPunct + 1);
      if (/[先师老同用网].{0,3}[生在户学友师者名]\s*[在于在]/.test(tail) ||
          /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(tail) ||
          tail.length > 40) {
        cleaned.content = cleaned.content.substring(0, lastPunct + 1);
      }
    }
    cleaned.content = cleaned.content.replace(/\n{1,3}[一-龥a-zA-Z0-9]{1,10}\s*[在于在]\s*(\d{4}[\/\-])?\s*$/gm, '');
    cleaned.content = cleaned.content.replace(/\n{1,2}\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*$/g, '');
    cleaned.content = cleaned.content.trim();
    if (cleaned.content.length > 600) cleaned.content = cleaned.content.substring(0, 600);
  }

  return cleaned;
}

// ==================== 聚合统计 ====================

function computeReviewStats(reviews) {
  if (!reviews || reviews.length === 0) return null;

  const stats = { total: reviews.length };

  // 审稿时间分布
  const times = [];
  for (const r of reviews) {
    if (r.reviewTime) {
      const m = r.reviewTime.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        const n = parseInt(m[1]);
        if (r.reviewTime.includes('天') && n < 30) times.push(n);
        else if (r.reviewTime.includes('天')) times.push(Math.round(n / 30));
        else if (r.reviewTime.includes('周')) times.push(Math.round(n / 4.3));
        else if (r.reviewTime.includes('月') || !r.reviewTime.includes('年')) times.push(n);
        else if (r.reviewTime.includes('年')) times.push(n * 12);
      }
    }
  }
  if (times.length > 0) {
    times.sort((a, b) => a - b);
    stats.reviewTimeMin = times[0];
    stats.reviewTimeMax = times[times.length - 1];
    stats.reviewTimeAvg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  }

  // 录用率
  if (reviews.length >= 3) {
    const accepted = reviews.filter(r =>
      r.accepted && (r.accepted.includes('录用') || r.accepted.includes('接收'))
    ).length;
    stats.acceptanceRate = Math.round((accepted / reviews.length) * 100);
  }

  // 难度分布
  const difficulties = reviews
    .filter(r => r.difficulty)
    .map(r => r.difficulty);
  if (difficulties.length > 0) {
    const dist = {};
    difficulties.forEach(d => { dist[d] = (dist[d] || 0) + 1; });
    stats.difficultyDistribution = dist;
  }

  return stats;
}

// ==================== 主合并逻辑 ====================

function merge() {
  // 1. 加载数据
  if (!fs.existsSync(WANWEI_DATA)) {
    console.error('错误: 找不到万维书刊网数据文件:', WANWEI_DATA);
    console.error('请先运行: node scrape-eshukan.js --match-existing');
    process.exit(1);
  }

  const wanweiRaw = JSON.parse(fs.readFileSync(WANWEI_DATA, 'utf-8'));
  const wanweiJournals = wanweiRaw.journals || [];

  if (wanweiJournals.length === 0) {
    console.error('错误: 万维数据中没有期刊条目');
    process.exit(1);
  }

  console.log(`万维书刊网数据: ${wanweiJournals.length} 本期刊`);

  // 2. 加载源文件
  delete require.cache[require.resolve(SOURCE)];
  const sourceJournals = require(SOURCE);

  if (!Array.isArray(sourceJournals)) {
    console.error('错误: 源文件不是数组');
    process.exit(1);
  }

  console.log(`源文件: ${sourceJournals.length} 本期刊\n`);

  // 3. 匹配（评分制，选最佳而非第一个）
  const matches = [];
  const unmatchedWanwei = [];
  const unmatchedSource = [];

  const typeScoreMap = { exact: 100, prefix: 80, 'no-brackets': 90, 'no-brackets-prefix': 60 };
  const MIN_SCORE = 55;

  for (const wj of wanweiJournals) {
    const candidates = [];

    for (const sj of sourceJournals) {
      const matchType = namesMatch(wj.name, sj.name);
      if (!matchType) continue;

      const typeScore = typeScoreMap[matchType];
      // 用去括号后的长度计算相似度（避免括号内元数据干扰）
      const sw = stripBrackets(normalizeName(wj.name));
      const ss = stripBrackets(normalizeName(sj.name));
      const lenRatio = Math.min(sw.length, ss.length) / Math.max(sw.length, ss.length);
      const lenBonus = Math.round(lenRatio * 10);

      // 短名匹配长名的惩罚：防止"文化遗产"→"文化遗产保护与研究"、"中国美术"→"中国美术馆"
      let shortPenalty = 0;
      const shortLen = Math.min(sw.length, ss.length);
      const longLen = Math.max(sw.length, ss.length);
      if (shortLen <= 5 && longLen >= 5 && matchType !== 'exact' && matchType !== 'no-brackets') {
        shortPenalty = 30;
      }

      candidates.push({ sj, matchType, score: typeScore + lenBonus - shortPenalty });
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      if (candidates[0].score >= MIN_SCORE) {
        matches.push({ wanwei: wj, source: candidates[0].sj, matchType: candidates[0].matchType });
      } else {
        unmatchedWanwei.push(wj.name);
      }
    } else {
      unmatchedWanwei.push(wj.name);
    }
  }

  // 找源文件中未匹配的
  const matchedSourceNames = new Set(matches.map(m => m.source.name));
  for (const sj of sourceJournals) {
    if (!matchedSourceNames.has(sj.name)) {
      unmatchedSource.push(sj.name);
    }
  }

  // 如果指定了 --single，只保留那一本
  let effectiveMatches = matches;
  if (TARGET_NAME) {
    effectiveMatches = matches.filter(m =>
      normalizeName(m.source.name).includes(normalizeName(TARGET_NAME))
    );
    if (effectiveMatches.length === 0) {
      console.error(`未找到匹配的期刊: ${TARGET_NAME}`);
      process.exit(1);
    }
    console.log(`[--single] 只处理: ${effectiveMatches[0].source.name}\n`);
  }

  console.log(`匹配成功: ${matches.length} 本`);
  if (unmatchedWanwei.length > 0) {
    console.log(`万维未匹配: ${unmatchedWanwei.length} 本 (${unmatchedWanwei.join(', ')})`);
  }
  if (unmatchedSource.length > 0 && !TARGET_NAME) {
    console.log(`源文件未匹配: ${unmatchedSource.length} 本`);
  }
  console.log('');

  // 4. 变更预览 / 应用
  const changes = [];
  const now = new Date().toISOString().slice(0, 10);
  let publisherFillCount = 0;

  for (const m of effectiveMatches) {
    const wj = m.wanwei;
    const sj = m.source;
    const entryChanges = [];

    // eshukanId
    if (wj.eshukanId && sj.wanweiId !== wj.eshukanId) {
      const oldVal = sj.wanweiId ? `(原wanweiId: ${sj.wanweiId})` : '无';
      entryChanges.push(`wanweiId→eshukanId: ${oldVal} → ${wj.eshukanId}`);
      sj.wanweiId = wj.eshukanId;
    }

    // eshukan reviews (清洗后) — 在 rescrape-eshukan-reviews.js 完成后才有数据
    const cleanedReviews = (wj.reviews || []).map(cleanReview).filter(r => r.reviewTime || r.content);
    if (cleanedReviews.length > 0) {
      const oldCount = (sj.wanweiReviews || []).length;
      if (oldCount !== cleanedReviews.length || JSON.stringify(sj.wanweiReviews) !== JSON.stringify(cleanedReviews)) {
        entryChanges.push(`wanweiReviews: ${oldCount}条 → ${cleanedReviews.length}条`);
        sj.wanweiReviews = cleanedReviews;
      }
    }

    // wanweiReviewStats
    const stats = computeReviewStats(cleanedReviews);
    if (stats) {
      const oldStatsStr = JSON.stringify(sj.wanweiReviewStats || {});
      if (oldStatsStr !== JSON.stringify(stats)) {
        entryChanges.push(`wanweiReviewStats: 已更新`);
        sj.wanweiReviewStats = stats;
      }
    }

    // reviewCycle — 仅在原字段为空时更新
    if (!sj.reviewCycle && wj.reviewStats && wj.reviewStats.reviewTime) {
      const rt = wj.reviewStats.reviewTime;
      if (rt && rt.trim() && rt.trim() !== '-' && rt.trim() !== '暂无') {
        const m2 = rt.match(/(\d+)\s*天/);
        if (m2) {
          sj.reviewCycle = `${m2[1]}天`;
        } else {
          sj.reviewCycle = rt.trim();
        }
        entryChanges.push(`reviewCycle: (空) → ${sj.reviewCycle}`);
      }
    }

    // ==== 万维书刊网特有的 basicInfo 合并 ====
    if (wj.basicInfo) {
      const bi = wj.basicInfo;

      // publisher — 填补空白（139本缺失！）
      if (!sj.publisher && bi.publisher) {
        const pub = bi.publisher.trim().replace(/\s+/g, '');
        if (pub && pub.length > 1) {
          sj.publisher = pub;
          entryChanges.push(`publisher: (空) → ${pub}`);
          publisherFillCount++;
        }
      }

      // ISSN — 与源文件比对，不一致时记录
      if (bi.issn && sj.issn) {
        const eshukanIssn = bi.issn.replace(/^ISSN\s*/i, '').replace(/\s+/g, '');
        const sourceIssn = sj.issn.replace(/\s+/g, '');
        if (eshukanIssn !== sourceIssn) {
          entryChanges.push(`⚠ ISSN不一致: 源="${sj.issn}" 万维书刊网="${bi.issn}"`);
        }
      }

      // pageFee — 仅在原为空时更新
      if (!sj.pageFee) {
        const feeHint = bi.pageFeeFromName || '';
        if (feeHint.includes('不收版面费') || feeHint.includes('不收版面费审稿费')) {
          sj.pageFee = '不收版面费';
          entryChanges.push(`pageFee: (空) → 不收版面费`);
        }
      }

      // 联系方式 — 仅在原为空时补充
      if (!sj.submissionEmail && bi.email) {
        const email = bi.email.split(/[;；]/)[0].replace(/^[^:：]+[：:]\s*/, '').trim();
        if (email && email.includes('@') && email.length < 80) {
          sj.submissionEmail = email;
          entryChanges.push(`submissionEmail: (空) → ${email.substring(0,40)}...`);
        }
      }

      if (!sj.officialSite && bi.website) {
        const site = bi.website.trim();
        if (site.startsWith('http') && site.length > 10) {
          sj.officialSite = site;
          entryChanges.push(`officialSite: (空) → ${site.substring(0,50)}`);
        }
      }

      // 影响因子 — 仅在原为空时更新
      if (!sj.impactFactor && bi.impactFactor) {
        const ifVal = parseFloat(bi.impactFactor);
        if (ifVal > 0) {
          sj.impactFactor = ifVal;
          entryChanges.push(`impactFactor: (空) → ${ifVal}`);
        }
      }

      // 电话地址等补充信息存到 notes
      if (bi.phone || bi.address) {
        const extras = [];
        if (bi.phone && !(sj.notes || '').includes(bi.phone.trim())) {
          extras.push(`电话:${bi.phone.replace(/[;；]/g, ' / ')}`);
        }
        if (bi.address && !(sj.notes || '').includes('地址:')) {
          extras.push(`地址:${bi.address.trim()}`);
        }
        if (extras.length > 0) {
          const oldNotes = sj.notes || '';
          sj.notes = oldNotes + (oldNotes ? ' | ' : '') + extras.join(' | ');
          entryChanges.push(`notes: 补充联系方式`);
        }
      }
    }

    // realAuthorProfile — 追加万维书刊网洞察
    if (cleanedReviews.length >= 2) {
      const insights = [];
      const degrees = {};
      cleanedReviews.forEach(r => {
        if (r.degree) degrees[r.degree] = (degrees[r.degree] || 0) + 1;
      });
      const degreeSummary = Object.entries(degrees)
        .sort((a, b) => b[1] - a[1])
        .map(([d, c]) => `${d}(${c}人)`)
        .join('、');
      if (degreeSummary) insights.push(`投稿人学历: ${degreeSummary}`);

      if (stats && stats.acceptanceRate !== undefined) {
        insights.push(`万维书刊网点名录用率约${stats.acceptanceRate}%`);
      }

      if (insights.length > 0) {
        const addition = insights.join('；');
        const oldProfile = sj.realAuthorProfile || '';
        if (!oldProfile.includes(addition)) {
          sj.realAuthorProfile = oldProfile
            ? oldProfile + '。' + addition
            : addition;
          entryChanges.push(`realAuthorProfile: 追加 ${insights.length} 条万维洞察`);
        }
      }
    }

    // source — 追加标记
    if (sj.source && !sj.source.includes('万维书刊网核验')) {
      sj.source += ' · 万维书刊网核验';
      entryChanges.push(`source: 追加万维书刊网标记`);
    } else if (!sj.source) {
      sj.source = '万维书刊网核验';
      entryChanges.push(`source: (空) → 万维书刊网核验`);
    }

    // lastUpdated
    if (sj.lastUpdated !== now) {
      sj.lastUpdated = now;
    }

    if (entryChanges.length > 0) {
      changes.push({
        name: sj.name,
        id: sj.id,
        matchType: m.matchType,
        changes: entryChanges,
      });
    }
  }

  // 5. 输出报告
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`变更摘要: ${changes.length} 本期刊将被更新\n`);

  if (changes.length === 0) {
    console.log('没有需要更新的内容。');
    return;
  }

  if (DRY_RUN) {
    console.log('[DRY RUN] 预览变更 (不实际写入):\n');
    for (const c of changes) {
      console.log(`  📋 ${c.name} (${c.id}) [匹配: ${c.matchType}]`);
      c.changes.forEach(ch => console.log(`     - ${ch}`));
    }
    console.log(`\n共 ${changes.length} 本期刊将被更新。`);
    console.log('运行 node merge-wanwei-data.js 执行实际合并。');
    return;
  }

  // 显示简要变更
  for (const c of changes) {
    console.log(`  ✅ ${c.name} — ${c.changes.length} 处变更`);
  }

  // 6. 备份 & 写入
  console.log(`\n备份: ${BACKUP}`);
  fs.writeFileSync(BACKUP, fs.readFileSync(SOURCE, 'utf-8'), 'utf-8');

  // 重新构建源文件内容
  const sourceContent = fs.readFileSync(SOURCE, 'utf-8');
  // 找到 journalDatabase 数组定义并替换
  // 策略：读取整个文件，替换 module.exports 前的数组内容

  // 序列化更新后的数据
  const newArrayJson = JSON.stringify(sourceJournals, null, 2);
  // 转义 $` 等模板字符串特殊字符（源文件是纯数据，不应有这些）
  const safeJson = newArrayJson.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  // 更简单的方法：直接重写整个文件
  const header = `const journalDatabase = `;
  const footer = `\n\nmodule.exports = journalDatabase;\n`;

  const newContent = header + JSON.stringify(sourceJournals, null, 2) + footer;

  // 验证新内容可被 require
  try {
    fs.writeFileSync(SOURCE, newContent, 'utf-8');
    delete require.cache[require.resolve(SOURCE)];
    const verify = require(SOURCE);
    if (!Array.isArray(verify) || verify.length !== sourceJournals.length) {
      throw new Error(`验证失败: 数组长度不匹配 (${verify.length} vs ${sourceJournals.length})`);
    }
    console.log(`验证通过: ${verify.length} 本期刊`);
  } catch (err) {
    console.error('写入验证失败:', err.message);
    console.error('从备份恢复...');
    fs.copyFileSync(BACKUP, SOURCE);
    process.exit(1);
  }

  console.log(`\n✅ 合并完成!`);
  console.log(`   更新了 ${changes.length} 本期刊`);
  if (publisherFillCount > 0) console.log(`   其中 ${publisherFillCount} 本补全了 publisher`);
  console.log(`   备份保存在: ${BACKUP}`);
  console.log(`\n下一步:`);
  console.log(`   1. node build.js   # 重新构建`);
  console.log(`   2. 双击 index.html # 浏览器测试`);
  console.log(`   3. git status      # 确认无误后提交`);
}

merge();
