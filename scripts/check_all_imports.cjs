const fs = require('fs');
const path = require('path');
const dataDir = path.join(process.cwd(), 'src', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.js'));
const exportsMap = {};
for (const f of files) {
  const content = fs.readFileSync(path.join(dataDir, f), 'utf-8');
  exportsMap[f] = [];
  const exportRegex = /export\s+(?:async\s+)?(?:function|const|let|var)\s+([a-zA-Z0-9_]+)/g;
  for (const match of content.matchAll(exportRegex)) {
    exportsMap[f].push(match[1]);
  }
  const exportObjRegex = /export\s+\{([^}]+)\}/g;
  for (const m of content.matchAll(exportObjRegex)) {
    const syms = m[1].split(',').map(s => s.trim()).filter(s => s);
    exportsMap[f].push(...syms);
  }
}
const allExports = new Set(Object.values(exportsMap).flat());
let hasWarnings = false;
for (const f of files) {
  if (f === 'seedData.js') continue;
  const content = fs.readFileSync(path.join(dataDir, f), 'utf-8');
  for (const exp of allExports) {
    if (content.includes(exp)) {
      const isExported = exportsMap[f].includes(exp);
      const isImportedRegex = new RegExp('import\\s+\\{[^}]*\\b' + exp + '\\b[^}]*\\}');
      const isImported = isImportedRegex.test(content);
      if (!isExported && !isImported) {
        // filter out cases like student.getStudents() or something
        if (new RegExp('\\b' + exp + '\\b').test(content)) {
           console.log(`WARNING: ${f} uses ${exp} but it might not be imported.`);
        }
      }
    }
  }
}
