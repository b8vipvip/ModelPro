const fs = require('node:fs');
const path = 'test/chain.test.mjs';
let source = fs.readFileSync(path, 'utf8');
const oldLine = " const redesigned=open.indexOf('const redesignedDirectRows = defaultChatDirectModelRows\\\\(picker\\\\)');";
const fallbackOldLine = " const redesigned=open.indexOf('const redesignedDirectRows = defaultChatDirectModelRows\\(picker\\)');";
const nextLine = " const redesigned=open.search(/(?:const|let) redesignedDirectRows = defaultChatDirectModelRows\\(picker\\)/);";
if (!source.includes(nextLine)) {
  if (source.includes(oldLine)) source = source.replace(oldLine, nextLine);
  else if (source.includes(fallbackOldLine)) source = source.replace(fallbackOldLine, nextLine);
  else throw new Error('legacy direct-picker assertion anchor not found');
}
fs.writeFileSync(path, source);
