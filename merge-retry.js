/**
 * 合并补抓结果到主数据源
 * 用法: node merge-retry.js
 */
const fs = require('fs');
const path = require('path');

const retry = require('./src/journals.retry.js');
const main = require('./src/journals.source.js');

let merged = 0;
for (const rj of retry) {
  const mj = main.find(j => j.name === rj.name || (rj.issn && j.issn === rj.issn));
  if (!mj) { console.log('NOT FOUND in main: ' + rj.name); continue; }

  if (rj.cnkiArticles && rj.cnkiArticles.length > 0) {
    mj.cnkiArticles = mj.cnkiArticles || [];
    // 去重：按 title 去重
    const existingTitles = new Set(mj.cnkiArticles.map(a => a.title));
    for (const a of rj.cnkiArticles) {
      if (!existingTitles.has(a.title)) {
        mj.cnkiArticles.push(a);
        existingTitles.add(a.title);
      }
    }
    // 合并关键词
    const allKw = rj.cnkiArticles.flatMap(a => (a.keywords || '').split(';').map(k => k.trim()).filter(Boolean));
    const existingKw = mj.keywords || [];
    mj.keywords = [...new Set([...existingKw, ...allKw])].slice(0, 80);
  }

  if (rj.columns && rj.columns.length > 0) {
    const existing = mj.columns || [];
    mj.columns = [...new Set([...existing, ...rj.columns])];
  }

  mj.lastCnkiScrape = rj.lastCnkiScrape || mj.lastCnkiScrape;
  merged++;
  console.log('Merged: ' + rj.name + ' (' + (rj.cnkiArticles ? rj.cnkiArticles.length : 0) + ' articles)');
}

const header = 'const journalDatabase = ';
const footer = '\n\nmodule.exports = journalDatabase;\n';
fs.writeFileSync(path.join(__dirname, 'src', 'journals.source.js'), header + JSON.stringify(main, null, 2) + footer, 'utf-8');
console.log('\nDone. Merged ' + merged + ' journals into journals.source.js');
