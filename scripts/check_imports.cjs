const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'src', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.js'));

const exportsMap = {};

for (const f of files) {
  const content = fs.readFileSync(path.join(dataDir, f), 'utf-8');
  const exportRegex = /export\s+(?:async\s+)?(?:function|const|let|var)\s+([a-zA-Z0-9_]+)/g;
  const match = [...content.matchAll(exportRegex)];
  exportsMap[f] = match.map(m => m[1]);
  
  // also handle "export { a, b, c }"
  const exportObjRegex = /export\s+\{([^}]+)\}/g;
  const objMatches = [...content.matchAll(exportObjRegex)];
  for (const m of objMatches) {
    const syms = m[1].split(',').map(s => s.trim()).filter(s => s);
    exportsMap[f].push(...syms);
  }
}

let hasWarnings = false;

for (const f of files) {
  const content = fs.readFileSync(path.join(dataDir, f), 'utf-8');
  
  // 1. check imports from other files
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]\.\/([^'"]+)['"]/g;
  const imports = [...content.matchAll(importRegex)];
  
  for (const match of imports) {
    const symbols = match[1].split(',').map(s => s.trim()).filter(s => s);
    const sourceFile = match[2] + '.js';
    
    if (exportsMap[sourceFile]) {
      for (const sym of symbols) {
        if (!exportsMap[sourceFile].includes(sym)) {
          console.log(`WARNING: ${f} imports '${sym}' from '${sourceFile}', but it is not exported!`);
          hasWarnings = true;
        }
      }
    }
  }
  
  // 2. basic check for used but undeclared identifiers inside the file 
  // (this is harder to do accurately with regex, but we can look for specific ones)
  const commonStoreFunctions = [
    'getSchoolProfile', 'getStudents', 'withRetry', 'mutationGuard', 'cachedQuery',
    '_currentSchoolId', '_currentAuthUser', 'getUserByAuthId', 'logAuditEvent'
  ];
  for (const sym of commonStoreFunctions) {
    // If the symbol is in the file but not in any import or definition
    if (content.includes(sym) && !exportsMap[f].includes(sym)) {
      // Check if it's imported from anywhere
      const isImported = new RegExp(`import\\s+{[^}]*\\b${sym}\\b[^}]*}`).test(content);
      if (!isImported) {
        // Exclude some edge cases, like it being a property (obj.getStudents)
        // Just print a warning
        console.log(`WARNING: ${f} uses '${sym}' but it might not be imported or defined.`);
        hasWarnings = true;
      }
    }
  }
}

if (!hasWarnings) {
  console.log("No import/export mismatch found!");
}
