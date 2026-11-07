/**
 * Deep cross-module import audit for Termly.
 * Checks store files AND page files for uses of known exported symbols
 * without a corresponding import statement.
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(process.cwd(), 'src');
const dataDir = path.join(srcDir, 'data');
const pagesDir = path.join(srcDir, 'pages');

// Collect all exported symbols from data/ store files
function collectExports(dir) {
  const map = {}; // symbol -> sourceFile
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    const exportFnRegex = /export\s+(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]+)/g;
    const exportVarRegex = /export\s+(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]+)/g;
    const exportBraceRegex = /export\s*\{([^}]+)\}/g;
    for (const m of content.matchAll(exportFnRegex)) map[m[1]] = f;
    for (const m of content.matchAll(exportVarRegex)) map[m[1]] = f;
    for (const m of content.matchAll(exportBraceRegex)) {
      for (const sym of m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim())) {
        if (sym) map[sym] = f;
      }
    }
  }
  return map;
}

// Check a file for uses of symbols that aren't imported
function checkFile(filePath, allExports, allImported) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);

  // Collect what's imported in this file
  const importedHere = new Set();
  const importRegex = /import\s+\{([^}]+)\}\s+from/g;
  for (const m of content.matchAll(importRegex)) {
    for (const sym of m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim())) {
      if (sym) importedHere.add(sym);
    }
  }
  // Also collect default imports
  const defaultImportRegex = /import\s+([a-zA-Z_][a-zA-Z0-9_]+)\s+from/g;
  for (const m of content.matchAll(defaultImportRegex)) importedHere.add(m[1]);

  // Collect what's defined locally (function, const, let, var, class)
  const localDefs = new Set();
  const localDefRegex = /(?:function|const|let|var|class)\s+([a-zA-Z_][a-zA-Z0-9_]+)/g;
  for (const m of content.matchAll(localDefRegex)) localDefs.add(m[1]);

  const issues = [];
  for (const [sym, sourceFile] of Object.entries(allExports)) {
    if (importedHere.has(sym) || localDefs.has(sym)) continue;
    // Check if actually used as a call/reference (not just in a string or comment)
    const usageRegex = new RegExp(`(?<!['"\\w./])\\b${sym}\\s*[({\\[;,. ]`, 'g');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      // Skip if inside a string literal (rough check)
      const stripped = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
      if (usageRegex.test(stripped)) {
        usageRegex.lastIndex = 0;
        issues.push(`  ${fileName}:${i + 1} → uses "${sym}" (from ${sourceFile}) but it's not imported`);
      }
    }
  }
  return issues;
}

const storeExports = collectExports(dataDir);

// Remove noisy false-positive symbols (Supabase table names used as strings etc.)
const TABLE_NAMES = new Set(['students', 'teachers', 'fees', 'attendance', 'marks', 'schools']);
for (const key of TABLE_NAMES) delete storeExports[key];

let allIssues = [];

// Check store files
for (const f of fs.readdirSync(dataDir).filter(f => f.endsWith('.js'))) {
  const issues = checkFile(path.join(dataDir, f), storeExports, {});
  allIssues.push(...issues);
}

// Check page files (recursively)
function walkPages(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPages(full);
    else if (entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) {
      const issues = checkFile(full, storeExports, {});
      allIssues.push(...issues);
    }
  }
}
walkPages(pagesDir);

if (allIssues.length === 0) {
  console.log('✅ No missing imports found! All symbols are properly imported.');
} else {
  console.log(`⚠️  Found ${allIssues.length} potential missing imports:\n`);
  console.log(allIssues.join('\n'));
}
