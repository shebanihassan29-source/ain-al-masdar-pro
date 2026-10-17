'use strict';
/**
 * Run automatically by Render's build command (see render.yaml).
 * If the files were uploaded to GitHub "flat" (all in the repository root, because the web uploader
 * would not accept folders), this moves each one into the folder the server expects.
 * Safe to run when the folders already exist: it only moves files that are still in the root.
 */
const fs = require('fs');
const path = require('path');

const MAP = {
  'index.html': 'public', 'admin.html': 'public', 'terms.html': 'public', 'privacy.html': 'public',
  'account.js': 'public/static', 'admin.js': 'public/static', 'style.css': 'public/static', 'fonts.css': 'public/static',
  'pro.html': 'private',
  'smoke.js': 'test',
  'fix-pro.py': 'tools', 'build-pro.py': 'tools',
};
for (const w of ['400', '600', '800']) for (const s of ['arabic', 'latin']) MAP[`cairo-${s}-${w}-normal.woff2`] = 'public/static/fonts';

let moved = 0;
for (const [file, dir] of Object.entries(MAP)) {
  const from = path.join(__dirname, file);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
  fs.renameSync(from, path.join(__dirname, dir, file));
  moved++;
}
console.log(`[organize] moved ${moved} file(s) into place`);
const required = ['public/index.html', 'public/admin.html', 'public/static/account.js', 'public/static/admin.js', 'public/static/style.css', 'private/pro.html'];
const missing = required.filter((f) => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) { console.error('[organize] MISSING files: ' + missing.join(', ')); process.exit(1); }
