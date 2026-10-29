// Copies browser builds of the file-parsing libraries into www/vendor (loaded lazily by the app).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js'],
  ['node_modules/mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
];
for (const [src, dst] of files) {
  fs.copyFileSync(path.join(root, src), path.join(out, dst));
  console.log('vendor ->', dst);
}
