/**
 * 聊·选刊 - 数据混淆构建脚本(双数据库版)
 * 
 * 用法:在项目根目录运行 `node build.js`
 * 
 * 输入:
 *   src/journals.source.js  (主数据库,明文,本地维护)
 *   src/xuebao.source.js    (学报数据库,明文,本地维护)
 * 
 * 输出:
 *   journals.js             (主数据库混淆版,push 到 GitHub)
 *   xuebao.js               (学报数据库混淆版,push 到 GitHub)
 * 
 * 整理者:胡泽(@43JOJO,聊城大学)
 */

const fs = require('fs');
const path = require('path');

// ==== 任务定义:每个数据库一份配置 ====
const TASKS = [
  {
    label: '主数据库',
    sourcePath: path.join(__dirname, 'src', 'journals.source.js'),
    outputPath: path.join(__dirname, 'journals.js'),
    globalVar: 'journalDatabase',
    requiredFields: ['id', 'name', 'domains', 'keywords', 'catalogLevel', 'frequency'],
    needIdCheck: true,
  },
  {
    label: '学报数据库',
    sourcePath: path.join(__dirname, 'src', 'xuebao.source.js'),
    outputPath: path.join(__dirname, 'xuebao.js'),
    globalVar: 'xuebaoDatabase',
    requiredFields: ['name', 'level', 'domains'],
    needIdCheck: false,
  },
];

let allOk = true;

// ==== 逐个处理 ====
for (const task of TASKS) {
  console.log('');
  console.log('▶ 处理:' + task.label);
  
  // 1. 检查源文件
  if (!fs.existsSync(task.sourcePath)) {
    console.error('  ❌ 找不到源文件:' + task.sourcePath);
    console.error('     请确认文件存在,且末尾有 module.exports = ...;');
    allOk = false;
    continue;
  }
  
  // 2. 加载数据
  let sourceData;
  try {
    delete require.cache[require.resolve(task.sourcePath)];
    sourceData = require(task.sourcePath);
  } catch (err) {
    console.error('  ❌ 源文件加载失败:' + err.message);
    console.error('     请检查 JavaScript 语法(逗号、引号、括号闭合)。');
    allOk = false;
    continue;
  }
  
  // 3. 校验数据结构
  if (!Array.isArray(sourceData)) {
    console.error('  ❌ 源文件必须导出一个数组(末尾要有 module.exports = xxxDatabase;)');
    allOk = false;
    continue;
  }
  if (sourceData.length === 0) {
    console.error('  ❌ 数组为空,请检查源文件内容。');
    allOk = false;
    continue;
  }
  
  // 4. 校验必需字段
  const sample = sourceData[0];
  const missing = task.requiredFields.filter(f => !(f in sample));
  if (missing.length > 0) {
    console.error('  ❌ 第一条数据缺少必需字段:' + missing.join(', '));
    allOk = false;
    continue;
  }
  
  // 5. ID 唯一性检查(只对主数据库)
  if (task.needIdCheck) {
    const ids = sourceData.map(j => j.id);
    const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupIds.length > 0) {
      console.error('  ❌ 检测到重复 ID:' + [...new Set(dupIds)].join(', '));
      allOk = false;
      continue;
    }
  }
  
  // 6. 编码 + 输出
  const json = JSON.stringify(sourceData);
  const encoded = Buffer.from(json, 'utf-8').toString('base64');
  const buildTime = new Date().toISOString().slice(0, 10);
  
  const output = `/**
 * 聊·选刊 ${task.label}
 * 整理者:胡泽(@43JOJO,聊城大学)
 * 构建时间:${buildTime}
 * 数据条数:${sourceData.length}
 * 
 * 协议:CC BY-NC-SA 4.0(署名-非商业-相同方式共享)
 * https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh
 * 
 * 本数据库为个人耗时整理。允许在保留署名前提下个人使用、学习、研究。
 * 禁止:移除署名再发布、商业用途、未经授权的批量爬取与转售。
 * 衍生作品须采用相同协议开源。
 * 
 * 侵权举报与合作:674737568@qq.com
 */
(function () {
  var _d = "${encoded}";
  try {
    var bin = atob(_d);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var json = new TextDecoder('utf-8').decode(bytes);
    window.${task.globalVar} = JSON.parse(json);
  } catch (e) {
    console.error('${task.label}加载失败:', e);
    window.${task.globalVar} = [];
  }
})();
`;
  
  fs.writeFileSync(task.outputPath, output, 'utf-8');
  
  const sizeKB = (Buffer.byteLength(output) / 1024).toFixed(1);
  console.log('  ✅ 成功');
  console.log('     条目数:' + sourceData.length);
  console.log('     输出:  ' + path.basename(task.outputPath) + ' (' + sizeKB + ' KB)');
}

// ==== 总结报告 ====
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (allOk) {
  console.log('✅ 全部构建成功');
  console.log('');
  console.log('⚠️  push 前请确认:');
  console.log('   1. 运行 git status,【没有】src/ 目录或 *.source.js');
  console.log('   2. .gitignore 已正确配置(开头有点)');
  console.log('   3. 浏览器打开 index.html 测试搜索功能正常');
} else {
  console.log('❌ 部分构建失败,请按上方提示修复后重新运行');
  process.exit(1);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
