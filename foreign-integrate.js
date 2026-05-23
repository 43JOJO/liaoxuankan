// ====== 外文匹配集成任务包 ======
// 目标: 英文论文时用 computeMatchScoreForeign 替代 computeMatchScore
// 约束: 不改 renderResults/buildJournalCard/determineTier/checkConstraints

// === 1. doSearch 主循环 (当前版本) ===
// 主搜索函数
function doSearch() {
  const profile = {
    identity: $('profile-identity').value,
    degree: $('profile-degree').value,
    budget: $('profile-budget').value,
    timeline: $('profile-timeline').value,
    unit: $('profile-unit').value,
    funding: $('profile-funding').value,
    language: $('profile-language').value,
    supervisor: $('profile-supervisor').value,
    province: $('profile-province').value,
    unitName: $('profile-unit-name').value.trim()
  };
  currentUnit = profile.unit;
  currentUserLabel = getUserLabel(profile);
  window.currentProfile = profile;
  window.currentPaperText = (($('paper-title').value + ' ' + $('paper-abstract').value + ' ' + $('paper-keywords').value)).toLowerCase();

  const paperTitle = $('paper-title').value.trim();
  const paperAbstract = $('paper-abstract').value.trim();
  const paperKeywords = $('paper-keywords').value.trim();

  if (!paperTitle && !paperAbstract && !paperKeywords) {
    alert('请至少填写论文标题、摘要或关键词之一');
    return;
  }

  const paperText = paperTitle + ' ' + paperAbstract;

  // 语言检测：英文论文自动切换到外文期刊库
  const engChars = (paperText.match(/[a-zA-Z]/g) || []).length;
  const chnChars = (paperText.match(/[一-鿿]/g) || []).length;
  const isEnglish = engChars > chnChars * 2 || (chnChars === 0 && engChars > 20);
  const activeDatabase = (isEnglish && typeof foreignJournalDatabase !== 'undefined')
    ? foreignJournalDatabase : journalDatabase;
  window.isEnglishPaper = isEnglish;
  if (isEnglish && typeof foreignJournalDatabase !== 'undefined') {
    console.log('检测到英文论文，切换到外文期刊库 (' + foreignJournalDatabase.length + ' 本)');
  }

  allResults = [];

  for (const journal of activeDatabase) {
    const match = computeMatchScore(paperText, paperKeywords, journal, currentDiscipline);
    if (match.score <= 0) continue;

    const constraints = checkConstraints(journal, profile);

    let tier;
    if (constraints.blocked) {
      tier = 'blocked';
    } else {
      tier = determineTier(match.score, journal);
      if (!tier) continue;
    }

    allResults.push({
      journal,
      matchScore: match.score,
      domainBoost: match.domainBoost || 0,
      matchedKeywords: match.matchedKeywords,
      unmatchedKeywords: match.unmatchedKeywords,
      tier,
      warnings: constraints.warnings,
      blocked: constraints.blocked
    });
  }

  const tierOrder = { 'reach': 0, 'match': 1, 'safe': 2, 'blocked': 3 };
  allResults.sort((a, b) => {
    if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
    return b.matchScore - a.matchScore;
  });

  // 初始化筛选按钮的计数
  updateFilterCounts();
  // 显示筛选栏
  $('filter-bar').style.display = 'flex';
  // 重置筛选状态
  activeFilters.level = new Set();

// === 2. computeMatchScore 返回格式 ===

// 改进的匹配分数计算
function computeMatchScore(paperText, paperKeywords, journal, discipline) {
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const toLower = (s) => String(s || '').toLowerCase();
  const uniqKey = (s) => toLower(s).trim();
    score,
    matchedKeywords,
    unmatchedKeywords,

    ratio: coverageRatio,
    domainBoost: Math.round(domainPart + reviewTopicBoost),
    columnBoost: Math.round(columnBoost),
    userKwBoost,

    coverageScore: Math.round(coverageScore),
    precisionScore: Math.round(precisionScore),
    adaptationScore: Math.round(adaptationScore),
    titlePrecision: Math.round(titlePrecision),
    cnkiPrecision: Math.round(cnkiPrecision),
    reviewTopicBoost: Math.round(reviewTopicBoost),
    identityBoost: Math.round(identityFit),
    unitBoost: Math.round(unitFit),
    feeTransparency: Math.round(feeTransparency),
    transparencyPenalty: Math.round(transparencyPenalty),
    geoPenalty: Math.round(geoPenalty)
  };
}

function parseReviewDays(cycleStr) {
  if (!cycleStr) return null;
  const s = cycleStr.toLowerCase();
  const nums = s.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  if (s.includes('天')) return parseInt(nums[nums.length - 1]);
  if (s.includes('周')) return parseInt(nums[nums.length - 1]) * 7;
--
--
  return { score, tags };
}


// === 3. allResults item 结构 (readerResults 使用) ===
    }

    allResults.push({
      journal,
      matchScore: match.score,
      domainBoost: match.domainBoost || 0,
      matchedKeywords: match.matchedKeywords,
      unmatchedKeywords: match.unmatchedKeywords,
      tier,
      warnings: constraints.warnings,
      blocked: constraints.blocked
    });
  }

  const tierOrder = { 'reach': 0, 'match': 1, 'safe': 2, 'blocked': 3 };
  allResults.sort((a, b) => {
    if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
    return b.matchScore - a.matchScore;
  });

  // 初始化筛选按钮的计数

// === 4. 外文库字段结构 ===
{
  "name": "A + U: Architecture and Urbanism",
  "domains": [
    "建筑学"
  ],
  "keywords": [],
  "catalogLevel": "A&HCI",
  "frequency": "月刊",
  "language": "英文",
  "reviewCycle": "不适用/官网未公开（杂志型，编辑遴选或约稿为主）",
  "pageFee": "无APC；商业杂志/编辑出版，不按学术版面费模式",
  "oaType": "非OA/部分内容开放（杂志型；以官网访问政策为准）",
  "authorRequirement": "未见学术职称限制；杂志/评论类以编辑约稿、投稿提案或编辑遴选为主",
  "submissionMethod": "在线投稿",
  "officialSite": "https://japlusu.com/"
}
