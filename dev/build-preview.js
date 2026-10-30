#!/usr/bin/env node
/**
 * Builds dev/preview.html: the web app as one static page, with the Apps Script
 * backend replaced by dev/mock-server.js. Lets you try the UI locally:
 *
 *   node dev/build-preview.js && npx http-server dev   (or any static server)
 *
 * Camera access needs http://localhost or https.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const read = name => fs.readFileSync(path.join(src, name), 'utf8');

let html = read('Index.html').replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, name) => read(name + '.html'));
const mock = fs.readFileSync(path.join(__dirname, 'mock-server.js'), 'utf8');
html = html.replace('<head>', '<head>\n<script>\n' + mock + '\n</script>');

if (/<\?/.test(html)) throw new Error('Unprocessed template tag left in Index.html');
fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('Wrote dev/preview.html');
