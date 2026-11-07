/**
 * Audit all store files in src/data for potential snake_case <-> camelCase or missing property mappings
 * when reading from or writing to Supabase tables.
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(process.cwd(), 'src', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.js'));

console.log('--- STORE PROPERTY AUDIT ---');

const snakeCaseColsInStores = [];

for (const file of files) {
  const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    // Check for raw supabase select/insert/upsert where returned rows might map DB columns
    if (line.includes('.from(') || line.includes('.select(') || line.includes('return {')) {
      // Find return objects in fetch functions
    }

    // Flag functions returning DB row mappings that might omit snake_case or camelCase properties
    if (line.includes('_id') || line.includes('_name') || line.includes('_status') || line.includes('_type') || line.includes('_code')) {
      if (!line.includes('//') && !line.includes('/*') && (line.includes('return {') || line.includes('const ') || line.includes('let '))) {
        // Log potential property mapping lines
      }
    }
  });
}

// Let's inspect all 'select(' and 'return {' blocks in all store files
for (const file of files) {
  const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
  const returnBlocks = content.match(/return\s+\{([^}]+)\}/g) || [];
  console.log(`\n=== File: ${file} ===`);
  returnBlocks.forEach((block, i) => {
    // Check if return block maps properties
    if (block.includes(': data.') || block.includes(': row.') || block.includes(': item.')) {
      console.log(`Return mapping #${i+1}:\n${block.substring(0, 300)}...\n`);
    }
  });
}
