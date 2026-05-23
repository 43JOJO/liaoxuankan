const fs = require('fs');
const SOURCE = 'D:/journal-advisor/src/journals.source.js';
const d = require(SOURCE);

let cleaned = 0;
for (const j of d) {
  for (const r of (j.wanweiReviews || [])) {
    if (!r.content) continue;
    let c = r.content;
    const old = c;

    const lines = c.split('\n');
    while (lines.length > 1 && lines[lines.length-1].trim() === '') lines.pop();

    if (lines.length > 1) {
      const last = lines[lines.length-1].trim();
      const isSig = (
        /^[^\n]{1,40}[\s]{1,6}[在于]\s*(\d{4}[\/\-])?/.test(last) ||
        /^[a-zA-Z0-9_]{3,20}\s{2,}$/.test(last) ||
        /^匿名用户/.test(last) ||
        (/^[a-zA-Z一-鿿_]{2,15}\s{2,}$/.test(last) && last.length < 25)
      );
      if (isSig && !/[。！？!?,，]/.test(last) && last.length < 50) {
        lines.pop();
        while (lines.length > 1 && lines[lines.length-1].trim() === '') lines.pop();
        c = lines.join('\n').trim();
      }
    }

    c = c.replace(/\n{0,2}\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*$/g, '');

    if (c.length < 20 && !/[。，！？]/.test(c) && /用户|匿名/.test(c)) c = '';

    if (c !== old) {
      r.content = c.trim() || null;
      if (!r.content || r.content.length < 5) r.content = null;
      cleaned++;
    }
  }
}

const header = 'const journalDatabase = ';
const footer = '\n\nmodule.exports = journalDatabase;\n';
fs.writeFileSync(SOURCE, header + JSON.stringify(d, null, 2) + footer, 'utf-8');
console.log('Cleaned:', cleaned, 'reviews');

const j = d.find(j=>j.name.includes('艺术与设计'));
console.log('');
console.log(j?.name, 'reviews:');
(j?.wanweiReviews || []).forEach((r,i) => {
  console.log('  ' + (i+1) + '. content:', (r.content||'(空)').substring(0,80));
  console.log('     degree:', r.degree, '| accepted:', r.accepted, '| date:', r.date);
});
